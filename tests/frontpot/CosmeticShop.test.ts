import { PlayerCosmeticsSchema } from "@openfront/shared/WireSchemas";
import {
  generateKeyPair,
  getAddressFromPublicKey,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  partiallySignTransaction,
} from "@solana/kit";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import {
  DevnetRPC,
  DevnetTransactions,
} from "../../src/frontpot/payments/DevnetTransactions";
import { FeeSponsor } from "../../src/frontpot/payments/FeeSponsor";
import { GENESIS_HASHES } from "../../src/frontpot/payments/Network";
import { UserOwnedWallets } from "../../src/frontpot/payments/UserOwnedWallets";
import type { PlayerSession } from "../../src/frontpot/PlayerAuth";
import {
  assertBurn,
  burnWire,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
} from "../../src/frontpot/shop/BurnPolicy";
import {
  flagSVG,
  SHOP_ITEMS,
  rendererCatalog,
  purchaseItems,
  resolvedAppearance,
} from "../../src/frontpot/shop/Catalog";
import { CosmeticShop, shopConfig } from "../../src/frontpot/shop/Shop";
const dbs: DatabaseSync[] = [];
afterEach(() => dbs.splice(0).forEach((db) => db.close()));
async function fixture() {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  const user = await generateKeyPair(),
    payer = await generateKeyPair();
  const source = await getAddressFromPublicKey(user.publicKey),
    sponsorAddress = await getAddressFromPublicKey(payer.publicKey);
  const mint = await getAddressFromPublicKey(
      (await generateKeyPair()).publicKey,
    ),
    account = await getAddressFromPublicKey(
      (await generateKeyPair()).publicKey,
    );
  const state = {
    status: null as null | {
      err: unknown;
      confirmationStatus: string;
      slot: number;
    },
    height: 1,
    balance: "100000000000",
    accountOwner: source as string,
    mintProgram: TOKEN_PROGRAM as string,
    extensions: [] as Array<{ extension: string }>,
    simulation: null as unknown,
  };
  const request = vi.fn(
    async (_url: unknown, init: RequestInit | undefined) => {
      const { method } = JSON.parse(String(init?.body));
      const result =
        method === "getGenesisHash"
          ? GENESIS_HASHES.devnet
          : method === "getAccountInfo"
            ? {
                value: {
                  owner: state.mintProgram,
                  data: {
                    parsed: {
                      type: "mint",
                      info: {
                        decimals: 6,
                        isInitialized: true,
                        extensions: state.extensions,
                      },
                    },
                  },
                },
              }
            : method === "getTokenAccountsByOwner"
              ? {
                  value: [
                    {
                      pubkey: account,
                      account: {
                        owner: state.mintProgram,
                        data: {
                          parsed: {
                            type: "account",
                            info: {
                              owner: state.accountOwner,
                              mint,
                              state: "initialized",
                              tokenAmount: {
                                amount: state.balance,
                                decimals: 6,
                              },
                            },
                          },
                        },
                      },
                    },
                  ],
                }
              : method === "getLatestBlockhash"
                ? {
                    value: {
                      blockhash: "11111111111111111111111111111111",
                      lastValidBlockHeight: 100,
                    },
                  }
                : method === "getBlockHeight"
                  ? state.height
                  : method === "getFeeForMessage"
                    ? { value: 10000 }
                    : method === "simulateTransaction"
                      ? { value: { err: state.simulation } }
                      : method === "getSignatureStatuses"
                        ? { value: [state.status] }
                        : method === "sendTransaction"
                          ? "sent"
                          : undefined;
      if (result === undefined) throw new Error(method);
      return new Response(JSON.stringify({ result }));
    },
  );
  const rpc = new DevnetRPC("https://rpc.invalid", request),
    txs = new DevnetTransactions(db, rpc);
  const sign = async (key: CryptoKeyPair, wire: string) =>
    getBase64EncodedWireTransaction(
      await partiallySignTransaction(
        [key],
        getTransactionDecoder().decode(Buffer.from(wire, "base64")),
      ),
    );
  const signer = {
    sign: vi.fn(async (_id: string, wire: string) => sign(payer, wire)),
  };
  const sponsor = new FeeSponsor(
    db,
    { id: "fees", address: sponsorAddress },
    signer,
    rpc,
  );
  const wallets = new UserOwnedWallets(
    db,
    {
      verify: async () => ({
        id: "user-wallet",
        address: source,
        subject: "subject",
        verifiedAt: Date.now(),
      }),
    },
    txs,
    null,
    sponsor,
  );
  const identity: PlayerSession = {
    id: "player",
    token: "token",
    name: "Player",
    wallet: source,
    subject: "subject",
    expires: Date.now() + 100000,
  };
  await wallets.register(identity, "user-wallet");
  const config = {
    enabled: true,
    mint,
    prices: Object.fromEntries(SHOP_ITEMS.map((i) => [i.id, i.tokens])),
  };
  const shop = new CosmeticShop(db, config, wallets);
  return {
    shop,
    db,
    config,
    wallets,
    identity,
    state,
    signer,
    request,
    txs,
    sign: (wire: string) => sign(user, wire),
  };
}
it("is preview-only by default and requires explicit approved prices to enable", () => {
  expect(shopConfig({}, "mainnet").enabled).toBe(false);
  expect(() => shopConfig({ SOW_SHOP_CHECKOUT: "enabled" }, "mainnet")).toThrow(
    /approved/,
  );
  expect(() =>
    shopConfig({ SOW_SHOP_PRICES: '{"ember-standard":"0"}' }, "mainnet"),
  ).toThrow(/price/);
});
it("persists before sending, grants only at finality, survives restart, and equips only owned flags", async () => {
  const f = await fixture(),
    id = randomUUID();
  expect(() => f.shop.equip(f.identity.id, "ember-standard")).toThrow(/own/);
  const p = await f.shop.prepare(f.identity, id, "ember-standard");
  const signed = await f.sign(p.wire.transaction);
  const before = await f.shop.submit(f.identity, id, signed);
  expect(before.owned).toEqual([]);
  expect(f.txs.get(`shop:${id}`)?.state).toBe("pending");
  expect(f.signer.sign).toHaveBeenCalledTimes(1);
  await f.shop.submit(f.identity, id, signed);
  expect(f.signer.sign).toHaveBeenCalledTimes(1);
  const restarted = new CosmeticShop(f.db, f.config, f.wallets);
  f.state.status = { err: null, confirmationStatus: "confirmed", slot: 12 };
  await restarted.reconcilePending();
  expect(restarted.inventory(f.identity.id).owned).toEqual([]);
  f.state.status.confirmationStatus = "finalized";
  await restarted.reconcilePending();
  expect(restarted.inventory(f.identity.id).owned).toEqual(["ember-standard"]);
  restarted.equip(f.identity.id, "ember-standard");
  expect(restarted.cosmetics(f.identity.id)).toEqual({
    flag: "/frontpot/api/shop/art/ember-standard.svg?v=2",
  });
  expect(restarted.cosmetics("stranger")).toBeUndefined();
  expect(restarted.receipts()).toHaveLength(1);
  expect(restarted.activity()).toMatchObject({
    totalTokens: "1000",
    purchases: 1,
  });
  await expect(
    restarted.prepare(f.identity, randomUUID(), "ember-standard"),
  ).rejects.toThrow(/already own/);
  restarted.equip(f.identity.id, null);
  expect(restarted.cosmetics(f.identity.id)).toBeUndefined();
});
it("rejects altered burn terms and missing signatures before charging sponsor budget", async () => {
  const f = await fixture(),
    id = randomUUID(),
    p = await f.shop.prepare(f.identity, id, "ember-standard");
  const altered = burnWire(
    { ...p.terms, amount: "1" },
    "11111111111111111111111111111111",
    100,
  );
  expect(() => assertBurn(altered, p.terms)).toThrow(/approved/);
  await expect(
    f.shop.submit(f.identity, id, await f.sign(altered)),
  ).rejects.toThrow(/changed/);
  await expect(
    f.shop.submit(f.identity, id, p.wire.transaction),
  ).rejects.toThrow(/signature/);
  expect(f.signer.sign).not.toHaveBeenCalled();
  expect(
    f.db.prepare("SELECT count(*) AS n FROM fee_sponsorships").get()?.n,
  ).toBe(0);
});
it("binds requests to one player/item, cancels only unsigned requests, and blocks duplicate charges", async () => {
  const f = await fixture(),
    id = randomUUID(),
    p = await f.shop.prepare(f.identity, id, "ember-standard");
  expect(await f.shop.prepare(f.identity, id, "ember-standard")).toEqual(p);
  await expect(
    f.shop.prepare(f.identity, randomUUID(), "ember-standard"),
  ).rejects.toThrow(/existing purchase/);
  await expect(
    f.shop.submit(
      { ...f.identity, id: "stranger" },
      id,
      await f.sign(p.wire.transaction),
    ),
  ).rejects.toThrow(/not found/);
  await f.shop.cancel(f.identity.id, id);
  await expect(
    f.shop.submit(f.identity, id, await f.sign(p.wire.transaction)),
  ).rejects.toThrow(/not found/);
  const q = await f.shop.prepare(f.identity, randomUUID(), "ember-standard");
  await f.shop.submit(f.identity, q.id, await f.sign(q.wire.transaction));
  await expect(f.shop.cancel(f.identity.id, q.id)).rejects.toThrow(
    /cannot be cancelled/,
  );
});
it("rejects wrong token owner, unsupported mint program, and insufficient tokens", async () => {
  const f = await fixture();
  f.state.accountOwner = "stranger";
  await expect(
    f.shop.prepare(f.identity, randomUUID(), "ember-standard"),
  ).rejects.toThrow(/enough/);
  f.state.accountOwner = f.identity.wallet;
  f.state.balance = "1";
  await expect(
    f.shop.prepare(f.identity, randomUUID(), "ember-standard"),
  ).rejects.toThrow(/enough/);
  f.state.mintProgram = "wrong";
  await expect(
    f.shop.prepare(f.identity, randomUUID(), "ember-standard"),
  ).rejects.toThrow(/supported/);
  expect(f.signer.sign).not.toHaveBeenCalled();
});
it("holds expired or failed burns without granting or replacing, and recovers late finality", async () => {
  const f = await fixture(),
    p = await f.shop.prepare(f.identity, randomUUID(), "ember-standard");
  await f.shop.submit(f.identity, p.id, await f.sign(p.wire.transaction));
  f.state.height = 101;
  await f.shop.reconcilePending();
  expect(f.shop.inventory(f.identity.id).purchases[0].state).toBe("review");
  expect(f.shop.inventory(f.identity.id).owned).toEqual([]);
  f.state.status = { err: null, confirmationStatus: "finalized", slot: 12 };
  await f.shop.reconcilePending();
  expect(f.shop.inventory(f.identity.id).owned).toEqual(["ember-standard"]);
  expect(f.signer.sign).toHaveBeenCalledTimes(1);
});
it("does not grant a finalized failed burn", async () => {
  const f = await fixture(),
    p = await f.shop.prepare(f.identity, randomUUID(), "ember-standard");
  f.state.status = {
    err: { InstructionError: [0, "error"] },
    confirmationStatus: "finalized",
    slot: 12,
  };
  await f.shop.submit(f.identity, p.id, await f.sign(p.wire.transaction));
  expect(f.shop.inventory(f.identity.id).owned).toEqual([]);
  expect(f.shop.receipts()).toEqual([]);
});
it("fails closed when purchases disabled, while retaining inventory and recovery", async () => {
  const f = await fixture();
  f.config.enabled = false;
  await expect(
    f.shop.prepare(f.identity, randomUUID(), "ember-standard"),
  ).rejects.toThrow(/preview/);
  expect(f.shop.inventory(f.identity.id).owned).toEqual([]);
});
it("serves original fixed artwork without arbitrary URLs or injected SVG", () => {
  for (const item of SHOP_ITEMS) {
    expect(flagSVG(item.id)).toContain("<svg");
    expect(flagSVG(item.id)).not.toMatch(/script|https:|href=/);
  }
  expect(() => flagSVG("<script>")).toThrow();
});

