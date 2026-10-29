import { JoinUsernameSchema } from "@openfront/engine-api/Schemas";
import { PersistentIdSchema } from "@openfront/shared/WireSchemas";
import express from "express";
import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAuthRoutes, bearerToken } from "../../src/frontpot/AuthRoutes";
import {
  PlayerAuth,
  AuthError,
  validateUsername,
} from "../../src/frontpot/PlayerAuth";
import { LobbyStore } from "../../src/frontpot/Store";

const wallet = "11111111111111111111111111111111";
const otherWallet = "So11111111111111111111111111111111111111112";
const verified = (subject = "did:privy:alice", address = wallet) => ({
  subject,
  wallet: address,
  expires: Date.now() + 3600_000,
});
const databases: DatabaseSync[] = [];
const servers: Server[] = [];
function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  return { db, auth: new PlayerAuth(db) };
}
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const db of databases.splice(0)) db.close();
  vi.useRealTimers();
});

describe("wallet and username access", () => {
  it("rejects old guest/wallet sessions and requires a claimed username", () => {
    const { db, auth } = fixture();
    db.exec(
      "CREATE TABLE sessions(token TEXT PRIMARY KEY, body TEXT NOT NULL)",
    );
    db.prepare("INSERT INTO sessions VALUES(?,?)").run(
      "legacy",
      JSON.stringify({
        wallet,
        name: "Commander",
        expires: Date.now() + 3600_000,
      }),
    );
    expect(() => auth.auth("legacy")).toThrow("Sign in");
    const pending = auth.signIn(verified());
    expect(pending.name).toBe("");
    expect(() => auth.auth(pending.token)).toThrow("Choose a username");
    expect(auth.auth(pending.token, false).wallet).toBe(wallet);
    const ready = auth.claimUsername(pending.token, "MapMaster");
    expect(auth.auth(ready.token).name).toBe("MapMaster");
  });
  it("reserves usernames case-insensitively and survives service reconstruction", () => {
    const { db, auth } = fixture();
    const a = auth.signIn(verified());
    const b = auth.signIn(verified("did:privy:bob", otherWallet));
    auth.claimUsername(a.token, "MapMaster");
    expect(() => auth.claimUsername(b.token, "mapmaster")).toThrow("taken");
    expect(() => auth.claimUsername(a.token, "SomeoneElse")).toThrow(
      "already set",
    );
    const restarted = new PlayerAuth(db);
    const returning = restarted.signIn(verified());
    expect(returning.id).toBe(a.id);
    expect(returning.name).toBe("MapMaster");
  });
  it("rejects missing, malformed, too-short and too-long usernames without silently changing them", () => {
    for (const invalid of [
      undefined,
      123,
      "",
      "ab",
      "a".repeat(21),
      "has spaces",
      "abc<script>",
      "námé",
      "has-dash",
    ])
      expect(() => validateUsername(invalid)).toThrow("3–20");
    expect(validateUsername("  Commander_7 ")).toBe("Commander_7");
  });
  it("binds each profile to its verified subject and wallet", () => {
    const { auth } = fixture();
    auth.signIn(verified());
    expect(() => auth.signIn(verified("did:privy:bob", wallet))).toThrow(
      "another player",
    );
    expect(() => auth.signIn(verified("did:privy:alice", otherWallet))).toThrow(
      "already linked",
    );
  });
  it("refreshes its own session only, respects expiry and revokes on logout", () => {
    const { auth } = fixture();
    const a = auth.signIn(verified());
    auth.claimUsername(a.token, "Alice");
    expect(auth.signIn(verified(), a.token).token).toBe(a.token);
    const b = auth.signIn(verified("did:privy:bob", otherWallet), a.token);
    expect(b.token).not.toBe(a.token);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 3600_001);
    expect(() => auth.auth(a.token)).toThrow("Sign in");
    vi.useRealTimers();
    auth.logout(b.token);
    expect(() => auth.auth(b.token, false)).toThrow("Sign in");
  });
  it("preserves historical wallet player IDs without migrating guest names", () => {
    const { db, auth } = fixture();
    db.prepare("INSERT INTO wallet_identities VALUES(?,?)").run(
      wallet,
      "historic-wallet-player",
    );
    const player = auth.signIn(verified());
    expect(player.id).toBe("historic-wallet-player");
    expect(player.name).toBe("");
  });
  it("blocks bypass endpoints and match actions over HTTP until verified and named", async () => {
    const { auth } = fixture();
    const store = new LobbyStore();
    const app = express();
    app.use(express.json());
    const verifier = {
      verify: vi.fn(async (token: string, address: string) => {
        if (token !== "verified-fixture" || address !== wallet)
          throw new Error("Bad token");
        return verified();
      }),
    };
    registerAuthRoutes(app, auth, verifier, () => {});
    app.post("/frontpot/api/rooms", (req, res) =>
      res.json(store.create(auth.auth(bearerToken(req)), req.body)),
    );
    app.post("/frontpot/api/rooms/:id/join", (req, res) =>
      res.json(store.join(auth.auth(bearerToken(req)), req.params.id)),
    );
    app.use(
      (
        e: Error,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) =>
        res
          .status(e instanceof AuthError ? e.status : 400)
          .json({ error: e.message }),
    );
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as { port: number };
    const post = (route: string, body = {}, token = "") =>
      fetch(`http://127.0.0.1:${address.port}/frontpot/api${route}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
    for (const path of [
      "/session",
      "/wallet/challenge",
      "/wallet/verify",
      "/presence",
      "/rooms",
      "/rooms/abcdefgh/join",
    ])
      expect((await post(path, { name: "Fake", wallet })).status).toBe(401);
    expect(
      (await post("/session/privy", { accessToken: "fake", wallet })).status,
    ).toBe(401);
    const session = await (
      await post("/session/privy", {
        accessToken: "verified-fixture",
        wallet,
        name: "Ignored",
      })
    ).json();
    for (const path of ["/rooms", "/rooms/abcdefgh/join", "/presence"])
      expect(
        (await post(path, { mode: "ffa", practice: true }, session.token))
          .status,
      ).toBe(403);
    expect(
      (await post("/profile", { username: "ab" }, session.token)).status,
    ).toBe(400);
    expect(
      (await post("/profile", { username: "Alice" }, session.token)).status,
    ).toBe(200);
    expect((await post("/presence", {}, session.token)).status).toBe(200);
    expect(auth.activePlayerIDs().size).toBe(1);
    const created = await post(
      "/rooms",
      { mode: "ffa", practice: true },
      session.token,
    );
    expect(created.status).toBe(200);
    expect((await created.json()).members[0]).toMatchObject({
      name: "Alice",
      wallet,
    });
    expect((await post("/logout", {}, session.token)).status).toBe(200);
    expect((await post("/presence", {}, session.token)).status).toBe(401);
    expect(auth.activePlayerIDs().size).toBe(0);
    expect((await post("/rooms", {}, session.token)).status).toBe(401);
  });
});

describe("Free Play guests", () => {
  it("issues server-only guest tokens without persistent profiles and blocks account auth", () => {
    const { auth, db } = fixture();
    const guest = auth.createGuest("Visitor123");
    expect(guest.guest).toBe(true);
    expect(JoinUsernameSchema.safeParse(guest.name).success).toBe(true);
    expect(PersistentIdSchema.safeParse(guest.id).success).toBe(true);
    expect(JoinUsernameSchema.safeParse(auth.createGuest("abcdefghijklmnopqrst").name).success).toBe(true);
    expect(guest.name).toBe("Visitor123 Guest");
    expect(guest.wallet).toBe("");
    expect(auth.auth(guest.token, true, true).id).toBe(guest.id);
    expect(() => auth.auth(guest.token)).toThrow("wallet");
    expect(() => auth.renameUsername(guest.token, "Different")).toThrow(
      "wallet",
    );
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM player_profiles").get()?.n,
    ).toBe(0);
    auth.logout(guest.token);
    expect(() => auth.auth(guest.token, true, true)).toThrow();
  });
  it("reserves registered usernames case-insensitively and validates guest names", () => {
    const { auth } = fixture();
    const player = auth.signIn(verified());
    auth.claimUsername(player.token, "Registered");
    expect(() => auth.createGuest("registered")).toThrow("registered player");
    expect(() => auth.createGuest("<script>")).toThrow();
    expect(() => auth.auth("guest:forged", true, true)).toThrow();
  });
});
