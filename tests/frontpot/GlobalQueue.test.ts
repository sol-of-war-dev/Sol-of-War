import { afterEach, describe, expect, it } from "vitest";
import { GlobalQueue } from "../../src/frontpot/GlobalQueue";
import { advanceLobby } from "../../src/frontpot/LobbyLifecycle";
import { MatchLedger } from "../../src/frontpot/MatchLedger";
import { mapPopulation } from "../../src/frontpot/Rules";
import { LobbyStore, LOBBY_COUNTDOWN_MS } from "../../src/frontpot/Store";

const ledgers: MatchLedger[] = [];
afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.db.close();
});
function fixture() {
  let now = 1_000;
  const store = new LobbyStore(() => now);
  const queue = new GlobalQueue(store);
  const ledger = new MatchLedger(":memory:");
  ledgers.push(ledger);
  queue.saveSettings(
    { ...queue.snapshot().settings, variety: false },
    0,
    "fixture",
  );
  const room = [...store.rooms.values()].find(
    (r) => r.queueKey === "ffa:0.25",
  )!;
  const ready: string[] = [];
  const players = Array.from({ length: 26 }, (_, i) =>
    store.identity(`Player${i}`),
  );
  function join(i: number) {
    store.join(players[i], room.id);
    ready.push(players[i].id);
  }
  function tick(at = now, ids = ready) {
    now = at;
    return advanceLobby(room, ids, now, (r, seats) => ledger.lock(r, seats));
  }
  return {
    store,
    queue,
    room,
    ledger,
    players,
    ready,
    join,
    tick,
    time: (t: number) => {
      now = t;
    },
  };
}
describe("global queue lifecycle", () => {
  it("expires a funded disconnected seat at the single deadline without locking it", () => {
    const f = fixture();
    f.join(0);
    const id = f.players[0].id;
    const deadline = f.room.startsAt!;
    expect(
      advanceLobby(
        f.room,
        [],
        deadline,
        (r, seats) => f.ledger.lock(r, seats),
        [id],
      ),
    ).toBe("expired");
    expect(f.room.members.map((m) => m.id)).toEqual([id]);
    expect(f.room.startsAt).toBe(deadline);
    expect(f.room.locked).toBeUndefined();
    expect(f.store.activeRoom(f.players[0])).toBeUndefined();
    expect(f.tick(deadline + 120000)).toBe("unchanged");
  });
  it("reserves an entry still confirming but never counts it as funded or starts with it", () => {
    const f = fixture();
    f.join(0);
    const id = f.players[0].id;
    const result = advanceLobby(
      f.room,
      [id],
      f.room.startsAt!,
      (r, seats) => f.ledger.lock(r, seats),
      [],
      [id],
    );
    expect(result).toBe("expired");
    expect(f.room.members).toHaveLength(1);
    expect(f.room.readyIDs).toEqual([]);
    expect(f.room.locked).toBeUndefined();
  });
  it("locks only connected funded players and excludes a disconnected reservation", () => {
    const f = fixture();
    [0, 1, 2].forEach(f.join);
    const ids = f.players.slice(0, 3).map((p) => p.id);
    expect(
      advanceLobby(
        f.room,
        ids.slice(0, 2),
        f.room.startsAt!,
        (r, seats) => f.ledger.lock(r, seats),
        ids,
      ),
    ).toBe("locked");
    expect(f.room.members.map((m) => m.id)).toEqual(ids.slice(0, 2));
    expect(f.room.locked?.entrants).toBe(2);
    expect(f.store.activeRoom(f.players[2])).toBeUndefined();
  });

  it("keeps six slots per match type and only replenishes the slot that started", () => {
    const f = fixture();
    expect(f.store.rooms.size).toBe(18);
    expect(f.queue.replenish()).toEqual([]);
    for (const mode of ["ffa", "1v1", "2v2"] as const) {
      expect(f.queue.pending(undefined, mode)).toHaveLength(6);
      for (const ranked of [false, true]) {
        const lane = f.queue.pending(ranked, mode);
        expect(lane).toHaveLength(3);
        expect(lane.map((r) => r.queuePosition)).toEqual([0, 1, 2]);
        expect(lane.filter((r) => r.startsAt !== null)).toHaveLength(1);
      }
    }
    expect(
      [...f.store.rooms.values()].every(
        (r) => !r.private && !r.practice && r.members.length === 0,
      ),
    ).toBe(true);
    f.join(0);
    f.join(1);
    const map = f.room.rules.gameMap;
    expect(f.tick(f.room.startsAt!)).toBe("locked");
    const next = f.queue.replenish();
    expect(next).toHaveLength(1);
    expect(next[0].mode).toBe(f.room.mode);
    expect(next[0].lamports).toBeGreaterThan(0);
    expect(next[0].ranked).toBe(next[0].mode !== "ffa");
    expect(next[0].id).not.toBe(f.room.id);
    expect(next[0].rules.gameMap).not.toBe(map);
    expect(next[0].startsAt).toBeNull();
    expect(next[0].queuePosition).toBe(2);
    expect(f.queue.pending(true, "ffa")[0].mode).toBe("ffa");
    expect(f.queue.pending(true, "ffa")[0].startsAt).toBe(
      f.room.locked!.at + LOBBY_COUNTDOWN_MS,
    );
    expect(
      f.queue.pending(true, "ffa").filter((r) => r.startsAt !== null),
    ).toHaveLength(1);
  });
  it("starts a full later lobby immediately without resetting the head countdown", () => {
    const f = fixture();
    const original = f.queue.pending(true, "1v1");
    const head = original[0];
    const deadline = head.startsAt;
    const second = original[1];
    f.store.join(f.players[2], second.id);
    f.store.join(f.players[3], second.id);
    const ids = f.players.slice(2, 4).map((p) => p.id);
    expect(
      advanceLobby(second, ids, 2_000, (r, seats) => f.ledger.lock(r, seats)),
    ).toBe("locked");
    expect(second.startsAt).toBe(2_000);
    expect(second.locked?.entrants).toBe(2);
    f.queue.replenish();
    expect(f.queue.pending(true, "ffa")).toHaveLength(3);
    expect(f.queue.pending(true, "1v1")[0].id).toBe(head.id);
    expect(head.startsAt).toBe(deadline);
    expect(
      f.queue.pending(true, "ffa").filter((r) => r.startsAt !== null),
    ).toHaveLength(1);
    expect(f.store.publicRoom(second).prizeLamports).toBe(495_000_000);
    expect(
      advanceLobby(second, ids, 2_001, () => {
        throw new Error("double lock");
      }),
    ).toBe("unchanged");
  });
  it("waits for every queued seat to be connected and funded before early start", () => {
    const f = fixture();
    const room = f.queue.pending(true, "1v1")[1];
    f.store.join(f.players[0], room.id);
    f.store.join(f.players[1], room.id);
    const ids = f.players.slice(0, 2).map((p) => p.id);
    const lock = (r: typeof room, seats: typeof room.members) =>
      f.ledger.lock(r, seats);
    expect(advanceLobby(room, ids, 2_000, lock, [ids[0]], ids)).toBe("queued");
    expect(advanceLobby(room, [ids[0]], 2_001, lock, ids, ids)).toBe("queued");
    expect(room.startsAt).toBeNull();
    expect(advanceLobby(room, ids, 2_002, lock, ids, ids)).toBe("locked");
  });
  it("starts a full unranked lobby before its countdown ends", () => {
    const f = fixture();
    const room = f.queue.pending(false).find((r) => r.mode === "1v1")!;
    f.store.join(f.players[0], room.id);
    f.store.join(f.players[1], room.id);
    room.startsAt = 121_000;
    expect(
      advanceLobby(
        room,
        f.players.slice(0, 2).map((p) => p.id),
        2_000,
        (r, seats) => f.ledger.lock(r, seats),
      ),
    ).toBe("locked");
    expect(room.startsAt).toBe(2_000);
  });
  it("requires balanced teams before starting a full queued 2v2", () => {
    const f = fixture();
    const room = f.queue.pending(false, "2v2")[1];
    for (let i = 0; i < 4; i++) f.store.join(f.players[i], room.id);
    room.members.forEach((m, i) => {
      m.team = i === 3 ? 1 : 0;
    });
    const ids = room.members.map((m) => m.id);
    const lock = (r: typeof room, seats: typeof room.members) =>
      f.ledger.lock(r, seats);
    expect(advanceLobby(room, ids, 2_000, lock)).toBe("queued");
    expect(room.locked).toBeUndefined();
    room.members[2].team = 1;
    expect(advanceLobby(room, ids, 2_001, lock)).toBe("locked");
    expect(room.locked?.entrants).toBe(4);
  });
  it("shows the exact net prize and freezes it at zero, including after a leave", () => {
    const f = fixture();
    for (let i = 0; i < 25; i++) f.join(i);
    f.tick();
    expect(f.store.publicRoom(f.room).prizeLamports).toBe(6_187_500_000);
    expect(f.store.publicRoom(f.room).readyCount).toBe(25);
    expect(f.tick(f.room.startsAt!)).toBe("locked");
    const locked = f.ledger.get(f.room.id)!;
    expect(locked.feeLamports).toBe(62_500_000);
    expect(locked.poolLamports).toBe(6_250_000_000);
    f.store.leave(f.players[0], f.room.id);
    f.tick(f.room.startsAt! + 500, []);
    expect(f.room.members).toHaveLength(25);
    expect(f.store.publicRoom(f.room).prizeLamports).toBe(6_187_500_000);
    expect(f.ledger.get(f.room.id)).toEqual(locked);
    const next = f.store.create(f.players[0], { mode: "1v1", stake: "0.5" });
    expect(next.id).not.toBe(f.room.id);
    expect(() => f.store.join(f.players[0], f.room.id)).toThrow("Leave");
    expect(() => f.store.join(f.players[25], f.room.id)).toThrow("started");
  });
  it("accepts entries during the countdown but rejects the exact deadline before the next tick", () => {
    const f = fixture();
    f.time(f.room.startsAt! - 1);
    f.join(0);
    f.join(1);
    expect(f.room.members).toHaveLength(2);
    f.time(f.room.startsAt!);
    expect(() => f.store.join(f.players[2], f.room.id)).toThrow("closing");
    f.store.leave(f.players[0], f.room.id);
    expect(f.room.members).toHaveLength(2);
    expect(f.tick(f.room.startsAt!)).toBe("locked");
  });
  it("expires an underfilled head once and promotes the next game with a fresh clock", () => {
    const f = fixture();
    f.join(0);
    const deadline = f.room.startsAt!;
    const next = f.queue.pending(true, "ffa")[1];
    expect(f.tick(deadline)).toBe("expired");
    expect(f.room.startsAt).toBe(deadline);
    expect(f.room.locked).toBeUndefined();
    expect(f.ledger.get(f.room.id)).toBeNull();
    f.store.rooms.delete(f.room.id);
    expect(f.queue.replenish()).toHaveLength(1);
    expect(f.queue.pending(true, "ffa")[0].id).toBe(next.id);
    expect(next.startsAt).toBe(deadline + LOBBY_COUNTDOWN_MS);
    expect(
      f.queue.pending(true, "ffa").filter((r) => r.startsAt !== null),
    ).toHaveLength(1);
    expect(f.tick(deadline + LOBBY_COUNTDOWN_MS)).toBe("unchanged");
  });
  it("excludes unfinished/disconnected connections from the pool and the locked roster", () => {
    const f = fixture();
    f.join(0);
    f.join(1);
    f.store.join(f.players[2], f.room.id);
    f.tick();
    expect(f.store.publicRoom(f.room).prizeLamports).toBe(495_000_000);
    f.tick(f.room.startsAt!);
    expect(f.room.members.map((p) => p.id)).toEqual(f.ready);
    expect(f.ledger.get(f.room.id)!.participants).toHaveLength(2);
  });
  it("reduces the live pool on disconnect, restores it on reconnect, and never extends the countdown", () => {
    const f = fixture();
    f.join(0);
    f.join(1);
    const deadline = f.room.startsAt;
    f.tick();
    f.tick(2_000, [f.ready[0]]);
    expect(f.store.publicRoom(f.room).prizeLamports).toBe(247_500_000);
    f.tick(3_000);
    expect(f.store.publicRoom(f.room).prizeLamports).toBe(495_000_000);
    expect(f.room.startsAt).toBe(deadline);
  });
  it.each(["ffa", "1v1", "2v2"])(
    "expires an empty %s head at its deadline and promotes the next match",
    (mode) => {
      const f = fixture();
      const before = f.queue.pending(true, mode as "ffa" | "1v1" | "2v2");
      const head = before[0];
      const deadline = head.startsAt!;
      const tick = (at: number) =>
        advanceLobby(head, [], at, (r, seats) => f.ledger.lock(r, seats));
      expect(tick(deadline - 1)).toBe("countdown");
      expect(tick(deadline)).toBe("expired");
      expect(head.status).toBe("finished");
      expect(head.locked).toBeUndefined();
      expect(f.ledger.get(head.id)).toBeNull();
      expect(tick(deadline + 1)).toBe("unchanged");
      // The server removes expired rooms before replenishing, so idle queues
      // cannot accumulate finished rooms against the 40-room capacity limit.
      f.store.rooms.delete(head.id);
      f.time(deadline);
      const replacement = f.queue.replenish();
      const after = f.queue.pending(true, head.mode);
      expect(replacement).toHaveLength(1);
      expect(f.store.rooms.size).toBe(18);
      expect(after.slice(0, 2).map((r) => r.id)).toEqual(
        before.slice(1).map((r) => r.id),
      );
      expect(after[0].startsAt).toBe(deadline + LOBBY_COUNTDOWN_MS);
      expect(after.slice(1).every((r) => r.startsAt === null)).toBe(true);
      expect(after.map((r) => r.queuePosition)).toEqual([0, 1, 2]);
      expect(after[2].id).toBe(replacement[0].id);
    },
  );
  it("expires disconnected reservations without locking them or counting them as players", () => {
    const f = fixture();
    const deadline = f.room.startsAt!;
    f.time(deadline - 1);
    f.store.join(f.players[0], f.room.id);
    expect(f.tick(deadline, [])).toBe("expired");
    expect(f.room.members).toEqual([]);
    expect(f.room.readyIDs).toEqual([]);
    expect(f.room.locked).toBeUndefined();
    expect(f.ledger.get(f.room.id)).toBeNull();
  });
  it("keeps private and practice lobbies waiting without an automatic timer", () => {
    const f = fixture();
    for (const practice of [false, true]) {
      const room = f.store.create(f.players[Number(practice)], {
        mode: "ffa",
        stake: practice ? "0" : "0.25",
        practice,
        private: true,
      });
      expect(
        advanceLobby(room, [], room.startsAt ?? 121_000, (r, seats) =>
          f.ledger.lock(r, seats),
        ),
      ).toBe("waiting");
      expect(room.status).toBe("waiting");
      expect(room.startsAt).toBeNull();
    }
  });
  it("requires the private lobby host and confirmed connected players to start", () => {
    const f = fixture();
    const host = f.players[0],
      guest = f.players[1];
    const r = f.store.create(host, {
      private: true,
      mode: "1v1",
      stake: "0.01",
    });
    f.store.join(guest, r.id);
    const ids = [host.id, guest.id];
    const lock = (r: typeof f.room, seats: typeof r.members) =>
      f.ledger.lock(r, seats);
    f.time(500_000);
    expect(advanceLobby(r, ids, 500_000, lock, [host.id])).toBe("waiting");
    expect(() => f.store.requestStart(guest, r.id)).toThrow("Only the host");
    expect(() => f.store.requestStart(host, r.id)).toThrow("confirmed");
    expect(r.startsAt).toBeNull();
    advanceLobby(r, ids, 500_000, lock, ids);
    f.store.requestStart(host, r.id);
    expect(advanceLobby(r, ids, 500_000, lock, ids)).toBe("locked");
    expect(r.locked?.entrants).toBe(2);
  });
  it("keeps empty system lobbies until their deadline but removes abandoned custom lobbies", () => {
    const f = fixture();
    f.join(0);
    const deadline = f.room.startsAt;
    f.store.leave(f.players[0], f.room.id);
    expect(f.store.rooms.has(f.room.id)).toBe(true);
    expect(f.room.startsAt).toBe(deadline);
    expect(f.tick(deadline!)).toBe("expired");
    const custom = f.store.create(f.players[1], {
      mode: "1v1",
      stake: "0.5",
      private: true,
    });
    f.store.leave(f.players[1], custom.id);
    expect(f.store.rooms.has(custom.id)).toBe(false);
  });
  it("closes an incomplete 2v2 without starting another countdown", () => {
    const f = fixture();
    const room = [...f.store.rooms.values()].find((r) => r.mode === "2v2")!;
    for (let i = 0; i < 4; i++) f.store.join(f.players[i], room.id);
    const tick = (ids: string[]) =>
      advanceLobby(room, ids, room.startsAt!, (r, seats) =>
        f.ledger.lock(r, seats),
      );
    const deadline = room.startsAt;
    expect(tick(f.players.slice(0, 3).map((p) => p.id))).toBe("expired");
    expect(room.startsAt).toBe(deadline);
    expect(room.locked).toBeUndefined();
    expect(tick(f.players.slice(0, 4).map((p) => p.id))).toBe("unchanged");
  });
  it("does not count stale reservations or permit a full lobby to overfill", () => {
    const f = fixture();
    const room = [...f.store.rooms.values()].find((r) => r.mode === "1v1")!;
    f.store.join(f.players[0], room.id);
    f.store.join(f.players[1], room.id);
    expect(() => f.store.join(f.players[2], room.id)).toThrow("full");
    advanceLobby(room, [], 121_000, (r, seats) => f.ledger.lock(r, seats));
    expect(room.members).toHaveLength(0);
    expect(room.locked).toBeUndefined();
    expect(f.store.publicRoom(room).prizeLamports).toBe(0);
  });
  it("keeps practice free with its short ready countdown", () => {
    const f = fixture();
    const room = f.store.create(f.players[0], {
      mode: "ffa",
      stake: "0",
      practice: true,
    });
    advanceLobby(room, [f.players[0].id], 1_000, (r, seats) =>
      f.ledger.lock(r, seats),
    );
    expect(room.startsAt).toBe(5_000);
    advanceLobby(room, [f.players[0].id], 5_000, (r, seats) =>
      f.ledger.lock(r, seats),
    );
    expect(room.locked!.prizeLamports).toBe(0);
  });
});

