import { z } from "zod";
import { decodeAddress } from "../Wallet";
import { DEVNET_GENESIS_HASH } from "./DevnetNetwork";

const account = z.object({ pubkey: z.string(), signer: z.boolean() });
const instruction = z.object({
  programId: z.string(),
  parsed: z
    .object({
      type: z.string(),
      info: z.object({
        source: z.string(),
        destination: z.string(),
        lamports: z.number().int().safe(),
      }),
    })
    .optional(),
});
const transaction = z.object({
  blockTime: z.number().int(),
  meta: z.object({ err: z.null() }),
  transaction: z.object({
    signatures: z.array(z.string()),
    message: z.object({
      accountKeys: z.array(account),
      instructions: z.array(instruction),
    }),
  }),
});
export type DepositTerms = {
  signature: string;
  source: string;
  destination: string;
  lamports: number;
  opensAt: number;
  closesAt: number;
};
/** Examine a finalized RPC response, never a client-supplied parsed receipt.
 * Strict direct SOL transfers only. Unsupported transfers go to reconciliation.
 */
export function verifyDepositTransaction(
  raw: unknown,
  terms: DepositTerms,
): void {
  decodeAddress(terms.source);
  decodeAddress(terms.destination);
  if (
    !Number.isSafeInteger(terms.lamports) ||
    terms.lamports <= 0 ||
    terms.source === terms.destination
  )
    throw new Error("Invalid deposit terms");
  const tx = transaction.parse(raw);
  if (
    tx.transaction.signatures[0] !== terms.signature ||
    tx.blockTime * 1000 < terms.opensAt ||
    tx.blockTime * 1000 > terms.closesAt
  )
    throw new Error("Deposit does not belong to this funding window");
  if (
    !tx.transaction.message.accountKeys.some(
      (a) => a.pubkey === terms.source && a.signer,
    )
  )
    throw new Error("Deposit sender did not sign");
  const transfers = tx.transaction.message.instructions.filter(
    (i) =>
      i.programId === "11111111111111111111111111111111" &&
      i.parsed?.type === "transfer" &&
      i.parsed.info.destination === terms.destination,
  );
  if (
    transfers.length !== 1 ||
    transfers[0].parsed!.info.source !== terms.source ||
    transfers[0].parsed!.info.lamports !== terms.lamports
  )
    throw new Error("Deposit must equal the agreed stake and destination");
}

export async function verifyFinalizedDeposit(
  rpcURL: string,
  terms: DepositTerms,
  request: typeof fetch = fetch,
): Promise<void> {
  const rpc = async (method: string, params: unknown[]) => {
    const response = await request(rpcURL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error("Solana RPC unavailable");
    const body = (await response.json()) as {
      result?: unknown;
      error?: unknown;
    };
    if (body.error || body.result === undefined)
      throw new Error("Solana RPC did not confirm the deposit");
    return body.result;
  };
  if ((await rpc("getGenesisHash", [])) !== DEVNET_GENESIS_HASH)
    throw new Error("Deposit RPC must be Solana devnet");
  const status = (await rpc("getSignatureStatuses", [
    [terms.signature],
    { searchTransactionHistory: true },
  ])) as { value?: Array<{ err: unknown; confirmationStatus: string } | null> };
  if (
    status.value?.[0]?.confirmationStatus !== "finalized" ||
    status.value[0].err !== null
  )
    throw new Error("Deposit is not finalized");
  verifyDepositTransaction(
    await rpc("getTransaction", [
      terms.signature,
      {
        encoding: "jsonParsed",
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
      },
    ]),
    terms,
  );
}
