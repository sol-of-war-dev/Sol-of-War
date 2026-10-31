import { describe, it, expect } from "vitest";
import { MatchLedger } from "../../src/frontpot/MatchLedger";
import { MatchReceipts } from "../../src/frontpot/MatchReceipts";
import { LobbyStore } from "../../src/frontpot/Store";
function fixture() {
  const ledger = new MatchLedger(":memory:");
  const store = new LobbyStore();
  const host = store.identity("Alice"),
    other = store.identity("Bobby");
  const room = store.create(host, { mode: "1v1", stake: "0.01" });
  store.join(other, room.id);
  ledger.open(room);
  ledger.lock(room, room.members);
  ledger.refund(room.id, "Test cancellation");
  return { ledger, service: new MatchReceipts(ledger), room, host, other };
}
const submission = {
  reason: "Payout issue",
  description: "Please check my refund transaction.",
  email: "player@example.com",
  evidence: "Replay at 03:10",
};
describe("Public receipts and participant disputes", () => {
  it("rejects nonparticipants and invalid input, saves a single durable reference", () => {
    const f = fixture();
    try {
      expect(() => f.service.submit(f.room.id, "stranger", submission)).toThrow(
        "participant",
      );
      expect(() =>
        f.service.submit(f.room.id, f.host.id, {
          ...submission,
          email: "invalid",
        }),
      ).toThrow("email");
      expect(() =>
        f.service.submit(f.room.id, f.host.id, {
          ...submission,
          description: "x".repeat(2001),
        }),
      ).toThrow();
      const first = f.service.submit(f.room.id, f.host.id, submission);
      expect(f.service.submit(f.room.id, f.host.id, submission).id).toBe(
        first.id,
      );
      expect(f.service.mine(f.room.id, f.other.id)).toBeNull();
      const mine = f.service.mine(f.room.id, f.host.id)!;
      expect(mine).not.toHaveProperty("email");
      expect(new MatchReceipts(f.ledger).list()).toHaveLength(1);
    } finally {
      f.ledger.close();
    }
  });
  it("denies private, practice and unfinished public receipts and replays", () => {
    const f = fixture();
    try {
      const pool = f.ledger.get(f.room.id)!;
      for (const patch of [
        { private: true },
        { practice: true },
        { state: "playing" },
        { state: "waiting" },
      ]) {
        f.ledger.db
          .prepare("UPDATE pools SET body=? WHERE id=?")
          .run(JSON.stringify({ ...pool, ...patch }), pool.matchID);
        expect(() => f.service.pool(pool.matchID)).toThrow("not available");
        expect(() => f.service.replay(pool.matchID)).toThrow("not available");
      }
    } finally {
      f.ledger.close();
    }
  });
  it("preserves dated review updates without changing the settlement", () => {
    const f = fixture();
    try {
      const before = f.ledger.get(f.room.id);
      const claim = f.service.submit(f.room.id, f.host.id, submission);
      expect(() =>
        f.service.resolve(claim.id, "admin", {
          status: "paid",
          resolution: "Not an allowed action",
        }),
      ).toThrow();
      f.service.resolve(claim.id, "admin", {
        status: "reviewing",
        resolution: "Reviewing the original transaction.",
      });
      f.service.resolve(claim.id, "admin", {
        status: "resolved",
        resolution: "Refund confirmed in the original receipt.",
      });
      expect(
        f.ledger.db.prepare("SELECT * FROM result_dispute_events").all(),
      ).toHaveLength(2);
      expect(f.service.mine(f.room.id, f.host.id)?.status).toBe("resolved");
      expect(f.ledger.get(f.room.id)).toEqual(before);
    } finally {
      f.ledger.close();
    }
  });
});

it("redacts replay identifiers, reports, unknown fields and private chat without altering gameplay turns", async () => {
  const { tutorialLobby } = await import("../../src/frontpot/TutorialGame");
  const { createHash } = await import("node:crypto");
  const { GameRecordSchema } = await import("@openfront/shared/WireSchemas");
  const f = fixture();
  try {
    const start = tutorialLobby().gameStartInfo!;
    const record = {
      version: "v0.0.2",
      secret: "SHOULD-NOT-LEAK",
      info: {
        ...start,
        gameID: f.room.id,
        start: 1000,
        end: 2000,
        duration: 1000,
        num_turns: 1,
        winner: ["player", start.players[0].clientID],
        lobbyFillTime: 0,
        reports: [],
        tribes: [{ name: "Public tribe", secret: "SHOULD-NOT-LEAK" }],
        players: start.players.map((p) => ({
          ...p,
          persistentID: "12345678-1234-4234-8234-123456789abc",
          stats: {},
        })),
      },
      turns: [
        {
          turnNumber: 0,
          intents: [
            {
              type: "quick_chat",
              clientID: start.players[0].clientID,
              recipient: start.players[0].clientID,
              quickChatKey: "help.troops",
            },
          ],
        },
      ],
    };
    f.ledger.saveRecord(record as never);
    const before = f.ledger.record(f.room.id);
    const replay = f.service.replay(f.room.id);
    const data = JSON.parse(replay.body);
    expect(data.info.players[0].persistentID).toBeNull();
    expect(data.info.reports).toBeUndefined();
    expect(replay.body).not.toContain("SHOULD-NOT-LEAK");
    expect(data.turns).toEqual([{ turnNumber: 0, intents: [] }]);
    expect(() => GameRecordSchema.parse(data)).not.toThrow();
    expect(replay.hash).toBe(
      createHash("sha256").update(replay.body).digest("hex"),
    );
    expect(f.ledger.record(f.room.id)).toEqual(before);
  } finally {
    f.ledger.close();
  }
});
