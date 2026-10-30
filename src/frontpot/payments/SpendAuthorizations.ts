import { createPublicKey, randomUUID, verify } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { InputError } from "../Store";
import { decodeAddress } from "../Wallet";
import type { PaymentNetwork } from "./Network";
import { bindPaymentDatabase } from "./PaymentDatabase";
import {
  spendApprovalMessage,
  type SpendApproval,
  type SpendProof,
  type SpendTerms,
} from "./SpendApproval";

function normalized(t: SpendTerms): SpendTerms {
  return {
    requestID: t.requestID,
    playerID: t.playerID,
    wallet: t.wallet,
    source: t.source,
    destination: t.destination,
    lamports: t.lamports,
    network: t.network,
    kind: t.kind,
    matchID: t.matchID ?? null,
    termsHash: t.termsHash ?? null,
  };
}
const denied = () =>
  new InputError(
    "Approve this exact payment with your connected wallet. The approval is missing, invalid or expired.",
  );

/** Durable, one-request wallet consent. This is an application safeguard, not
 * an isolation boundary against an operator with the database and signing keys. */
export class SpendAuthorizations {
  readonly origin: string;
  constructor(
    private db: DatabaseSync,
    readonly network: PaymentNetwork,
    origin: string,
    private now: () => number = Date.now,
  ) {
    const url = new URL(origin);
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      (url.protocol !== "https:" &&
        !(
          network === "devnet" &&
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        ))
    )
      throw new Error(
        "Payment approvals require a canonical HTTPS APP_ORIGIN (localhost HTTP is devnet-only)",
      );
    this.origin = origin;
    bindPaymentDatabase(db, network);
    db.exec(
      "CREATE TABLE IF NOT EXISTS spend_authorizations(nonce TEXT PRIMARY KEY, player_id TEXT NOT NULL, request_id TEXT NOT NULL, expires INTEGER NOT NULL, body TEXT NOT NULL, signature TEXT, consumed INTEGER); CREATE INDEX IF NOT EXISTS spend_authorizations_request ON spend_authorizations(player_id,request_id)",
    );
  }
  issue(terms: SpendTerms): SpendApproval {
    const t = normalized(terms);
    if (
      t.network !== this.network ||
      !t.playerID ||
      t.playerID.length > 128 ||
      !new RegExp(
        `^${t.kind === "withdrawal" ? "withdrawal" : "deposit"}:[a-zA-Z0-9-]{8,128}$`,
      ).test(t.requestID) ||
      !["withdrawal", "wager"].includes(t.kind) ||
      !Number.isSafeInteger(t.lamports) ||
      t.lamports <= 0 ||
      (t.kind === "wager"
        ? !t.matchID || !/^[a-f0-9]{64}$/.test(t.termsHash ?? "")
        : t.matchID !== null || t.termsHash !== null)
    )
      throw denied();
    for (const value of [t.wallet, t.source, t.destination])
      decodeAddress(value);
    const now = this.now();
    // Keep consumed evidence. Unused expired challenges authorize nothing.
    this.db
      .prepare(
        "DELETE FROM spend_authorizations WHERE consumed IS NULL AND expires<?",
      )
      .run(now);
    const rows = this.db
      .prepare(
        "SELECT body FROM spend_authorizations WHERE player_id=? AND request_id=? AND consumed IS NULL AND expires>? ORDER BY rowid DESC",
      )
      .all(t.playerID, t.requestID, now);
    for (const row of rows) {
      const a = JSON.parse(String(row.body)) as SpendApproval;
      if (
        JSON.stringify(normalized(a)) === JSON.stringify(t) &&
        a.origin === this.origin
      )
        return a;
    }
    if (
      Number(
        this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM spend_authorizations WHERE player_id=? AND consumed IS NULL",
          )
          .get(t.playerID)!.n,
      ) >= 20
    )
      throw new InputError(
        "Too many pending payment approvals. Wait a few minutes and retry.",
      );
    const a: SpendApproval = {
      ...t,
      version: 1,
      origin: this.origin,
      nonce: randomUUID(),
      expires: now + 5 * 60_000,
    };
    this.db
      .prepare(
        "INSERT INTO spend_authorizations(nonce,player_id,request_id,expires,body) VALUES(?,?,?,?,?)",
      )
      .run(a.nonce, a.playerID, a.requestID, a.expires, JSON.stringify(a));
    return a;
  }
  private check(terms: SpendTerms, proof: unknown, consumed: boolean) {
    const p = proof as Partial<SpendProof> | null;
    if (
      !p ||
      typeof p.nonce !== "string" ||
      typeof p.signature !== "string" ||
      !/^[0-9a-f-]{36}$/.test(p.nonce) ||
      !/^[A-Za-z0-9+/]{86}==$/.test(p.signature)
    )
      throw denied();
    const row = this.db
      .prepare("SELECT * FROM spend_authorizations WHERE nonce=?")
      .get(p.nonce);
    if (!row) throw denied();
    const a = JSON.parse(String(row.body)) as SpendApproval;
    if (
      a.version !== 1 ||
      a.origin !== this.origin ||
      a.network !== this.network ||
      JSON.stringify(normalized(a)) !== JSON.stringify(normalized(terms)) ||
      (consumed
        ? row.consumed === null ||
          Number(row.consumed) > a.expires ||
          row.signature !== p.signature
        : row.consumed !== null || a.expires <= this.now())
    )
      throw denied();
    const key = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        decodeAddress(a.wallet),
      ]),
      format: "der",
      type: "spki",
    });
    if (
      !verify(
        null,
        Buffer.from(spendApprovalMessage(a)),
        key,
        Buffer.from(p.signature, "base64"),
      )
    )
      throw denied();
    return p as SpendProof;
  }
  /** Must run in the same SQLite transaction as inserting the transfer. */
  consume(terms: SpendTerms, proof: unknown): SpendProof {
    if (!this.db.isTransaction)
      throw new Error(
        "Payment approval consumption requires the transfer transaction",
      );
    const p = this.check(terms, proof, false);
    const changed = this.db
      .prepare(
        "UPDATE spend_authorizations SET signature=?,consumed=? WHERE nonce=? AND consumed IS NULL",
      )
      .run(p.signature, this.now(), p.nonce);
    if (changed.changes !== 1) throw denied();
    return p;
  }
  verifySaved(terms: SpendTerms, proof: unknown) {
    this.check(terms, proof, true);
  }
}
