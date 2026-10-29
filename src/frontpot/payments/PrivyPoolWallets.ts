import { decodeAddress } from "../Wallet";
import type { PaymentNetwork } from "./Network";

export type ManagedPoolWallet = {
  id: string;
  address: string;
  externalID: string;
};
export type PoolWalletConfig = {
  network?: PaymentNetwork;
  appID: string;
  appSecret: string;
  ownerID: string;
  policyIDs: string[];
};
/** Server-only provisioning adapter. No private keys are generated or exported.
 * Caller must persist the unique external ID BEFORE invoking this operation.
 * Uncertain outcomes must be reconciled by external ID; never mint a replacement.
 * The public demo deliberately never instantiates this adapter.
 */
export class PrivyPoolWallets {
  constructor(
    private config: PoolWalletConfig,
    private request: typeof fetch = fetch,
  ) {
    if (
      !config.appID ||
      !config.appSecret ||
      !config.ownerID ||
      !config.policyIDs.length
    )
      throw new Error("Pool wallet ownership and policies must be configured");
  }
  async find(externalID: string): Promise<ManagedPoolWallet | null> {
    if (!externalID.startsWith(`match-${this.config.network ?? "devnet"}-`))
      throw new Error("Pool wallet network mismatch");
    const response = await this.request(
      `https://api.privy.io/v1/wallets/ext_wal_${encodeURIComponent(externalID)}`,
      {
        headers: {
          "privy-app-id": this.config.appID,
          Authorization: `Basic ${Buffer.from(`${this.config.appID}:${this.config.appSecret}`).toString("base64")}`,
        },
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      },
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("Pool wallet lookup unavailable");
    return this.validate(await response.json(), externalID);
  }
  private validate(raw: unknown, externalID: string): ManagedPoolWallet {
    const wallet = raw as {
      id?: string;
      address?: string;
      chain_type?: string;
      external_id?: string;
      owner_id?: string;
    };
    if (
      !wallet.id ||
      !wallet.address ||
      wallet.chain_type !== "solana" ||
      wallet.external_id !== externalID ||
      wallet.owner_id !== this.config.ownerID
    )
      throw new Error(
        "Unexpected pool wallet response; reconciliation required",
      );
    decodeAddress(wallet.address);
    return { id: wallet.id, address: wallet.address, externalID };
  }
  async create(externalID: string): Promise<ManagedPoolWallet> {
    if (
      !new RegExp(
        `^match-${this.config.network ?? "devnet"}-[a-zA-Z0-9-]{8,51}$`,
      ).test(externalID)
    )
      throw new Error(
        "Expected a persisted network-specific match wallet identifier",
      );
    const response = await this.request("https://api.privy.io/v1/wallets", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "privy-app-id": this.config.appID,
        Authorization: `Basic ${Buffer.from(`${this.config.appID}:${this.config.appSecret}`).toString("base64")}`,
        "privy-idempotency-key": externalID,
      },
      body: JSON.stringify({
        chain_type: "solana",
        external_id: externalID,
        owner_id: this.config.ownerID,
        policy_ids: this.config.policyIDs,
      }),
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(
        `Pool wallet provisioning requires reconciliation (${response.status})`,
      );
    return this.validate(await response.json(), externalID);
  }
}
