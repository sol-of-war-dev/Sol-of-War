import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LobbyStore, parseStake, limits } from "../../src/frontpot/Store";
import { WalletChallenges } from "../../src/frontpot/Wallet";

describe("Frontpot matchmaking", () => {
  it("creates an ID-based lobby and validates host edits before guests join", () => {
    const store = new LobbyStore(() => 1000, 1_000_000);
    const host = store.identity("Host"),
      guest = store.identity("Guest");
    const room = store.create(host, {
      mode: "ffa",
      stake: "0.01",
      private: true,
    });
    expect(room.name).toBe(`Lobby ${room.id}`);
    const id = room.id;
    store.updateSettings(host, id, {
      mode: "2v2",
      stake: "0.25",
      private: true,
    });
    expect(room.id).toBe(id);
    expect(room.lamports).toBe(250_000_000);
    expect(limits(room)).toEqual({ min: 4, max: 4 });
    expect(room.startsAt).toBeNull();
    expect(() =>
      store.updateSettings(guest, id, { mode: "ffa", stake: "1" }),
    ).toThrow("Only the host");
    expect(() =>
      store.updateSettings(host, id, { mode: "ffa", stake: "-1" }),
    ).toThrow();
    expect(room.mode).toBe("2v2");
    store.join(guest, id);
    expect(() =>
      store.updateSettings(host, id, { mode: "1v1", stake: "0.01" }),
    ).toThrow("locked");
    expect(room.lamports).toBe(250_000_000);
  });
  it("normalizes unranked edits and does not restart a public deadline", () => {
    let now = 1000;
    const store = new LobbyStore(() => now);
    const host = store.identity("Host");
    const room = store.create(host, {
      mode: "ffa",
      stake: "0.01",
      private: true,
    });
    store.updateSettings(host, room.id, {
      mode: "ffa",
      ranked: false,
      stake: "0",
      private: false,
    });
    const deadline = room.startsAt;
    now += 5000;
    store.updateSettings(host, room.id, {
      mode: "1v1",
      ranked: false,
      stake: "0",
      private: false,
    });
    expect(room.startsAt).toBe(deadline);
    expect(room.lamports).toBe(0);
  });
  it("discovers only the caller's active membership and clears it on explicit leave", () => {
    const store = new LobbyStore();
    const host = store.identity("Host"),
      guest = store.identity("Guest");
    const room = store.create(host, {
      mode: "1v1",
      stake: "0.01",
      private: true,
    });
    expect(store.activeRoom(host)?.id).toBe(room.id);
    expect(store.activeRoom(guest)).toBeUndefined();
    store.join(host, room.id);
    expect(room.members).toHaveLength(1);
    store.leave(host, room.id);
    expect(store.activeRoom(host)).toBeUndefined();
  });

  it("does not restore a departed player while preserving the locked prize roster", () => {
    const store = new LobbyStore();
    const host = store.identity("Host"),
      guest = store.identity("Guest");
    const room = store.create(host, {
      mode: "1v1",
      stake: "0.01",
      private: true,
    });
    store.join(guest, room.id);
    room.status = "playing";
    room.locked = { at: Date.now(), entrants: 2, prizeLamports: 19800000 };
    const roster = [...room.members];
    store.leave(host, room.id);
    store.leave(host, room.id);
    expect(store.activeRoom(host)).toBeUndefined();
    expect(store.activeRoom(guest)?.id).toBe(room.id);
    expect(room.members).toEqual(roster);
    expect(room.departedIDs).toEqual([host.id]);
  });

  it("normalizes exact stakes and rejects invalid or excessive amounts", () => {
    expect(parseStake(".25")).toEqual({ stake: "0.25", lamports: 250000000 });
    expect(parseStake("00.2500")).toEqual({
      stake: "0.25",
      lamports: 250000000,
    });
    expect(parseStake("1000.123456789")).toEqual({
      stake: "1000.123456789",
      lamports: 1_000_123_456_789,
    });
    for (const value of [
      "NaN",
      "Infinity",
      "-1",
      "0",
      "9007199.254740992",
      "0.1234567891",
      "0.00001",
      "1e-3",
      0.25,
    ])
      expect(() => parseStake(value)).toThrow();
  });
  it("rejects unfundable real entries before creating a lobby, while keeping practice free", () => {
    const store = new LobbyStore(Date.now, 1_000_000);
    const player = store.identity("Alice");
    for (const mode of ["ffa", "1v1", "2v2"]) {
      expect(() =>
        store.create(player, { mode, stake: "0.000999999" }),
      ).toThrow("at least 0.001 SOL");
      expect(store.rooms.size).toBe(0);
    }
    expect(
      store.create(player, { mode: "ffa", stake: "ignored", practice: true })
        .lamports,
    ).toBe(0);
    const paid = new LobbyStore(Date.now, 1_000_000);
    expect(
      paid.create(paid.identity("Bob"), { mode: "1v1", stake: "0.001" })
        .lamports,
    ).toBe(1_000_000);
    const demo = new LobbyStore();
    expect(
      demo.create(demo.identity("Demo"), { mode: "ffa", stake: "0.0001" })
        .lamports,
    ).toBe(100_000);
  });
  it("matches the same normalized stake and mode, and isolates different amounts and modes", () => {
    const store = new LobbyStore();
    const first = store.create(
      store.identity("Alice"),
      { mode: "ffa", stake: "0.25" },
      true,
    );
    const second = store.create(
      store.identity("Bobby"),
      { mode: "ffa", stake: "0.2500" },
      true,
    );
    expect(second.id).toBe(first.id);
    expect(second.members).toHaveLength(2);
    expect(
      store.create(store.identity("Carol"), { mode: "ffa", stake: "0.5" }, true)
        .id,
    ).not.toBe(first.id);
    expect(
      store.create(
        store.identity("David"),
        { mode: "1v1", stake: "0.25" },
        true,
      ).id,
    ).not.toBe(first.id);
  });
  it("balances 2v2 seats and enforces the four-player capacity", () => {
    const store = new LobbyStore();
    const room = store.create(store.identity("Alice"), {
      mode: "2v2",
      stake: "0.25",
    });
    for (const name of ["Bobby", "Carol", "David"])
      store.join(store.identity(name), room.id);
    expect(room.members.map((m) => m.team)).toEqual([0, 1, 0, 1]);
    expect(limits(room)).toEqual({ min: 4, max: 4 });
    expect(() => store.join(store.identity("Extra"), room.id)).toThrow("full");
  });
  it("never quick-matches private or practice rooms", () => {
    const store = new LobbyStore();
    const privateRoom = store.create(store.identity("Alice"), {
      mode: "ffa",
      stake: "0.25",
      private: true,
    });
    const publicRoom = store.create(
      store.identity("Bobby"),
      { mode: "ffa", stake: "0.25" },
      true,
    );
    expect(publicRoom.id).not.toBe(privateRoom.id);
    const practice = store.create(store.identity("Carol"), {
      mode: "ffa",
      stake: "garbage",
      practice: true,
    });
    expect(practice.lamports).toBe(0);
    expect(limits(practice)).toEqual({ min: 1, max: 1 });
  });
  it("blocks multiple active rooms and keeps the shared deadline when a member leaves", () => {
    const store = new LobbyStore();
    const a = store.identity("Alice");
    const b = store.identity("Bobby");
    const room = store.create(a, { mode: "1v1", stake: "1" });
    store.join(b, room.id);
    expect(() => store.create(a, { mode: "2v2", stake: "1" })).toThrow("Leave");
    room.status = "countdown";
    room.startsAt = Date.now() + 1000;
    store.leave(a, room.id);
    expect(room.status).toBe("countdown");
    expect(room.startsAt).not.toBeNull();
    expect(room.host).toBe(b.id);
  });
  it("rejects expired sessions and never puts bearer tokens in room data", () => {
    const store = new LobbyStore();
    const a = store.identity("Alice");
    const room = store.create(a, { mode: "ffa", stake: "1" });
    expect(store.publicRoom(room).host).toBe(room.host);
    expect(JSON.stringify(store.publicRoom(room))).not.toContain(a.token);
    a.expires = Date.now() - 1;
    expect(() => store.auth(a.token)).toThrow("expired");
  });
});