it("generates FFA matches with map populations while keeping fixed human teams", () => {
  const store = new LobbyStore();
  new GlobalQueue(store).replenish();
  for (const room of store.rooms.values()) {
    expect(room.rules).toMatchObject({
      ...mapPopulation(room.rules.gameMap, room.rules.gameMapSize, room.mode),
      ...(room.lamports > 0 ? { nations: "disabled" } : {}),
    });
  }
  expect(
    [...store.rooms.values()].some((r) => r.mode === "ffa" && r.rules.bots > 0),
  ).toBe(true);
});

it("keeps player-created public lobbies outside the eighteen generated slots", () => {
  const f = fixture();
  const custom = f.store.create(f.players[0], {
    mode: "1v1",
    stake: "0",
    ranked: false,
    private: false,
  });
  expect(f.queue.replenish()).toEqual([]);
  expect(f.queue.pending()).toHaveLength(18);
  expect(f.store.rooms.size).toBe(19);
  expect(custom.queueKey).toBeUndefined();
});

it("splits odd mode targets in favor of Free and gives a sole enabled lane all slots", () => {
  const store = new LobbyStore();
  const queue = new GlobalQueue(store);
  const settings = queue.snapshot().settings;
  settings.targetSize = 5;
  queue.saveSettings(settings, 0, "test");
  for (const mode of ["ffa", "1v1", "2v2"] as const) {
    expect(queue.pending(false, mode)).toHaveLength(3);
    expect(queue.pending(true, mode)).toHaveLength(2);
  }
  const single = new GlobalQueue(new LobbyStore());
  settings.templates = settings.templates.filter((t) => !t.ranked);
  single.saveSettings(settings, 0, "test");
  expect(single.pending(true)).toHaveLength(0);
  for (const mode of ["ffa", "1v1", "2v2"] as const)
    expect(single.pending(false, mode)).toHaveLength(5);
});
