import type { ReplayedWinner } from "@openfront/engine/WinnerReplay";
import type { PartialGameRecord } from "@openfront/shared/WireSchemas";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { serialize, deserialize } from "node:v8";
import type { PaymentMode } from "./payments/Network";
import { bindPaymentDatabase } from "./payments/PaymentDatabase";
import { Rankings } from "./Rankings";
import { PLATFORM_FEE_BPS, prizeSplit } from "./Rules";
import type { Room, Seat } from "./Store";

export type PoolState =
  | "waiting"
  | "playing"
  | "verifying"
  | "payout_pending"
  | "refund_pending"
  | "settled"
  | "refunded"
  | "review";
export type Pool = {
  matchID: string;
  poolID: string;
  mode: Room["mode"];
  parties?: string[][];
  ranked?: boolean;
  practice?: boolean;
  name: string;
  map: string;
  network: PaymentMode;
  address: string | null;
  signature?: string;
  feeBps: number;
  stakeLamports: number;
  state: PoolState;
  created: number;
  updated: number;
  reason: string;
  participants: Array<{
    id: string;
    name: string;
    wallet?: string;
    team: number;
  }>;
  poolLamports: number;
  feeLamports: number;
  payouts: Array<{ playerID: string; wallet?: string; lamports: number }>;
  verificationHash?: string;
  replayAvailable?: boolean;
  private?: boolean;
  placements?: Record<string, number>;
};
/** Durable result ledger; contains no signing keys. Devnet results remain
 * pending until the payment worker confirms finalization. Payout addresses are
 * frozen from authenticated funded seats, never taken from a result report.
 * Simulation records are never eligible for the devnet transport.
 */
