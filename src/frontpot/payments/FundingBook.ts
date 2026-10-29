import { DatabaseSync } from "node:sqlite";
import { decodeAddress } from "../Wallet";
import { verifyFinalizedDeposit } from "./DepositVerifier";

export type FundingTerms = {
  matchID: string;
  poolAddress: string;
  stakeLamports: number;
  opensAt: number;
  closesAt: number;
  wallets: string[];
};
type Funding = FundingTerms & {
  state: "funding" | "funded" | "locked" | "cancelled";
};
/** Devnet funding adapter; the public simulation does not call this class.
 * Persist and freeze all wallets before asking anyone to deposit. A transaction
 * can fund only one seat, across all matches, even after process restarts.
 */
export class FundingBook {
  constructor(
    private db: DatabaseSync,
    private rpcURL: string,
    private request: typeof fetch = fetch,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS funding(match_id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deposits(signature TEXT PRIMARY KEY,match_id TEXT NOT NULL,wallet TEXT NOT NULL,lamports INTEGER NOT NULL,UNIQUE(match_id,wallet));`);
  }
  get(id: string): Funding | null {
    const row = this.db
      .prepare("SELECT body FROM funding WHERE match_id=?")
      .get(id);
    return row ? JSON.parse(String(row.body)) : null;
  }
  open(terms: FundingTerms): Funding {
    decodeAddress(terms.poolAddress);
    for (const wallet of terms.wallets) decodeAddress(wallet);
    if (
      !terms.matchID ||
      !Number.isSafeInteger(terms.stakeLamports) ||
      terms.stakeLamports <= 0 ||
      terms.stakeLamports > 100e9 ||
      terms.wallets.length < 2 ||
      terms.wallets.length > 100 ||
      new Set(terms.wallets).size !== terms.wallets.length ||
      terms.wallets.includes(terms.poolAddress) ||
      !Number.isSafeInteger(terms.opensAt) ||
      !Number.isSafeInteger(terms.closesAt) ||
      terms.closesAt <= terms.opensAt
    )
      throw new Error("Invalid funding terms");
    const existing = this.get(terms.matchID);
    if (existing) {
      const { state, ...original } = existing;
      void state;
      if (JSON.stringify(original) !== JSON.stringify(terms))
        throw new Error("Funding terms are immutable");
      return existing;
    }
    const record: Funding = { ...structuredClone(terms), state: "funding" };
    this.db
      .prepare("INSERT INTO funding(match_id,body) VALUES(?,?)")
      .run(terms.matchID, JSON.stringify(record));
    return record;
  }
  async confirm(
    matchID: string,
    wallet: string,
    signature: string,
  ): Promise<Funding> {
    const terms = this.get(matchID);
    if (!terms || !terms.wallets.includes(wallet))
      throw new Error("Wallet is not registered for this match");
    const receipt = this.db
      .prepare("SELECT match_id,wallet FROM deposits WHERE signature=?")
      .get(signature);
    if (receipt) {
      if (receipt.match_id !== matchID || receipt.wallet !== wallet)
        throw new Error("Deposit already credited elsewhere");
      return terms;
    }
    if (terms.state !== "funding" || Date.now() > terms.closesAt)
      throw new Error("Funding is closed");
    await verifyFinalizedDeposit(
      this.rpcURL,
      {
        signature,
        source: wallet,
        destination: terms.poolAddress,
        lamports: terms.stakeLamports,
        opensAt: terms.opensAt,
        closesAt: terms.closesAt,
      },
      this.request,
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const latest = this.get(matchID)!;
      if (latest.state !== "funding" || Date.now() > latest.closesAt)
        throw new Error(
          "Funding closed while confirming. Reconcile the transfer for refund.",
        );
      this.db
        .prepare(
          "INSERT INTO deposits(signature,match_id,wallet,lamports) VALUES(?,?,?,?)",
        )
        .run(signature, matchID, wallet, terms.stakeLamports);
      const row = this.db
        .prepare("SELECT COUNT(*) AS count FROM deposits WHERE match_id=?")
        .get(matchID)!;
      if (Number(row.count) === latest.wallets.length) {
        latest.state = "funded";
        this.db
          .prepare("UPDATE funding SET body=? WHERE match_id=?")
          .run(JSON.stringify(latest), matchID);
      }
      this.db.exec("COMMIT");
      return latest;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  lock(matchID: string) {
    const terms = this.get(matchID);
    if (!terms || !["funded", "locked"].includes(terms.state))
      throw new Error("Every stake must be finalized before starting");
    terms.state = "locked";
    this.db
      .prepare("UPDATE funding SET body=? WHERE match_id=?")
      .run(JSON.stringify(terms), matchID);
    return terms;
  }
  cancel(matchID: string) {
    const terms = this.get(matchID);
    if (!terms) return;
    if (terms.state === "locked")
      throw new Error(
        "A started match requires a verified settlement or adjudicated refund",
      );
    terms.state = "cancelled";
    this.db
      .prepare("UPDATE funding SET body=? WHERE match_id=?")
      .run(JSON.stringify(terms), matchID);
    // Return exact confirmed entries; never collect a fee on cancellation.
    // Sending these refunds belongs to a separate durable, reconciled outbox.
    return this.db
      .prepare("SELECT wallet,lamports FROM deposits WHERE match_id=?")
      .all(matchID);
  }
}
