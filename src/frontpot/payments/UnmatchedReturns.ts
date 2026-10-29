import { getTransferSolInstructionDataDecoder } from "@solana-program/system";
import {
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
} from "@solana/kit";
import type { DatabaseSync } from "node:sqlite";
import { InputError } from "../Store";
import { validateDepositSignature } from "./DepositSignature";
import {
  acceptSignature,
  type DevnetTransactions,
  type PoolSigner,
} from "./DevnetTransactions";
import { expectedPoolBalance } from "./PoolReconciliation";
import type { ManagedPoolWallet } from "./PrivyPoolWallets";

type ReturnPlan = {
  matchID: string;
  depositSignature: string;
  source: ManagedPoolWallet;
  to: string;
  lamports: number;
  slot: number;
  createdAt: number;
};
/** A return is derived from one finalized native-SOL transfer into this pool.
 * Operators never choose a recipient or amount. Ambiguous/program transfers
 * remain held for review. No network fee is taken out of the returned amount. */
export class UnmatchedReturns {
  private running = false;
  constructor(
    private db: DatabaseSync,
    private transactions: DevnetTransactions,
    private signer: PoolSigner,
    private payer: { id: string; address: string },
  ) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS unmatched_returns(signature TEXT PRIMARY KEY,match_id TEXT NOT NULL,body TEXT NOT NULL)",
    );
  }
  private known(signature: string) {
    return !!this.db
      .prepare(
        "SELECT 1 FROM chain_jobs WHERE json_extract(body,'$.signature')=? UNION ALL SELECT 1 FROM chain_attempts WHERE signature=? LIMIT 1",
      )
      .get(signature, signature);
  }
  private plan(signature: string): ReturnPlan | null {
    const row = this.db
      .prepare("SELECT body FROM unmatched_returns WHERE signature=?")
      .get(signature);
    return row ? JSON.parse(String(row.body)) : null;
  }
  has(signature: string) {
    return this.plan(signature) !== null;
  }
  async request(matchID: string, signature: string) {
    if (this.running)
      throw new InputError(
        "Another return is being checked. Try again shortly.",
      );
    this.running = true;
    try {
      const existing = this.plan(signature);
      if (existing) {
        if (existing.matchID !== matchID)
          throw new InputError("Return does not belong to this match.");
        return await this.send(existing);
      }
      const recorded = this.db
        .prepare(
          "SELECT slot,delta FROM unmatched_pool_transactions WHERE match_id=? AND signature=?",
        )
        .get(matchID, signature);
      const match = this.db
        .prepare("SELECT body FROM devnet_matches WHERE id=?")
        .get(matchID);
      const source: ManagedPoolWallet | undefined = match
        ? JSON.parse(String(match.body)).wallet
        : undefined;
      if (!recorded || !source || this.known(signature))
        throw new InputError("No unmatched deposit is eligible for return.");
      const rpc = this.transactions.rpc;
      await rpc.check();
      const result = await rpc.call<null | {
        slot: number;
        transaction: [string, string];
        meta: { err: unknown; preBalances: number[]; postBalances: number[] };
      }>("getTransaction", [
        signature,
        {
          encoding: "base64",
          commitment: "finalized",
          maxSupportedTransactionVersion: 0,
        },
      ]);
      if (
        !result?.meta ||
        result.meta.err !== null ||
        result.slot !== Number(recorded.slot) ||
        result.transaction[1] !== "base64"
      )
        throw new InputError("Finalized deposit evidence is unavailable.");
      const tx = getTransactionDecoder().decode(
        Buffer.from(result.transaction[0], "base64"),
      );
      if (getSignatureFromTransaction(tx) !== signature)
        throw new InputError("Deposit signature mismatch.");
      const message = getCompiledTransactionMessageDecoder().decode(
        tx.messageBytes,
      );
      if (
        (message.version !== 0 && message.version !== "legacy") ||
        (message.version === 0 && message.addressTableLookups?.length) ||
        message.instructions.length !== 1
      )
        throw new InputError("This transfer requires manual review.");
      const instruction = message.instructions[0],
        accounts = instruction.accountIndices;
      if (
        message.staticAccounts[instruction.programAddressIndex] !==
          "11111111111111111111111111111111" ||
        accounts?.length !== 2 ||
        instruction.data?.length !== 12 ||
        Buffer.from(instruction.data).readUInt32LE(0) !== 2
      )
        throw new InputError(
          "Only a direct native-SOL transfer can be returned automatically.",
        );
      const sender = message.staticAccounts[accounts[0]],
        recipient = message.staticAccounts[accounts[1]];
      const amount = getTransferSolInstructionDataDecoder().decode(
        instruction.data,
      ).amount;
      const pre = result.meta.preBalances[accounts[1]],
        post = result.meta.postBalances[accounts[1]];
      if (
        recipient !== source.address ||
        sender === recipient ||
        message.staticAccounts[0] === source.address ||
        amount <= 0n ||
        amount > BigInt(Number.MAX_SAFE_INTEGER) ||
        !Number.isSafeInteger(pre) ||
        !Number.isSafeInteger(post) ||
        pre < 0 ||
        post < 0 ||
        BigInt(post) - BigInt(pre) !== amount ||
        BigInt(String(recorded.delta)) !== amount
      )
        throw new InputError(
          "Deposit balance evidence does not match the transfer.",
        );
      await acceptSignature(
        result.transaction[0],
        result.transaction[0],
        sender,
      );
      // An issued entry must follow the entry/refund path, even if its client
      // did not submit it yet or the entry has moved to another state.
      for (const row of this.db
        .prepare("SELECT body FROM devnet_entries WHERE match_id=?")
        .all(matchID)) {
        const entry = JSON.parse(String(row.body));
        // A separate transfer must stay returnable if this entry already has
        // its own receipt. Otherwise protect wallet-adjusted issued deposits.
        if (this.transactions.get(`deposit:${entry.id}`)) continue;
        const issued = getTransactionDecoder().decode(
          Buffer.from(entry.wire.transaction, "base64"),
        );
        let matches = Buffer.from(issued.messageBytes).equals(
          Buffer.from(tx.messageBytes),
        );
        if (!matches && !entry.paymentWallet) {
          try {
            await validateDepositSignature(
              entry.wire,
              result.transaction[0],
              entry.wallet,
            );
            matches = true;
          } catch {
            // A different signed transfer remains eligible for its own return.
          }
        }
        if (matches)
          throw new InputError(
            "This is an issued match entry; recover it through entry reconciliation.",
          );
      }
      const balance = await rpc.call<{ value: number }>("getBalance", [
        source.address,
        { commitment: "finalized" },
      ]);
      const obligations = expectedPoolBalance(this.db, matchID);
      if (
        obligations < 0n ||
        !Number.isSafeInteger(balance.value) ||
        BigInt(balance.value) - obligations < amount
      )
        throw new InputError(
          "Pool balance does not cover this return and the recorded match obligations.",
        );
      const plan: ReturnPlan = {
        matchID,
        depositSignature: signature,
        source,
        to: sender,
        lamports: Number(amount),
        slot: result.slot,
        createdAt: Date.now(),
      };
      // The request can overlap an externally submitted entry while RPC calls
      // are in flight. Recheck before committing the immutable return plan.
      this.db.exec("BEGIN IMMEDIATE");
      try {
        if (this.known(signature))
          throw new InputError(
            "This deposit is already recorded as a match entry.",
          );
        this.db
          .prepare("INSERT INTO unmatched_returns VALUES(?,?,?)")
          .run(signature, matchID, JSON.stringify(plan));
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      return await this.send(plan);
    } finally {
      this.running = false;
    }
  }
  private send(plan: ReturnPlan) {
    return this.transactions.send(
      `return:${plan.depositSignature}`,
      plan.source,
      this.payer,
      [{ to: plan.to, lamports: plan.lamports }],
      this.signer,
    );
  }
  async tick() {
    if (this.running) return 0;
    this.running = true;
    let failures = 0;
    try {
      const rows = this.db
        .prepare(
          "SELECT r.body FROM unmatched_returns r LEFT JOIN chain_jobs j ON j.id='return:' || r.signature WHERE j.id IS NULL OR json_extract(j.body,'$.state')='pending' ORDER BY r.rowid ASC LIMIT 20",
        )
        .all();
      for (const row of rows) {
        try {
          await this.send(JSON.parse(String(row.body)));
        } catch {
          failures++;
        }
      }
    } finally {
      this.running = false;
    }
    return failures;
  }
  async retry(signature: string) {
    const plan = this.plan(signature);
    if (!plan) throw new InputError("Return plan not found.");
    return this.transactions.retryFailed(
      `return:${signature}`,
      plan.source,
      this.payer,
      [{ to: plan.to, lamports: plan.lamports }],
      this.signer,
    );
  }
}
