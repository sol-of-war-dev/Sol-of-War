import { getTransferSolInstruction } from "@solana-program/system";
import {
  createNoopSigner,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getPublicKeyFromAddress,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signatureBytes,
  verifySignature,
} from "@solana/kit";
import type { DatabaseSync } from "node:sqlite";
import { InputError } from "../Store";
import { GENESIS_HASHES, type PaymentNetwork } from "./Network";
import { bindPaymentDatabase } from "./PaymentDatabase";
import type { Transfer } from "./SettlementOutbox";

export type Wire = { transaction: string; lastValidBlockHeight: number };
export type ChainJob = Wire & {
  id: string;
  signature: string;
  attempt?: number;
  finalizedAt?: number;
  finalizedSlot?: number;
  createdAt?: number;
  checkedAt?: number;
  reviewReason?: "expired_unconfirmed" | "transaction_failed";
  confirmationStatus?: string;
  state: "pending" | "finalized" | "review";
};
export interface PoolSigner {
  sign(walletID: string, transaction: string): Promise<string>;
}
/** Verify the selected network before building, signing or recovering transfers. */
export class DevnetRPC {
  constructor(
    readonly url: string,
    private request: typeof fetch = fetch,
    readonly network: PaymentNetwork = "devnet",
  ) {}
  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const response = await this.request(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error("Payment RPC unavailable");
    const data = (await response.json()) as { result?: T; error?: unknown };
    if (data.error || data.result === undefined)
      throw new Error("Payment RPC request failed");
    return data.result;
  }
  async check() {
    if ((await this.call("getGenesisHash")) !== GENESIS_HASHES[this.network])
      throw new Error(`Payment RPC must be Solana ${this.network}`);
  }
  async build(
    source: string,
    feePayer: string,
    transfers: Transfer[],
    reference?: string,
  ): Promise<Wire> {
    await this.check();
    if (!transfers.length || transfers.length > 100)
      throw new Error("Invalid transfer count");
    for (const p of transfers)
      if (
        !Number.isSafeInteger(p.lamports) ||
        p.lamports <= 0 ||
        p.to === source
      )
        throw new Error("Invalid transfer");
    const { value: latest } = await this.call<{
      value: { blockhash: string; lastValidBlockHeight: number };
    }>("getLatestBlockhash", [{ commitment: "finalized" }]);
    const tx = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(address(feePayer), m),
      (m) =>
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: blockhash(latest.blockhash),
            lastValidBlockHeight: BigInt(latest.lastValidBlockHeight),
          },
          m,
        ),
      (m) =>
        appendTransactionMessageInstructions(
          [
            ...transfers.map((p) =>
              getTransferSolInstruction({
                source: createNoopSigner(address(source)),
                destination: address(p.to),
                amount: BigInt(p.lamports),
              }),
            ),
            ...(reference
              ? [
                  {
                    programAddress: address(
                      "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
                    ),
                    data: new TextEncoder().encode(reference),
                  },
                ]
              : []),
          ],
          m,
        ),
      compileTransaction,
    );
    return {
      transaction: getBase64EncodedWireTransaction(tx),
      lastValidBlockHeight: latest.lastValidBlockHeight,
    };
  }
}
const decode = (wire: string) => {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(wire) || wire.length > 1800)
    throw new Error("Invalid transaction encoding");
  return getTransactionDecoder().decode(Buffer.from(wire, "base64"));
};
/** Reject changes to any instruction, amount, destination, blockhash or payer.
 * Privy signing-only wallets may return a raw 64-byte signature. */
export async function acceptSignature(
  unsigned: string,
  signed: string,
  signer: string,
): Promise<string> {
  const original = decode(unsigned);
  if (!(signer in original.signatures)) throw new Error("Unexpected signer");
  const bytes = Buffer.from(signed, "base64");
  const returned =
    bytes.length === 64
      ? {
          ...original,
          signatures: {
            ...original.signatures,
            [signer]: signatureBytes(bytes),
          },
        }
      : decode(signed);
  if (
    !Buffer.from(original.messageBytes).equals(
      Buffer.from(returned.messageBytes),
    )
  )
    throw new Error("Wallet changed the deposit transaction");
  const sig = returned.signatures[address(signer)];
  if (
    !sig ||
    !(await verifySignature(
      await getPublicKeyFromAddress(address(signer)),
      sig,
      original.messageBytes,
    ))
  )
    throw new Error("Invalid wallet signature");
  return getBase64EncodedWireTransaction({
    ...original,
    signatures: { ...original.signatures, [signer]: sig },
  });
}
/** Persist the exact fully signed bytes BEFORE any broadcast. Reconciliation
 * rebroadcasts only these bytes, so a timeout/restart can never pay twice.
 * Expired or failed transactions require review; no blind replacement signing. */
