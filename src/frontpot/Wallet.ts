import { createPublicKey, randomBytes, verify } from "node:crypto";
import { InputError } from "./Store";

const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function decodeAddress(address: string): Buffer {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address))
    throw new InputError("Invalid Solana wallet address.");
  let value = 0n;
  for (const char of address)
    value = value * 58n + BigInt(alphabet.indexOf(char));
  const hex = value === 0n ? "" : value.toString(16);
  const decoded = Buffer.concat([
    Buffer.alloc(address.match(/^1*/)?.[0].length ?? 0),
    Buffer.from(hex.length % 2 ? `0${hex}` : hex, "hex"),
  ]);
  if (decoded.length !== 32)
    throw new InputError("Invalid Solana wallet address.");
  return decoded;
}
export class WalletChallenges {
  private pending = new Map<
    string,
    { address: string; origin: string; message: string; expires: number }
  >();
  create(address: string, origin: string) {
    decodeAddress(address);
    for (const [key, challenge] of this.pending)
      if (challenge.expires < Date.now()) this.pending.delete(key);
    if (this.pending.size >= 1000)
      throw new InputError("Please try again shortly.");
    const nonce = randomBytes(24).toString("hex");
    const expires = Date.now() + 5 * 60 * 1000;
    const message = `${new URL(origin).host} wants you to sign in with your Solana account:\n${address}\n\nSign in to the Frontpot demo. No transaction or transfer is authorized.\n\nURI: ${origin}\nVersion: 1\nChain ID: solana:devnet\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}\nExpiration Time: ${new Date(expires).toISOString()}`;
    this.pending.set(nonce, { address, origin, message, expires });
    return { nonce, message };
  }
  verify(nonce: string, signature: string, origin: string): string {
    const challenge = this.pending.get(nonce);
    this.pending.delete(nonce);
    if (
      !challenge ||
      challenge.expires < Date.now() ||
      challenge.origin !== origin
    )
      throw new InputError("Sign-in challenge expired. Please connect again.");
    const key = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        decodeAddress(challenge.address),
      ]),
      format: "der",
      type: "spki",
    });
    const bytes = Buffer.from(signature, "base64");
    if (
      bytes.length !== 64 ||
      !verify(null, Buffer.from(challenge.message), key, bytes)
    )
      throw new InputError("The wallet signature could not be verified.");
    return challenge.address;
  }
}
