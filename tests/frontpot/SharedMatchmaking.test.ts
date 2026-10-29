import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { advanceLobby } from "../../src/frontpot/LobbyLifecycle";
import { Parties } from "../../src/frontpot/Parties";
import { Rankings } from "../../src/frontpot/Rankings";
import { defaultRules } from "../../src/frontpot/Rules";
import { SharedMatchmaking } from "../../src/frontpot/SharedMatchmaking";
import { LobbyStore, type Identity } from "../../src/frontpot/Store";
const dbs: DatabaseSync[] = [];
afterEach(() => dbs.splice(0).forEach((db) => db.close()));
function fixture() {
  let now = Date.now();
  const store = new LobbyStore(() => now);
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  const ranks = new Rankings(db);
  const queue = new SharedMatchmaking(store, ranks, "simulation", () => now);
  const players = Array.from({ length: 8 }, (_, i) =>
    store.identity(`Player ${i}`),
  );
  const start = (
    i: number,
    mode: "1v1" | "2v2" = "1v1",
    members: Identity[] = [players[i]],
    budget = "0.1",
  ) => queue.start(players[i], { mode, ranked: true, budget }, members);
  const accept = (i: number) => {
    const s = queue.status(players[i])!;
    return queue.accept(
      players[i],
      s.id,
      s.offer!.id,
      () => {},
      () => {},
    );
  };
  const rate = (i: number, rating: number) =>
    db
      .prepare("INSERT OR REPLACE INTO ranked_ratings VALUES(?,?,?,?,?)")
      .run("simulation", "2v2", players[i].id, rating, 20);
  return {
    store,
    db,
    ranks,
    queue,
    players,
    start,
    accept,
    rate,
    advance: (ms: number) => (now += ms),
    now: () => now,
  };
}
it("only offers a complete 1v1 and requires both accepts, with an idempotent retry", () => {
  const f = fixture();
  expect(f.start(0)?.offer).toBeNull();
  f.start(1);
  const a = f.queue.status(f.players[0])!,
    b = f.queue.status(f.players[1])!;
  expect(a.offer?.id).toBe(b.offer?.id);
  expect(f.accept(0)).toBeNull();
  expect(f.store.rooms.size).toBe(0);
  const room = f.accept(1)!;
  expect(room.members).toHaveLength(2);
  expect(
    f.queue.accept(
      f.players[0],
      a.id,
      a.offer!.id,
      () => {},
      () => {},
    ),
  ).toBe(room);
  expect(f.store.rooms.size).toBe(1);
  expect(() => f.store.join(f.players[2], room.id)).toThrow();
});
it("uses exact entry and never mixes free play, modes or incompatible ratings", () => {
  const f = fixture();
  f.start(0);
  f.start(1, "1v1", undefined, "0.25");
  f.queue.start(f.players[2], { mode: "1v1", ranked: false, budget: "0" });
  f.start(3, "2v2");
  expect(f.queue.status(f.players[0])?.offer).toBeNull();
  expect(() =>
    f.queue.start(f.players[0], { mode: "1v1", ranked: true, budget: "0.5" }),
  ).toThrow();
  expect(() =>
    f.queue.start(f.players[4], { mode: "ffa", ranked: true, budget: "0.1" }),
  ).toThrow();
});
it("times out one shared offer, resumes accepted searchers and rejects stale acceptance", () => {
  const f = fixture();
  f.start(0);
  f.start(1);
  const old = f.queue.status(f.players[0])!;
  f.accept(0);
  f.advance(30_001);
  expect(f.queue.status(f.players[0])?.offer).toBeNull();
  expect(f.queue.status(f.players[1])).toBeNull();
  f.start(2);
  const fresh = f.queue.status(f.players[0])!;
  expect(fresh.offer!.id).not.toBe(old.offer!.id);
  expect(() =>
    f.queue.accept(
      f.players[0],
      old.id,
      old.offer!.id,
      () => {},
      () => {},
    ),
  ).toThrow();
  expect(f.queue.status(f.players[0])!.offer!.id).toBe(fresh.offer!.id);
});
it("keeps wide-gap duos together and matches opponents to their strongest player", () => {
  const f = fixture();
  [600, 1900, 1880, 1000, 650, 700, 1000, 1050].forEach((r, i) => f.rate(i, r));
  f.start(0, "2v2", f.players.slice(0, 2));
  f.start(4, "2v2", f.players.slice(4, 6));
  expect(f.queue.status(f.players[0])?.offer).toBeNull();
  f.start(2, "2v2", f.players.slice(2, 4));
  const offer = f.queue.status(f.players[0])!.offer!;
  expect(offer.players).toHaveLength(4);
  for (const i of [0, 1, 2]) expect(f.accept(i)).toBeNull();
  const room = f.accept(3)!;
  expect(room.members.find((m) => m.id === f.players[0].id)?.team).toBe(
    room.members.find((m) => m.id === f.players[1].id)?.team,
  );
  expect(room.parties).toHaveLength(2);
  expect(() => f.store.selectTeam(f.players[0], room.id, 1)).toThrow();
});
it("assigns four solo players balanced teams and never substitutes after offer", () => {
  const f = fixture();
  [1050, 1100, 1150, 1200].forEach((r, i) => f.rate(i, r));
  for (let i = 0; i < 4; i++) f.start(i, "2v2");
  const offer = f.queue.status(f.players[0])!.offer!;
  const team = (i: number) =>
    offer.players.find((p) => p.id === f.players[i].id)!.team;
  expect(team(0)).toBe(team(3));
  expect(team(1)).toBe(team(2));
  expect(team(0)).not.toBe(team(1));
  f.accept(0);
  f.queue.cancel(f.players[3]);
  expect(f.queue.status(f.players[0])?.offer).toBeNull();
  expect(f.store.rooms.size).toBe(0);
});
it("protects solo teammates from a wide-gap premade's lower rating", () => {
  const f = fixture();
  [500, 1900, 700, 750].forEach((r, i) => f.rate(i, r));
  f.start(0, "2v2", f.players.slice(0, 2));
  f.start(2, "2v2");
  f.start(3, "2v2");
  f.advance(180_000);
  expect(f.queue.status(f.players[0])?.offer).toBeNull();
});
it("requires both party members ready on the same settings revision", () => {
  const f = fixture(),
    parties = new Parties(f.store, (p) => f.queue.cancel(p), f.now);
  const p = parties.create(f.players[0])!;
  parties.join(f.players[1], p.code);
  let calls = 0;
  const start = (
    members: Identity[],
    s: { ranked: boolean; budget: string },
  ) => {
    calls++;
    f.queue.start(members[0], { mode: "2v2", ...s }, members);
  };
  let party = parties.view(f.players[0])!;
  parties.ready(f.players[0], party.revision, true, start);
  expect(calls).toBe(0);
  party = parties.configure(
    f.players[0],
    { ranked: true, budget: "0.25" },
    party.revision,
  )!;
  expect(party.readyIDs).toEqual([]);
  expect(() =>
    parties.ready(f.players[1], party.revision - 1, true, start),
  ).toThrow();
  parties.ready(f.players[1], party.revision, true, start);
  expect(calls).toBe(0);
  parties.ready(f.players[0], party.revision, true, start);
  expect(calls).toBe(1);
  expect(f.queue.status(f.players[1])?.budgetLamports).toBe(250_000_000);
});
it("does not start a matched room unless everyone connects and funds; expires once", () => {
  const f = fixture();
  f.start(0);
  f.start(1);
  f.accept(0);
  const room = f.accept(1)!;
  const ids = room.members.map((m) => m.id);
  let locks = 0;
  const lock = () => {
    locks++;
    return { poolLamports: 200_000_000, feeLamports: 2_000_000 };
  };
  expect(advanceLobby(room, ids, f.now(), lock, [ids[0]])).toBe("countdown");
  f.advance(120_001);
  expect(advanceLobby(room, ids, f.now(), lock, [ids[0]])).toBe("expired");
  expect(locks).toBe(0);
});
it("blocks queued players from direct lobby joins and rolls back failed preparation", () => {
  const f = fixture();
  const room = f.store.create(f.players[7], {
    mode: "1v1",
    ranked: true,
    stake: "0.1",
  });
  f.start(0);
  expect(() => f.store.join(f.players[0], room.id)).toThrow(
    /Cancel matchmaking/,
  );
  f.start(1);
  f.accept(0);
  const status = f.queue.status(f.players[1])!;
  expect(() =>
    f.queue.accept(
      f.players[1],
      status.id,
      status.offer!.id,
      () => {},
      () => {
        throw new Error("prepare failed");
      },
    ),
  ).toThrow("prepare failed");
  expect(f.store.rooms.size).toBe(1);
});
it("starts a full funded roster and cancels preparation if an accepted player leaves", () => {
  const f = fixture();
  f.start(0);
  f.start(1);
  f.accept(0);
  const room = f.accept(1)!;
  f.store.leave(f.players[0], room.id);
  let locked = false;
  expect(
    advanceLobby(
      room,
      [f.players[1].id],
      f.now(),
      () => {
        locked = true;
        return { poolLamports: 1, feeLamports: 0 };
      },
      [f.players[1].id],
    ),
  ).toBe("expired");
  expect(locked).toBe(false);
  expect(() => f.store.join(f.players[2], room.id)).toThrow();
  const g = fixture();
  g.start(0);
  g.start(1);
  g.accept(0);
  const full = g.accept(1)!;
  const ids = full.members.map((m) => m.id);
  expect(
    advanceLobby(
      full,
      ids,
      g.now(),
      () => ({ poolLamports: 200_000_000, feeLamports: 2_000_000 }),
      ids,
    ),
  ).toBe("locked");
  expect(full.locked?.entrants).toBe(2);
});
it("free 2v2 uses the same all-player acceptance without a SOL entry", () => {
  const f = fixture();
  for (let i = 0; i < 4; i++)
    f.queue.start(f.players[i], { mode: "2v2", ranked: false, budget: "0" });
  for (let i = 0; i < 3; i++) expect(f.accept(i)).toBeNull();
  const room = f.accept(3)!;
  expect(room.lamports).toBe(0);
  expect(room.ranked).toBe(false);
  expect(room.members).toHaveLength(4);
});

it("hides neutral empty ranked lobbies and blocks direct joining until matchmaking forms a roster", () => {
  const f = fixture();
  const room = f.store.createQueue("ranked-duel", "1v1", "0.1", defaultRules());
  expect(f.queue.visibleTo(room, f.players[0])).toBe(false);
  expect(f.queue.visibleTo(room, null)).toBe(false);
  expect(() => f.store.join(f.players[1], room.id)).toThrow("Use matchmaking");
});

it("filters occupied ranked lobbies and rejects an out-of-range direct join", () => {
  const f = fixture();
  f.rate(0, 1950);
  f.rate(1, 650);
  f.rate(2, 1900);
  const room = f.store.create(f.players[0], { mode: "2v2", ranked: true, stake: "0.1" });
  expect(f.queue.visibleTo(room, f.players[1])).toBe(false);
  expect(() => f.store.join(f.players[1], room.id)).toThrow("skill range");
  expect(f.queue.visibleTo(room, f.players[2])).toBe(true);
  expect(f.store.join(f.players[2], room.id).id).toBe(room.id);
});
