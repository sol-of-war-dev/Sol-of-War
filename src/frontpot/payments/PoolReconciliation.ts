import {
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getSignatureFromTransaction,
} from "@solana/kit";
import type { DatabaseSync } from "node:sqlite";
import type { DevnetRPC } from "./DevnetTransactions";
type PoolRow = { id: string; wallet?: { address: string } };
type Cursor = {
  anchor?: string;
  before?: string;
  head?: string;
  checkedAt?: number;
  balance?: string;
  expected?: string;
  difference?: string;
  complete?: boolean;
  error?: boolean;
};
export function expectedPoolBalance(db: DatabaseSync, id: string) {
  let total = 0n;
  const finalized = (jobID: string) =>
    db
      .prepare(
        "SELECT 1 FROM chain_jobs WHERE id=? AND json_extract(body,'$.state')='finalized'",
      )
      .get(jobID);
  for (const row of db
    .prepare("SELECT body FROM devnet_entries WHERE match_id=?")
    .all(id)) {
    const entry = JSON.parse(String(row.body));
    if (finalized(`deposit:${entry.id}`)) total += BigInt(entry.lamports);
    if (finalized(`refund:${entry.id}`)) total -= BigInt(entry.lamports);
  }
  const row = db
    .prepare("SELECT body FROM settlements WHERE match_id=?")
    .get(id);
  if (row) {
    const job = JSON.parse(String(row.body));
    if (finalized(`settlement:${job.key}`))
      total -= BigInt(job.plan.poolLamports);
  }
  return total;
}
/** Finalized history is paginated durably. Unmatched transfers are recorded,
 * never silently added to a game's prize or treated as an eligible seat. */
