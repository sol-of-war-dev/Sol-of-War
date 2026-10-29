import type { ReplayedWinner } from "@openfront/engine/WinnerReplay";
import type { PartialGameRecord } from "@openfront/shared/WireSchemas";
import express from "express";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MatchLedger } from "../../src/frontpot/MatchLedger";
import { AuthError, PlayerAuth } from "../../src/frontpot/PlayerAuth";
import {
  Profiles,
  profileProgress,
  registerProfileRoutes,
} from "../../src/frontpot/Profiles";
import { defaultProfileSettings } from "../../src/frontpot/ProfileTypes";
import { LobbyStore } from "../../src/frontpot/Store";

const ledgers: MatchLedger[] = [],
  servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const ledger of ledgers.splice(0)) ledger.close();
  vi.useRealTimers();
});
function fixture(network: "simulation" | "mainnet" = "simulation") {
  const ledger = new MatchLedger(":memory:", network);
  ledgers.push(ledger);
  const auth = new PlayerAuth(ledger.db),
    store = new LobbyStore();
  const players = ["Alice", "Bobby", "Carol", "David"].map((name, i) => {
    const session = auth.signIn({
      subject: `did:privy:fixture-${i}`,
      wallet: `private-wallet-${i}`,
      expires: Date.now() + 3600_000,
    });
    return auth.claimUsername(session.token, name);
  });
  const profiles = new Profiles(ledger, auth, network);
  function match(
    mode: "1v1" | "2v2" = "1v1",
    winner = 0,
    practice = false,
    ranked = true,
  ) {
    const room = store.create(players[0], {
      mode: practice ? "ffa" : mode,
      stake: ranked ? "0.25" : "0",
      ranked,
      practice,
    });
    const count = practice ? 1 : mode === "2v2" ? 4 : 2;
    for (let i = 1; i < count; i++) store.join(players[i], room.id);
    ledger.lock(room, room.members);
    const record = {
      info: {
        gameID: room.id,
        players: room.members.map((m, i) => ({
          clientID: `client-${i}`,
          persistentID: m.id,
        })),
      },
      turns: [],
    } as unknown as PartialGameRecord;
    ledger.verifying(room.id);
    const result = {
      winner:
        mode === "2v2"
          ? ["team", "Red", "client-0"]
          : ["player", `client-${winner}`],
      tick: 100,
      allPlayersStats: {},
    } as ReplayedWinner;
    ledger.settle(record, result);
    room.status = "finished";
    return room;
  }
  const input = (username = "NewAlice") => ({
    username,
    icon: "crown",
    color: "violet",
    bio: "Map enthusiast",
    showStats: true,
    showLevel: true,
    revision: 0,
  });
  return { ledger, auth, store, players, profiles, match, input };
}
describe("SolSiege player profiles", () => {
  it("limits visitors to stats and ranks while preserving the owner's full profile", () => {
    const f = fixture();
    f.match();
    const player = f.players[0];
    const own = f.profiles.view(player.id, player.id);
    expect(own.settings).toBeDefined();
    expect(own.finances).toBeDefined();
    expect(own.progress).not.toBeNull();
    expect(own.games).toHaveLength(1);
    for (const viewer of [undefined, f.players[1].id]) {
      const publicView = f.profiles.view(player.id, viewer);
      expect(publicView.stats).toEqual(own.stats);
      expect(publicView.rankedRatings).toEqual(own.rankedRatings);
      expect(publicView.games).toEqual([]);
      expect(publicView.progress).toBeNull();
      expect(publicView.legacyProgress).toBeUndefined();
      expect(publicView.settings).toBeUndefined();
      expect(publicView.finances).toBeUndefined();
    }
  });

  it("returns verified XP breakdowns only for eligible participants", () => {
    const f = fixture();
    const room = f.match("1v1", 0, false, false);
    const pool = f.ledger.get(room.id)!;
    expect(f.profiles.xpResult(pool, f.players[0].id)).toEqual({
      played: 100,
      win: 150,
      total: 250,
    });
    expect(f.profiles.xpResult(pool, f.players[1].id)).toEqual({
      played: 100,
      win: 0,
      total: 100,
    });
    expect(f.profiles.xpResult(pool, f.players[2].id)).toBeNull();
    expect(f.profiles.xpResult(pool, "guest:test")).toBeNull();
    expect(
      f.profiles.xpResult({ ...pool, state: "review" }, f.players[0].id),
    ).toBeNull();
    expect(
      f.profiles.xpResult({ ...pool, ranked: true }, f.players[0].id),
    ).toBeNull();
    expect(
      f.profiles.xpResult({ ...pool, practice: true }, f.players[0].id),
    ).toBeNull();
  });
  it("lobby badges match unranked profile progress and ignore ranked XP", () => {
    vi.useFakeTimers();
    const f = fixture();
    f.match("1v1", 0, false, true);
    expect(f.profiles.badge(f.players[0].id)?.level).toBe(1);
    for (let i = 0; i < 3; i++) f.match("1v1", 0, false, false);
    vi.advanceTimersByTime(3001);
    const progress = f.profiles.view(
      f.players[0].id,
      f.players[0].id,
    ).progress!;
    expect(f.profiles.badge(f.players[0].id)).toEqual({
      level: progress.level,
      prestige: progress.prestige,
      legend: progress.legend,
    });
    expect(progress.level).toBeGreaterThan(1);
  });

  it("renames the authenticated player without changing their identity, wallet or history", () => {
    const f = fixture(),
      player = f.players[0];
    f.match();
    const result = f.profiles.update(player.token, f.input());
    expect(result.identity).toMatchObject({
      id: player.id,
      token: player.token,
      wallet: player.wallet,
      name: "NewAlice",
      icon: "crown",
      color: "violet",
    });
    expect(result.profile.stats).toMatchObject({ games: 1, wins: 1 });
    const restarted = new PlayerAuth(f.ledger.db);
    expect(restarted.auth(player.token).name).toBe("NewAlice");
    expect(
      new Profiles(f.ledger, restarted, "simulation").view(player.id).bio,
    ).toBe("Map enthusiast");
    expect(f.ledger.history(player.id)[0].participants[0].name).toBe("Alice");
  });
  it("reserves names case-insensitively and rolls back every setting on conflict", () => {
    const f = fixture(),
      player = f.players[0];
    expect(() => f.profiles.update(player.token, f.input("bObBy"))).toThrow(
      "taken",
    );
    expect(f.auth.auth(player.token).name).toBe("Alice");
    expect(f.profiles.settings(player.id)).toEqual(defaultProfileSettings());
    const saved = f.profiles.update(player.token, f.input("ALICE"));
    expect(saved.profile.name).toBe("ALICE");
    expect(() => f.profiles.update(player.token, f.input("StaleSave"))).toThrow(
      "another window",
    );
    expect(f.auth.auth(player.token).name).toBe("ALICE");
  });
  it("rejects injected identity, XP, rank and arbitrary icons, and bounds biography text", () => {
    const f = fixture(),
      token = f.players[0].token;
    for (const change of [
      { id: f.players[1].id },
      { lifetimeXp: 999999 },
      { prestige: 10 },
      { icon: "https://tracker.test/pixel" },
      { color: "red;display:none" },
      { bio: "a".repeat(161) },
      { username: "<script>" },
    ]) {
      expect(() =>
        f.profiles.update(token, { ...f.input(), ...change }),
      ).toThrow();
    }
    expect(() => f.profiles.update("wrong-token", f.input())).toThrow(
      "Sign in",
    );
    expect(f.auth.auth(f.players[1].token).name).toBe("Bobby");
  });
  it("never exposes wallet, subject, token, payment amounts or private room IDs publicly", () => {
    const f = fixture(),
      room = f.match(),
      player = f.players[0];
    const publicView = f.profiles.view(player.id, f.players[1].id);
    expect(publicView.own).toBe(false);
    expect(publicView.settings).toBeUndefined();
    expect(publicView.finances).toBeUndefined();
    for (const hidden of [
      player.wallet,
      player.subject,
      player.token,
      room.id,
      "entryLamports",
      "payoutLamports",
      "paymentState",
    ])
      expect(JSON.stringify(publicView)).not.toContain(hidden);
    expect(publicView.stats?.wins).toBe(1);
    f.profiles.update(player.token, {
      ...f.input(),
      showStats: false,
      showLevel: false,
    });
    expect(f.profiles.view(player.id)).toMatchObject({
      stats: null,
      progress: null,
      games: [],
    });
    expect(f.profiles.view(player.id, player.id).stats?.wins).toBe(1);
    expect(f.profiles.badge(player.id)).toBeUndefined();
  });
  it("derives results exactly once and credits both winning 2v2 teammates", () => {
    const f = fixture();
    f.match("2v2", 0, false, false);
    const winners = [f.players[0], f.players[2]],
      losers = [f.players[1], f.players[3]];
    for (const player of winners)
      expect(f.profiles.view(player.id, player.id)).toMatchObject({
        stats: { games: 1, wins: 1 },
        progress: { lifetimeXp: 250 },
      });
    for (const player of losers)
      expect(f.profiles.view(player.id, player.id)).toMatchObject({
        stats: { games: 1, losses: 1 },
        progress: { lifetimeXp: 100 },
      });
    for (let i = 0; i < 5; i++)
      expect(
        new Profiles(f.ledger, f.auth, "simulation").view(
          f.players[0].id,
          f.players[0].id,
        ).progress?.lifetimeXp,
      ).toBe(250);
  });
  it("excludes practice, unverified, cancelled and other-network games from XP and wins", () => {
    const f = fixture();
    f.match("1v1", 0, true);
    const reviewed = f.match();
    const p = f.ledger.get(reviewed.id)!;
    p.verificationHash = undefined;
    p.state = "review";
    f.ledger.db
      .prepare("UPDATE pools SET body=? WHERE id=?")
      .run(JSON.stringify(p), p.matchID);
    const refunded = f.match();
    const r = f.ledger.get(refunded.id)!;
    r.state = "refunded";
    f.ledger.db
      .prepare("UPDATE pools SET body=? WHERE id=?")
      .run(JSON.stringify(r), r.matchID);
    const other = f.match();
    const o = f.ledger.get(other.id)!;
    o.network = "devnet";
    f.ledger.db
      .prepare("UPDATE pools SET body=? WHERE id=?")
      .run(JSON.stringify(o), o.matchID);
    expect(f.profiles.view(f.players[0].id, f.players[0].id)).toMatchObject({
      stats: { games: 0, wins: 0 },
      progress: { lifetimeXp: 0 },
    });
  });
  it("separates verified prizes awaiting payment from finalized prizes", () => {
    const f = fixture("mainnet"),
      room = f.match(),
      id = f.players[0].id;
    expect(f.profiles.view(id, id)).toMatchObject({
      stats: { wins: 1 },
      finances: {
        wageredLamports: "250000000",
        paidLamports: "0",
        pendingLamports: "495000000",
      },
    });
    f.ledger.confirmPayment(room.id, "settled", "fixture-finalized-signature");
    expect(
      new Profiles(f.ledger, f.auth, "mainnet").view(id, id).finances,
    ).toMatchObject({ paidLamports: "495000000", pendingLamports: "0" });
  });
  it("computes streaks and levels from results and preserves lifetime XP through prestige", () => {
    const f = fixture();
    vi.useFakeTimers();
    f.match();
    vi.advanceTimersByTime(1000);
    f.match("1v1", 1);
    vi.advanceTimersByTime(1000);
    f.match();
    vi.advanceTimersByTime(1000);
    f.match();
    expect(
      f.profiles.view(f.players[0].id, f.players[0].id).stats,
    ).toMatchObject({
      games: 4,
      wins: 3,
      losses: 1,
      winRate: 75,
      streak: 2,
      bestStreak: 2,
    });
    expect(profileProgress(0, defaultProfileSettings())).toMatchObject({
      level: 1,
      xpInLevel: 0,
      xpForNext: 100,
    });
    expect(profileProgress(250, defaultProfileSettings())).toMatchObject({
      level: 2,
      xpInLevel: 150,
      xpForNext: 300,
    });
    expect(profileProgress(980100, defaultProfileSettings())).toMatchObject({
      level: 100,
      canPrestige: true,
    });
    expect(
      profileProgress(980350, { prestige: 1, prestigeXp: 980100 }),
    ).toMatchObject({ level: 2, lifetimeXp: 980350, prestige: 1 });
    expect(
      profileProgress(980100, { prestige: 10, prestigeXp: 0 }),
    ).toMatchObject({ legend: true, canPrestige: false });
    expect(() => f.profiles.prestige(f.players[0].token, 0)).toThrow(
      "level 100",
    );
  });
  it("persists an earned prestige without losing lifetime XP or awarding it twice", () => {
    const f = fixture(),
      room = f.match("1v1", 0, false, false),
      player = f.players[0];
    const template = f.ledger.get(room.id)!;
    const insert = f.ledger.db.prepare(
      "INSERT INTO pools(id,body) VALUES(?,?)",
    );
    f.ledger.db.exec("BEGIN");
    for (let i = 1; i < 3921; i++) {
      const id = `earned-match-${i}`;
      insert.run(
        id,
        JSON.stringify({
          ...template,
          matchID: id,
          created: template.created + i,
        }),
      );
    }
    f.ledger.db.exec("COMMIT");
    expect(f.profiles.view(player.id, player.id).progress).toMatchObject({
      level: 100,
      canPrestige: true,
      lifetimeXp: 980250,
    });
    expect(f.profiles.prestige(player.token, 0).progress).toMatchObject({
      level: 1,
      prestige: 1,
      lifetimeXp: 980250,
      xpInLevel: 0,
    });
    expect(() => f.profiles.prestige(player.token, 0)).toThrow("changed");
    expect(() => f.profiles.prestige(player.token, 1)).toThrow("level 100");
    expect(
      new Profiles(f.ledger, f.auth, "simulation").view(player.id, player.id)
        .progress,
    ).toMatchObject({ level: 1, prestige: 1, lifetimeXp: 980250 });
  });
  it("enforces ownership and active-match edit protection through the HTTP routes", async () => {
    const f = fixture(),
      player = f.players[0],
      app = express();
    app.use(express.json());
    registerProfileRoutes(app, f.profiles, f.auth, f.store);
    app.use(
      (
        e: Error,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) =>
        res
          .status(e instanceof AuthError ? e.status : 500)
          .json({ error: e.message }),
    );
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/frontpot/api`;
    const post = (body: unknown, token = player.token) =>
      fetch(`${base}/profile/settings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
    expect((await fetch(`${base}/profile`)).status).toBe(401);
    expect((await fetch(`${base}/players/nonexistent`)).status).toBe(404);
    expect(
      await (
        await fetch(`${base}/players/${player.id}`, {
          headers: { Authorization: "Bearer forged" },
        })
      ).json(),
    ).toMatchObject({ own: false });
    expect((await post(f.input(), "fake")).status).toBe(401);
    const room = f.store.create(player, { mode: "1v1", stake: "0.25" });
    expect((await post(f.input())).status).toBe(409);
    expect(f.auth.auth(player.token).name).toBe("Alice");
    room.status = "finished";
    expect((await post(f.input())).status).toBe(200);
    const updated = f.auth.auth(player.token),
      next = f.store.create(updated, { mode: "1v1", stake: "0.25" });
    expect(f.store.publicRoom(next).members[0]).toMatchObject({
      name: "NewAlice",
      icon: "crown",
      color: "violet",
    });
  });
});

it("keeps ranked performance out of unranked XP while exposing per-mode ratings", () => {
  const f = fixture();
  f.match();
  const profile = f.profiles.view(f.players[0].id, f.players[0].id);
  expect(profile.progress?.lifetimeXp).toBe(0);
  expect(profile.legacyProgress?.lifetimeXp).toBe(250);
  expect(profile.rankedRatings?.find((r) => r.mode === "1v1")).toMatchObject({
    rating: 1024,
    games: 1,
  });
  expect(profile.games[0].ratingChange).toMatchObject({ delta: 24, place: 1 });
});
