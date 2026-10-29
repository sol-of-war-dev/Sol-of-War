import type { RankedResult } from "./RankedResult";
import { rankTier } from "./RankTiers";
export { rankTier } from "./RankTiers";
import type { DatabaseSync } from "node:sqlite";
import type { Pool } from "./MatchLedger";
import type { Mode } from "./Store";
export type RankedRating = {
  mode: Mode;
  rating: number;
  games: number;
  provisional: boolean;
  tier: string;
};
export type RankedRecord = RankedRating & { wins: number; losses: number };
export class Rankings {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS ranked_ratings(network TEXT, mode TEXT, player TEXT, rating REAL NOT NULL, games INTEGER NOT NULL, PRIMARY KEY(network,mode,player));
      CREATE TABLE IF NOT EXISTS ranked_results(match_id TEXT PRIMARY KEY, network TEXT NOT NULL, mode TEXT NOT NULL, at INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ranked_pairs(network TEXT, mode TEXT, a TEXT, b TEXT, at INTEGER, match_id TEXT);
      CREATE INDEX IF NOT EXISTS ranked_pairs_lookup ON ranked_pairs(network,mode,a,b,at);`);
  }
  get(network: string, mode: Mode, player: string): RankedRating {
    const row = this.db
      .prepare(
        "SELECT rating,games FROM ranked_ratings WHERE network=? AND mode=? AND player=?",
      )
      .get(network, mode, player);
    const rating = Math.round(Number(row?.rating ?? 1000)),
      games = Number(row?.games ?? 0);
    return {
      mode,
      rating,
      games,
      provisional: games < 10,
      tier: games < 10 ? "Unranked" : rankTier(rating),
    };
  }
  view(network: string, player: string): RankedRecord[] {
    // Read persisted verified results so existing accounts need no backfill.
    // Only counted results contribute, matching the rated-games total.
    const records = this.db
      .prepare(`
      SELECT r.mode,
        SUM(CASE WHEN json_extract(p.value, '$.place') = 1 THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN json_extract(p.value, '$.place') > 1 THEN 1 ELSE 0 END) AS losses
      FROM ranked_results r, json_each(r.body) p
      WHERE r.network = ? AND p.key = ? AND json_extract(p.value, '$.counted') = 1
      GROUP BY r.mode
    `)
      .all(network, player);
    return (["1v1", "2v2"] as const).map((mode) => {
      const record = records.find((row) => row.mode === mode);
      return {
        ...this.get(network, mode, player),
        wins: Number(record?.wins ?? 0),
        losses: Number(record?.losses ?? 0),
      };
    });
  }
  result(match: string, player: string): RankedResult | undefined {
    const row = this.db
      .prepare("SELECT body FROM ranked_results WHERE match_id=?")
      .get(match);
    return row ? JSON.parse(String(row.body))[player] : undefined;
  }
  /** Called inside the ledger transaction: result and ratings commit together. */
  apply(pool: Pool) {
    if (
      !pool.verificationHash ||
      pool.state !== "settled" ||
      pool.ranked === false ||
      pool.mode === "ffa" ||
      pool.practice ||
      pool.private ||
      pool.stakeLamports <= 0 ||
      pool.participants.length < 2
    )
      return;
    if (
      this.db
        .prepare("SELECT 1 FROM ranked_results WHERE match_id=?")
        .get(pool.matchID)
    )
      return;
    this.db
      .prepare("DELETE FROM ranked_pairs WHERE at < ?")
      .run(pool.updated - 86400000);
    const members = pool.participants;
    if (new Set(members.map((p) => p.id)).size !== members.length) return;
    const winners = new Set(pool.payouts.map((p) => p.playerID));
    if (winners.size !== (pool.mode === "2v2" ? 2 : 1)) return;
    const places = Object.fromEntries(
      members.map((p) => [p.id, winners.has(p.id) ? 1 : 2]),
    );
    if (
      !places ||
      members.some(
        (p) =>
          !Number.isInteger(places[p.id]) ||
          places[p.id] < 1 ||
          places[p.id] > members.length,
      )
    )
      return;
    const ratings = members.map((p) => this.get(pool.network, pool.mode, p.id));
    const deltas = members.map(() => 0),
      counted = members.map(() => false);
    for (let i = 0; i < members.length; i++)
      for (let j = i + 1; j < members.length; j++) {
        if (pool.mode === "2v2" && members[i].team === members[j].team)
          continue;
        const [a, b] = [members[i].id, members[j].id].sort();
        const previous = Number(
          this.db
            .prepare(
              "SELECT count(*) AS n FROM ranked_pairs WHERE network=? AND mode=? AND a=? AND b=? AND at>? AND at<=?",
            )
            .get(
              pool.network,
              pool.mode,
              a,
              b,
              pool.updated - 86400000,
              pool.updated,
            )?.n ?? 0,
        );
        const weight =
          previous === 0 ? 1 : previous === 1 ? 0.5 : previous === 2 ? 0.25 : 0;
        const teamRating = (index: number) => {
          if (pool.mode !== "2v2") return ratings[index].rating;
          const team = members
            .map((p, k) => ({ ...p, rating: ratings[k].rating }))
            .filter((p) => p.team === members[index].team);
          const party = pool.parties?.some(
            (group) =>
              group.length === 2 && team.every((p) => group.includes(p.id)),
          );
          return party
            ? Math.max(...team.map((p) => p.rating))
            : team.reduce((n, p) => n + p.rating, 0) / 2;
        };
        const expected =
          1 / (1 + 10 ** ((teamRating(j) - teamRating(i)) / 400));
        const score =
          places[members[i].id] < places[members[j].id]
            ? 1
            : places[members[i].id] === places[members[j].id]
              ? 0.5
              : 0;
        const k = ratings[i].provisional || ratings[j].provisional ? 48 : 32;
        const divisor = pool.mode === "2v2" ? 2 : members.length - 1;
        const delta = (weight * k * (score - expected)) / divisor;
        deltas[i] += delta;
        deltas[j] -= delta;
        if (weight) {
          counted[i] = true;
          counted[j] = true;
        }
        this.db
          .prepare("INSERT INTO ranked_pairs VALUES(?,?,?,?,?,?)")
          .run(pool.network, pool.mode, a, b, pool.updated, pool.matchID);
      }
    const changes: Record<string, unknown> = {};
    members.forEach((p, i) => {
      const before = ratings[i].rating,
        after = Math.max(0, before + Math.round(deltas[i]));
      this.db
        .prepare(
          "INSERT INTO ranked_ratings VALUES(?,?,?,?,?) ON CONFLICT(network,mode,player) DO UPDATE SET rating=excluded.rating,games=excluded.games",
        )
        .run(
          pool.network,
          pool.mode,
          p.id,
          after,
          ratings[i].games + (counted[i] ? 1 : 0),
        );
      changes[p.id] = {
        before,
        after,
        delta: after - before,
        place: places[p.id],
        counted: counted[i],
        beforeTier: ratings[i].tier,
        afterTier:
          ratings[i].games + (counted[i] ? 1 : 0) < 10
            ? "Unranked"
            : rankTier(after),
        gamesAfter: ratings[i].games + (counted[i] ? 1 : 0),
      };
    });
    this.db
      .prepare("INSERT INTO ranked_results VALUES(?,?,?,?,?)")
      .run(
        pool.matchID,
        pool.network,
        pool.mode,
        pool.updated,
        JSON.stringify(changes),
      );
  }
}
