import type { ServerMessage } from "@openfront/shared/WireSchemas";
import {
  encodeClientMessage,
  decodeServerMessage,
  createGameWireContext,
} from "@openfront/shared/ZbinWire";
import type { ZbContext } from "@openfront/zbin";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WebSocket } from "ws";

const origin = process.env.DEMO_TEST_ORIGIN ?? "http://127.0.0.1:3000";
async function api(path: string, token?: string, body?: unknown) {
  const response = await fetch(`${origin}/frontpot/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  assert.ok(response.ok, JSON.stringify(value));
  return value;
}
function socket(token: string, room: string, name: string) {
  const ws = new WebSocket(`${origin.replace(/^http/, "ws")}/w0`, { origin });
  let ctx: ZbContext | undefined;
  const messages: ServerMessage[] = [];
  ws.on("open", () =>
    ws.send(
      encodeClientMessage(
        {
          type: "join",
          token,
          gameID: room,
          username: name,
          clanTag: null,
          turnstileToken: null,
          gitCommit: "DEV",
          cosmetics: {},
        },
        undefined,
      ),
    ),
  );
  ws.on("message", (bytes) => {
    const message = decodeServerMessage(new Uint8Array(bytes as Buffer), ctx);
    messages.push(message);
    if (message.type === "start")
      ctx = createGameWireContext(message.gameStartInfo.players);
  });
  const ping = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN)
      ws.send(encodeClientMessage({ type: "ping", sentAt: 1 }, ctx));
  }, 1000);
  ws.on("close", () => clearInterval(ping));
  return { ws, messages };
}
const participants = [];
const connections: ReturnType<typeof socket>[] = [];
let room: { id: string } | null = null;
try {
  const sessionFile = process.env.DEMO_TEST_SESSION_FILE;
  assert.ok(
    sessionFile,
    "Supply seven authenticated test sessions through DEMO_TEST_SESSION_FILE; guest sign-in is disabled.",
  );
  const sessions = JSON.parse(readFileSync(sessionFile, "utf8"));
  assert.equal(sessions.length, 7);
  for (const session of sessions)
    participants.push(await api("/session", session.token));
  const queue = await api("/rooms");
  assert.equal(queue.length, 6);
  const globalRoom = queue.find(
    (r: { queueKey: string }) => r.queueKey === "ffa:0.25",
  );
  assert.ok(globalRoom.startsAt - globalRoom.serverNow <= 120_000);
  assert.equal(globalRoom.prizeLamports, 0);
  const globalConnections = [];
  for (const p of participants.slice(5)) {
    await api(`/rooms/${globalRoom.id}/join`, p.token, {});
    const connection = socket(p.token, globalRoom.id, p.name);
    globalConnections.push(connection);
    connections.push(connection);
  }
  room = await api("/rooms", participants[0].token, {
    mode: "2v2",
    stake: "0.25",
    private: true,
    rules: {
      gameMap: "World",
      gameMapSize: "Normal",
      maxTimerValue: 1,
      randomSpawn: true,
    },
  });
  for (let i = 0; i < 3; i++) {
    if (i) await api(`/rooms/${room!.id}/join`, participants[i].token, {});
    connections.push(
      socket(participants[i].token, room!.id, participants[i].name),
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.equal(
    (await api(`/rooms/${room!.id}`, participants[0].token)).status,
    "countdown",
  );
  const outsider = socket(
    participants[4].token,
    room!.id,
    participants[4].name,
  );
  connections.push(outsider);
  const closeCode = await new Promise((resolve) =>
    outsider.ws.once("close", resolve),
  );
  assert.equal(closeCode, 1008, "Nonmembers must not enter a game socket");
  await api(`/rooms/${room!.id}/join`, participants[3].token, {});
  connections.push(
    socket(participants[3].token, room!.id, participants[3].name),
  );
  const deadline = Date.now() + 130_000;
  while (
    connections
      .filter((c) => c !== outsider)
      .some((c) => !c.messages.some((m) => m.type === "start")) &&
    Date.now() < deadline
  )
    await new Promise((resolve) => setTimeout(resolve, 200));
  for (const connection of connections.filter(
    (c) => c !== outsider && !globalConnections.includes(c),
  )) {
    const start = connection.messages.find((m) => m.type === "start");
    assert.ok(
      start && start.type === "start",
      "Every seated player receives the game start",
    );
    assert.equal(start.gameStartInfo.players.length, 4);
    assert.equal(start.gameStartInfo.config.gameMap, "World");
    assert.equal(start.gameStartInfo.config.gameMapSize, "Normal");
    assert.equal(start.gameStartInfo.config.randomSpawn, true);
    assert.equal(start.gameStartInfo.config.bots, 0);
    assert.deepEqual(
      start.gameStartInfo.players.map((p) => p.teamIndex).sort(),
      [0, 0, 1, 1],
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.ok(connections[0].messages.some((m) => m.type === "turn"));
  const pool = await api(`/rooms/${room!.id}/pool`, participants[0].token);
  assert.equal(pool.state, "playing");
  assert.equal(pool.participants.length, 4);
  assert.equal(pool.feeBps, 100);
  assert.equal(pool.poolLamports, 1_000_000_000);
  const lobbyList = await api("/rooms");
  assert.ok(!lobbyList.some((r: { id: string }) => r.id === room!.id));
  const globalPool = await api(
    `/rooms/${globalRoom.id}/pool`,
    participants[5].token,
  );
  assert.equal(globalPool.participants.length, 2);
  assert.equal(globalPool.poolLamports - globalPool.feeLamports, 495_000_000);
  const lockedRoom = await api(`/rooms/${globalRoom.id}`);
  assert.equal(lockedRoom.prizeLamports, 495_000_000);
  assert.equal(lockedRoom.readyCount, 2);
  assert.ok(lockedRoom.locked);
  for (const c of globalConnections) {
    const start = c.messages.find((m) => m.type === "start");
    assert.ok(start && start.type === "start");
    assert.equal(start.gameStartInfo.players.length, 2);
  }
  const replacement = lobbyList.find(
    (r: { queueKey: string }) => r.queueKey === globalRoom.queueKey,
  );
  assert.ok(replacement && replacement.id !== globalRoom.id);
  assert.equal(replacement.prizeLamports, 0);
  const lateJoin = await fetch(
    `${origin}/frontpot/api/rooms/${globalRoom.id}/join`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${participants[4].token}`,
      },
      body: "{}",
    },
  );
  assert.equal(lateJoin.status, 400);
  await api(`/rooms/${globalRoom.id}/leave`, participants[5].token, {});
  const afterLeave = await api(`/rooms/${globalRoom.id}`);
  assert.equal(afterLeave.prizeLamports, 495_000_000);
  assert.equal(afterLeave.readyCount, 2);
  assert.equal(afterLeave.members.length, 2);
  if (process.env.DEMO_TEST_ADMIN === "1") {
    const adminToken = participants[0].token;
    let admin = await api("/admin", adminToken);
    admin = await api("/admin/operations/deployment", adminToken, {
      enabled: true,
      revision: admin.operations.control.revision,
      reason: "Local active-game drain regression",
    });
    assert.equal(admin.operations.deployment.enabled, true);
    assert.equal(admin.operations.deployment.ready, false);
    assert.equal(admin.operations.deployment.activeGames, 2);
    assert.equal(admin.operations.deployment.waitingLobbies, 0);
    assert.equal((await api("/availability")).draining, true);
    assert.equal(
      (await api("/rooms")).filter(
        (r: { queuePosition?: number; status: string }) =>
          ["waiting", "countdown"].includes(r.status),
      ).length,
      0,
    );
    const activeConnection = connections.find(
      (c) => c !== outsider && !globalConnections.includes(c),
    )!;
    const turns = activeConnection.messages.filter(
      (m) => m.type === "turn",
    ).length;
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(
      activeConnection.messages.filter((m) => m.type === "turn").length > turns,
      "Draining must not interrupt a running game",
    );
    assert.equal(
      (await api(`/rooms/${room!.id}`, adminToken)).status,
      "playing",
    );
    admin = await api("/admin/operations/deployment", adminToken, {
      enabled: false,
      revision: admin.operations.control.revision,
      reason: "Drain regression complete",
    });
    assert.equal(admin.operations.control.paused, true);
    assert.equal(admin.rooms.length, 6);
    await api("/admin/operations/admissions", adminToken, {
      paused: false,
      revision: admin.operations.control.revision,
      reason: "Reopen after regression",
    });
    assert.equal((await api("/availability")).entriesPaused, false);
    console.log(
      "PASS: deployment preparation closes waiting lobbies, preserves live game turns, reports blockers, and reopens explicitly",
    );
  }
  console.log(
    "PASS: global two-minute queue, automatic replacement, exact net prize, late-entry rejection, immutable prize after leave; real WebSocket admission, 4-player readiness, balanced 2v2 teams, start delivery, turn relay, and private-room visibility.",
  );
} finally {
  for (const c of connections) c.ws.close();
  if (room)
    for (const p of participants)
      await api(`/rooms/${room.id}/leave`, p.token, {}).catch(() => {});
}
