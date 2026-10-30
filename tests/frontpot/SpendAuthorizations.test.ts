import { getBase58Decoder } from "@solana/kit";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  spendApprovalMessage,
  type SpendTerms,
} from "../../src/frontpot/payments/SpendApproval";
import { SpendAuthorizations } from "../../src/frontpot/payments/SpendAuthorizations";
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const keys = generateKeyPairSync("ed25519");
  const wallet = getBase58Decoder().decode(
    keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32),
  );
  let time = Date.now();
  const service = new SpendAuthorizations(
    db,
    "devnet",
    "https://solofwar.fun",
    () => time,
  );
  const terms: SpendTerms = {
    requestID: `withdrawal:${randomUUID()}`,
    playerID: "alice",
    wallet,
    source: "11111111111111111111111111111111",
    destination: wallet,
    lamports: 1_000_001,
    network: "devnet",
    kind: "withdrawal",
    matchID: null,
    termsHash: null,
  };
  const a = service.issue(terms);
  const proof = {
    nonce: a.nonce,
    signature: sign(
      null,
      Buffer.from(spendApprovalMessage(a)),
      keys.privateKey,
    ).toString("base64"),
  };
  const consume = (t = terms, p: unknown = proof) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = service.consume(t, p);
      db.exec("COMMIT");
      return result;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  return {
    db,
    service,
    terms,
    a,
    proof,
    consume,
    advance: () => {
      time += 300_001;
    },
  };
}
describe("payment approvals", () => {
  it("displays precise SOL and lamports and explicitly authorizes payment", () => {
    const f = fixture();
    expect(spendApprovalMessage(f.a)).toContain(
      "0.001000001 SOL (1000001 lamports)",
    );
    expect(spendApprovalMessage(f.a)).toContain("It is not a sign-in request");
    expect(f.service.issue(f.terms)).toEqual(f.a);
  });
  it("consumes once, survives service restart and retains approval after expiry for the same durable transfer", () => {
    const f = fixture();
    f.consume();
    f.advance();
    const restarted = new SpendAuthorizations(
      f.db,
      "devnet",
      "https://solofwar.fun",
    );
    expect(() => restarted.verifySaved(f.terms, f.proof)).not.toThrow();
    expect(() => f.consume()).toThrow("Approve this exact payment");
  });
  it("requires atomic consumption and rolls it back with the transfer", () => {
    const f = fixture();
    expect(() => f.service.consume(f.terms, f.proof)).toThrow(
      "requires the transfer transaction",
    );
    f.db.exec("BEGIN IMMEDIATE");
    f.service.consume(f.terms, f.proof);
    f.db.exec("ROLLBACK");
    expect(() => f.consume()).not.toThrow();
  });
  it.each([
    { lamports: 2_000_000 },
    { destination: "11111111111111111111111111111111" },
    { playerID: "bob" },
    { requestID: `withdrawal:${randomUUID()}` },
    { network: "mainnet" as const },
    { kind: "wager" as const },
    { source: "So11111111111111111111111111111111111111112" },
    { wallet: "So11111111111111111111111111111111111111112" },
    { matchID: "another-game" },
    { termsHash: "f".repeat(64) },
  ])("rejects altered terms %j without burning valid approval", (changed) => {
    const f = fixture();
    expect(() => f.consume({ ...f.terms, ...changed })).toThrow();
    expect(() => f.consume()).not.toThrow();
  });
  it("rejects unsigned, forged and expired approvals", () => {
    const f = fixture();
    expect(() => f.consume(f.terms, null)).toThrow();
    expect(() =>
      f.consume(f.terms, {
        ...f.proof,
        signature: Buffer.alloc(64).toString("base64"),
      }),
    ).toThrow();
    expect(() => f.service.verifySaved(f.terms, f.proof)).toThrow();
    f.advance();
    expect(() => f.consume()).toThrow();
  });
  it("rejects an approval issued for another deployment origin", () => {
    const f = fixture();
    f.consume();
    const other = new SpendAuthorizations(
      f.db,
      "devnet",
      "https://other.example",
    );
    expect(() => other.verifySaved(f.terms, f.proof)).toThrow();
  });
  it("bounds open challenges and expires unused requests", () => {
    const f = fixture();
    for (let i = 1; i < 20; i++)
      f.service.issue({ ...f.terms, requestID: `withdrawal:${randomUUID()}` });
    expect(() =>
      f.service.issue({ ...f.terms, requestID: `withdrawal:${randomUUID()}` }),
    ).toThrow("Too many");
    f.advance();
    expect(() => f.service.issue(f.terms)).not.toThrow();
  });
  it("requires a fixed secure origin and match context for wagers", () => {
    const f = fixture();
    expect(
      () =>
        new SpendAuthorizations(f.db, "devnet", "https://solofwar.fun/path"),
    ).toThrow();
    expect(
      () => new SpendAuthorizations(f.db, "devnet", "http://solofwar.fun"),
    ).toThrow();
    expect(() =>
      f.service.issue({
        ...f.terms,
        kind: "wager",
        requestID: `deposit:${randomUUID()}`,
      }),
    ).toThrow();
  });
});
