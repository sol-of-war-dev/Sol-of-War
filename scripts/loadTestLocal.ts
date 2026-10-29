import {
  encodeClientMessage,
  decodeServerMessage,
  createGameWireContext,
} from "@openfront/shared/ZbinWire";
/** Isolated localhost-only simulation. No production credentials or payment RPCs. */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir, cpus, totalmem, platform, arch } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WebSocket } from "ws";
import { PlayerAuth } from "../src/frontpot/PlayerAuth";
import { replayWinnerInChild } from "../src/server/WinnerReplay";

const levels = (process.env.LOAD_LEVELS ?? "25,50,100,150")
  .split(",")
  .map(Number);
const seconds = Number(process.env.LOAD_SECONDS ?? 105);
const connectionCap = Number(process.env.LOAD_CONNECTION_CAP ?? 150);
if (
  levels.some((n) => !Number.isInteger(n) || n < 2 || n > connectionCap) ||
  ![150, 500].includes(connectionCap) ||
  seconds < 10 ||
  seconds > 600
)
  throw Error("Invalid load parameters");
const out = process.env.LOAD_OUTPUT ?? path.resolve("load-test-results");
mkdirSync(out, { recursive: true });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (a: number[], q: number) =>
  a.length
    ? [...a].sort((a, b) => a - b)[
        Math.min(a.length - 1, Math.floor(a.length * q))
      ]
    : null;
