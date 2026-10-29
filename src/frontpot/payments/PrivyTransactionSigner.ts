import canonicalize from "canonicalize";
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import type { PoolSigner } from "./DevnetTransactions";

/** Privy's documented REST signing protocol. The server SDK currently peers on
 * Solana Kit 5; this application uses Kit 8. No exported Solana private keys. */
export class PrivyTransactionSigner implements PoolSigner {
  private key: KeyObject;
  constructor(
    private appID: string,
    private appSecret: string,
    authorizationKey: string,
    private request: typeof fetch = fetch,
  ) {
    this.key = createPrivateKey({
      key: Buffer.from(authorizationKey.replace(/^wallet-auth:/, ""), "base64"),
      format: "der",
      type: "pkcs8",
    });
    if (
      this.key.asymmetricKeyType !== "ec" ||
      this.key.asymmetricKeyDetails?.namedCurve !== "prime256v1"
    )
      throw new Error("Expected a Privy P-256 authorization key");
  }
  async sign(walletID: string, transaction: string) {
    const url = `https://api.privy.io/v1/wallets/${encodeURIComponent(walletID)}/rpc`;
    const body = {
      method: "signTransaction",
      params: { transaction, encoding: "base64" },
    };
    const headers = {
      "privy-app-id": this.appID,
      "privy-request-expiry": String(Date.now() + 60_000),
    };
    const signature = sign(
      "sha256",
      Buffer.from(
        canonicalize({ version: 1, method: "POST", url, body, headers })!,
      ),
      this.key,
    ).toString("base64");
    const response = await this.request(url, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(`${this.appID}:${this.appSecret}`).toString("base64")}`,
        "privy-authorization-signature": signature,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error("Privy transaction signing unavailable");
    const result = (await response.json()) as {
      method?: string;
      data?: { signed_transaction?: string; encoding?: string };
    };
    if (
      result.method !== "signTransaction" ||
      result.data?.encoding !== "base64" ||
      !result.data.signed_transaction
    )
      throw new Error("Unexpected signing response");
    return result.data.signed_transaction;
  }
}
