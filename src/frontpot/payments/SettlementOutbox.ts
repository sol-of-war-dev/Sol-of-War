import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { PLATFORM_FEE_BPS } from "../Rules";
import { decodeAddress } from "../Wallet";
import type { PaymentNetwork } from "./Network";

export type Transfer = { to: string; lamports: number };
export type SettlementPlan = {
  matchID: string;
  poolWalletID: string;
  poolAddress: string;
  treasury: string;
  network: PaymentNetwork;
  verificationHash: string;
  poolLamports: number;
  feeLamports: number;
  prizes: Transfer[];
};
export type Submission = {
  reference: string;
  signature?: string;
  status: "pending" | "finalized" | "failed";
};
export interface SettlementProvider {
  // Must submit fee + every prize as ONE atomic Solana transaction, with a
  // separate platform-funded fee payer. Never subtract network fees from prizes.
  sendAtomic(
    plan: Readonly<SettlementPlan>,
    idempotencyKey: string,
  ): Promise<Submission>;
  reconcile(idempotencyKey: string): Promise<Submission | null>;
}
type Job = {
  matchID: string;
  key: string;
  plan: Readonly<SettlementPlan>;
  state: "prepared" | "submitting" | "pending" | "confirmed" | "review";
  submission?: Submission;
  lastFailureAt?: number;
};
/** Immutable settlement outbox bound to the configured payment network. */
export class SettlementOutbox {
  constructor(
    private db: DatabaseSync,
    private network: PaymentNetwork = "devnet",
  ) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS settlements(match_id TEXT PRIMARY KEY, body TEXT NOT NULL)",
    );
  }
  get(matchID: string): Job | null {
    const row = this.db
      .prepare("SELECT body FROM settlements WHERE match_id=?")
      .get(matchID);
    return row ? JSON.parse(String(row.body)) : null;
  }
  prepare(plan: SettlementPlan): Job {
    if (
      plan.network !== this.network ||
      !/^[a-f0-9]{64}$/.test(plan.verificationHash) ||
      !plan.matchID ||
      !plan.poolWalletID ||
      !Number.isSafeInteger(plan.poolLamports) ||
      plan.poolLamports <= 0 ||
      plan.prizes.length < 1 ||
      plan.prizes.length > 2
    )
      throw new Error(
        "Expected a server-verified settlement on the configured network",
      );
    decodeAddress(plan.poolAddress);
    decodeAddress(plan.treasury);
    if (
      !Number.isSafeInteger(plan.feeLamports) ||
      BigInt(plan.feeLamports) !==
        (BigInt(plan.poolLamports) * BigInt(PLATFORM_FEE_BPS)) / 10000n
    )
      throw new Error(
        `Platform fee must be ${PLATFORM_FEE_BPS / 100}% of the pool`,
      );
    for (const p of plan.prizes) {
      decodeAddress(p.to);
      if (
        !Number.isSafeInteger(p.lamports) ||
        p.lamports <= 0 ||
        p.to === plan.poolAddress
      )
        throw new Error("Invalid prize destination or amount");
    }
    if (
      plan.treasury === plan.poolAddress ||
      new Set(plan.prizes.map((p) => p.to)).size !== plan.prizes.length ||
      plan.feeLamports + plan.prizes.reduce((n, p) => n + p.lamports, 0) !==
        plan.poolLamports
    )
      throw new Error("Payouts must conserve the whole pool");
    const existing = this.get(plan.matchID);
    if (existing) {
      if (JSON.stringify(existing.plan) !== JSON.stringify(plan))
        throw new Error("Settlement terms are immutable");
      return existing;
    }
    const job: Job = {
      matchID: plan.matchID,
      key: randomUUID(),
      plan: structuredClone(plan),
      state: "prepared",
    };
    this.db
      .prepare("INSERT INTO settlements(match_id,body) VALUES(?,?)")
      .run(job.matchID, JSON.stringify(job));
    return job;
  }
  private save(job: Job) {
    this.db
      .prepare("UPDATE settlements SET body=? WHERE match_id=?")
      .run(JSON.stringify(job), job.matchID);
    return job;
  }
  /** A held job can only be completed from its already persisted, finalized
   * transaction. Never change its plan, idempotency key, or transfer bytes. */
  confirmRecorded(matchID: string) {
    const job = this.get(matchID);
    if (!job) return null;
    const row = this.db
      .prepare("SELECT body FROM chain_jobs WHERE id=?")
      .get(`settlement:${job.key}`);
    if (!row) return job;
    const chain = JSON.parse(String(row.body));
    if (chain.state !== "finalized" || !chain.signature) return job;
    job.state = "confirmed";
    job.submission = {
      reference: job.key,
      signature: chain.signature,
      status: "finalized",
    };
    return this.save(job);
  }
  async run(matchID: string, provider: SettlementProvider): Promise<Job> {
    // Claim before awaiting the provider. SQLite serializes competing workers.
    this.db.exec("BEGIN IMMEDIATE");
    let job: Job;
    let send = false;
    try {
      const found = this.get(matchID);
      if (!found) throw new Error("Settlement not prepared");
      job = found;
      if (job.state === "prepared") {
        job.state = "submitting";
        this.save(job);
        send = true;
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    if (job.state === "confirmed" || job.state === "review") return job;
    try {
      const result = send
        ? await provider.sendAtomic(job.plan, job.key)
        : await provider.reconcile(job.key);
      // Ambiguous failures are reconciled, NEVER automatically resent with a new
      // key (provider idempotency expires). A missing response is not a failure.
      if (!result) return this.get(matchID)!;
      if (result.status === "finalized" && !result.signature)
        throw new Error("Missing finalized transaction signature");
      const latest = this.get(matchID)!;
      if (latest.state === "confirmed") return latest;
      latest.submission = result;
      delete latest.lastFailureAt;
      latest.state =
        result.status === "finalized"
          ? "confirmed"
          : result.status === "failed"
            ? "review"
            : "pending";
      return this.save(latest);
    } catch {
      const latest = this.get(matchID)!;
      if (latest.state !== "confirmed") {
        latest.lastFailureAt = Date.now();
        this.save(latest);
      }
      return latest;
    }
  }
}
