import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import type { Pool } from "../../src/frontpot/MatchLedger";
import { Rankings } from "../../src/frontpot/Rankings";
const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
function fixture() {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  return { db, ranks: new Rankings(db) };
}
function pool(id = "match", changes: Partial<Pool> = {}): Pool {
  return {
    matchID: id,
    poolID: id,
    mode: "1v1",
    ranked: true,
    practice: false,
    private: false,
    name: "Match",
    map: "World",
    network: "simulation",
    address: null,
    feeBps: 100,
    stakeLamports: 10000000,
    state: "settled",
    created: 1000,
    updated: 2000,
    reason: "verified",
    participants: [
      { id: "a", name: "A", team: 0 },
      { id: "b", name: "B", team: 1 },
    ],
    poolLamports: 20000000,
    feeLamports: 200000,
    payouts: [{ playerID: "a", lamports: 19800000 }],
    verificationHash: "trusted",
    ...changes,
  };
}
it("applies verified results once, persists across restarts, separates mode/network and ignores entry price", () => {
  const { db, ranks } = fixture();
  ranks.apply(pool());
  ranks.apply(pool());
  expect(ranks.get("simulation", "1v1", "a")).toMatchObject({
    rating: 1024,
    games: 1,
    provisional: true,
  });
  expect(new Rankings(db).get("simulation", "1v1", "b").rating).toBe(976);
  expect(ranks.get("mainnet", "1v1", "a").rating).toBe(1000);
  expect(ranks.get("simulation", "ffa", "a").rating).toBe(1000);
  const second = fixture();
  second.ranks.apply(pool("expensive", { stakeLamports: 1e9 }));
  expect(second.ranks.get("simulation", "1v1", "a").rating).toBe(1024);
});
it("does not rate private, free, unverified, practice, refunded or pending matches", () => {
  const { ranks } = fixture();
  for (const change of [
    { private: true },
    { ranked: false },
    { verificationHash: undefined },
    { practice: true },
    { state: "refunded" },
    { state: "payout_pending" },
  ] as Partial<Pool>[])
    ranks.apply(pool(JSON.stringify(change), change));
  expect(ranks.get("simulation", "1v1", "a").games).toBe(0);
});
it("keeps FFA wagers unrated even with verified placements", () => {
  const { ranks } = fixture();
  const p = pool("ffa", {
    mode: "ffa",
    ranked: false,
    placements: { a: 1, b: 2 },
  });
  ranks.apply(p);
  expect(ranks.get("simulation", "ffa", "a").rating).toBe(1000);
  expect(ranks.get("simulation", "ffa", "a").games).toBe(0);
  expect(ranks.result(p.matchID, "a")).toBeUndefined();
  expect(ranks.view("simulation", "a").map((r) => r.mode)).toEqual([
    "1v1",
    "2v2",
  ]);
});

it("reduces repeated opponents and excludes the fourth pairing in 24 hours", () => {
  const { ranks } = fixture();
  for (let i = 0; i < 3; i++) ranks.apply(pool(`m${i}`, { updated: 2000 + i }));
  const before = ranks.get("simulation", "1v1", "a");
  ranks.apply(pool("m4", { updated: 2004 }));
  expect(ranks.get("simulation", "1v1", "a")).toEqual(before);
  expect(ranks.result("m4", "a")?.counted).toBe(false);
  ranks.apply(pool("tomorrow", { updated: 86410000 }));
  expect(ranks.get("simulation", "1v1", "a").games).toBe(4);
});
it("uses team strength and awards both teammates without comparing allies", () => {
  const { ranks } = fixture();
  ranks.apply(
    pool("teams", {
      mode: "2v2",
      participants: [
        ...pool().participants,
        { id: "c", name: "C", team: 0 },
        { id: "d", name: "D", team: 1 },
      ],
      payouts: [
        { playerID: "a", lamports: 1 },
        { playerID: "c", lamports: 1 },
      ],
    }),
  );
  expect(ranks.get("simulation", "2v2", "a").rating).toBe(1024);
  expect(ranks.get("simulation", "2v2", "c").rating).toBe(1024);
  expect(ranks.get("simulation", "2v2", "b").rating).toBe(976);
  expect(ranks.view("simulation", "c")[1]).toMatchObject({
    wins: 1,
    losses: 0,
  });
});

it("shows persisted per-mode win/loss records without counting duplicates or unrated repeats", () => {
  const { db, ranks } = fixture();
  for (let i = 0; i < 4; i++) ranks.apply(pool(`record${i}`));
  ranks.apply(pool("record0"));
  const restored = new Rankings(db);
  expect(restored.view("simulation", "a")[0]).toMatchObject({
    games: 3,
    wins: 3,
    losses: 0,
  });
  expect(restored.view("simulation", "b")[0]).toMatchObject({
    games: 3,
    wins: 0,
    losses: 3,
  });
  expect(restored.view("simulation", "a")[1]).toMatchObject({
    wins: 0,
    losses: 0,
  });
  expect(restored.view("mainnet", "a")[0]).toMatchObject({
    wins: 0,
    losses: 0,
  });
});
it("persists rank movement and placement completion with the verified Elo result", () => {
  const { db, ranks } = fixture();
  const insert = db.prepare("INSERT INTO ranked_ratings VALUES(?,?,?,?,?)");
  insert.run("simulation", "1v1", "a", 1292, 20);
  insert.run("simulation", "1v1", "b", 1308, 20);
  ranks.apply(pool());
  expect(ranks.result("match", "a")).toMatchObject({
    beforeTier: "Gold I",
    afterTier: "Gold II",
    gamesAfter: 21,
  });
  expect(ranks.result("match", "b")).toMatchObject({
    beforeTier: "Gold II",
    afterTier: "Gold I",
    gamesAfter: 21,
  });
  db.prepare("UPDATE ranked_ratings SET games=9 WHERE player='a'").run();
  ranks.apply(pool("placement"));
  expect(ranks.result("placement", "a")).toMatchObject({
    beforeTier: "Unranked",
    afterTier: "Gold II",
    gamesAfter: 10,
  });
});
it("uses the strongest party member for team expectations instead of rewarding a large internal Elo gap", () => {
  const { db, ranks } = fixture();
  const insert = db.prepare("INSERT INTO ranked_ratings VALUES(?,?,?,?,?)");
  for (const [id, rating] of [
    ["a", 1900],
    ["b", 600],
    ["c", 1900],
    ["d", 1900],
  ] as const)
    insert.run("simulation", "2v2", id, rating, 20);
  ranks.apply(
    pool("party", {
      mode: "2v2",
      parties: [["a", "b"]],
      participants: [
        { id: "a", name: "A", team: 0 },
        { id: "b", name: "B", team: 0 },
        { id: "c", name: "C", team: 1 },
        { id: "d", name: "D", team: 1 },
      ],
      payouts: [
        { playerID: "a", lamports: 1 },
        { playerID: "b", lamports: 1 },
      ],
    }),
  );
  expect(ranks.result("party", "a")?.delta).toBe(16);
  expect(ranks.result("party", "b")?.delta).toBe(16);
});