export class PoolReconciliation {
  constructor(
    private db: DatabaseSync,
    private rpc: DevnetRPC,
    private importDeposit: (matchID: string, wire: string) => Promise<boolean>,
  ) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS pool_reconciliation(match_id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS unmatched_pool_transactions(match_id TEXT NOT NULL,signature TEXT NOT NULL,slot INTEGER NOT NULL,delta TEXT NOT NULL,PRIMARY KEY(match_id,signature)); CREATE TABLE IF NOT EXISTS unmatched_returns(signature TEXT PRIMARY KEY,match_id TEXT NOT NULL,body TEXT NOT NULL);",
    );
  }
  private cursor(id: string): Cursor {
    const r = this.db
      .prepare("SELECT body FROM pool_reconciliation WHERE match_id=?")
      .get(id);
    return r ? JSON.parse(String(r.body)) : {};
  }
  private save(id: string, value: Cursor) {
    this.db
      .prepare(
        "INSERT INTO pool_reconciliation VALUES(?,?) ON CONFLICT(match_id) DO UPDATE SET body=excluded.body",
      )
      .run(id, JSON.stringify(value));
  }
  private known(signature: string) {
    return !!this.db
      .prepare(
        "SELECT 1 FROM chain_jobs WHERE json_extract(body,'$.signature')=? UNION ALL SELECT 1 FROM chain_attempts WHERE signature=? LIMIT 1",
      )
      .get(signature, signature);
  }
  expected(id: string) {
    return expectedPoolBalance(this.db, id);
  }
  async scan(id: string) {
    const row = this.db
      .prepare("SELECT body FROM devnet_matches WHERE id=?")
      .get(id);
    const pool: PoolRow | undefined = row
      ? JSON.parse(String(row.body))
      : undefined;
    if (!pool?.wallet) return;
    const state = this.cursor(id);
    try {
      await this.rpc.check();
      const page = await this.rpc.call<
        Array<{ signature: string; slot: number }>
      >("getSignaturesForAddress", [
        pool.wallet.address,
        {
          commitment: "finalized",
          limit: 100,
          ...(state.before ? { before: state.before } : {}),
        },
      ]);
      if (!state.before) state.head = page[0]?.signature ?? state.anchor;
      let done = page.length < 100;
      for (const item of page) {
        if (item.signature === state.anchor) {
          done = true;
          break;
        }
        if (!Number.isSafeInteger(item.slot) || item.slot < 0)
          throw new Error("Invalid finalized slot");
        if (this.known(item.signature)) {
          this.db
            .prepare(
              "DELETE FROM unmatched_pool_transactions WHERE match_id=? AND signature=?",
            )
            .run(id, item.signature);
          continue;
        }
        if (
          this.db
            .prepare(
              "SELECT 1 FROM unmatched_pool_transactions WHERE match_id=? AND signature=?",
            )
            .get(id, item.signature)
        )
          continue;
        const tx = await this.rpc.call<null | {
          transaction: [string, string];
          meta: {
            preBalances: number[];
            postBalances: number[];
            loadedAddresses?: { writable: string[]; readonly: string[] };
          };
        }>("getTransaction", [
          item.signature,
          {
            encoding: "base64",
            commitment: "finalized",
            maxSupportedTransactionVersion: 0,
          },
        ]);
        if (!tx?.meta || tx.transaction[1] !== "base64")
          throw new Error("Finalized transaction history unavailable");
        const decoded = getTransactionDecoder().decode(
          Buffer.from(tx.transaction[0], "base64"),
        );
        if (getSignatureFromTransaction(decoded) !== item.signature)
          throw new Error("Transaction signature mismatch");
        if (await this.importDeposit(id, tx.transaction[0])) continue;
        const message = getCompiledTransactionMessageDecoder().decode(
          decoded.messageBytes,
        );
        const accounts = [
          ...message.staticAccounts,
          ...(tx.meta.loadedAddresses?.writable ?? []),
          ...(tx.meta.loadedAddresses?.readonly ?? []),
        ];
        const index = accounts.indexOf(pool.wallet.address as never),
          pre = tx.meta.preBalances[index],
          post = tx.meta.postBalances[index];
        if (
          index < 0 ||
          !Number.isSafeInteger(pre) ||
          !Number.isSafeInteger(post) ||
          pre < 0 ||
          post < 0
        )
          throw new Error("Invalid pool balance evidence");
        const delta = BigInt(post) - BigInt(pre);
        this.db
          .prepare(
            "INSERT OR IGNORE INTO unmatched_pool_transactions VALUES(?,?,?,?)",
          )
          .run(id, item.signature, item.slot, String(delta));
      }
      state.complete = done;
      state.error = false;
      state.checkedAt = Date.now();
      if (done) {
        state.anchor = state.head;
        delete state.before;
        delete state.head;
        const balance = await this.rpc.call<{ value: number }>("getBalance", [
          pool.wallet.address,
          { commitment: "finalized" },
        ]);
        if (!Number.isSafeInteger(balance.value) || balance.value < 0)
          throw new Error("Invalid pool balance");
        const expected = this.expected(id);
        state.balance = String(balance.value);
        state.expected = String(expected);
        state.difference = String(BigInt(balance.value) - expected);
      } else state.before = page[page.length - 1].signature;
      this.save(id, state);
    } catch {
      state.error = true;
      state.checkedAt = Date.now();
      this.save(id, state);
      throw new Error("Pool reconciliation incomplete");
    }
  }
  async tick() {
    // Bounded RPC work; oldest checks first. A page cursor survives restarts.
    const rows = this.db
      .prepare(
        "SELECT m.id FROM devnet_matches m LEFT JOIN pool_reconciliation r ON r.match_id=m.id WHERE json_extract(m.body,'$.wallet.address') IS NOT NULL ORDER BY COALESCE(json_extract(r.body,'$.checkedAt'),0) ASC LIMIT 3",
      )
      .all();
    let failures = 0;
    for (const row of rows)
      try {
        await this.scan(String(row.id));
      } catch {
        failures++;
      }
    return failures;
  }
  snapshot() {
    const pools = this.db
      .prepare("SELECT match_id,body FROM pool_reconciliation")
      .all()
      .map((r) => ({
        matchID: String(r.match_id),
        ...(JSON.parse(String(r.body)) as Cursor),
      }));
    return {
      poolsChecked: pools.length,
      issues: pools
        .filter(
          (p) =>
            p.error === true ||
            p.complete === false ||
            (p.difference !== undefined && p.difference !== "0"),
        )
        .slice(0, 20),
      unmatched: this.db
        .prepare(
          "SELECT t.match_id AS matchID,t.signature,t.slot,t.delta,CASE WHEN r.signature IS NULL THEN 'unreviewed' ELSE COALESCE(json_extract(j.body,'$.state'),'preparing') END AS state FROM unmatched_pool_transactions t LEFT JOIN unmatched_returns r ON r.signature=t.signature LEFT JOIN chain_jobs j ON j.id='return:' || t.signature WHERE COALESCE(json_extract(j.body,'$.state'),'')!='finalized' ORDER BY t.rowid DESC LIMIT 20",
        )
        .all()
        .map((r) => ({
          matchID: String(r.matchID),
          signature: String(r.signature),
          slot: Number(r.slot),
          delta: String(r.delta),
          state: String(r.state),
        })),
    };
  }
}
