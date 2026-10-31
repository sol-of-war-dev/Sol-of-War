import { GameRecordSchema } from "@openfront/shared/WireSchemas";
import { createHash, randomUUID } from "node:crypto";
import type { MatchLedger } from "./MatchLedger";
import { InputError } from "./Store";

export class MatchReceipts {
  constructor(readonly ledger: MatchLedger) {
    ledger.db.exec(`CREATE TABLE IF NOT EXISTS result_disputes (
      id TEXT PRIMARY KEY, match_id TEXT NOT NULL, player_id TEXT NOT NULL,
      reason TEXT NOT NULL, description TEXT NOT NULL, email TEXT NOT NULL,
      evidence TEXT NOT NULL, status TEXT NOT NULL, resolution TEXT NOT NULL,
      created INTEGER NOT NULL, updated INTEGER NOT NULL,
      UNIQUE(match_id, player_id));
      CREATE TABLE IF NOT EXISTS result_dispute_events (
      id INTEGER PRIMARY KEY, dispute_id TEXT NOT NULL, actor TEXT NOT NULL,
      at INTEGER NOT NULL, status TEXT NOT NULL, resolution TEXT NOT NULL);`);
  }
  pool(id: string) {
    const pool = this.ledger.get(id);
    if (
      !pool ||
      pool.private ||
      pool.practice ||
      ["waiting", "playing"].includes(pool.state)
    )
      throw new InputError("Public receipt is not available for this match.");
    return pool;
  }
  replay(id: string) {
    this.pool(id);
    const source = this.ledger.record(id);
    if (!source) throw new InputError("Replay is unavailable for this match.");
    // Schema parsing strips unknown fields; omit reports and account identifiers.
    const parsed = GameRecordSchema.parse({ ...source, gitCommit: "DEV" });
    parsed.info.reports = undefined;
    parsed.info.tribes = parsed.info.tribes?.map((tribe) => ({
      name: tribe.name,
    }));
    parsed.turns = parsed.turns.map((turn) => ({
      ...turn,
      intents: turn.intents.filter((intent) => intent.type !== "quick_chat"),
    }));
    parsed.info.players = parsed.info.players.map((p) => ({
      ...p,
      persistentID: null,
    }));
    const body = JSON.stringify(parsed, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    return { body, hash: createHash("sha256").update(body).digest("hex") };
  }
  submit(id: string, player: string, input: Record<string, unknown>) {
    const pool = this.pool(id);
    if (!pool.participants.some((p) => p.id === player))
      throw new InputError("Only a participant can dispute this match.");
    const field = (key: string, min: number, max: number) => {
      const value = typeof input[key] === "string" ? input[key].trim() : "";
      if (value.length < min || value.length > max)
        throw new InputError(`Check the ${key} field.`);
      return value;
    };
    const reason = field("reason", 1, 40);
    if (
      !["Incorrect winner", "Payout issue", "Replay issue", "Other"].includes(
        reason,
      )
    )
      throw new InputError("Choose a dispute reason.");
    const description = field("description", 10, 2000),
      email = field("email", 0, 254),
      evidence = field("evidence", 0, 500);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new InputError("Enter a valid email address.");
    const existing = this.ledger.db
      .prepare(
        "SELECT id FROM result_disputes WHERE match_id=? AND player_id=?",
      )
      .get(id, player);
    if (existing)
      return { id: String(existing.id), status: "already submitted" };
    const reference = randomUUID(),
      now = Date.now();
    this.ledger.db
      .prepare(
        "INSERT INTO result_disputes VALUES(?,?,?,?,?,?,?,'submitted','',?,?)",
      )
      .run(
        reference,
        id,
        player,
        reason,
        description,
        email,
        evidence,
        now,
        now,
      );
    return { id: reference, status: "submitted" };
  }
  list() {
    return this.ledger.db
      .prepare("SELECT * FROM result_disputes ORDER BY created DESC LIMIT 100")
      .all();
  }
  mine(id: string, player: string) {
    return (
      this.ledger.db
        .prepare(
          "SELECT id,status,resolution,created,updated FROM result_disputes WHERE match_id=? AND player_id=?",
        )
        .get(id, player) ?? null
    );
  }
  resolve(id: string, actor: string, input: Record<string, unknown>) {
    if (!["reviewing", "resolved", "declined"].includes(String(input.status)))
      throw new InputError("Choose a review status.");
    const resolution =
      typeof input.resolution === "string" ? input.resolution.trim() : "";
    if (resolution.length < 10 || resolution.length > 2000)
      throw new InputError(
        "Explain the review in 10–2000 characters. Do not include private contact details.",
      );
    const db = this.ledger.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!db.prepare("SELECT id FROM result_disputes WHERE id=?").get(id))
        throw new InputError("Dispute not found.");
      const now = Date.now();
      db.prepare(
        "UPDATE result_disputes SET status=?,resolution=?,updated=? WHERE id=?",
      ).run(String(input.status), resolution, now, id);
      db.prepare(
        "INSERT INTO result_dispute_events(dispute_id,actor,at,status,resolution) VALUES(?,?,?,?,?)",
      ).run(id, actor, now, String(input.status), resolution);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}
