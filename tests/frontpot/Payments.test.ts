import { generateKeyPair, exportSPKI, SignJWT } from "jose";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  verifyDepositTransaction,
  verifyFinalizedDeposit,
  type DepositTerms,
} from "../../src/frontpot/payments/DepositVerifier";
import { FundingBook } from "../../src/frontpot/payments/FundingBook";
import { PrivyPoolWallets } from "../../src/frontpot/payments/PrivyPoolWallets";
import {
  SettlementOutbox,
  type SettlementPlan,
} from "../../src/frontpot/payments/SettlementOutbox";
import { PrivyIdentity } from "../../src/frontpot/PrivyIdentity";
// Public test addresses only; no signers or funds used by these tests.
const a = "11111111111111111111111111111111";
const b = "So11111111111111111111111111111111111111112";
const c = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const terms: DepositTerms = {
  signature: "test-signature",
  source: a,
  destination: b,
  lamports: 250_000_000,
  opensAt: 100_000,
  closesAt: 200_000,
};
const receipt = () => ({
  blockTime: 150,
  meta: { err: null },
  transaction: {
    signatures: [terms.signature],
    message: {
      accountKeys: [{ pubkey: a, signer: true }],
      instructions: [
        {
          programId: a,
          parsed: {
            type: "transfer",
            info: { source: a, destination: b, lamports: 250_000_000 },
          },
        },
      ],
    },
  },
});
const plan: SettlementPlan = {
  matchID: "game-1",
  poolWalletID: "privy-pool",
  poolAddress: b,
  treasury: c,
  network: "devnet",
  verificationHash: "a".repeat(64),
  poolLamports: 500_000_000,
  feeLamports: 5_000_000,
  prizes: [{ to: a, lamports: 495_000_000 }],
};
describe("payments integration boundaries", () => {
  it("accepts the new 1% fee and rejects a 5% fee for a new settlement", () => {
    const db = new DatabaseSync(":memory:");
    const box = new SettlementOutbox(db);
    expect(box.prepare(plan).plan.feeLamports).toBe(5_000_000);
    expect(() =>
      box.prepare({
        ...plan,
        matchID: "old-fee-attempt",
        feeLamports: 25_000_000,
        prizes: [{ to: a, lamports: 475_000_000 }],
      }),
    ).toThrow("Platform fee must be 1%");
    db.close();
  });
  it("verifies Privy signature, audience and linked Solana wallet", async () => {
    const keys = await generateKeyPair("ES256", { extractable: true });
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256" })
      .setSubject("did:privy:test")
      .setIssuer("privy.io")
      .setAudience("app-test")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(keys.privateKey);
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "did:privy:test",
            linked_accounts: [
              { type: "wallet", chain_type: "solana", address: a },
            ],
          }),
        ),
    ) as unknown as typeof fetch;
    const auth = new PrivyIdentity(
      {
        appID: "app-test",
        appSecret: "test-only",
        verificationKey: await exportSPKI(keys.publicKey),
      },
      request,
    );
    expect((await auth.verify(token, a)).wallet).toBe(a);
    await expect(auth.verify(token, b)).rejects.toThrow("not linked");
    const other = new PrivyIdentity(
      {
        appID: "wrong-app",
        appSecret: "test-only",
        verificationKey: await exportSPKI(keys.publicKey),
      },
      request,
    );
    await expect(other.verify(token, a)).rejects.toThrow();
  });
  it("provisions a separately owned wallet with stable request and external IDs", async () => {
    const request = vi.fn(async (_url: unknown, options: any) => {
      const body = JSON.parse(options.body);
      return new Response(
        JSON.stringify({
          id: "wallet-1",
          address: b,
          chain_type: "solana",
          external_id: body.external_id,
          owner_id: body.owner_id,
        }),
      );
    });
    const provider = new PrivyPoolWallets(
      {
        appID: "app-test",
        appSecret: "test-only",
        ownerID: "pool-owner",
        policyIDs: ["pool-policy"],
      },
      request as typeof fetch,
    );
    const id = "match-devnet-12345678";
    expect((await provider.create(id)).address).toBe(b);
    const requestOptions = request.mock.calls[0][1];
    expect(requestOptions.headers["privy-idempotency-key"]).toBe(id);
    expect(JSON.parse(requestOptions.body).policy_ids).toEqual(["pool-policy"]);
    await expect(provider.create("match-mainnet-12345678")).rejects.toThrow();
  });
  it("rejects wrong amounts, senders, signatures, windows and failed deposits", () => {
    expect(() => verifyDepositTransaction(receipt(), terms)).not.toThrow();
    for (const bad of [
      { ...terms, lamports: 1 },
      { ...terms, source: c },
      { ...terms, signature: "wrong" },
      { ...terms, closesAt: 149_000 },
      { ...terms, destination: c },
    ])
      expect(() => verifyDepositTransaction(receipt(), bad)).toThrow();
    expect(() =>
      verifyDepositTransaction(
        { ...receipt(), meta: { err: "failed" } },
        terms,
      ),
    ).toThrow();
  });
  it("requires finalized confirmation before crediting a deposit", async () => {
    const request = vi.fn(
      async (_url: unknown, init: any) =>
        new Response(
          JSON.stringify({
            result:
              JSON.parse(init.body).method === "getGenesisHash"
                ? "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
                : { value: [{ confirmationStatus: "confirmed", err: null }] },
          }),
        ),
    ) as unknown as typeof fetch;
    await expect(
      verifyFinalizedDeposit("https://rpc.invalid", terms, request),
    ).rejects.toThrow("not finalized");
  });
  it("cannot change a prepared payout or send it twice after a lost response", async () => {
    const db = new DatabaseSync(":memory:");
    const box = new SettlementOutbox(db);
    const first = box.prepare(plan);
    expect(() => box.prepare({ ...plan, treasury: a })).toThrow("immutable");
    const provider = {
      sendAtomic: vi.fn(async () => {
        throw new Error("connection lost after broadcast");
      }),
      reconcile: vi.fn(async () => ({
        reference: "r",
        signature: "chain-signature",
        status: "finalized" as const,
      })),
    };
    expect((await box.run(plan.matchID, provider)).state).toBe("submitting");
    const recovered = new SettlementOutbox(db);
    expect((await recovered.run(plan.matchID, provider)).state).toBe(
      "confirmed",
    );
    await recovered.run(plan.matchID, provider);
    expect(provider.sendAtomic).toHaveBeenCalledTimes(1);
    expect(recovered.get(plan.matchID)?.key).toBe(first.key);
    db.close();
  });
  it("requires every finalized entry and never credits the same transfer twice", async () => {
    const db = new DatabaseSync(":memory:");
    const now = Date.now();
    const request = vi.fn(async (_url: unknown, init: any) => {
      const { method, params } = JSON.parse(init.body);
      if (method === "getGenesisHash")
        return new Response(
          JSON.stringify({
            result: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
          }),
        );
      if (method === "getSignatureStatuses")
        return new Response(
          JSON.stringify({
            result: { value: [{ confirmationStatus: "finalized", err: null }] },
          }),
        );
      const sender = params[0] === "sig-a" ? a : c;
      return new Response(
        JSON.stringify({
          result: {
            blockTime: Math.floor(now / 1000),
            meta: { err: null },
            transaction: {
              signatures: [params[0]],
              message: {
                accountKeys: [{ pubkey: sender, signer: true }],
                instructions: [
                  {
                    programId: a,
                    parsed: {
                      type: "transfer",
                      info: {
                        source: sender,
                        destination: b,
                        lamports: 250_000_000,
                      },
                    },
                  },
                ],
              },
            },
          },
        }),
      );
    }) as unknown as typeof fetch;
    const book = new FundingBook(db, "https://rpc.invalid", request);
    book.open({
      matchID: "m1",
      poolAddress: b,
      stakeLamports: 250_000_000,
      opensAt: now - 2000,
      closesAt: now + 60000,
      wallets: [a, c],
    });
    expect(() => book.lock("m1")).toThrow();
    expect((await book.confirm("m1", a, "sig-a")).state).toBe("funding");
    await book.confirm("m1", a, "sig-a");
    expect(
      Number(db.prepare("SELECT COUNT(*) AS n FROM deposits").get()!.n),
    ).toBe(1);
    await expect(book.confirm("m1", c, "sig-a")).rejects.toThrow();
    expect((await book.confirm("m1", c, "sig-c")).state).toBe("funded");
    book.lock("m1");
    expect(() => book.cancel("m1")).toThrow();
    db.close();
  });
  it("blocks mainnet and payout totals that differ from the pool", () => {
    const db = new DatabaseSync(":memory:");
    const box = new SettlementOutbox(db);
    expect(() =>
      box.prepare({ ...plan, network: "mainnet" as "devnet" }),
    ).toThrow();
    expect(() => box.prepare({ ...plan, feeLamports: 0 })).toThrow();
    expect(() =>
      box.prepare({ ...plan, prizes: [{ to: a, lamports: 500_000_000 }] }),
    ).toThrow();
    db.close();
  });
});
