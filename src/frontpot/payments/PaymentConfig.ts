import { decodeAddress } from "../Wallet";
import type { PaymentNetwork } from "./Network";
export const DEVNET_TREASURY = "8B2hVW2hDC2jtxunccQoFagoKtLyDDi32eB1YqVbRzES";
export type PaymentLimits = {
  maxEntryLamports: number;
  maxPoolLamports: number;
  maxHeldLamports: number;
  maxOpenPools: number;
};
/** Production requires separate custody; operator limits are optional. */
export function paymentConfig(env: NodeJS.ProcessEnv = process.env) {
  const mode = env.PAYMENTS_MODE ?? "simulation";
  if (mode === "simulation") return null;
  if (mode !== "devnet" && mode !== "mainnet")
    throw new Error("Unsupported payment mode");
  const network: PaymentNetwork = mode;
  const required = (key: string) => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`${network} setup missing ${key}`);
    return value;
  };
  const prefix = network === "mainnet" ? "MAINNET" : "DEVNET";
  const treasury =
    network === "devnet"
      ? (env.DEVNET_TREASURY_WALLET?.trim() ?? DEVNET_TREASURY)
      : required("MAINNET_TREASURY_WALLET");
  const payer = {
    id: required(`PRIVY_${prefix}_FEE_PAYER_ID`),
    address: required(`${prefix}_FEE_PAYER_ADDRESS`),
  };
  decodeAddress(treasury);
  decodeAddress(payer.address);
  if (treasury === payer.address)
    throw new Error("Treasury and network fee payer must be separate wallets");
  const admission =
    network === "mainnet" ? required("MAINNET_ADMISSION") : "invite";
  if (admission !== "invite" && admission !== "public")
    throw new Error("MAINNET_ADMISSION must be invite or public");
  const allowed =
    admission === "public"
      ? null
      : new Set(
          required(`${prefix}_PLAYER_WALLETS`)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        );
  if (allowed && !allowed.size)
    throw new Error("Invite list must contain a wallet");
  if (allowed) for (const wallet of allowed) decodeAddress(wallet);
  const rpcURL = required(`SOLANA_${prefix}_RPC_URL`);
  const url = new URL(rpcURL);
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new Error("Payment RPC must use HTTPS without userinfo or fragment");
  const custodyPrefix =
    network === "mainnet" ? "PRIVY_MAINNET_POOL" : "PRIVY_POOL";
  const wallets = {
    appID: required("PRIVY_APP_ID"),
    appSecret: required("PRIVY_APP_SECRET"),
    ownerID: required(`${custodyPrefix}_OWNER_ID`),
    policyIDs: required(`${custodyPrefix}_POLICY_IDS`)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    network,
  };
  if (!wallets.policyIDs.length)
    throw new Error("Payment policies cannot be empty");
  const authorizationKey = required(`${custodyPrefix}_AUTHORIZATION_KEY`);
  let limits: PaymentLimits | undefined;
  let stateDir: string | undefined;
  if (network === "mainnet") {
    for (const [key, test] of [
      [wallets.ownerID, env.PRIVY_POOL_OWNER_ID],
      [authorizationKey, env.PRIVY_POOL_AUTHORIZATION_KEY],
      [payer.id, env.PRIVY_DEVNET_FEE_PAYER_ID],
      [payer.address, env.DEVNET_FEE_PAYER_ADDRESS],
    ])
      if (test?.trim() === key)
        throw new Error(
          "Mainnet must use separate custody credentials and fee payer",
        );
    if (
      wallets.policyIDs.some((p) =>
        (env.PRIVY_POOL_POLICY_IDS ?? "")
          .split(",")
          .map((s) => s.trim())
          .includes(p),
      )
    )
      throw new Error("Mainnet must use separate transfer policies");
    const integer = (key: string, minimum: number) => {
      const raw = required(key),
        value = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < minimum)
        throw new Error(`Invalid ${key}`);
      return value;
    };
    const hasLimits = [
      "MAINNET_MAX_ENTRY_LAMPORTS",
      "MAINNET_MAX_POOL_LAMPORTS",
      "MAINNET_MAX_HELD_LAMPORTS",
      "MAINNET_MAX_OPEN_POOLS",
    ].some((k) => env[k] !== undefined);
    if (hasLimits)
      limits = {
        maxEntryLamports: integer("MAINNET_MAX_ENTRY_LAMPORTS", 1_000_000),
        maxPoolLamports: integer("MAINNET_MAX_POOL_LAMPORTS", 2_000_000),
        maxHeldLamports: integer("MAINNET_MAX_HELD_LAMPORTS", 2_000_000),
        maxOpenPools: integer("MAINNET_MAX_OPEN_POOLS", 1),
      };
    if (
      limits &&
      (limits.maxPoolLamports < limits.maxEntryLamports * 2 ||
        limits.maxHeldLamports < limits.maxPoolLamports)
    )
      throw new Error("Mainnet pool and held-funds limits are inconsistent");
    stateDir = required("MAINNET_STATE_DIR");
    if (!stateDir.startsWith("/"))
      throw new Error("MAINNET_STATE_DIR must be an absolute path");
  }
  return {
    network,
    treasury,
    payer,
    allowed,
    rpcURL,
    wallets,
    authorizationKey,
    limits,
    stateDir,
  };
}
