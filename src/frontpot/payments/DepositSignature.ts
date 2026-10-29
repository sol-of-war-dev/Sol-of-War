import {
  address,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getPublicKeyFromAddress,
  getSignatureFromTransaction,
  getTransactionDecoder,
  verifySignature,
} from "@solana/kit";
import { InputError } from "../Store";
import {
  acceptSignature,
  type DevnetRPC,
  type Wire,
} from "./DevnetTransactions";

const SYSTEM = "11111111111111111111111111111111";
const COMPUTE = "ComputeBudget111111111111111111111111111111";
const changed = () =>
  new InputError(
    "Your wallet changed the entry amount, destination, signer, or supported instructions. No payment was sent.",
  );
const decode = (wire: string) => {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(wire) || wire.length > 1800)
    throw changed();
  try {
    return getTransactionDecoder().decode(Buffer.from(wire, "base64"));
  } catch {
    throw changed();
  }
};

/** Only the player's exact native-SOL transfer plus optional network-fee
 * instructions. No other program, recipient, signer or lookup table is allowed. */
function terms(wire: string, signer: string) {
  const tx = decode(wire);
  let m;
  try {
    m = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  } catch {
    throw changed();
  }
  if (
    (m.version !== 0 && m.version !== "legacy") ||
    (m.version === 0 && m.addressTableLookups?.length) ||
    m.header.numSignerAccounts !== 1 ||
    m.header.numReadonlySignerAccounts !== 0 ||
    m.staticAccounts[0] !== signer ||
    new Set(m.staticAccounts).size !== m.staticAccounts.length
  )
    throw changed();
  const writableEnd =
    m.staticAccounts.length - m.header.numReadonlyNonSignerAccounts;
  const used = new Set<string>([signer]);
  const computeTags = new Set<number>();
  let transfer: { destination: string; data: string } | undefined;
  for (const instruction of m.instructions) {
    const program = m.staticAccounts[instruction.programAddressIndex];
    const indices = instruction.accountIndices ?? [];
    const data = Buffer.from(instruction.data ?? []);
    if (!program || instruction.programAddressIndex < writableEnd)
      throw changed();
    used.add(program);
    if (program === SYSTEM) {
      if (
        transfer ||
        indices.length !== 2 ||
        indices[0] !== 0 ||
        indices[1] < 1 ||
        indices[1] >= writableEnd ||
        data.length !== 12 ||
        data.readUInt32LE(0) !== 2 ||
        data.readBigUInt64LE(4) === 0n
      )
        throw changed();
      const destination = m.staticAccounts[indices[1]];
      if (!destination || destination === signer) throw changed();
      used.add(destination);
      transfer = { destination, data: data.toString("hex") };
    } else if (program === COMPUTE) {
      const tag = data[0];
      if (indices.length || computeTags.has(tag)) throw changed();
      // Priority fees are paid only by the signing player, never the pool or
      // platform fee payer. The wallet presents these fees for user approval.
      if (tag === 2) {
        if (
          data.length !== 5 ||
          data.readUInt32LE(1) < 1 ||
          data.readUInt32LE(1) > 1_400_000
        )
          throw changed();
      } else if (tag !== 3 || data.length !== 9) throw changed();
      computeTags.add(tag);
    } else throw changed();
  }
  if (
    !transfer ||
    used.size !== m.staticAccounts.length ||
    m.staticAccounts.some((a) => !used.has(a))
  )
    throw changed();
  return { tx, transfer, blockhash: m.lifetimeToken };
}

/** External wallets may recompile the message, add priority-fee instructions,
 * or refresh its blockhash. Validate signed payment semantics, not serialization.
 * Platform payout/refund signing continues to require byte-identical messages. */
export async function validateDepositSignature(
  issued: Wire,
  returned: string,
  signer: string,
) {
  const expected = terms(issued.transaction, signer);
  const signed =
    Buffer.from(returned, "base64").length === 64
      ? await acceptSignature(issued.transaction, returned, signer)
      : returned;
  const actual = terms(signed, signer);
  if (
    actual.transfer.destination !== expected.transfer.destination ||
    actual.transfer.data !== expected.transfer.data
  )
    throw changed();
  const signature = actual.tx.signatures[address(signer)];
  if (
    !signature ||
    !(await verifySignature(
      await getPublicKeyFromAddress(address(signer)),
      signature,
      actual.tx.messageBytes,
    ))
  )
    throw new InputError(
      "The wallet signature could not be verified. No payment was sent.",
    );
  return { expected, actual };
}

export async function acceptDepositSignature(
  issued: Wire,
  returned: string,
  signer: string,
  rpc: DevnetRPC,
): Promise<Wire> {
  const { expected, actual } = await validateDepositSignature(
    issued,
    returned,
    signer,
  );
  let lastValidBlockHeight = issued.lastValidBlockHeight;
  if (actual.blockhash !== expected.blockhash) {
    await rpc.check();
    // A wallet may have already broadcast, or history recovery may find this
    // deposit after its blockhash expires. Keep the original signed receipt.
    const statuses = await rpc.call<{
      value: Array<{ err: unknown; confirmationStatus: string } | null>;
    }>("getSignatureStatuses", [
      [getSignatureFromTransaction(actual.tx)],
      { searchTransactionHistory: true },
    ]);
    if (statuses.value[0]?.confirmationStatus === "finalized") {
      if (statuses.value[0].err !== null)
        throw new InputError(
          "The wallet transaction failed on-chain. No entry was credited.",
        );
      return {
        transaction: getBase64EncodedWireTransaction(actual.tx),
        lastValidBlockHeight,
      };
    }
    const valid = await rpc.call<{ context: { slot: number }; value: boolean }>(
      "isBlockhashValid",
      [actual.blockhash, { commitment: "confirmed" }],
    );
    if (!valid.value)
      throw new InputError(
        "The wallet payment request expired. Leave this lobby and create a new one. No payment was sent.",
      );
    // A latest blockhash at or after the validation slot gives a conservative
    // upper bound on the accepted hash's lifetime. An uncertain transfer is
    // still held for reconciliation; this never authorizes a replacement.
    const latest = await rpc.call<{ value: { lastValidBlockHeight: number } }>(
      "getLatestBlockhash",
      [{ commitment: "confirmed", minContextSlot: valid.context.slot }],
    );
    if (
      !Number.isSafeInteger(latest.value.lastValidBlockHeight) ||
      latest.value.lastValidBlockHeight < 1
    )
      throw new Error("Could not validate payment expiration");
    lastValidBlockHeight = latest.value.lastValidBlockHeight;
  }
  return {
    transaction: getBase64EncodedWireTransaction(actual.tx),
    lastValidBlockHeight,
  };
}
