// Local integration harness only. Fixtures are written to an isolated database,
// never exposed through an authentication bypass in the application server.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PlayerAuth } from "../src/frontpot/PlayerAuth";

const state = mkdtempSync(path.join(tmpdir(), "solsiege-network-test-"));
const db = new DatabaseSync(path.join(state, "matches.sqlite"));
const auth = new PlayerAuth(db);
function testWallet() {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const bytes = randomBytes(32);
  let value = BigInt(`0x${bytes.toString("hex")}`);
  let result = "";
  while (value) {
    result = alphabet[Number(value % 58n)] + result;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    result = `1${result}`;
  }
  return result;
}
const sessions = [
  "TestAlpha",
  "TestBravo",
  "TestCharlie",
  "TestDelta",
  "TestOutsider",
  "QueueAlpha",
  "QueueBravo",
].map((name) => {
  const session = auth.signIn({
    subject: `did:privy:test-${name}`,
    wallet: testWallet(),
    expires: Date.now() + 3600_000,
  });
  return auth.claimUsername(session.token, name);
});
db.close();
const sessionFile = path.join(state, "sessions.json");
writeFileSync(sessionFile, JSON.stringify(sessions), { mode: 0o600 });
const portFinder = createServer();
await new Promise<void>((resolve, reject) => {
  portFinder.on("error", reject);
  portFinder.listen(0, "127.0.0.1", resolve);
});
const port = (portFinder.address() as { port: number }).port;
await new Promise<void>((resolve) => portFinder.close(() => resolve()));
const origin = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  GAME_ENV: "dev",
  GIT_COMMIT: "DEV",
  HOST: "127.0.0.1",
  PORT: String(port),
  APP_ORIGIN: origin,
  FRONTPOT_STATE_DIR: state,
  PAYMENTS_MODE: "simulation",
  PRIVY_APP_ID: "",
  PRIVY_APP_SECRET: "",
  PRIVY_VERIFICATION_KEY: "",
  SOLSIEGE_ADMIN_WALLETS: sessions[0].wallet!,
};
const server = spawn(
  process.execPath,
  ["--import", "tsx", "src/frontpot/Server.ts"],
  { env, stdio: ["ignore", "ignore", "pipe"] },
);
let failure = "";
server.stderr?.on("data", (chunk) => {
  failure += String(chunk);
});
try {
  const deadline = Date.now() + 15_000;
  while (
    !(await fetch(`${origin}/healthz`)
      .then((r) => r.ok)
      .catch(() => false))
  ) {
    if (server.exitCode !== null || Date.now() > deadline)
      throw new Error(`Test server did not start: ${failure}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const api = async (route: string, player = 0, body?: unknown) =>
    fetch(`${origin}/frontpot/api${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sessions[player].token}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const created = await api("/rooms", 0, { mode: "1v1", stake: "0.25" });
  if (!created.ok)
    throw new Error("Admission fixture could not create a match");
  const room = await created.json();
  const snapshot = await (await api("/admin")).json();
  const paused = await api("/admin/operations/admissions", 0, {
    paused: true,
    revision: snapshot.operations.control.revision,
    reason: "Local admission regression",
  });
  if (!paused.ok) throw new Error("Admin could not pause admissions");
  if (
    (await api("/rooms", 1, { mode: "1v1", stake: "0.25" })).status !== 503 ||
    (await api(`/rooms/${room.id}/join`, 1, {})).status !== 503
  )
    throw new Error("Paused admissions accepted a new entry");
  if (!(await api(`/rooms/${room.id}/join`, 0, {})).ok)
    throw new Error("Pause prevented an existing member from rejoining");
  const practice = await api("/rooms", 1, { mode: "ffa", practice: true });
  if (!practice.ok) throw new Error("Pause incorrectly blocked practice");
  const practiceRoom = await practice.json();
  const resumed = await api("/admin/operations/admissions", 0, {
    paused: false,
    revision: snapshot.operations.control.revision + 1,
    reason: "Regression verified",
  });
  if (!resumed.ok) throw new Error("Admin could not resume admissions");
  await api(`/rooms/${room.id}/leave`, 0, {});
  await api(`/rooms/${practiceRoom.id}/leave`, 1, {});
  console.log(
    "PASS: pause blocks new entries, preserves existing members and practice, then resumes",
  );
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/testDemoNetwork.ts"],
    {
      env: {
        ...env,
        DEMO_TEST_ORIGIN: origin,
        DEMO_TEST_SESSION_FILE: sessionFile,
        DEMO_TEST_ADMIN: "1",
      },
      stdio: "inherit",
    },
  );
  const code = await new Promise((resolve) => child.on("exit", resolve));
  if (code !== 0) throw new Error("Authenticated multiplayer test failed");
} finally {
  server.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    if (server.exitCode !== null) resolve();
    else server.on("exit", () => resolve());
  });
  rmSync(state, { recursive: true, force: true });
}
