import express from "express";
import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { registerAdminRoutes } from "../../src/frontpot/AdminRoutes";
import { AdminStats } from "../../src/frontpot/AdminStats";
import { GlobalQueue } from "../../src/frontpot/GlobalQueue";
import { LiveMonitoring } from "../../src/frontpot/LiveMonitoring";
import { MatchLedger } from "../../src/frontpot/MatchLedger";
import { Operations } from "../../src/frontpot/Operations";
import { PlayerAuth, AuthError } from "../../src/frontpot/PlayerAuth";
import { defaultQueueSettings } from "../../src/frontpot/QueueSettings";
import { LobbyStore } from "../../src/frontpot/Store";

const databases: DatabaseSync[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const db of databases.splice(0)) db.close();
});
const adminWallet = "CVT7yhhxz1bY1o6ZeL3U7eWNpTppbzdAjv89iDCm8oZM";
function fixture() {
  const db = new MatchLedger(":memory:").db;
  databases.push(db);
  const store = new LobbyStore();
  db.exec(
    "CREATE TABLE queue_settings(id INTEGER PRIMARY KEY,settings TEXT,template_cursor INTEGER,map_cursor INTEGER,revision INTEGER)",
  );
  db.prepare("INSERT INTO queue_settings VALUES(1,?,0,0,0)").run(
    JSON.stringify({ ...defaultQueueSettings(), variety: false }),
  );
  const queue = new GlobalQueue(store, db);
  queue.replenish();
  return { db, store, queue };
}
describe("queue administration", () => {
  it("persists generation settings and cursors without rewriting queued terms", () => {
    const { db, store, queue } = fixture();
    const original = queue.pending(true, "ffa").map((r) => JSON.stringify(r));
    const settings = { ...defaultQueueSettings(), variety: false };
    settings.templates = [
      {
        ...settings.templates[0],
        stake: "0.05",
        maxPlayers: 25,
        minPlayers: 5,
        minutes: 12,
      },
    ];
    settings.targetSize = 7;
    queue.saveSettings(settings, 0, adminWallet);
    expect(
      queue
        .pending(true, "ffa")
        .slice(0, 3)
        .map((r) => JSON.stringify(r)),
    ).toEqual(original);
    expect(queue.pending(true, "ffa")[3]).toMatchObject({
      stake: "0.05",
      minPlayers: 5,
      rules: { maxPlayers: 25, maxTimerValue: 12 },
    });
    const restored = new GlobalQueue(new LobbyStore(), db);
    expect(restored.snapshot().settings).toEqual(settings);
    expect(restored.snapshot().revision).toBe(1);
    expect(() => restored.saveSettings(settings, 0, adminWallet)).toThrow(
      "another window",
    );
    expect(
      db.prepare("SELECT COUNT(*) as n FROM queue_admin_audit").get()!.n,
    ).toBe(1);
  });
  it("appends manual matches, edits empty matches and prevents rewriting joined or locked matches", () => {
    const { store, queue } = fixture();
    const template = {
      ...defaultQueueSettings().templates[0],
      stake: "0.02",
      maxPlayers: 20,
    };
    const added = queue.enqueue(template, adminWallet);
    expect(added.queuePosition).toBe(3);
    expect(added.startsAt).toBeNull();
    queue.edit(added.id, { ...template, stake: "0.03" }, adminWallet);
    expect(added.stake).toBe("0.03");
    const player = store.identity("AdminTest");
    store.join(player, added.id);
    expect(() => queue.edit(added.id, template, adminWallet)).toThrow(
      "player has joined",
    );
    expect(() => queue.remove(added.id, adminWallet)).toThrow(
      "player has joined",
    );
    store.leave(player, added.id);
    added.poolID = "terms-opened";
    expect(() => queue.edit(added.id, template, adminWallet)).toThrow(
      "player has joined",
    );
    added.status = "playing";
    expect(() => queue.edit(added.id, template, adminWallet)).toThrow(
      "already started",
    );
  });
  it("honors paused generation, preserves the head deadline and promotes after removal", () => {
    const { queue } = fixture();
    const settings = { ...defaultQueueSettings(), variety: false };
    settings.enabled = false;
    settings.targetSize = 2;
    const deadline = queue.pending(true, "ffa")[0].startsAt;
    queue.saveSettings(settings, 0, adminWallet);
    expect(queue.pending(true, "ffa")).toHaveLength(3);
    expect(queue.pending(true, "ffa")[0].startsAt).toBe(deadline);
    const second = queue.pending(true, "ffa")[1];
    queue.remove(queue.pending(true, "ffa")[0].id, adminWallet);
    expect(queue.pending(true, "ffa")).toHaveLength(2);
    expect(second.startsAt).not.toBeNull();
    expect(
      queue.pending(true, "ffa").filter((r) => r.startsAt !== null),
    ).toHaveLength(1);
  });
  it("rejects invalid maps, size, capacity, entry amounts and unbalanced team settings", () => {
    const { queue } = fixture();
    const valid = defaultQueueSettings().templates[0];
    for (const patch of [
      { map: "Fake" },
      { size: "Huge" },
      { stake: "0" },
      { stake: "9007199.254740992" },
      { stake: "0.00001" },
      { maxPlayers: 101 },
      { minPlayers: 50, maxPlayers: 20 },
      { mode: "2v2", minPlayers: 2, maxPlayers: 4 },
      { mode: "1v1", minPlayers: 2, maxPlayers: 8 },
    ])
      expect(() => queue.enqueue({ ...valid, ...patch }, adminWallet)).toThrow(
        "valid match",
      );
    expect(queue.pending(true, "ffa")).toHaveLength(3);
  });
  it("rejects unfundable manual, edited and generated entries without mutating queue settings", () => {
    const db = new MatchLedger(":memory:").db;
    databases.push(db);
    const store = new LobbyStore(Date.now, 1_000_000);
    db.exec(
      "CREATE TABLE queue_settings(id INTEGER PRIMARY KEY,settings TEXT,template_cursor INTEGER,map_cursor INTEGER,revision INTEGER)",
    );
    db.prepare("INSERT INTO queue_settings VALUES(1,?,0,0,0)").run(
      JSON.stringify({ ...defaultQueueSettings(), variety: false }),
    );
    const queue = new GlobalQueue(store, db);
    queue.replenish();
    const before = queue.snapshot();
    const template = {
      ...defaultQueueSettings().templates[0],
      stake: "0.000999999",
    };
    expect(() => queue.enqueue(template, adminWallet)).toThrow();
    expect(() =>
      queue.edit(queue.pending(true, "ffa")[1].id, template, adminWallet),
    ).toThrow();
    const settings = { ...defaultQueueSettings(), variety: false };
    settings.templates[0] = template;
    expect(() => queue.saveSettings(settings, 0, adminWallet)).toThrow();
    expect(queue.snapshot().settings).toEqual(before.settings);
    expect(queue.snapshot().revision).toBe(0);
    expect(queue.pending(true, "ffa").map((r) => r.stake)).toEqual(
      before.rooms
        .filter((r) => r.lamports > 0 && r.mode === "ffa")
        .map((r) => r.stake),
    );
    expect(
      db.prepare("SELECT COUNT(*) as n FROM queue_admin_audit").get()!.n,
    ).toBe(0);
    expect(queue.snapshot().minimumEntryLamports).toBe(1_000_000);
    const valid = queue.enqueue({ ...template, stake: "0.01" }, adminWallet);
    expect(valid.lamports).toBe(10_000_000);
    expect(() =>
      queue.enqueue({ ...template, stake: "1000" }, adminWallet),
    ).toThrow();
  });
  it("upgrades legacy queue stakes into the supported range", () => {
    const { db } = fixture();
    const settings = { ...defaultQueueSettings(), variety: false };
    settings.templates[0].stake = "0.0001";
    settings.templates[1].stake = "2";
    db.prepare("UPDATE queue_settings SET settings=? WHERE id=1").run(
      JSON.stringify(settings),
    );
    const upgraded = new GlobalQueue(
      new LobbyStore(Date.now, 1_000_000),
      db,
    ).snapshot().settings;
    expect(upgraded.templates[0].stake).toBe("0.01");
    expect(upgraded.templates[1].stake).toBe("1");
  });
  it("protects every route using the verified session wallet, never request fields", async () => {
    const { db, queue, store } = fixture();
    const auth = new PlayerAuth(db);
    const admin = auth.signIn({
      subject: "did:privy:admin",
      wallet: adminWallet,
      expires: Date.now() + 3600000,
    });
    auth.claimUsername(admin.token, "Admin");
    const outsider = auth.signIn({
      subject: "did:privy:other",
      wallet: "11111111111111111111111111111111",
      expires: Date.now() + 3600000,
    });
    auth.claimUsername(outsider.token, "Other");
    const app = express();
    app.use(express.json());
    const stats = new AdminStats(db, auth, store, () => []);
    const operations = new Operations(db, null);
    registerAdminRoutes(
      app,
      auth,
      queue,
      adminWallet,
      () => stats.snapshot(),
      operations,
      () => {},
      () =>
        new LiveMonitoring(() => ({
          connections: 7,
          connectionLimit: 150,
          rooms: [],
        })).snapshot(),
    );
    app.use(
      (
        err: Error,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) =>
        res
          .status(err instanceof AuthError ? err.status : 400)
          .json({ error: err.message }),
    );
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}/frontpot/api/admin`;
    const id = queue.pending(true, "ffa")[1].id;
    const liveResponse = await fetch(origin, {
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    expect((await liveResponse.json()).live.connections).toBe(7);
    for (const [suffix, method] of [
      ["", "GET"],
      ["/settings", "POST"],
      ["/matches", "POST"],
      [`/matches/${id}/edit`, "POST"],
      [`/matches/${id}/remove`, "POST"],
      ["/operations/admissions", "POST"],
      ["/operations/deployment", "POST"],
      ["/operations/payments/fake/check", "POST"],
      ["/operations/payments/fake/retry", "POST"],
    ]) {
      for (const [token, status] of [
        ["", 401],
        ["fake", 401],
        [outsider.token, 403],
      ] as const) {
        const response = await fetch(origin + suffix, {
          method,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          ...(method === "POST"
            ? { body: JSON.stringify({ wallet: adminWallet, isAdmin: true }) }
            : {}),
        });
        expect(response.status).toBe(status);
      }
    }
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${admin.token}`,
    };
    const overview = await fetch(origin, { headers });
    expect(overview.status).toBe(200);
    expect((await overview.json()).stats).toMatchObject({
      registeredPlayers: 2,
      paymentsMode: "simulation",
      allTime: { wageredLamports: "0" },
    });
    const paused = await fetch(origin + "/operations/admissions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        paused: true,
        revision: 0,
        reason: "Check service health",
        wallet: "spoofed",
      }),
    });
    expect(paused.status).toBe(200);
    expect((await paused.json()).operations.control).toMatchObject({
      paused: true,
      actor: adminWallet,
    });
    const created = await fetch(origin + "/matches", {
      method: "POST",
      headers,
      body: JSON.stringify(defaultQueueSettings().templates[0]),
    });
    expect(created.status).toBe(200);
    expect((await created.json()).rooms).toHaveLength(19);
    const drained = await fetch(origin + "/operations/deployment", {
      method: "POST",
      headers,
      body: JSON.stringify({
        enabled: true,
        revision: 1,
        reason: "Planned update",
        wallet: "spoofed",
      }),
    });
    expect(drained.status).toBe(200);
    expect((await drained.json()).operations.control).toMatchObject({
      draining: true,
      paused: true,
      actor: adminWallet,
    });
    auth.logout(admin.token);
    expect((await fetch(origin, { headers })).status).toBe(401);
  });
});
