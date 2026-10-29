import type { PartialGameRecord } from "@openfront/shared/WireSchemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdminStats,
  type ConnectedPlayer,
} from "../../src/frontpot/AdminStats";
import { formatAdminSol } from "../../src/frontpot/AdminStatsView";
import { MatchLedger } from "../../src/frontpot/MatchLedger";
import { PlayerAuth } from "../../src/frontpot/PlayerAuth";
import { LobbyStore } from "../../src/frontpot/Store";

const ledgers: MatchLedger[] = [];
afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  vi.useRealTimers();
});
function fixture() {
  const ledger = new MatchLedger(":memory:");
  ledgers.push(ledger);
  const auth = new PlayerAuth(ledger.db);
  const store = new LobbyStore();
  const connections: ConnectedPlayer[] = [];
  const stats = new AdminStats(ledger.db, auth, store, () => connections);
  return { ledger, auth, store, connections, stats };
}
function match(f: ReturnType<typeof fixture>, mode: "1v1" | "2v2" = "1v1") {
  const room = f.store.create(f.store.identity("Alice"), {
    mode,
    stake: "0.25",
  });
  for (let i = 1; i < (mode === "2v2" ? 4 : 2); i++)
    f.store.join(f.store.identity(`Player${i}`), room.id);
  f.ledger.lock(room, room.members);
  room.status = "playing";
  const record = {
    info: {
      gameID: room.id,
      players: room.members.map((m, i) => ({
        clientID: `client-${i}`,
        persistentID: m.id,
      })),
    },
    turns: [],
  } as unknown as PartialGameRecord;
  const settle = () => {
    f.ledger.verifying(room.id);
    f.ledger.settle(record, {
      winner:
        mode === "2v2"
          ? ["team", "Red", "client-0", "client-2"]
          : ["player", "client-0"],
      tick: 100,
      allPlayersStats: {},
    });
  };
  return { room, settle };
}
describe("administrator statistics", () => {
  it("separates settled fees and winner payouts from refunds and unresolved pools", () => {
    const f = fixture();
    const settled = match(f, "2v2");
    settled.settle();
    settled.settle();
    const refunded = match(f);
    f.ledger.refund(refunded.room.id, "No winner");
    const review = match(f);
    f.ledger.review(review.room.id, "Result mismatch");
    match(f);
    const empty = f.store.create(f.store.identity("Waiting"), {
      mode: "ffa",
      stake: "0.25",
    });
    f.ledger.open(empty);
    f.ledger.refund(empty.id, "Empty lobby");
    const practice = f.store.create(f.store.identity("Practice"), {
      mode: "ffa",
      stake: "0",
      practice: true,
    });
    f.ledger.lock(practice, practice.members);
    const result = f.stats.snapshot();
    expect(result.allTime).toEqual({
      wageredLamports: "2500000000",
      paidOutLamports: "990000000",
      feesLamports: "10000000",
      refundedLamports: "500000000",
      startedMatches: 4,
      settledMatches: 1,
      refundedMatches: 1,
    });
    expect(result.unsettledLamports).toBe("1000000000");
    expect(result.reviewMatches).toBe(1);
    expect(result.issues[0].reason).toBe("Result mismatch");
    expect(result.activity).toHaveLength(4);
    expect(JSON.stringify(result)).not.toMatch(
      /wallet|participants|token|subject/,
    );
    expect(BigInt(result.allTime.wageredLamports)).toBe(
      BigInt(result.allTime.paidOutLamports) +
        BigInt(result.allTime.feesLamports) +
        BigInt(result.allTime.refundedLamports) +
        BigInt(result.unsettledLamports),
    );
  });
  it("uses start time for wagers and settlement time for payouts in a rolling 24-hour window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T10:00:00Z"));
    const f = fixture();
    const old = match(f);
    vi.setSystemTime(new Date("2026-10-22T10:00:00Z"));
    old.settle();
    const fresh = match(f);
    f.ledger.refund(fresh.room.id, "Refunded today");
    const result = f.stats.snapshot();
    expect(result.allTime.wageredLamports).toBe("1000000000");
    expect(result.last24Hours).toMatchObject({
      wageredLamports: "500000000",
      paidOutLamports: "495000000",
      feesLamports: "5000000",
      refundedLamports: "500000000",
      startedMatches: 1,
      settledMatches: 1,
    });
    vi.advanceTimersByTime(24 * 3600_000 + 1);
    expect(f.stats.snapshot().last24Hours.wageredLamports).toBe("0");
  });
  it("counts verified usernames and deduplicates active players across tabs and game connections", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
    const f = fixture();
    const verified = {
      subject: "did:privy:alice",
      wallet: "wallet-a",
      expires: Date.now() + 3600_000,
    };
    const alice = f.auth.signIn(verified);
    f.auth.claimUsername(alice.token, "Alice");
    const tab2 = f.auth.signIn(verified);
    f.auth.signIn({
      ...verified,
      subject: "did:privy:bob",
      wallet: "wallet-b",
    });
    const { room } = match(f);
    f.connections.push(
      { id: alice.id, roomID: room.id },
      { id: alice.id, roomID: room.id },
    );
    expect(f.stats.snapshot()).toMatchObject({
      registeredPlayers: 1,
      incompleteProfiles: 1,
      activePlayers: 1,
      playersInGames: 1,
      liveMatches: 1,
    });
    vi.advanceTimersByTime(90_001);
    expect(f.stats.snapshot().activePlayers).toBe(1); // Connected play outlives browser heartbeat.
    f.connections.splice(0);
    expect(f.stats.snapshot().activePlayers).toBe(0);
    f.auth.auth(tab2.token);
    expect(f.stats.snapshot().activePlayers).toBe(1);
    f.auth.logout(tab2.token);
    expect(f.stats.snapshot().activePlayers).toBe(0);
    f.auth.auth(alice.token);
    vi.advanceTimersByTime(3600_000);
    expect(f.stats.snapshot().activePlayers).toBe(0);
  });
  it("flags delayed verification, refreshes cached totals and retains totals after reconstruction", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
    const f = fixture();
    const game = match(f);
    f.ledger.verifying(game.room.id);
    expect(f.stats.snapshot().delayedVerifications).toBe(0);
    vi.advanceTimersByTime(300_000);
    expect(f.stats.snapshot()).toMatchObject({
      verifyingMatches: 1,
      delayedVerifications: 1,
    });
    game.settle();
    vi.advanceTimersByTime(5_000);
    expect(f.stats.snapshot()).toMatchObject({
      verifyingMatches: 0,
      delayedVerifications: 0,
    });
    const restored = new AdminStats(
      f.ledger.db,
      new PlayerAuth(f.ledger.db),
      new LobbyStore(),
      () => [],
    );
    expect(restored.snapshot().allTime).toEqual(f.stats.snapshot().allTime);
  });
  it("preserves integer precision for lifetime totals beyond JavaScript's safe range", () => {
    const f = fixture();
    const game = match(f);
    const pool = f.ledger.get(game.room.id)!;
    const insert = f.ledger.db.prepare(
      "INSERT INTO pools(id,body) VALUES(?,?)",
    );
    const event = f.ledger.db.prepare(
      "INSERT INTO pool_events(match_id,at,state,reason) VALUES(?,?,?,?)",
    );
    f.ledger.db.exec("DELETE FROM pools; DELETE FROM pool_events; BEGIN");
    for (let i = 0; i < 1001; i++) {
      const id = `precision-${i}`;
      insert.run(
        id,
        JSON.stringify({
          ...pool,
          matchID: id,
          poolLamports: 9_999_999_999_999,
        }),
      );
      event.run(id, Date.now(), "playing", "Locked");
    }
    f.ledger.db.exec("COMMIT");
    const expected = (9_999_999_999_999n * 1001n).toString();
    expect(f.stats.snapshot().allTime.wageredLamports).toBe(expected);
    expect(formatAdminSol(expected)).toBe("10,009,999.999998999");
    expect(formatAdminSol("6187500000")).toBe("6.1875");
  });
});
