import { getBase58Decoder, getTransactionDecoder } from "@solana/kit";
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  assertNativeTransfer,
  type NativeTransferTerms,
} from "./NativeTransferPolicy";
import type { PaymentNetwork } from "./Network";
import { bindPaymentDatabase } from "./PaymentDatabase";

type Envelope = { keyID: string; iv: string; tag: string; ciphertext: string };
export type PlayerWallet = {
  playerID: string;
  address: string;
  created: number;
};
export type WalletKeyring = { active: string; keys: Record<string, string> };
/** Server-only envelope encryption. The keyring must live outside the database
 * and its backups. No endpoint exports keys or accepts arbitrary signing data.
 * Old wrapping keys must remain available until all records have been rotated. */
export class PlayerWalletVault {
  private keys = new Map<string, Buffer>();
  constructor(
    private db: DatabaseSync,
    readonly network: PaymentNetwork,
    private keyring: WalletKeyring,
  ) {
    bindPaymentDatabase(db, network);
    for (const [id, encoded] of Object.entries(keyring.keys)) {
      const key = Buffer.from(encoded, "base64");
      if (
        !/^[a-zA-Z0-9_-]{1,64}$/.test(id) ||
        key.length !== 32 ||
        key.toString("base64") !== encoded
      )
        throw new Error("Invalid player wallet wrapping key");
      this.keys.set(id, key);
    }
    if (!this.keys.has(keyring.active))
      throw new Error("Missing active player wallet wrapping key");
    db.exec(
      "CREATE TABLE IF NOT EXISTS player_wallets(player_id TEXT PRIMARY KEY,address TEXT NOT NULL UNIQUE,created INTEGER NOT NULL,envelope TEXT NOT NULL)",
    );
    // Never silently replace an unrecoverable wallet with a new deposit address.
    for (const row of db.prepare("SELECT * FROM player_wallets").all()) {
      const bytes = this.decrypt(
        String(row.player_id),
        String(row.address),
        JSON.parse(String(row.envelope)),
      );
      bytes.fill(0);
    }
  }
  private aad(playerID: string, address: string) {
    return Buffer.from(
      JSON.stringify([
        "solsiege-player-wallet-v1",
        this.network,
        playerID,
        address,
      ]),
    );
  }
  private decrypt(playerID: string, address: string, envelope: Envelope) {
    const key = this.keys.get(envelope.keyID);
    if (!key)
      throw new Error(
        "Player wallet wrapping key unavailable; restore the original keyring",
      );
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(envelope.iv, "base64"),
    );
    decipher.setAAD(this.aad(playerID, address));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const bytes = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]);
    const publicBytes = createPublicKey(
      createPrivateKey({ key: bytes, format: "der", type: "pkcs8" }),
    ).export({ format: "der", type: "spki" });
    if (getBase58Decoder().decode(publicBytes.subarray(-32)) !== address) {
      bytes.fill(0);
      throw new Error("Player wallet address does not match its encrypted key");
    }
    return bytes;
  }
  get(playerID: string): PlayerWallet | null {
    const row = this.db
      .prepare(
        "SELECT player_id,address,created FROM player_wallets WHERE player_id=?",
      )
      .get(playerID);
    return row
      ? {
          playerID: String(row.player_id),
          address: String(row.address),
          created: Number(row.created),
        }
      : null;
  }
  ensure(playerID: string): PlayerWallet {
    const saved = this.get(playerID);
    if (saved) return saved;
    if (!playerID || playerID.length > 128)
      throw new Error("Invalid wallet owner");
    const pair = generateKeyPairSync("ed25519");
    const address = getBase58Decoder().decode(
      pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32),
    );
    const privateBytes = pair.privateKey.export({
      format: "der",
      type: "pkcs8",
    });
    try {
      const iv = randomBytes(12);
      const cipher = createCipheriv(
        "aes-256-gcm",
        this.keys.get(this.keyring.active)!,
        iv,
      );
      cipher.setAAD(this.aad(playerID, address));
      const ciphertext = Buffer.concat([
        cipher.update(privateBytes),
        cipher.final(),
      ]);
      const envelope: Envelope = {
        keyID: this.keyring.active,
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      };
      this.db
        .prepare(
          "INSERT INTO player_wallets VALUES(?,?,?,?) ON CONFLICT(player_id) DO NOTHING",
        )
        .run(playerID, address, Date.now(), JSON.stringify(envelope));
      return this.get(playerID)!;
    } finally {
      privateBytes.fill(0);
    }
  }
  /** Internal only: callers build and authorize the exact transfer first. */
  signTransfer(
    playerID: string,
    transaction: string,
    terms: NativeTransferTerms,
  ): string {
    if (this.get(playerID)?.address !== terms.source)
      throw new Error("Wrong player wallet source");
    assertNativeTransfer(transaction, terms);
    return this.sign(playerID, transaction);
  }
  sign(playerID: string, transaction: string): string {
    const wallet = this.get(playerID);
    const row = this.db
      .prepare("SELECT envelope FROM player_wallets WHERE player_id=?")
      .get(playerID);
    if (!wallet || !row) throw new Error("Player wallet not found");
    const tx = getTransactionDecoder().decode(
      Buffer.from(transaction, "base64"),
    );
    if (!(wallet.address in tx.signatures))
      throw new Error("Wrong player wallet signer");
    const bytes = this.decrypt(
      playerID,
      wallet.address,
      JSON.parse(String(row.envelope)),
    );
    try {
      return sign(
        null,
        Buffer.from(tx.messageBytes),
        createPrivateKey({ key: bytes, format: "der", type: "pkcs8" }),
      ).toString("base64");
    } finally {
      bytes.fill(0);
    }
  }
}
