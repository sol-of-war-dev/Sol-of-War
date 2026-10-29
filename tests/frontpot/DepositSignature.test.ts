import {
  address,
  generateKeyPair,
  getAddressFromPublicKey,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
  partiallySignTransaction,
  signBytes,
} from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { acceptDepositSignature } from "../../src/frontpot/payments/DepositSignature";
import {
  acceptSignature,
  DevnetRPC,
} from "../../src/frontpot/payments/DevnetTransactions";
import { GENESIS_HASHES } from "../../src/frontpot/payments/Network";
import { InputError } from "../../src/frontpot/Store";

const COMPUTE = address("ComputeBudget111111111111111111111111111111");
async function fixture() {
  const key = await generateKeyPair();
  const payer = await getAddressFromPublicKey(key.publicKey);
  const recipient = await getAddressFromPublicKey(
    (await generateKeyPair()).publicKey,
  );
  let valid = true,
    finalized = false;
  const request = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const { method } = JSON.parse(init!.body as string);
    const result =
      method === "getGenesisHash"
        ? GENESIS_HASHES.mainnet
        : method === "getLatestBlockhash"
          ? {
              value: {
                blockhash: "11111111111111111111111111111111",
                lastValidBlockHeight: 900,
              },
            }
          : method === "isBlockhashValid"
            ? { context: { slot: 500 }, value: valid }
            : method === "getSignatureStatuses"
              ? {
                  value: [
                    finalized
                      ? { err: null, confirmationStatus: "finalized" }
                      : null,
                  ],
                }
              : undefined;
    if (result === undefined) throw new Error(`Unexpected RPC ${method}`);
    return new Response(JSON.stringify({ result }));
  });
  const rpc = new DevnetRPC(
    "https://rpc.invalid",
    request as typeof fetch,
    "mainnet",
  );
  const issued = await rpc.build(payer, payer, [
    { to: recipient, lamports: 1_000_000 },
  ]);
  issued.lastValidBlockHeight = 200;
  const tx = getTransactionDecoder().decode(
    Buffer.from(issued.transaction, "base64"),
  );
  const message = getCompiledTransactionMessageDecoder().decode(
    tx.messageBytes,
  );
  if (message.version !== 0) throw new Error("Expected v0");
  const sign = async (
    m: Parameters<
      ReturnType<typeof getCompiledTransactionMessageEncoder>["encode"]
    >[0] = message,
  ) =>
    getBase64EncodedWireTransaction(
      await partiallySignTransaction([key], {
        ...tx,
        messageBytes: getCompiledTransactionMessageEncoder().encode(
          m,
        ) as typeof tx.messageBytes,
      }),
    );
  const compute = () => {
    const limit = Buffer.alloc(5);
    limit[0] = 2;
    limit.writeUInt32LE(200_000, 1);
    const price = Buffer.alloc(9);
    price[0] = 3;
    price.writeBigUInt64LE(1_000n, 1);
    return {
      ...message,
      header: { ...message.header, numReadonlyNonSignerAccounts: 2 },
      staticAccounts: [...message.staticAccounts, COMPUTE],
      instructions: [
        { programAddressIndex: 3, data: limit },
        { programAddressIndex: 3, data: price },
        ...message.instructions,
      ],
    };
  };
  return {
    key,
    payer,
    recipient,
    rpc,
    request,
    issued,
    tx,
    message,
    sign,
    compute,
    expired: () => {
      valid = false;
    },
    finalized: () => {
      finalized = true;
    },
  };
}

