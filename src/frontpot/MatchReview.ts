import type { MatchLedger, Pool } from "./MatchLedger";
import type { DevnetPayments } from "./payments/DevnetPayments";
import { InputError } from "./Store";

/** Review can replay the saved game or refund the original funded roster.
 * It cannot supply a winner, change recipients, or override a prepared payout. */
export class MatchReview {
  constructor(
    private ledger: MatchLedger,
    private payments: DevnetPayments | null,
    private enqueueVerification: (id: string) => void,
  ) {}
  private blocked(pool: Pool) {
    if (pool.state !== "review" || pool.verificationHash || pool.signature)
      return "This match has a recorded result or is not awaiting result review.";
    const db = this.ledger.db;
    if (
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE name='settlements'")
        .get() &&
      db.prepare("SELECT 1 FROM settlements WHERE match_id=?").get(pool.matchID)
    )
      return "A payout plan exists. Use payment recovery.";
    if (pool.network !== "simulation" && pool.stakeLamports > 0) {
      const match = this.payments?.match(pool.matchID);
      if (
        !this.payments ||
        this.payments.network !== pool.network ||
        match?.state !== "locked"
      )
        return "The funded roster is not locked on the active network.";
      const entries = db
        .prepare("SELECT body FROM devnet_entries WHERE match_id=?")
        .all(pool.matchID)
        .map((r) => JSON.parse(String(r.body)));
      if (
        match.roster.length !== pool.participants.length ||
        pool.participants.some(
          (p) =>
            !match.roster.includes(p.id) ||
            !entries.some(
              (e) =>
                e.playerID === p.id &&
                e.wallet === p.wallet &&
                e.lamports === pool.stakeLamports &&
                e.state === "locked" &&
                this.payments!.transactions.get(`deposit:${e.id}`)?.state ===
                  "finalized" &&
                !this.payments!.transactions.get(`refund:${e.id}`),
            ),
        )
      )
        return "Recorded participant payments must be reconciled first.";
    }
    return null;
  }
  snapshot() {
    return this.ledger.db
      .prepare(
        "SELECT id FROM pools WHERE json_extract(body,'$.state')='review' ORDER BY rowid DESC LIMIT 20",
      )
      .all()
      .map((r) => {
        const pool = this.ledger.get(String(r.id))!,
          blocked = this.blocked(pool);
        return {
          matchID: pool.matchID,
          name: pool.name,
          reason: pool.reason,
          poolLamports: pool.poolLamports,
          ranked: pool.stakeLamports > 0,
          canRefund: !blocked,
          canReplay: !blocked && this.ledger.hasRecord(pool.matchID),
          blocked,
        };
      });
  }
  act(id: string, action: "replay" | "refund") {
    const pool = this.ledger.get(id);
    if (!pool) throw new InputError("Match not found.");
    const reason = this.blocked(pool);
    if (reason) throw new InputError(reason);
    if (action === "replay") {
      if (!this.ledger.hasRecord(id))
        throw new InputError("No saved recording is available.");
      this.ledger.retryVerification(id);
      this.enqueueVerification(id);
    } else {
      this.ledger.refund(
        id,
        "Match result could not be verified. Original entries returned in full; no platform fee.",
      );
      if (pool.network !== "simulation" && pool.stakeLamports > 0)
        this.payments?.cancel(id);
    }
  }
}
