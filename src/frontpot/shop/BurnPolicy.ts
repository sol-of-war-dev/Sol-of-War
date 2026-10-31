import { getBurnCheckedInstruction } from "@solana-program/token";
import {
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export type BurnTerms = {
  program: string;
  source: string;
  payer: string;
  account: string;
  mint: string;
  amount: string;
  decimals: number;
  reference: string;
};
export function buildBurn(terms: BurnTerms, hash: string, height: number) {
  if (
    !/^[1-9][0-9]{0,19}$/.test(terms.amount) ||
    BigInt(terms.amount) > 18446744073709551615n ||
    !Number.isInteger(terms.decimals) ||
    terms.decimals < 0 ||
    terms.decimals > 9 ||
    terms.source === terms.payer ||
    ![TOKEN_PROGRAM, TOKEN_2022_PROGRAM].includes(terms.program) ||
    !/^sow-shop:[0-9a-f-]{36}$/.test(terms.reference)
  )
    throw new Error("Invalid cosmetic burn terms");
  return pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(terms.payer), m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: blockhash(hash), lastValidBlockHeight: BigInt(height) },
        m,
      ),
    (m) =>
      appendTransactionMessageInstructions(
        [
          getBurnCheckedInstruction(
            {
              account: address(terms.account),
              mint: address(terms.mint),
              authority: createNoopSigner(address(terms.source)),
              amount: BigInt(terms.amount),
              decimals: terms.decimals,
            },
            { programAddress: address(terms.program) },
          ),
          {
            programAddress: address(
              "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
            ),
            data: new TextEncoder().encode(terms.reference),
          },
        ],
        m,
      ),
    compileTransaction,
  );
}
export function burnWire(terms: BurnTerms, hash: string, height: number) {
  return getBase64EncodedWireTransaction(buildBurn(terms, hash, height));
}
/** Both browser and sponsor reject any extra instruction or altered account/amount. */
export function assertBurn(wire: string, terms: BurnTerms) {
  if (
    typeof wire !== "string" ||
    wire.length > 1800 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(wire)
  )
    throw new Error("Invalid burn transaction");
  const tx = getTransactionDecoder().decode(
    Uint8Array.from(atob(wire), (c) => c.charCodeAt(0)),
  );
  const m = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const expected = buildBurn(terms, String(m.lifetimeToken), 1);
  if (
    tx.messageBytes.length !== expected.messageBytes.length ||
    tx.messageBytes.some((b, i) => b !== expected.messageBytes[i])
  )
    throw new Error("Transaction does not match the approved cosmetic burn");
}