const stats = (a: number[]) => ({
  samples: a.length,
  p50: percentile(a, 0.5),
  p95: percentile(a, 0.95),
  p99: percentile(a, 0.99),
  max: a.length
    ? a.reduce((max, value) => Math.max(max, value), -Infinity)
    : null,
});
const report: any = {
  at: new Date().toISOString(),
  environment: "isolated localhost; production server code; simulated funds",
  host: {
    platform: platform(),
    arch: arch(),
    cpu: cpus()[0].model,
    logicalCpus: cpus().length,
    ramGiB: Math.round(totalmem() / 2 ** 30),
  },
  seconds,
  connectionCap,
  levels: [],
};
function wallet() {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz",
    bytes = randomBytes(32);
  let n = BigInt(`0x${bytes.toString("hex")}`),
    s = "";
  while (n) {
    s = alphabet[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b) break;
    s = "1" + s;
  }
  return s;
}
async function run(count: number) {
  const state = mkdtempSync(path.join(tmpdir(), "sow-load-"));
  const db = new DatabaseSync(path.join(state, "matches.sqlite")),
    auth = new PlayerAuth(db);
  const sessions = Array.from({ length: count + 1 }, (_, i) => {
    const s = auth.signIn({
      subject: `did:privy:load-${i}`,
      wallet: wallet(),
      expires: Date.now() + 3600000,
    });
    return auth.claimUsername(s.token, `LoadPlayer${i}`);
  });
  db.close();
  const finder = createServer();
  await new Promise<void>((r) => finder.listen(0, "127.0.0.1", r));
  const port = (finder.address() as any).port;
  await new Promise<void>((r) => finder.close(() => r()));
  const origin = `http://127.0.0.1:${port}`;
  const telemetry = path.join(state, "telemetry.jsonl"),
    instrument = path.join(state, "metrics.mjs");
  writeFileSync(
    instrument,
    `import {appendFileSync} from 'node:fs'; import {monitorEventLoopDelay} from 'node:perf_hooks';const h=monitorEventLoopDelay({resolution:10});h.enable();let cpu=process.cpuUsage(),t=performance.now();setInterval(()=>{const now=performance.now(),next=process.cpuUsage();appendFileSync(${JSON.stringify(telemetry)},JSON.stringify({rss:process.memoryUsage().rss,cpuPercent:((next.user-cpu.user)+(next.system-cpu.system))/(now-t)/10,lagP99Ms:h.percentile(99)/1e6,lagMaxMs:h.max/1e6})+'\\n');cpu=next;t=now;h.reset();},1000).unref();`,
  );
  // Only the disposable local server copy gets the expanded test cap.
  const serverSource = path.resolve("src/frontpot/Server.ts");
  const serverEntry =
    connectionCap === 150
      ? serverSource
      : path.resolve(`src/frontpot/.load-server-${process.pid}.ts`);
  if (connectionCap !== 150) {
    const source = readFileSync(serverSource, "utf8");
    if (source.split("wss.clients.size >= 150").length !== 2)
      throw Error("Server cap guard changed; inspect before testing");
    writeFileSync(
      serverEntry,
      source.replace(
        "wss.clients.size >= 150",
        `wss.clients.size >= ${connectionCap}`,
      ),
    );
  }
  const server = spawn(
    process.execPath,
    ["--import", instrument, "--import", "tsx", serverEntry],
    {
      env: {
        PATH: process.env.PATH,
        TMPDIR: tmpdir(),
        GAME_ENV: "dev",
        GIT_COMMIT: "DEV",
        HOST: "127.0.0.1",
        PORT: String(port),
        APP_ORIGIN: origin,
        FRONTPOT_STATE_DIR: state,
        PAYMENTS_MODE: "simulation",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let serverLog = "";
  server.stdout.on("data", (b) => (serverLog += b));
  server.stderr.on("data", (b) => (serverLog += b));
  const metrics: any = {
    players: count,
    apiMs: [],
    apiErrors: [],
    pingMs: [],
    turnGapMs: [],
    joinMs: [],
    rejoinMs: [],
    receivedBytes: 0,
    intentsSent: 0,
    turnIntents: 0,
    unexpectedCloses: [],
    decodeErrors: [],
    games: [],
    rejoins: 0,
  };
  const clients: any[] = [];
  const groups: any[] = [];
  let stopping = false,
    monitor: any;
  const api = async (
    route: string,
    player = 0,
    body?: unknown,
    sharedIP = false,
  ) => {
    const t = performance.now();
    const r = await fetch(origin + "/frontpot/api" + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${sessions[player].token}`,
        "x-forwarded-for": sharedIP
          ? "192.0.2.200"
          : `10.0.${Math.floor(player / 250)}.${(player % 250) + 1}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    metrics.apiMs.push(performance.now() - t);
    const data = await r.json();
    if (!r.ok) {
      metrics.apiErrors.push({ route, status: r.status });
      throw Error(`${route}: ${r.status} ${JSON.stringify(data)}`);
    }
    return data;
  };
  const connect = (i: number, g: any, rejoin = false) => {
    const c = clients[i] ?? {
      i,
      g,
      lastTurn: -1,
      started: false,
      expectedClose: false,
    };
    clients[i] = c;
    c.expectedClose = false;
    c.ctx = undefined;
    c.lastArrival = 0;
    const since = performance.now();
    const ws = new WebSocket(origin.replace("http", "ws") + "/w0", { origin });
    c.ws = ws;
    c.send = (msg: any) => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(encodeClientMessage(msg, c.ctx));
    };
    ws.on("open", () =>
      c.send(
        rejoin
          ? {
              type: "rejoin",
              token: sessions[i].token,
              gameID: g.id,
              lastTurn: c.lastTurn,
            }
          : {
              type: "join",
              token: sessions[i].token,
              gameID: g.id,
              username: sessions[i].name,
              clanTag: null,
              turnstileToken: null,
              gitCommit: "DEV",
              cosmetics: {},
            },
      ),
    );
    ws.on("message", (b) => {
      try {
        metrics.receivedBytes += Array.isArray(b)
          ? b.reduce((total, part) => total + part.byteLength, 0)
          : b.byteLength;
        const m: any = decodeServerMessage(new Uint8Array(b as Buffer), c.ctx);
        if (m.type === "start") {
          c.ctx = createGameWireContext(m.gameStartInfo.players);
          c.started = true;
          g.start ??= m.gameStartInfo;
          g.startedAt ??= Date.now();
          if (rejoin) {
            metrics.rejoinMs.push(performance.now() - since);
            metrics.rejoins++;
          }
          for (const t of m.turns) {
            c.lastTurn = Math.max(c.lastTurn, t.turnNumber);
            if (i === g.first) g.turns.set(t.turnNumber, t);
          }
        }
        if (m.type === "lobby_info" && !c.joined) {
          c.joined = true;
          metrics.joinMs.push(performance.now() - since);
        }
        if (m.type === "turn") {
          const now = performance.now();
          if (c.lastArrival) metrics.turnGapMs.push(now - c.lastArrival);
          c.lastArrival = now;
          c.lastTurn = m.turn.turnNumber;
          if (i === g.first) {
            g.turns.set(m.turn.turnNumber, m.turn);
            metrics.turnIntents += m.turn.intents.length;
          }
        }
        if (m.type === "pong")
          metrics.pingMs.push(performance.now() - m.sentAt);
      } catch (e) {
        metrics.decodeErrors.push(String(e));
      }
    });
    ws.on("error", (e) => metrics.decodeErrors.push(String(e)));
    ws.on("close", (code, reason) => {
      if (!stopping && !c.expectedClose && !g.finishing)
        metrics.unexpectedCloses.push({ i, code, reason: String(reason) });
    });
    return c;
  };
  try {
    for (let n = 0; ; n++) {
      if (
        await fetch(origin + "/healthz")
          .then((r) => r.ok)
          .catch(() => false)
      )
        break;
      if (n > 150 || server.exitCode !== null)
        throw Error("Server did not start");
      await sleep(100);
    }
    const config = await api("/config");
    if (config.paymentsMode !== "simulation")
      throw Error("Refusing non-simulation target");
    for (let first = 0; first < count; first += 50) {
      const n = Math.min(50, count - first);
      const r = await api("/rooms", first, {
        mode: "ffa",
        ranked: false,
        stake: "0",
        private: true,
        rules: {
          gameMap: first % 100 === 0 ? "Europe" : "World",
          maxPlayers: n,
          maxTimerValue: 1,
          randomSpawn: true,
        },
      });
      const g = { id: r.id, first, n, turns: new Map(), finishing: false };
      groups.push(g);
      for (let i = first; i < first + n; i++) {
        if (i !== first) await api(`/rooms/${r.id}/join`, i, {});
        connect(i, g);
      }
    }
    monitor = setInterval(() => {
      for (const c of clients) {
        c.send({ type: "ping", sentAt: Math.floor(performance.now()) });
        if (c.started) {
          c.send({
            type: "intent",
            intent: { type: "attack", targetID: null, troops: 10 },
          });
          metrics.intentsSent++;
        }
      }
    }, 1000);
    for (const g of groups) {
      for (let n = 0; ; n++) {
        const r = await api(`/rooms/${g.id}`, g.first);
        if (r.readyCount === g.n) break;
        if (n > 50) throw Error("Players not ready");
        await sleep(200);
      }
      await api(`/rooms/${g.id}/start`, g.first, {});
    }
    const start = Date.now();
    let reconnected = false,
      capChecked = false;
    let polling = false;
    const poll = setInterval(() => {
      if (polling) return;
      polling = true;
      void Promise.all(
        clients.map((c) => api(`/rooms/${c.g.id}`, c.i).catch(() => null)),
      ).finally(() => (polling = false));
    }, 2000);
    try {
      while (Date.now() - start < seconds * 1000) {
        await sleep(1000);
        if (!reconnected && Date.now() - start > 20000) {
          reconnected = true;
          const subset = clients.filter((_, i) => i % 10 === 0);
          for (const c of subset) {
            c.expectedClose = true;
            c.ws.close();
          }
          await sleep(500);
          for (const c of subset) connect(c.i, c.g, true);
        }
        if (
          count === connectionCap &&
          !capChecked &&
          Date.now() - start > 40000
        ) {
          capChecked = true;
          metrics[`connection${connectionCap + 1}`] = await new Promise(
            (resolve) => {
              const probe = new WebSocket(
                origin.replace("http", "ws") + "/w0",
                {
                  origin,
                },
              );
              const timer = setTimeout(() => {
                probe.terminate();
                resolve("timeout");
              }, 3000);
              probe.once("open", () => {
                clearTimeout(timer);
                probe.close();
                resolve("unexpectedly admitted");
              });
              probe.once("error", () => {
                clearTimeout(timer);
                resolve("rejected at upgrade");
              });
            },
          );
        }
        if (Math.floor((Date.now() - start) / 1000) % 20 === 0)
          console.log(
            JSON.stringify({
              stage: count,
              elapsedSeconds: Math.floor((Date.now() - start) / 1000),
              started: clients.filter((c) => c.started).length,
              pingP95: percentile(metrics.pingMs, 0.95),
              errors: metrics.apiErrors.length + metrics.decodeErrors.length,
            }),
          );
      }
    } finally {
      clearInterval(poll);
    }
    // Replay the captured real turn stream; submit its result to every simulated client.
    const finishStart = performance.now();
    const results = await Promise.all(
      groups.map(async (g) => {
        const t = performance.now();
        const replay = await replayWinnerInChild(
          g.start,
          [...g.turns.values()].sort(
            (a: any, b: any) => a.turnNumber - b.turnNumber,
          ),
        );
        const result: any = {
          players: g.n,
          turns: g.turns.size,
          replayMs: performance.now() - t,
          hasWinner: !!replay?.winner,
          tick: replay?.tick,
        };
        if (replay?.winner) {
          g.finishing = true;
          for (const c of clients.filter((c) => c.g === g))
            c.send({
              type: "winner",
              winner: replay.winner,
              allPlayersStats: replay.allPlayersStats,
            });
        }
        return result;
      }),
    );
    metrics.games = results;
    if (results.every((r) => r.hasWinner)) {
      for (let n = 0; n < 120; n++) {
        const pools = await Promise.all(
          groups.map((g) => api(`/rooms/${g.id}/pool`, g.first)),
        );
        if (
          pools.every((p) =>
            ["settled", "refunded", "review"].includes(p.state),
          )
        ) {
          metrics.finalStates = pools.map((p) => p.state);
          break;
        }
        await sleep(500);
      }
    }
    metrics.finishAndVerifyMs = performance.now() - finishStart;
    metrics.startedPlayers = clients.filter((c) => c.started).length;
    metrics.connectedBeforeCleanup = clients.filter(
      (c) => c.ws.readyState === WebSocket.OPEN,
    ).length;
    const samples = readFileSync(telemetry, "utf8")
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
    const summary = {
      ...metrics,
      apiMs: stats(metrics.apiMs),
      pingMs: stats(metrics.pingMs),
      turnGapMs: stats(metrics.turnGapMs),
      joinMs: stats(metrics.joinMs),
      rejoinMs: stats(metrics.rejoinMs),
      serverRSSMiB: stats(samples.map((s) => s.rss / 2 ** 20)),
      serverCPUPercent: stats(samples.map((s) => s.cpuPercent)),
      eventLoopP99Ms: stats(samples.map((s) => s.lagP99Ms)),
    };
    writeFileSync(
      path.join(out, `${count}-players.json`),
      JSON.stringify(summary, null, 2),
    );
    return summary;
  } catch (e) {
    writeFileSync(
      path.join(out, `${count}-failure.log`),
      String(e) + "\n" + serverLog.slice(-10000),
    );
    throw e;
  } finally {
    stopping = true;
    clearInterval(monitor);
    for (const c of clients) c.ws.terminate();
    await new Promise<void>((resolve) => {
      if (server.exitCode !== null || server.signalCode !== null)
        return resolve();
      const timeout = setTimeout(() => {
        server.kill("SIGKILL");
        resolve();
      }, 5000);
      server.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      server.kill("SIGTERM");
    });
    if (serverEntry !== serverSource) rmSync(serverEntry, { force: true });
    rmSync(state, { recursive: true, force: true });
  }
}
for (const n of levels) {
  console.log(`Starting isolated ${n}-player test`);
  try {
    report.levels.push(await run(n));
  } catch (e) {
    report.levels.push({ players: n, error: String(e) });
    console.error(String(e));
    process.exitCode = 1;
  }
  writeFileSync(
    path.join(out, "summary.json"),
    JSON.stringify(report, null, 2),
  );
}
console.log(`Results saved to ${out}`);
