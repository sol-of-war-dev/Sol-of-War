import type { DatabaseSync } from "node:sqlite";
import type { PaymentNetwork } from "./Network";
/** A database and every transaction in it belong to exactly one funded network.
 * Legacy devnet tables retain their names to avoid rewriting payment records. */
export function bindPaymentDatabase(db: DatabaseSync, network: PaymentNetwork) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS payment_network(id INTEGER PRIMARY KEY CHECK(id=1),network TEXT NOT NULL)",
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    const saved = db
      .prepare("SELECT network FROM payment_network WHERE id=1")
      .get();
    if (saved && saved.network !== network)
      throw new Error(
        "Payment database belongs to a different network. Use a separate state directory.",
      );
    if (!saved) {
      const exists = (table: string) =>
        !!db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
          .get(table);
      // Every pre-network-binding wire transaction was devnet. Fail closed even
      // if it is already finalized: a different cluster cannot inherit receipts.
      if (
        network === "mainnet" &&
        ["chain_jobs", "devnet_matches", "devnet_entries", "settlements"].some(
          (t) => exists(t) && db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get(),
        )
      )
        throw new Error(
          "Legacy payment records require a separate mainnet database.",
        );
      if (
        exists("pools") &&
        db
          .prepare(
            "SELECT 1 FROM pools WHERE json_extract(body,'$.network')!='simulation' AND json_extract(body,'$.network')!=? LIMIT 1",
          )
          .get(network)
      )
        throw new Error("Match ledger belongs to a different network.");
      db.prepare(
        "INSERT INTO payment_network VALUES(1,?) ON CONFLICT(id) DO NOTHING",
      ).run(network);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