export class DevnetTransactions {
  constructor(
    private db: DatabaseSync,
    readonly rpc: DevnetRPC,
  ) {
    bindPaymentDatabase(db, rpc.network);
    db.exec(
      "CREATE TABLE IF NOT EXISTS chain_jobs(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE UNIQUE INDEX IF NOT EXISTS chain_jobs_signature ON chain_jobs(json_extract(body, '$.signature'));",
    );
    db.exec(
      "CREATE TABLE IF NOT EXISTS chain_attempts(signature TEXT PRIMARY KEY,job_id TEXT NOT NULL,body TEXT NOT NULL)",
    );
  }
  get(id: string): ChainJob | null {
    const row = this.db
      .prepare("SELECT body FROM chain_jobs WHERE id=?")
      .get(id);
    return row ? JSON.parse(String(row.body)) : null;
  }
  private async signedJob(id: string, wire: Wire): Promise<ChainJob> {
    const tx = decode(wire.transaction);
    for (const [key, sig] of Object.entries(tx.signatures))
      if (
        !sig ||
        !(await verifySignature(
          await getPublicKeyFromAddress(address(key)),
          sig,
          tx.messageBytes,
        ))
      )
        throw new Error("Transaction is not fully signed");
    return {
      ...wire,
      id,
      signature: getSignatureFromTransaction(tx),
      state: "pending",
      createdAt: Date.now(),
    };
  }
  async persist(id: string, wire: Wire) {
    const job = await this.signedJob(id, wire);
    // A receipt can fund an entry or be returned, never both. Check and claim
    // under the same SQLite write lock used to persist accidental-return plans.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (
        id.startsWith("deposit:") &&
        this.db
          .prepare("SELECT 1 FROM sqlite_master WHERE name='unmatched_returns'")
          .get() &&
        this.db
          .prepare("SELECT 1 FROM unmatched_returns WHERE signature=?")
          .get(job.signature)
      )
        throw new InputError(
          "This deposit is reserved for return and cannot fund a match.",
        );
      // Competing callers use the winning persisted transaction, never their own.
      this.db
        .prepare(
          "INSERT INTO chain_jobs(id,body) VALUES(?,?) ON CONFLICT(id) DO NOTHING",
        )
        .run(id, JSON.stringify(job));
      const saved = this.get(id)!;
      this.db.exec("COMMIT");
      return saved;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private save(job: ChainJob) {
    const current = this.get(job.id);
    if (
      current &&
      (current.state === "finalized" || current.signature !== job.signature)
    )
      return current;
    this.db
      .prepare("UPDATE chain_jobs SET body=? WHERE id=?")
      .run(JSON.stringify(job), job.id);
    return job;
  }
  /** Inspect the saved signature, including held jobs. Never signs or broadcasts. */
  async inspect(id: string): Promise<ChainJob | null> {
    const job = this.get(id);
    if (!job || job.state === "finalized") return job;
    await this.rpc.check();
    const statuses = await this.rpc.call<{
      value: Array<{
        err: unknown;
        confirmationStatus: string;
        slot?: number;
      } | null>;
    }>("getSignatureStatuses", [
      [job.signature],
      { searchTransactionHistory: true },
    ]);
    const status = statuses.value[0];
    job.checkedAt = Date.now();
    job.confirmationStatus = status?.confirmationStatus;
    if (status?.confirmationStatus === "finalized") {
      job.state = status.err === null ? "finalized" : "review";
      if (job.state === "finalized") {
        job.finalizedAt = Date.now();
        job.finalizedSlot = status.slot;
        delete job.reviewReason;
      } else job.reviewReason = "transaction_failed";
      return this.save(job);
    }
    // A confirmed signature can still finalize after its blockhash expires.
    if (status) return this.save(job);
    const height = await this.rpc.call<number>("getBlockHeight", [
      { commitment: "finalized" },
    ]);
    if (height > job.lastValidBlockHeight) {
      job.state = "review";
      job.reviewReason = "expired_unconfirmed";
      return this.save(job);
    }
    return this.save(job);
  }
  async reconcile(id: string): Promise<ChainJob | null> {
    const existing = this.get(id);
    if (!existing || existing.state !== "pending") return existing;
    const job = await this.inspect(id);
    if (!job || job.state !== "pending" || job.confirmationStatus) return job;
    // A failed send is ambiguous. Leave the saved signature pending for polling.
    try {
      await this.rpc.call("sendTransaction", [
        job.transaction,
        { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 3 },
      ]);
    } catch {
      /* retry identical bytes */
    }
    return job;
  }
  /** Explicit operator retry of a FINALIZED FAILURE only. Unknown/expired
   * signatures are not proof of nonpayment and cannot enter this path. */
  async retryFailed(
    id: string,
    source: { id: string; address: string },
    payer: { id: string; address: string },
    transfers: Transfer[],
    signer: PoolSigner,
  ) {
    const original = this.get(id);
    if (!original || !/^(refund|settlement|return):/.test(id))
      throw new Error("Only recorded outgoing payments can be retried");
    const checked = await this.inspect(id);
    if (
      !checked ||
      checked.signature !== original.signature ||
      checked.state !== "review" ||
      checked.reviewReason !== "transaction_failed" ||
      checked.confirmationStatus !== "finalized"
    )
      throw new Error(
        "Retry requires a finalized failed transaction; uncertain payments stay in review",
      );
    const wire = await this.rpc.build(source.address, payer.address, transfers);
    const message = (tx: string) =>
      getCompiledTransactionMessageDecoder().decode(decode(tx).messageBytes);
    const oldMessage = message(original.transaction),
      newMessage = message(wire.transaction);
    // A retry may change only the recent blockhash, never accounts/instructions.
    if (
      JSON.stringify({ ...oldMessage, lifetimeToken: "" }) !==
      JSON.stringify({ ...newMessage, lifetimeToken: "" })
    )
      throw new Error(
        "Replacement payment differs from the original transaction",
      );
    if (oldMessage.lifetimeToken === newMessage.lifetimeToken)
      throw new Error(
        "Wait for a newer blockhash before retrying this payment",
      );
    let signed = await acceptSignature(
      wire.transaction,
      await signer.sign(source.id, wire.transaction),
      source.address,
    );
    if (payer.address !== source.address)
      signed = await acceptSignature(
        signed,
        await signer.sign(payer.id, signed),
        payer.address,
      );
    const replacement = await this.signedJob(id, {
      ...wire,
      transaction: signed,
    });
    replacement.attempt = (original.attempt ?? 1) + 1;
    if (
      this.db
        .prepare("SELECT 1 FROM chain_attempts WHERE signature=?")
        .get(replacement.signature)
    )
      throw new Error("Replacement reuses a previous failed signature");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.get(id)!;
      if (
        current.signature !== original.signature ||
        current.state !== "review"
      ) {
        this.db.exec("COMMIT");
        return current;
      }
      this.db
        .prepare("INSERT INTO chain_attempts VALUES(?,?,?)")
        .run(original.signature, id, JSON.stringify(checked));
      this.db
        .prepare("UPDATE chain_jobs SET body=? WHERE id=?")
        .run(JSON.stringify(replacement), id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    // Persist first; worker broadcasts the replacement using the existing job ID.
    return replacement;
  }
  async send(
    id: string,
    source: { id: string; address: string },
    payer: { id: string; address: string },
    transfers: Transfer[],
    signer: PoolSigner,
    reference?: string,
  ) {
    await this.rpc.check();
    if (!this.get(id)) {
      const wire = await this.rpc.build(
        source.address,
        payer.address,
        transfers,
        reference,
      );
      let signed = await acceptSignature(
        wire.transaction,
        await signer.sign(source.id, wire.transaction),
        source.address,
      );
      if (payer.address !== source.address)
        signed = await acceptSignature(
          signed,
          await signer.sign(payer.id, signed),
          payer.address,
        );
      await this.persist(id, { ...wire, transaction: signed });
    }
    return (await this.reconcile(id))!;
  }
}