export class MatchLedger {
  readonly db: DatabaseSync;
  readonly rankings: Rankings;
  constructor(
    file: string,
    private network: PaymentMode = "simulation",
  ) {
    this.db = new DatabaseSync(file);
    if (network !== "simulation") bindPaymentDatabase(this.db, network);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS pools(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pool_events(id INTEGER PRIMARY KEY, match_id TEXT NOT NULL, at INTEGER NOT NULL, state TEXT NOT NULL, reason TEXT NOT NULL);`);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS pool_events_match_state_at ON pool_events(match_id,state,at)",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS recordings(id TEXT PRIMARY KEY, body BLOB NOT NULL)",
    );
    this.rankings = new Rankings(this.db);
  }
  saveRecord(record: PartialGameRecord) {
    this.db
      .prepare(
        "INSERT INTO recordings(id,body) VALUES(?,?) ON CONFLICT(id) DO NOTHING",
      )
      .run(record.info.gameID, serialize(record));
  }
  record(id: string): PartialGameRecord | null {
    const row = this.db
      .prepare("SELECT body FROM recordings WHERE id=?")
      .get(id);
    return row
      ? (deserialize(row.body as Uint8Array) as PartialGameRecord)
      : null;
  }
  hasRecord(id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM recordings WHERE id=?").get(id);
  }
  pendingVerification(): string[] {
    return this.db
      .prepare("SELECT id FROM pools")
      .all()
      .map((r) => String(r.id))
      .filter(
        (id) => this.get(id)?.state === "verifying" && this.hasRecord(id),
      );
  }
  get(id: string): Pool | null {
    const row = this.db.prepare("SELECT body FROM pools WHERE id=?").get(id);
    return row ? (JSON.parse(String(row.body)) as Pool) : null;
  }
  private save(p: Pool) {
    p.updated = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT INTO pools(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
        )
        .run(p.matchID, JSON.stringify(p));
      this.db
        .prepare(
          "INSERT INTO pool_events(match_id,at,state,reason) VALUES(?,?,?,?)",
        )
        .run(p.matchID, p.updated, p.state, p.reason);
      this.rankings.apply(p);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return p;
  }
  open(room: Room): Pool {
    const existing = this.get(room.id);
    if (existing) return existing;
    return this.save({
      matchID: room.id,
      poolID: randomUUID(),
      mode: room.mode,
      ranked: !room.practice && room.mode !== "ffa" && room.ranked !== false,
      practice: room.practice,
      private: room.private,
      name: room.name,
      map: room.rules.gameMap,
      network: room.practice ? "simulation" : this.network,
      address: null,
      feeBps: room.lamports === 0 ? 0 : PLATFORM_FEE_BPS,
      stakeLamports: room.lamports,
      state: "waiting",
      created: Date.now(),
      updated: Date.now(),
      reason: "Waiting for players. No funds collected.",
      participants: [],
      poolLamports: 0,
      feeLamports: 0,
      payouts: [],
    });
  }
  updateSettings(room: Room) {
    const pool = this.open(room);
    if (pool.state !== "waiting" || pool.participants.length)
      throw new Error("Pool settings are locked.");
    return this.save({
      ...pool,
      mode: room.mode,
      ranked: room.ranked,
      private: room.private,
      map: room.rules.gameMap,
      stakeLamports: room.lamports,
      feeBps: room.lamports === 0 ? 0 : PLATFORM_FEE_BPS,
    });
  }
  lock(room: Room, seats: Seat[]): Pool {
    const p = this.open(room);
    if (p.state === "playing") return p;
    if (p.state !== "waiting") throw new Error("Pool cannot be started twice");
    const expected = room.practice
      ? 1
      : room.mode === "1v1"
        ? 2
        : room.mode === "2v2"
          ? 4
          : seats.length;
    if (
      seats.length !== expected ||
      new Set(seats.map((s) => s.id)).size !== seats.length ||
      (!room.practice && seats.length < 2)
    )
      throw new Error("Incomplete match roster");
    if (
      room.mode === "2v2" &&
      [0, 1].some((t) => seats.filter((s) => s.team === t).length !== 2)
    )
      throw new Error("Unbalanced teams");
    p.participants = seats.map(({ id, name, wallet, team }) => ({
      id,
      name,
      wallet,
      team,
    }));
    p.parties = room.parties
      ?.filter(
        (group) =>
          group.length === 2 &&
          group.every((id) => seats.some((s) => s.id === id)) &&
          seats.find((s) => s.id === group[0])?.team ===
            seats.find((s) => s.id === group[1])?.team,
      )
      .map((group) => [...group]);
    p.poolLamports = p.stakeLamports * seats.length;
    p.feeLamports = prizeSplit(
      p.stakeLamports,
      seats.length,
      1,
      p.feeBps,
    ).feeLamports;
    p.state = "playing";
    p.reason =
      p.stakeLamports === 0
        ? "Free match roster locked."
        : p.network !== "simulation"
          ? "Funded roster and payout destinations locked."
          : "Roster and payout destinations locked. Simulated entries only.";
    return this.save(p);
  }
  verifying(id: string) {
    const p = this.get(id);
    if (!p || p.state !== "playing") return p;
    p.state = "verifying";
    p.reason = "Replaying the match on the server to verify the result.";
    return this.save(p);
  }
  review(id: string, reason: string) {
    const p = this.get(id);
    if (!p || ["settled", "refunded"].includes(p.state)) return p;
    p.state = "review";
    p.reason = reason;
    return this.save(p);
  }
  /** Replays always use the immutable archived recording. A payout decision
   * that already has a verification hash must use payment recovery instead. */
  retryVerification(id: string) {
    const pool = this.get(id);
    if (
      !pool ||
      pool.state !== "review" ||
      pool.verificationHash ||
      !this.hasRecord(id)
    )
      throw new Error("No unverified recording is eligible for replay.");
    pool.state = "verifying";
    pool.reason =
      "An administrator requested another verification of the saved match.";
    return this.save(pool);
  }
  refund(id: string, reason: string) {
    const p = this.get(id);
    if (!p || ["settled", "refunded"].includes(p.state)) return p;
    p.state =
      p.network !== "simulation" && p.stakeLamports > 0
        ? "refund_pending"
        : "refunded";
    p.reason =
      p.stakeLamports === 0
        ? "Free match cancelled. No funds collected."
        : reason;
    p.feeLamports = 0;
    p.payouts = p.participants.map((s) => ({
      playerID: s.id,
      wallet: s.wallet,
      lamports: p.stakeLamports,
    }));
    return this.save(p);
  }
  settle(
    record: PartialGameRecord,
    replay: ReplayedWinner | null,
  ): Pool | null {
    const p = this.get(record.info.gameID);
    if (!p || ["settled", "refunded"].includes(p.state)) return p;
    if (p.state !== "verifying")
      throw new Error("Result must be verified before settlement");
    if (!replay || replay.tick === null)
      return this.review(
        p.matchID,
        "Verification did not reach a result. No payout authorized.",
      );
    if (!replay.winner || replay.winner[0] === "nation")
      return this.refund(
        p.matchID,
        p.network !== "simulation"
          ? "No human winner. Entry refund pending; no platform fee."
          : "No human winner. Simulated entries returned; no platform fee.",
      );
    const roster = record.info.players;
    if (
      roster.length !== p.participants.length ||
      new Set(roster.map((r) => r.persistentID)).size !== roster.length ||
      p.participants.some((s) => !roster.some((r) => r.persistentID === s.id))
    )
      return this.review(
        p.matchID,
        "Recorded roster differs from locked entries.",
      );
    // The engine includes client IDs in the winner tuple. For player wins the
    // first ID is the winner; team wins contain every winning human after name.
    const clientIDs =
      replay.winner[0] === "player"
        ? [replay.winner[1]]
        : replay.winner.slice(2);
    const ids = roster
      .filter((r) => clientIDs.includes(r.clientID))
      .map((r) => r.persistentID);
    const eligible = p.participants.filter((s) => ids.includes(s.id));
    if (p.mode === "2v2" && replay.winner[0] !== "team")
      return this.review(p.matchID, "Expected a verified team winner.");
    if (p.mode !== "2v2" && replay.winner[0] !== "player")
      return this.review(p.matchID, "Expected a verified individual winner.");
    // The agreed 2v2 rule pays both registered teammates, including eliminated
    // players. Upstream's ranked eligibility may omit a disconnected teammate.
    const winners =
      p.mode === "2v2" && eligible.length
        ? p.participants.filter((s) => s.team === eligible[0].team)
        : eligible;
    if (
      winners.length !== (p.mode === "2v2" ? 2 : 1) ||
      (p.mode === "2v2" &&
        (winners[0].team !== winners[1].team ||
          eligible.some((s) => s.team !== winners[0].team)))
    )
      return this.review(
        p.matchID,
        "Winning side could not be matched to the locked roster.",
      );
    const split = prizeSplit(
      p.stakeLamports,
      p.participants.length,
      winners.length,
      p.feeBps,
    );
    p.payouts = winners.map((s, i) => ({
      playerID: s.id,
      wallet: s.wallet,
      lamports: split.payouts[i],
    }));
    if (replay.placements) {
      p.placements = Object.fromEntries(
        roster.map((r) => [r.persistentID, replay.placements![r.clientID]]),
      );
    }
    p.feeLamports = split.feeLamports;
    p.verificationHash = createHash("sha256")
      .update(
        JSON.stringify(
          { info: record.info, turns: record.turns, replay },
          (_k, v) => (typeof v === "bigint" ? v.toString() : v),
        ),
      )
      .digest("hex");
    p.state =
      p.network !== "simulation" && p.stakeLamports > 0
        ? "payout_pending"
        : "settled";
    p.reason =
      "Server replay verified. Demo payout recorded; no SOL transferred.";
    if (p.network !== "simulation" && p.stakeLamports > 0)
      p.reason = "Server replay verified. Payout awaiting confirmation.";
    if (p.stakeLamports === 0)
      p.reason = "Server replay verified. Free match complete.";
    return this.save(p);
  }
  confirmPayment(
    id: string,
    state: "settled" | "refunded",
    signature?: string,
  ) {
    const p = this.get(id);
    if (
      !p ||
      p.network === "simulation" ||
      p.state !== (state === "settled" ? "payout_pending" : "refund_pending")
    )
      throw new Error("Unexpected payment confirmation");
    p.state = state;
    p.signature = signature;
    p.reason =
      state === "settled"
        ? "Payout finalized."
        : "Entry refunds finalized. No platform fee.";
    return this.save(p);
  }
  history(playerID: string): Pool[] {
    return this.db
      .prepare("SELECT body FROM pools ORDER BY rowid DESC LIMIT 500")
      .all()
      .map((row) => JSON.parse(String(row.body)) as Pool)
      .filter((p) => p.participants.some((s) => s.id === playerID))
      .slice(0, 50);
  }
  /** Restore accounting only when the original verified settlement and its exact
   * stored transaction have independently reached finalization. No admin input
   * can choose a winner, recipient, amount or replacement signature. */
  confirmRecoveredSettlement(id: string) {
    const p = this.get(id);
    if (
      !p ||
      p.network === "simulation" ||
      p.state !== "review" ||
      !p.verificationHash
    )
      return false;
    const row = this.db
      .prepare("SELECT body FROM settlements WHERE match_id=?")
      .get(id);
    if (!row) return false;
    const settlement = JSON.parse(String(row.body));
    const plan = settlement.plan;
    if (
      settlement.state !== "confirmed" ||
      plan.network !== p.network ||
      plan.matchID !== id ||
      plan.verificationHash !== p.verificationHash ||
      plan.poolLamports !== p.poolLamports ||
      plan.feeLamports !== p.feeLamports ||
      JSON.stringify(plan.prizes) !==
        JSON.stringify(
          p.payouts.map((s) => ({ to: s.wallet, lamports: s.lamports })),
        )
    )
      return false;
    const chainRow = this.db
      .prepare("SELECT body FROM chain_jobs WHERE id=?")
      .get(`settlement:${settlement.key}`);
    if (!chainRow) return false;
    const chain = JSON.parse(String(chainRow.body));
    if (
      chain.state !== "finalized" ||
      !chain.signature ||
      chain.signature !== settlement.submission?.signature
    )
      return false;
    p.state = "payout_pending";
    p.reason = "Original payout signature reconciled after review.";
    this.save(p);
    this.confirmPayment(id, "settled", chain.signature);
    return true;
  }
  recoverInterrupted() {
    for (const row of this.db.prepare("SELECT id FROM pools").all()) {
      const p = this.get(String(row.id))!;
      if (["waiting", "playing"].includes(p.state))
        this.refund(
          p.matchID,
          p.network !== "simulation"
            ? "Server restarted. Entry refund pending; no fee."
            : "Demo server restarted. Simulated entries returned; no fee.",
        );
      else if (p.state === "verifying" && !this.hasRecord(p.matchID))
        this.review(
          p.matchID,
          "Verification interrupted without a saved recording. No payout authorized.",
        );
    }
  }
  close() {
    this.db.close();
  }
}
