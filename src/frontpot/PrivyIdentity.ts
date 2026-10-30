import {
  createRemoteJWKSet,
  importSPKI,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";
import type { VerifiedPlayer } from "./PlayerAuth";
import { decodeAddress } from "./Wallet";

export type PrivyConfig = {
  appID: string;
  appSecret: string;
  verificationKey?: string;
  identityOnly?: boolean;
};
export class PrivyIdentity {
  private readonly key: JWTVerifyGetKey;
  constructor(
    private config: PrivyConfig,
    private request: typeof fetch = fetch,
  ) {
    this.key = config.verificationKey
      ? () => importSPKI(config.verificationKey!, "ES256")
      : createRemoteJWKSet(
          new URL(
            `https://auth.privy.io/api/v1/apps/${encodeURIComponent(config.appID)}/jwks.json`,
          ),
        );
  }
  async verify(token: string, wallet: string): Promise<VerifiedPlayer> {
    decodeAddress(wallet);
    const { payload } = await jwtVerify(token, this.key, {
      issuer: "privy.io",
      audience: this.config.appID,
      algorithms: ["ES256"],
      requiredClaims: ["exp", "iat", "sub"],
    });
    if (this.config.identityOnly && typeof payload.linked_accounts !== "string")
      throw new Error(
        "Identity token required; access tokens are not accepted in user-owned wallet mode",
      );
    if (!payload.sub?.startsWith("did:privy:"))
      throw new Error("Invalid Privy identity");
    const response = await this.request(
      `https://api.privy.io/v1/users/${encodeURIComponent(payload.sub)}`,
      {
        headers: {
          "privy-app-id": this.config.appID,
          Authorization: `Basic ${Buffer.from(`${this.config.appID}:${this.config.appSecret}`).toString("base64")}`,
        },
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      },
    );
    if (!response.ok) throw new Error("Unable to verify linked wallet");
    const user = (await response.json()) as {
      id?: string;
      linked_accounts?: Array<{
        type?: string;
        chain_type?: string;
        address?: string;
      }>;
    };
    if (
      user.id !== payload.sub ||
      !user.linked_accounts?.some(
        (a) =>
          a.type === "wallet" &&
          a.chain_type === "solana" &&
          a.address === wallet,
      )
    )
      throw new Error("Wallet is not linked to this signed-in account");
    return { subject: payload.sub, wallet, expires: payload.exp! * 1000 };
  }
}
