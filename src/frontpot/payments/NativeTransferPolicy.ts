import { getTransferSolInstruction } from "@solana-program/system";
import {
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import type { Transfer } from "./SettlementOutbox";

export type NativeTransferTerms = {
  source: string;
  payer: string;
  transfers: Transfer[];
  reference?: string;
};

/** Fail closed against extra instructions/signers/lookup tables and altered
 * amounts, recipients, account privileges or memo before requesting a signature. */
export function assertNativeTransfer(wire: string, terms: NativeTransferTerms) {
  if (
    typeof wire !== "string" ||
    wire.length > 1800 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(wire)
  )
    throw new Error("Invalid native transfer encoding");
  const tx = getTransactionDecoder().decode(
    Uint8Array.from(atob(wire), (c) => c.charCodeAt(0)),
  );
  const m = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if (
    !m.lifetimeToken ||
    m.version !== 0 ||
    !terms.transfers.length ||
    terms.transfers.length > 100 ||
    terms.transfers.some(
      (t) =>
        !Number.isSafeInteger(t.lamports) ||
        t.lamports <= 0 ||
        t.to === terms.source,
    )
  )
    throw new Error("Invalid native transfer terms");
  const recentBlockhash = blockhash(String(m.lifetimeToken));
  const expected = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(terms.payer), m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: recentBlockhash, lastValidBlockHeight: 1n },
        m,
      ),
    (m) =>
      appendTransactionMessageInstructions(
        [
          ...terms.transfers.map((t) =>
            getTransferSolInstruction({
              source: createNoopSigner(address(terms.source)),
              destination: address(t.to),
              amount: BigInt(t.lamports),
            }),
          ),
          ...(terms.reference
            ? [
                {
                  programAddress: address(
                    "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
                  ),
                  data: new TextEncoder().encode(terms.reference),
                },
              ]
            : []),
        ],
        m,
      ),
    compileTransaction,
  );
  if (
    tx.messageBytes.length !== expected.messageBytes.length ||
    tx.messageBytes.some((b, i) => b !== expected.messageBytes[i])
  )
    throw new Error("Transaction does not match the approved native transfers");
}
