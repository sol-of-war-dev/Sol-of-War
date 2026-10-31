import {
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";
import type { ChainJob } from "./DevnetTransactions";

export type PublicTransfer = {
  signature: string;
  state: "pending" | "finalized" | "review";
  feePayer: string | null;
  finalizedAt: number | null;
  finalizedSlot: number | null;
};
export type PublicPaymentFlow = {
  poolAddress: string | null;
  treasury: string;
  entries: {
    name: string;
    source: string;
    lamports: number;
    deposit: PublicTransfer;
    refund: PublicTransfer | null;
  }[];
  settlement: {
    poolLamports: number;
    feeLamports: number;
    prizes: { to: string; lamports: number }[];
    transaction: PublicTransfer | null;
  } | null;
};
/** Public chain evidence only: never expose serialized transactions or signer IDs. */
export function publicTransfer(
  job: ChainJob | null | undefined,
): PublicTransfer | null {
  if (!job) return null;
  let feePayer: string | null = null;
  try {
    const tx = getTransactionDecoder().decode(
      Buffer.from(job.transaction, "base64"),
    );
    feePayer =
      getCompiledTransactionMessageDecoder().decode(tx.messageBytes)
        .staticAccounts[0] ?? null;
  } catch {
    /* Historical receipt can still be shown without a decoded payer. */
  }
  return {
    signature: job.signature,
    state: job.state,
    feePayer,
    finalizedAt: job.finalizedAt ?? null,
    finalizedSlot: job.finalizedSlot ?? null,
  };
}