it("supports the real Token-2022 burn layout and rejects unreviewed mint extensions", async () => {
  const f = await fixture();
  f.state.mintProgram = TOKEN_2022_PROGRAM;
  f.state.extensions = [
    { extension: "metadataPointer" },
    { extension: "tokenMetadata" },
  ];
  const p = await f.shop.prepare(f.identity, randomUUID(), "ember-standard");
  expect(p.terms.program).toBe(TOKEN_2022_PROGRAM);
  assertBurn(p.wire.transaction, p.terms);
  f.state.status = { err: null, confirmationStatus: "finalized", slot: 12 };
  await f.shop.submit(f.identity, p.id, await f.sign(p.wire.transaction));
  expect(f.shop.inventory(f.identity.id).owned).toEqual(["ember-standard"]);
  f.state.extensions.push({ extension: "permanentDelegate" });
  await expect(
    f.shop.prepare(f.identity, randomUUID(), "solar-command"),
  ).rejects.toThrow(/supported/);
});

it("covers every cosmetic category and effect slot with schema-valid original render data", () => {
  const catalog = rendererCatalog();
  expect(SHOP_ITEMS).toHaveLength(42);
  expect(new Set(SHOP_ITEMS.map((i) => i.category)).size).toBe(6);
  expect(Object.keys(catalog.patterns)).toHaveLength(3);
  expect(Object.keys(catalog.flags)).toHaveLength(3);
  expect(Object.keys(catalog.skins!)).toHaveLength(3);
  expect(Object.keys(catalog.crowns!)).toHaveLength(3);
  expect(
    Object.values(catalog.effects!).flatMap((group) => Object.values(group!)),
  ).toHaveLength(27);
  expect(
    new Set(
      SHOP_ITEMS.filter((i) => i.category === "effect").map((i) => i.slot),
    ).size,
  ).toBe(9);
  expect(new Set(SHOP_ITEMS.map((i) => i.cosmetic.name)).size).toBe(42);
  for (const item of SHOP_ITEMS) {
    expect(item.cosmetic.name).toMatch(/^[a-z0-9_]{1,32}$/);
    if (item.category === "bundle") expect(item.members).toHaveLength(13);
    else
      expect(
        PlayerCosmeticsSchema.safeParse(resolvedAppearance([item])).success,
      ).toBe(true);
  }
});
it("grants all bundle members only at finality, counts one burn, and persists independent equipment slots", async () => {
  const f = await fixture(),
    id = randomUUID();
  const p = await f.shop.prepare(f.identity, id, "ember-collection");
  expect(p.grants).toEqual(purchaseItems("ember-collection"));
  await f.shop.submit(f.identity, id, await f.sign(p.wire.transaction));
  expect(f.shop.inventory(f.identity.id).owned).toEqual([]);
  f.state.status = { err: null, confirmationStatus: "finalized", slot: 12 };
  await f.shop.reconcilePending();
  await f.shop.reconcilePending();
  expect(f.shop.inventory(f.identity.id).owned.sort()).toEqual(
    p.grants!.slice().sort(),
  );
  expect(f.shop.activity()).toMatchObject({
    purchases: 1,
    totalTokens: "12000",
  });
  expect(f.shop.receipts()).toHaveLength(1);
  for (const item of SHOP_ITEMS.filter(
    (i) => i.collection === "Ember" && i.slot,
  ))
    f.shop.equip(f.identity.id, item.id);
  const appearance = f.shop.cosmetics(f.identity.id)!;
  expect(appearance.flag).toContain("ember-standard");
  expect(appearance.skin?.name).toBe("ember_forge");
  expect(appearance.pattern).toBeUndefined();
  expect(appearance.crown?.name).toBe("ember_diadem");
  expect(Object.keys(appearance.effects!)).toHaveLength(9);
  expect(PlayerCosmeticsSchema.safeParse(appearance).success).toBe(true);
  f.shop.equip(f.identity.id, "ember-pattern");
  expect(f.shop.cosmetics(f.identity.id)?.skin).toBeUndefined();
  expect(f.shop.cosmetics(f.identity.id)?.pattern?.name).toBe("ember_ramparts");
  expect(() => f.shop.equip(f.identity.id, "ember-crown", "flag")).toThrow(
    /slot/,
  );
  expect(() => f.shop.equip(f.identity.id, "ember-collection")).toThrow(
    /equippable/,
  );
  expect(() => f.shop.equip("other", "ember-crown")).toThrow(/own/);
  const restarted = new CosmeticShop(f.db, f.config, f.wallets);
  expect(Object.keys(restarted.inventory(f.identity.id).equipped)).toHaveLength(
    12,
  );
  restarted.equip(f.identity.id, null, "crown");
  expect(restarted.cosmetics(f.identity.id)?.crown).toBeUndefined();
  expect(restarted.cosmetics(f.identity.id)?.flag).toBeDefined();
  await expect(
    restarted.prepare(f.identity, randomUUID(), "ember-crown"),
  ).rejects.toThrow(/already own/);
});
it("prevents overlapping bundle burns and single-item burns, including concurrent requests", async () => {
  const f = await fixture();
  const results = await Promise.allSettled([
    f.shop.prepare(f.identity, randomUUID(), "violet-collection"),
    f.shop.prepare(f.identity, randomUUID(), "violet-crown"),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const p = (
    results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<
      Awaited<ReturnType<CosmeticShop["prepare"]>>
    >
  ).value;
  await f.shop.cancel(f.identity.id, p.id);
  const single = await f.shop.prepare(f.identity, randomUUID(), "violet-crown");
  f.state.status = { err: null, confirmationStatus: "finalized", slot: 12 };
  await f.shop.submit(
    f.identity,
    single.id,
    await f.sign(single.wire.transaction),
  );
  await expect(
    f.shop.prepare(f.identity, randomUUID(), "violet-collection"),
  ).rejects.toThrow(/already own/);
});
it("migrates existing flag ownership and equipment without resurrecting a cleared flag", async () => {
  const f = await fixture();
  f.db
    .prepare("INSERT INTO shop_inventory VALUES(?,?,?,?)")
    .run(
      f.identity.id,
      "ember-standard",
      "historic-purchase",
      "historic-signature",
    );
  f.db
    .prepare("INSERT INTO shop_equipped VALUES(?,?)")
    .run(f.identity.id, "ember-standard");
  const migrated = new CosmeticShop(f.db, f.config, f.wallets);
  expect(migrated.inventory(f.identity.id).owned).toContain("ember-standard");
  expect(migrated.inventory(f.identity.id).equipped.flag).toBe(
    "ember-standard",
  );
  migrated.equip(f.identity.id, null, "flag");
  expect(
    new CosmeticShop(f.db, f.config, f.wallets).cosmetics(f.identity.id),
  ).toBeUndefined();
});