describe("external wallet deposit validation", () => {
  it("accepts unchanged signatures and legacy serialization while pool signing stays strict", async () => {
    const f = await fixture();
    const unchanged = await f.sign();
    expect(
      (await acceptDepositSignature(f.issued, unchanged, f.payer, f.rpc))
        .transaction,
    ).toBe(unchanged);
    const legacy = await f.sign({ ...f.message, version: "legacy" });
    expect(
      (await acceptDepositSignature(f.issued, legacy, f.payer, f.rpc))
        .transaction,
    ).toBe(legacy);
    await expect(
      acceptSignature(f.issued.transaction, legacy, f.payer),
    ).rejects.toThrow("changed");
    const raw = Buffer.from(
      await signBytes(f.key.privateKey, f.tx.messageBytes),
    ).toString("base64");
    expect(
      (await acceptDepositSignature(f.issued, raw, f.payer, f.rpc)).transaction,
    ).toBe(unchanged);
  });
  it("accepts priority fee instructions and reordered readonly program accounts", async () => {
    const f = await fixture();
    const m = f.compute();
    [m.staticAccounts[2], m.staticAccounts[3]] = [
      m.staticAccounts[3],
      m.staticAccounts[2],
    ];
    m.instructions = m.instructions.map((i) => ({
      ...i,
      programAddressIndex: i.programAddressIndex === 2 ? 3 : 2,
    }));
    const signed = await f.sign(m);
    expect(
      (await acceptDepositSignature(f.issued, signed, f.payer, f.rpc))
        .transaction,
    ).toBe(signed);
    await expect(
      acceptSignature(f.issued.transaction, signed, f.payer),
    ).rejects.toThrow("changed");
  });
  it("validates refreshed blockhashes and persists a conservative expiration bound", async () => {
    const f = await fixture();
    const signed = await f.sign({ ...f.message, lifetimeToken: f.recipient });
    const result = await acceptDepositSignature(
      f.issued,
      signed,
      f.payer,
      f.rpc,
    );
    expect(result).toEqual({ transaction: signed, lastValidBlockHeight: 900 });
    const calls = f.request.mock.calls.map((c) =>
      JSON.parse(c[1]!.body as string),
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        method: "getLatestBlockhash",
        params: [{ commitment: "confirmed", minContextSlot: 500 }],
      }),
    );
    f.expired();
    await expect(
      acceptDepositSignature(f.issued, signed, f.payer, f.rpc),
    ).rejects.toThrow("expired");
    f.finalized();
    expect(
      (await acceptDepositSignature(f.issued, signed, f.payer, f.rpc))
        .transaction,
    ).toBe(signed);
  });
  it("rejects changed amount, changed recipient, and a second transfer", async () => {
    const f = await fixture();
    const data = Buffer.from(f.message.instructions[0].data!);
    data.writeBigUInt64LE(2_000_000n, 4);
    const another = await getAddressFromPublicKey(
      (await generateKeyPair()).publicKey,
    );
    for (const m of [
      { ...f.message, instructions: [{ ...f.message.instructions[0], data }] },
      {
        ...f.message,
        staticAccounts: [f.payer, another, f.message.staticAccounts[2]],
      },
      {
        ...f.message,
        instructions: [...f.message.instructions, ...f.message.instructions],
      },
    ])
      await expect(
        acceptDepositSignature(f.issued, await f.sign(m), f.payer, f.rpc),
      ).rejects.toBeInstanceOf(InputError);
  });
  it("rejects extra programs, duplicate compute settings, unsupported instructions and unused accounts", async () => {
    const f = await fixture();
    const extra = await getAddressFromPublicKey(
      (await generateKeyPair()).publicKey,
    );
    const m = f.compute();
    for (const bad of [
      { ...m, staticAccounts: [...m.staticAccounts.slice(0, 3), extra] },
      { ...m, instructions: [...m.instructions, m.instructions[0]] },
      {
        ...m,
        instructions: [
          { programAddressIndex: 3, data: Uint8Array.from([1, 0, 0, 0, 0]) },
          ...f.message.instructions,
        ],
      },
      { ...m, instructions: f.message.instructions },
      {
        ...m,
        instructions: [
          { ...m.instructions[0], accountIndices: [0] },
          ...m.instructions.slice(1),
        ],
      },
    ])
      await expect(
        acceptDepositSignature(f.issued, await f.sign(bad), f.payer, f.rpc),
      ).rejects.toBeInstanceOf(InputError);
  });
  it("rejects readonly recipients, extra signers, lookups, invalid signatures and malformed input", async () => {
    const f = await fixture();
    // Keep valid payer signing while adding an unapproved second signer.
    const badHeader = {
      ...f.message,
      header: { ...f.message.header, numSignerAccounts: 2 },
    };
    const extraSignerWire = getBase64EncodedWireTransaction({
      messageBytes: getCompiledTransactionMessageEncoder().encode(
        badHeader,
      ) as typeof f.tx.messageBytes,
      signatures: { ...f.tx.signatures, [f.recipient]: null },
    });
    const lookups = {
      ...f.message,
      addressTableLookups: [
        {
          lookupTableAddress: f.recipient,
          writableIndexes: [0],
          readonlyIndexes: [],
        },
      ],
    };
    for (const wire of [
      await f.sign({
        ...f.message,
        header: { ...f.message.header, numReadonlyNonSignerAccounts: 2 },
      }),
      extraSignerWire,
      await f.sign(lookups),
      f.issued.transaction,
      "not base64!",
      "AQ==",
    ])
      await expect(
        acceptDepositSignature(f.issued, wire, f.payer, f.rpc),
      ).rejects.toBeInstanceOf(InputError);
  });
});
