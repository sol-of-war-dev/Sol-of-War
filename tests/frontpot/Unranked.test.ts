import type { ReplayedWinner } from "@openfront/engine/WinnerReplay";
import type { PartialGameRecord } from "@openfront/shared/WireSchemas";
import { describe, it, expect } from "vitest";
import { GlobalQueue } from "../../src/frontpot/GlobalQueue";
import { advanceLobby } from "../../src/frontpot/LobbyLifecycle";
import { assertWagerAccess } from "../../src/frontpot/MatchAccess";
import { MatchLedger } from "../../src/frontpot/MatchLedger";
import { MatchReview } from "../../src/frontpot/MatchReview";
import { PlayerAuth } from "../../src/frontpot/PlayerAuth";
import { Profiles } from "../../src/frontpot/Profiles";
import { defaultQueueSettings } from "../../src/frontpot/QueueSettings";
import { LobbyStore, matchAmount } from "../../src/frontpot/Store";
import { buildWinResult } from "../../src/frontpot/WinResult";

describe("Ranked and Unranked", () => {
  it("keeps legacy requests wagered and rejects contradictory or coerced entry terms", () => {
    const store = new LobbyStore(Date.now, 1_000_000),
      player = store.identity("Player");
    for (const [ranked, stake] of [
      [false, "0.25"],
      [true, "0"],
      [undefined, "0"],
      ["false", "0"],
      [0, "0"],
    ])
      expect(() => matchAmount(ranked, stake, 1_000_000)).toThrow();
    const room = store.create(player, { mode: "1v1", stake: "0.001" });
    expect(room.ranked).toBe(true);
    store.leave(player, room.id);
    const free = store.create(player, {
      mode: "1v1",
      stake: "0",
      ranked: false,
    });
    expect(free).toMatchObject({
      ranked: false,
      practice: false,
      lamports: 0,
      stake: "0",
    });
  });
  it("allows authenticated players outside the wager allowlist to play Unranked only", () => {
    const allowed = new Set(["invited-wallet"]);
    expect(() =>
      assertWagerAccess("other-wallet", false, allowed),
    ).not.toThrow();
    expect(() => assertWagerAccess("other-wallet", true, allowed)).toThrow(
      "invite-only",
    );
    expect(() =>
      assertWagerAccess("invited-wallet", true, allowed),
    ).not.toThrow();
  });
  it("advances and replenishes each FIFO independently without resetting the other clock", () => {
    let now = 1000;
    const store = new LobbyStore(() => now),
      queue = new GlobalQueue(store);
    queue.replenish();
    expect(queue.pending(true, "ffa")).toHaveLength(3);
    expect(queue.pending(false, "ffa")).toHaveLength(3);
    const ranked = queue.pending(true, "ffa"),
      free = queue.pending(false, "ffa");
    expect(queue.pending().filter((r) => r.startsAt !== null)).toHaveLength(6);
    const rankedDeadline = ranked[0].startsAt;
    now = free[0].startsAt!;
    expect(
      advanceLobby(free[0], [], now, () => {
        throw new Error("Empty lobby must not lock");
      }),
    ).toBe("expired");
    store.rooms.delete(free[0].id);
    expect(queue.replenish()).toHaveLength(1);
    expect(queue.pending(false, "ffa")[0].id).toBe(free[1].id);
    expect(queue.pending(false, "ffa")[0].startsAt).toBe(now + 120000);
    expect(queue.pending(true, "ffa")[0].startsAt).toBe(rankedDeadline);
    expect(queue.pending(false, "ffa").map((r) => r.queuePosition)).toEqual([
      0, 1, 2,
    ]);
  });
  it("upgrades persisted wager templates once and retains admin changes on restart", () => {
    const ledger = new MatchLedger(":memory:");
    try {
      ledger.db.exec(
        "CREATE TABLE queue_settings(id INTEGER PRIMARY KEY,settings TEXT,template_cursor INTEGER,map_cursor INTEGER,revision INTEGER)",
      );
      const settings = defaultQueueSettings();
      const legacy = {
        ...settings,
        templates: settings.templates
          .filter((t) => t.ranked)
          .map(({ ranked, ...t }) => t),
      };
      ledger.db
        .prepare("INSERT INTO queue_settings VALUES(1,?,0,0,0)")
        .run(JSON.stringify(legacy));
      const queue = new GlobalQueue(new LobbyStore(), ledger.db);
      expect(
        queue.snapshot().settings.templates.filter((t) => !t.ranked),
      ).toHaveLength(3);
      queue.replenish();
      const restored = new GlobalQueue(new LobbyStore(), ledger.db);
      expect(restored.snapshot().settings.templates).toEqual(
        queue.snapshot().settings.templates,
      );
      const rankedOnly = restored.snapshot().settings;
      rankedOnly.templates = rankedOnly.templates.filter((t) => t.ranked);
      restored.saveSettings(rankedOnly, 0, "admin");
      expect(
        new GlobalQueue(new LobbyStore(), ledger.db)
          .snapshot()
          .settings.templates.every((t) => t.ranked),
      ).toBe(true);
    } finally {
      ledger.close();
    }
  });
  it.each(["1v1", "2v2"] as const)(
    "verifies an Unranked %s result and progression without any payout obligation",
    (mode) => {
      const ledger = new MatchLedger(":memory:", "mainnet"),
        store = new LobbyStore();
      try {
        const auth = new PlayerAuth(ledger.db);
        const players = ["Alice", "Bobby", "Carol", "David"]
          .slice(0, mode === "1v1" ? 2 : 4)
          .map((name, i) => {
            const session = auth.signIn({
              subject: `did:privy:free-${i}`,
              wallet: `wallet-${i}`,
              expires: Date.now() + 3600000,
            });
            return auth.claimUsername(session.token, name);
          });
        const room = store.create(players[0], {
          mode,
          stake: "0",
          ranked: false,
        });
        players.slice(1).forEach((p) => store.join(p, room.id));
        expect(
          advanceLobby(
            room,
            players.map((p) => p.id),
            room.startsAt!,
            (r, seats) => ledger.lock(r, seats),
          ),
        ).toBe("locked");
        ledger.verifying(room.id);
        const record = {
          info: {
            gameID: room.id,
            players: room.members.map((m, i) => ({
              clientID: `c${i}`,
              persistentID: m.id,
            })),
          },
          turns: [],
        } as unknown as PartialGameRecord;
        const result = {
          winner:
            mode === "1v1" ? ["player", "c0"] : ["team", "Red", "c0", "c2"],
          tick: 100,
          allPlayersStats: {},
        } as ReplayedWinner;
        const settled = ledger.settle(record, result)!;
        expect(settled).toMatchObject({
          ranked: false,
          practice: false,
          state: "settled",
          stakeLamports: 0,
          poolLamports: 0,
          feeLamports: 0,
          feeBps: 0,
          address: null,
        });
        expect(settled.payouts.every((p) => p.lamports === 0)).toBe(true);
        const profiles = new Profiles(ledger, auth, "mainnet");
        const winner = profiles.view(players[0].id, players[0].id);
        expect(winner.stats).toMatchObject({ games: 1, wins: 1 });
        expect(winner.progress?.lifetimeXp).toBe(250);
        expect(winner.games[0]).toMatchObject({ ranked: false, result: "Won" });
        expect(winner.finances).toMatchObject({
          wageredLamports: "0",
          paidLamports: "0",
          pendingLamports: "0",
        });
        expect(profiles.view(players[1].id, players[1].id).progress?.lifetimeXp).toBe(100);
        expect(ledger.settle(record, result)).toEqual(settled);
      } finally {
        ledger.close();
      }
    },
  );
  it("cancels free games on mainnet without queuing refunds", () => {
    const store = new LobbyStore(),
      ledger = new MatchLedger(":memory:", "mainnet");
    try {
      const room = store.create(store.identity("Player"), {
        mode: "ffa",
        ranked: false,
        stake: "0",
      });
      ledger.open(room);
      expect(ledger.refund(room.id, "Player left")).toMatchObject({
        state: "refunded",
        poolLamports: 0,
        feeLamports: 0,
      });
    } finally {
      ledger.close();
    }
  });
  it("builds free multiplayer victory cards but never treats a zero-entry Ranked result as a prize", () => {
    const terms = {
      gameID: "fixture",
      mode: "1v1" as const,
      practice: false,
      ranked: false,
      stakeLamports: 0,
      playerName: "Alice",
    };
    const roster = [
      { clientID: "one", human: true, team: null },
      { clientID: "two", human: true, team: null },
    ];
    expect(buildWinResult(terms, roster, "one")).toMatchObject({
      ranked: false,
      entrants: 2,
      prizeLamports: 0,
      feeLamports: 0,
    });
    expect(
      buildWinResult({ ...terms, ranked: true }, roster, "one"),
    ).toBeNull();
  });
});

it("can review or cancel an interrupted free mainnet game without a payment service", () => {
  const ledger = new MatchLedger(":memory:", "mainnet"),
    store = new LobbyStore();
  try {
    const room = store.create(store.identity("Alice"), {
      mode: "1v1",
      stake: "0",
      ranked: false,
    });
    store.join(store.identity("Bobby"), room.id);
    ledger.lock(room, room.members);
    ledger.review(room.id, "Interrupted result verification");
    const review = new MatchReview(ledger, null, () => {});
    expect(review.snapshot()[0]).toMatchObject({
      ranked: false,
      canRefund: true,
      blocked: null,
    });
    review.act(room.id, "refund");
    expect(ledger.get(room.id)).toMatchObject({
      state: "refunded",
      poolLamports: 0,
    });
  } finally {
    ledger.close();
  }
});