function base58(bytes: Buffer): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let number = BigInt(`0x${bytes.toString("hex")}`);
  let text = "";
  while (number > 0n) {
    text = alphabet[Number(number % 58n)] + text;
    number /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    text = "1" + text;
  }
  return text;
}
describe("Solana wallet sign-in", () => {
  it("verifies a real Ed25519 signature, binds the origin, and prevents nonce reuse", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const address = base58(
      publicKey.export({ type: "spki", format: "der" }).subarray(-32),
    );
    const challenges = new WalletChallenges();
    const origin = "https://frontpot.example";
    const first = challenges.create(address, origin);
    const signature = sign(
      null,
      Buffer.from(first.message),
      privateKey,
    ).toString("base64");
    expect(challenges.verify(first.nonce, signature, origin)).toBe(address);
    expect(() => challenges.verify(first.nonce, signature, origin)).toThrow(
      "expired",
    );
    const second = challenges.create(address, origin);
    expect(() =>
      challenges.verify(
        second.nonce,
        sign(null, Buffer.from(second.message), privateKey).toString("base64"),
        "https://other.example",
      ),
    ).toThrow();
  });
  it("rejects a different wallet's signature and malformed addresses", () => {
    const first = generateKeyPairSync("ed25519"),
      second = generateKeyPairSync("ed25519");
    const challenges = new WalletChallenges();
    const origin = "https://frontpot.example";
    const address = base58(
      first.publicKey.export({ type: "spki", format: "der" }).subarray(-32),
    );
    const challenge = challenges.create(address, origin);
    expect(() =>
      challenges.verify(
        challenge.nonce,
        sign(null, Buffer.from(challenge.message), second.privateKey).toString(
          "base64",
        ),
        origin,
      ),
    ).toThrow("verified");
    expect(() => challenges.create("not-a-wallet", origin)).toThrow();
  });
});
