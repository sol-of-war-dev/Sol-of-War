import type { ReplayedWinner } from "@openfront/engine/WinnerReplay";
import type { PartialGameRecord } from "@openfront/shared/WireSchemas";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MatchLedger } from "../../src/frontpot/MatchLedger";
import { prizeSplit } from "../../src/frontpot/Rules";
import { LobbyStore } from "../../src/frontpot/Store";

function fixture(mode: "1v1" | "2v2" | "ffa" = "1v1") {
  const store = new LobbyStore();
  const room = store.create(store.identity("Alice", "wallet-a"), {
    mode,
    stake: "0.25",
  });
  const count = mode === "2v2" ? 4 : 2;
  for (let i = 1; i < count; i++)
    store.join(store.identity(`Player ${i}`, `wallet-${i}`), room.id);
  const ledger = new MatchLedger(":memory:");
  ledger.open(room);
  ledger.lock(room, room.members);
  ledger.verifying(room.id);
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
  const result = {
    winner:
      mode !== "2v2"
        ? ["player", "client-0"]
        : ["team", "Red", "client-0", "client-2"],
    tick: 100,
    allPlayersStats: {},
  } as ReplayedWinner;
  return { ledger, room, record, result };
}
describe("fixed match pools", () => {
  it("settles an FFA wager with its prize and fee but never changes Elo", () => {
    const f = fixture("ffa");
    const result = f.ledger.settle(f.record, f.result)!;
    expect(f.room.ranked).toBe(false);
    expect(result.ranked).toBe(false);
    expect(result.poolLamports).toBe(500_000_000);
    expect(result.feeLamports).toBe(5_000_000);
    expect(result.payouts[0].lamports).toBe(495_000_000);
    expect(
      f.ledger.rankings.result(f.room.id, f.room.members[0].id),
    ).toBeUndefined();
    f.ledger.close();
  });
  it("uses the edited entry and mode in the eventual payout ledger", () => {
    const store = new LobbyStore();
    const host = store.identity("Host");
    const room = store.create(host, {
      mode: "ffa",
      stake: "0.01",
      private: true,
    });
    const ledger = new MatchLedger(":memory:");
    const poolID = ledger.open(room).poolID;
    store.updateSettings(host, room.id, {
      mode: "1v1",
      stake: "0.25",
      private: true,
    });
    ledger.updateSettings(room);
    store.join(store.identity("Guest"), room.id);
    const pool = ledger.lock(room, room.members);
    expect(pool.poolID).toBe(poolID);
    expect(pool.mode).toBe("1v1");
    expect(pool.poolLamports).toBe(500_000_000);
    expect(pool.feeLamports).toBe(5_000_000);
    expect(() => ledger.updateSettings(room)).toThrow("locked");
    ledger.db.close();
  });
  it("charges exactly 1% and conserves every lamport", () => {
    expect(prizeSplit(250_000_000, 2)).toEqual({
      poolLamports: 500_000_000,
      feeLamports: 5_000_000,
      payouts: [495_000_000],
    });
    expect(prizeSplit(250_000_000, 10)).toEqual({
      poolLamports: 2_500_000_000,
      feeLamports: 25_000_000,
      payouts: [2_475_000_000],
    });
    for (let stake = 1; stake < 70; stake++) {
      const s = prizeSplit(stake, 3, 2);
      expect(s.feeLamports + s.payouts.reduce((a, b) => a + b, 0)).toBe(
        s.poolLamports,
      );
      expect(Math.abs(s.payouts[0] - s.payouts[1])).toBeLessThanOrEqual(1);
    }
  });
  it("honors a saved match fee when settling a result from before the fee change", () => {
    const { ledger, room, record, result } = fixture();
    const saved = ledger.get(room.id)!;
    expect(saved.feeBps).toBe(100);
    saved.feeBps = 500;
    ledger.db
      .prepare("UPDATE pools SET body=? WHERE id=?")
      .run(JSON.stringify(saved), room.id);
    const settled = ledger.settle(record, result)!;
    expect(settled.feeBps).toBe(500);
    expect(settled.feeLamports).toBe(25_000_000);
    expect(settled.payouts[0].lamports).toBe(475_000_000);
    ledger.close();
  });
  it("rejects invalid stored fee rates and allows zero-fee terms", () => {
    for (const fee of [-1, 10001, 1.5, NaN])
      expect(() => prizeSplit(250_000_000, 2, 1, fee)).toThrow(
        "Invalid prize terms",
      );
    expect(prizeSplit(250_000_000, 2, 1, 0).payouts).toEqual([500_000_000]);
  });
  it("freezes destination wallets and settles only once", () => {
    const { ledger, room, record, result } = fixture();
    const expected = room.members[0].wallet;
    room.members[0].wallet = "changed-later";
    const settled = ledger.settle(record, result)!;
    expect(settled.state).toBe("settled");
    expect(settled.payouts[0].wallet).toBe(expected);
    expect(settled.payouts[0].lamports).toBe(495_000_000);
    expect(
      ledger.settle(record, { ...result, winner: ["player", "client-1"] }),
    ).toEqual(settled);
    expect(ledger.refund(room.id, "late cancellation")).toEqual(settled);
    ledger.close();
  });
  it("splits 2v2 equally even if one winning teammate disconnected", () => {
    const { ledger, record, result } = fixture("2v2");
    const p = ledger.settle(record, {
      ...result,
      winner: ["team", "Red", "client-0"],
    })!;
    expect(p.payouts.map((x) => x.lamports)).toEqual([
      495_000_000, 495_000_000,
    ]);
    expect(p.feeLamports).toBe(10_000_000);
    ledger.close();
  });
  it("holds a failed or incomplete replay instead of trusting client votes", () => {
    const { ledger, room, record } = fixture();
    expect(ledger.settle(record, null)?.state).toBe("review");
    expect(ledger.get(room.id)?.payouts).toEqual([]);
    ledger.close();
  });
  it("refunds winnerless matches without a fee", () => {
    const { ledger, record, result } = fixture();
    const p = ledger.settle(record, { ...result, winner: undefined })!;
    expect(p.state).toBe("refunded");
    expect(p.feeLamports).toBe(0);
    expect(p.payouts.map((x) => x.lamports)).toEqual([
      250_000_000, 250_000_000,
    ]);
    ledger.close();
  });
  it("rejects fabricated winners and mismatching rosters", () => {
    const a = fixture();
    expect(
      a.ledger.settle(a.record, { ...a.result, winner: ["player", "intruder"] })
        ?.state,
    ).toBe("review");
    a.ledger.close();
    const b = fixture();
    b.record.info.players[0].persistentID = "intruder";
    expect(b.ledger.settle(b.record, b.result)?.state).toBe("review");
    b.ledger.close();
  });
  it("rejects a team result containing opponents from both locked teams", () => {
    const { ledger, record, result } = fixture("2v2");
    expect(
      ledger.settle(record, {
        ...result,
        winner: ["team", "Red", "client-0", "client-1"],
      })?.state,
    ).toBe("review");
    ledger.close();
  });
  it("resumes a saved verification after restart without authorizing a second payout", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "frontpot-verification-"));
    const file = path.join(dir, "ledger.sqlite");
    const { room, record, result, ledger: fixtureLedger } = fixture();
    fixtureLedger.close();
    try {
      const first = new MatchLedger(file);
      first.open(room);
      first.lock(room, room.members);
      first.saveRecord(record);
      first.verifying(room.id);
      first.close();
      const second = new MatchLedger(file);
      second.recoverInterrupted();
      expect(second.pendingVerification()).toEqual([room.id]);
      expect(second.record(room.id)).toEqual(record);
      expect(second.settle(second.record(room.id)!, result)?.state).toBe(
        "settled",
      );
      expect(second.pendingVerification()).toEqual([]);
      expect(second.settle(record, result)?.payouts).toHaveLength(1);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("restores records after restart and returns interrupted simulated stakes", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "frontpot-ledger-"));
    const file = path.join(dir, "ledger.sqlite");
    try {
      const store = new LobbyStore();
      const a = store.identity("Alice");
      const room = store.create(a, { mode: "1v1", stake: "1" });
      store.join(store.identity("Bob"), room.id);
      const first = new MatchLedger(file);
      first.open(room);
      first.lock(room, room.members);
      const poolID = first.get(room.id)!.poolID;
      first.close();
      const second = new MatchLedger(file);
      second.recoverInterrupted();
      expect(second.get(room.id)?.poolID).toBe(poolID);
      expect(second.get(room.id)?.state).toBe("refunded");
      expect(second.history(a.id)).toHaveLength(1);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

it("commits ranked ratings with the verified settlement and never applies them twice", () => {
  const { ledger, room, record, result } = fixture();
  ledger.settle(record, result);
  const winner = room.members[0].id;
  expect(ledger.rankings.get("simulation", "1v1", winner)).toMatchObject({
    rating: 1024,
    games: 1,
  });
  ledger.settle(record, result);
  expect(ledger.rankings.get("simulation", "1v1", winner).games).toBe(1);
  ledger.close();
});
