import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { explorerTransaction } from "../../src/frontpot/payments/Network";
import { paymentConfig } from "../../src/frontpot/payments/PaymentConfig";
import { bindPaymentDatabase } from "../../src/frontpot/payments/PaymentDatabase";
const env = {
  PAYMENTS_MODE: "mainnet",
  PRIVY_APP_ID: "app",
  PRIVY_APP_SECRET: "fixture",
  MAINNET_TREASURY_WALLET: "8B2hVW2hDC2jtxunccQoFagoKtLyDDi32eB1YqVbRzES",
  PRIVY_MAINNET_FEE_PAYER_ID: "production-payer",
  MAINNET_FEE_PAYER_ADDRESS: "CVT7yhhxz1bY1o6ZeL3U7eWNpTppbzdAjv89iDCm8oZM",
  MAINNET_ADMISSION: "invite",
  MAINNET_PLAYER_WALLETS: "CVT7yhhxz1bY1o6ZeL3U7eWNpTppbzdAjv89iDCm8oZM",
  SOLANA_MAINNET_RPC_URL: "https://mainnet-rpc.invalid/",
  PRIVY_MAINNET_POOL_OWNER_ID: "production-owner",
  PRIVY_MAINNET_POOL_POLICY_IDS: "production-policy",
  PRIVY_MAINNET_POOL_AUTHORIZATION_KEY: "fixture-production-key",
  MAINNET_STATE_DIR: "/data/frontpot/mainnet",
  MAINNET_MAX_ENTRY_LAMPORTS: "250000000",
  MAINNET_MAX_POOL_LAMPORTS: "1000000000",
  MAINNET_MAX_HELD_LAMPORTS: "2000000000",
  MAINNET_MAX_OPEN_POOLS: "2",
};
describe("mainnet configuration", () => {
  it("requires an explicit complete configuration and keeps simulation the default", () => {
    expect(paymentConfig({})).toBeNull();
    for (const field of Object.keys(env).filter(
      (k) => k !== "PAYMENTS_MODE" && !k.startsWith("MAINNET_MAX_"),
    )) {
      const missing: NodeJS.ProcessEnv = { ...env };
      delete missing[field];
      expect(() => paymentConfig(missing), field).toThrow();
    }
    expect(paymentConfig(env)).toMatchObject({
      network: "mainnet",
      limits: { maxEntryLamports: 250000000, maxOpenPools: 2 },
    });
  });
  it("requires an explicit choice before removing the invite restriction", () => {
    expect(
      paymentConfig({
        ...env,
        MAINNET_ADMISSION: "public",
        MAINNET_PLAYER_WALLETS: undefined,
      })?.allowed,
    ).toBeNull();
    expect(() => paymentConfig({ ...env, MAINNET_ADMISSION: "all" })).toThrow();
    expect(() =>
      paymentConfig({ ...env, MAINNET_PLAYER_WALLETS: ", ," }),
    ).toThrow();
  });
  it.each([
    { PRIVY_POOL_OWNER_ID: env.PRIVY_MAINNET_POOL_OWNER_ID },
    { PRIVY_POOL_AUTHORIZATION_KEY: env.PRIVY_MAINNET_POOL_AUTHORIZATION_KEY },
    { PRIVY_POOL_POLICY_IDS: env.PRIVY_MAINNET_POOL_POLICY_IDS },
    { PRIVY_DEVNET_FEE_PAYER_ID: env.PRIVY_MAINNET_FEE_PAYER_ID },
    { DEVNET_FEE_PAYER_ADDRESS: env.MAINNET_FEE_PAYER_ADDRESS },
  ])("rejects reused test custody %o", (patch) =>
    expect(() => paymentConfig({ ...env, ...patch })).toThrow("separate"),
  );
  it.each(["0", "-1", "NaN", "1.5", "9007199254740992", "1e9"])(
    "rejects invalid production limits %s",
    (value) =>
      expect(() =>
        paymentConfig({ ...env, MAINNET_MAX_ENTRY_LAMPORTS: value }),
      ).toThrow(),
  );
  it("cannot reuse a bound database for the other network", () => {
    const db = new DatabaseSync(":memory:");
    try {
      bindPaymentDatabase(db, "devnet");
      bindPaymentDatabase(db, "devnet");
      expect(() => bindPaymentDatabase(db, "mainnet")).toThrow(
        "different network",
      );
    } finally {
      db.close();
    }
  });
  it("blocks legacy transactions before binding a mainnet database", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "CREATE TABLE chain_jobs(id TEXT); INSERT INTO chain_jobs VALUES('old-deposit')",
      );
      expect(() => bindPaymentDatabase(db, "mainnet")).toThrow("Legacy");
      bindPaymentDatabase(db, "devnet");
    } finally {
      db.close();
    }
  });
  it("links receipts to their actual network", () => {
    expect(explorerTransaction("abc", "mainnet")).toBe(
      "https://explorer.solana.com/tx/abc",
    );
    expect(explorerTransaction("abc", "devnet")).toContain("?cluster=devnet");
  });
});

it("does not impose business wager or pool caps when none are configured", () => {
  const unlimited: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(unlimited))
    if (key.startsWith("MAINNET_MAX_")) delete unlimited[key];
  expect(paymentConfig(unlimited)?.limits).toBeUndefined();
});
