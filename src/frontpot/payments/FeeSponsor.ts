import { getTransactionDecoder } from "@solana/kit";
import type { DatabaseSync } from "node:sqlite";
import { assertBurn, type BurnTerms } from "../shop/BurnPolicy";
import { InputError } from "../Store";
import {
  acceptSignature,
  type DevnetRPC,
  type PoolSigner,
  type Wire,
} from "./DevnetTransactions";
import {
  assertNativeTransfer,
  type NativeTransferTerms,
} from "./NativeTransferPolicy";

/** Co-sign only an exact server-issued transfer already authorized by its owner.
 * No delegation, arbitrary transaction relay, or priority-fee instructions. */
export class FeeSponsor {
  constructor(
    private db: DatabaseSync,
    readonly payer: { id: string; address: string },
    private signer: PoolSigner,
    private rpc: DevnetRPC,
  ) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS fee_sponsorships(id TEXT PRIMARY KEY,player_id TEXT NOT NULL,day TEXT NOT NULL,lamports INTEGER NOT NULL)",
    );
  }
  async sign(
    id: string,
    playerID: string,
    issued: Wire,
    returned: string,
    terms: Omit<NativeTransferTerms, "payer">,
  ): Promise<Wire> {
    if (terms.source === this.payer.address)
      throw new InputError("Invalid sponsored source");
    assertNativeTransfer(issued.transaction, {
      ...terms,
      payer: this.payer.address,
    });
    return this.cosign(id, playerID, issued, returned, terms.source);
  }
  async signBurn(
    id: string,
    playerID: string,
    issued: Wire,
    returned: string,
    terms: BurnTerms,
  ): Promise<Wire> {
    if (
      !id.startsWith("shop:") ||
      terms.payer !== this.payer.address ||
      terms.source === this.payer.address
    )
      throw new InputError("Invalid burn sponsor");
    assertBurn(issued.transaction, terms);
    return this.cosign(id, playerID, issued, returned, terms.source);
  }
  private async cosign(
    id: string,
    playerID: string,
    issued: Wire,
    returned: string,
    source: string,
  ): Promise<Wire> {
    // Verify the user's signature before spending sponsor budget or calling its signer.
    const userSigned = await acceptSignature(
      issued.transaction,
      returned,
      source,
    );
    await this.rpc.check();
    const height = await this.rpc.call<number>("getBlockHeight", [
      { commitment: "confirmed" },
    ]);
    if (!Number.isSafeInteger(height) || height > issued.lastValidBlockHeight)
      throw new InputError(
        "The payment approval expired. No sponsored payment was submitted.",
      );
    const tx = getTransactionDecoder().decode(
      Buffer.from(userSigned, "base64"),
    );
    const fee = await this.rpc.call<{ value: number | null }>(
      "getFeeForMessage",
      [
        Buffer.from(tx.messageBytes).toString("base64"),
        { commitment: "confirmed" },
      ],
    );
    if (
      !Number.isSafeInteger(fee.value) ||
      fee.value === null ||
      fee.value <= 0 ||
      fee.value > 20_000
    )
      throw new InputError(
        "Network fee sponsorship is temporarily unavailable. Your wallet will not be charged instead.",
      );
    const simulation = await this.rpc.call<{ value: { err: unknown } }>(
      "simulateTransaction",
      [
        userSigned,
        { encoding: "base64", sigVerify: false, commitment: "confirmed" },
      ],
    );
    if (simulation.value.err !== null)
      throw new InputError(
        "The transfer could not be simulated successfully. No sponsored payment was submitted.",
      );
    // Durable daily budgets: 0.1 SOL overall, 0.002 per player.
    // Reserve before signing; failures remain charged to the budget. Retries of
    // the same intent reserve no more, and the fixed 20k cap covers its fee.
    const day = new Date().toISOString().slice(0, 10);
    if (!this.db.prepare("SELECT 1 FROM fee_sponsorships WHERE id=?").get(id)) {
      const totals = this.db
        .prepare(
          "SELECT COALESCE(SUM(lamports),0) AS total,COALESCE(SUM(CASE WHEN player_id=? THEN lamports ELSE 0 END),0) AS player FROM fee_sponsorships WHERE day=?",
        )
        .get(playerID, day)!;
      if (
        Number(totals.total) + 20_000 > 100_000_000 ||
        Number(totals.player) + 20_000 > 2_000_000
      )
        throw new InputError(
          "Today's network fee sponsorship limit has been reached. No payment was submitted.",
        );
      this.db
        .prepare("INSERT INTO fee_sponsorships VALUES(?,?,?,?)")
        .run(id, playerID, day, 20_000);
    }
    const signed = await acceptSignature(
      userSigned,
      await this.signer.sign(this.payer.id, userSigned),
      this.payer.address,
    );
    return { ...issued, transaction: signed };
  }
}
