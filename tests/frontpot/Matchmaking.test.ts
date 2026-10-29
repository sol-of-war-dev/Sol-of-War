import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { Matchmaking } from "../../src/frontpot/Matchmaking";
import { Rankings } from "../../src/frontpot/Rankings";
import { LobbyStore } from "../../src/frontpot/Store";
const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});
function fixture() {
  let now = 100000;
  const store = new LobbyStore(() => now, 10000000);
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  const ranks = new Rankings(db);
  const finder = new Matchmaking(store, ranks, "simulation", () => now);
  const me = store.identity("Me"),
    other = store.identity("Other");
  return {
    store,
    db,
    ranks,
    finder,
    me,
    other,
    advance: (ms: number) => (now += ms),
  };
}
it("finds a compatible occupied lobby and joins only after exact-offer acceptance", () => {
  const f = fixture();
  const room = f.store.create(f.other, { mode: "1v1", stake: "0.01" });
  const status = f.finder.start(f.me, {
    mode: "1v1",
    ranked: true,
    budget: "0.1",
  })!;
  expect(status.offer?.room?.id).toBe(room.id);
  expect(room.members).toHaveLength(1);
  const joined = f.finder.accept(
    f.me,
    status.id,
    status.offer!.id,
    (id) => f.store.join(f.me, id),
    () => {
      throw Error("should not create");
    },
  );
  expect(joined.members).toHaveLength(2);
  expect(f.finder.status(f.me)).toBeNull();
});
it("never exceeds budget or mixes free, private and ranked modes", () => {
  const f = fixture();
  f.store.create(f.other, { mode: "1v1", stake: "0.25" });
  expect(
    f.finder.start(f.me, { mode: "1v1", ranked: true, budget: "0.1" })?.offer,
  ).toBeNull();
  f.finder.cancel(f.me);
  expect(
    f.finder.start(f.me, { mode: "1v1", ranked: false })?.offer,
  ).toBeNull();
  expect(() =>
    f.finder.start(f.me, { mode: "1v1", ranked: true, budget: "1.01" }),
  ).toThrow("0.01 to 1");
  expect(() =>
    f.finder.start(f.me, { mode: "1v1", ranked: true, budget: "0.001" }),
  ).toThrow();
});
it("widens skill range with server time and does not reset it on duplicate starts", () => {
  const f = fixture();
  const room = f.store.create(f.other, { mode: "1v1", stake: "0.01" });
  f.db
    .prepare("INSERT INTO ranked_ratings VALUES(?,?,?,?,?)")
    .run("simulation", "1v1", f.other.id, 1300, 20);
  const first = f.finder.start(f.me, {
    mode: "1v1",
    ranked: true,
    budget: "0.01",
  })!;
  expect(first.offer).toBeNull();
  f.advance(45000);
  f.finder.status(f.me);
  f.advance(15000);
  const next = f.finder.start(f.me, {
    mode: "1v1",
    ranked: true,
    budget: "0.01",
  })!;
  expect(next.id).toBe(first.id);
  expect(next.offer?.room?.id).toBe(room.id);
});
it("rejects stale quotes, changed prices, filled rooms and cross-account tickets", () => {
  const f = fixture();
  const room = f.store.create(f.other, { mode: "1v1", stake: "0.01" });
  const status = f.finder.start(f.me, {
    mode: "1v1",
    ranked: true,
    budget: "0.1",
  })!;
  const join = (id: string) => f.store.join(f.me, id),
    create = () => {
      throw Error("unexpected");
    };
  expect(() => f.finder.accept(f.me, status.id, "stale", join, create)).toThrow(
    "changed",
  );
  expect(() =>
    f.finder.accept(f.other, status.id, status.offer!.id, join, create),
  ).toThrow("expired");
  room.lamports = 50000000;
  expect(() =>
    f.finder.accept(f.me, status.id, status.offer!.id, join, create),
  ).toThrow("changed or filled");
  expect(room.members).toHaveLength(1);
});
it("offers empty lobbies after ten seconds and creates only after confirmation", () => {
  const f = fixture();
  const room = f.store.create(f.other, { mode: "1v1", stake: "0.01" });
  room.members = [];
  expect(
    f.finder.start(f.me, { mode: "1v1", ranked: true, budget: "0.01" })?.offer,
  ).toBeNull();
  f.advance(10000);
  expect(f.finder.status(f.me)?.offer?.room?.id).toBe(room.id);
  f.store.rooms.clear();
  f.advance(20000);
  const status = f.finder.status(f.me)!;
  expect(status.offer?.create).toBe(true);
  expect(f.store.rooms.size).toBe(0);
  const joined = f.finder.accept(
    f.me,
    status.id,
    status.offer!.id,
    (id) => f.store.join(f.me, id),
    (input) => f.store.create(f.me, input),
  );
  expect(joined.lamports).toBe(10000000);
  expect(joined.ranked).toBe(true);
});
it("cancels searches and expires abandoned tickets", () => {
  const f = fixture();
  f.finder.start(f.me, { mode: "ffa", ranked: false });
  f.finder.cancel(f.me);
  expect(f.finder.status(f.me)).toBeNull();
  f.finder.start(f.me, { mode: "ffa", ranked: false });
  f.advance(181000);
  expect(f.finder.status(f.me)).toBeNull();
});
it("holds one offer per remaining seat and releases it on cancellation", () => {
  const f = fixture();
  const room = f.store.create(f.other, { mode: "1v1", stake: "0.01" });
  const second = f.store.identity("Second");
  expect(
    f.finder.start(f.me, { mode: "1v1", ranked: true, budget: "0.01" })?.offer
      ?.room?.id,
  ).toBe(room.id);
  expect(
    f.finder.start(second, { mode: "1v1", ranked: true, budget: "0.01" })
      ?.offer,
  ).toBeNull();
  f.finder.cancel(f.me);
  expect(f.finder.status(second)?.offer?.room?.id).toBe(room.id);
});
it("rechecks skill and map conditions before accepting an offer", () => {
  const f = fixture();
  const room = f.store.create(f.other, { mode: "1v1", stake: "0.01" });
  const status = f.finder.start(f.me, {
    mode: "1v1",
    ranked: true,
    budget: "0.01",
  })!;
  f.db
    .prepare("INSERT INTO ranked_ratings VALUES(?,?,?,?,?)")
    .run("simulation", "1v1", f.other.id, 2000, 20);
  expect(() =>
    f.finder.accept(
      f.me,
      status.id,
      status.offer!.id,
      (id) => f.store.join(f.me, id),
      () => {
        throw Error("unexpected");
      },
    ),
  ).toThrow("players");
  expect(room.members).toHaveLength(1);
});
it("puts simultaneous new-lobby acceptances into one compatible game", () => {
  const f = fixture();
  f.finder.start(f.me, { mode: "2v2", ranked: true, budget: "0.01" });
  f.finder.start(f.other, { mode: "2v2", ranked: true, budget: "0.01" });
  f.advance(30000);
  const a = f.finder.status(f.me)!,
    b = f.finder.status(f.other)!;
  expect(a.offer?.rules.gameMap).toBeDefined();
  const first = f.finder.accept(
    f.me,
    a.id,
    a.offer!.id,
    (id) => f.store.join(f.me, id),
    (input) => f.store.create(f.me, input),
  );
  const second = f.finder.accept(
    f.other,
    b.id,
    b.offer!.id,
    (id) => f.store.join(f.other, id),
    (input) => f.store.create(f.other, input),
  );
  expect(first.id).toBe(second.id);
  expect(second.members.map((p) => p.team)).toEqual([0, 1]);
  expect(f.store.rooms.size).toBe(1);
});
it("does not accept expired offers or offers for a room filled outside matchmaking", () => {
  const f = fixture();
  const room = f.store.create(f.other, { mode: "1v1", stake: "0.01" });
  const status = f.finder.start(f.me, {
    mode: "1v1",
    ranked: true,
    budget: "0.01",
  })!;
  f.store.join(f.store.identity("Browser player"), room.id);
  expect(() =>
    f.finder.accept(
      f.me,
      status.id,
      status.offer!.id,
      (id) => f.store.join(f.me, id),
      () => {
        throw Error("unexpected");
      },
    ),
  ).toThrow("changed or filled");
  expect(room.members).toHaveLength(2);
  const g = fixture();
  g.store.create(g.other, { mode: "1v1", stake: "0.01" });
  const expired = g.finder.start(g.me, {
    mode: "1v1",
    ranked: true,
    budget: "0.01",
  })!;
  g.advance(30001);
  expect(() =>
    g.finder.accept(
      g.me,
      expired.id,
      expired.offer!.id,
      (id) => g.store.join(g.me, id),
      () => {
        throw Error("unexpected");
      },
    ),
  ).toThrow("expired");
});
it("quotes the actual normalized rules when creating from a queue template", () => {
  const f = fixture();
  const template = f.store.create(f.other, { mode: "ffa", stake: "1" });
  template.rules.maxPlayers = 45;
  template.rules.maxTimerValue = 30;
  f.finder.start(f.me, { mode: "ffa", ranked: true, budget: "0.01" });
  f.advance(30000);
  const status = f.finder.status(f.me)!;
  const room = f.finder.accept(
    f.me,
    status.id,
    status.offer!.id,
    (id) => f.store.join(f.me, id),
    (input) => f.store.create(f.me, input),
  );
  expect(room.rules).toEqual(status.offer!.rules);
  expect(room.rules.maxPlayers).toBe(status.offer!.maxPlayers);
});
it("keeps 2v2 matchmaking out of host-controlled custom teams", () => {
  const f = fixture();
  f.store.create(f.other, { mode: "2v2", stake: "0.01" });
  const status = f.finder.start(f.me, {
    mode: "2v2",
    ranked: true,
    budget: "0.01",
  });
  expect(status?.offer).toBeNull();
});

it.each(["1v1", "2v2", "ffa"] as const)(
  "never matches Bronze I with Diamond II in %s, even after a long wait",
  (mode) => {
    const f = fixture();
    const room = f.store.create(f.other, { mode, stake: "0.01" });
    room.automaticTeams = true;
    const set = f.db.prepare("INSERT INTO ranked_ratings VALUES(?,?,?,?,?)");
    set.run("simulation", mode, f.me.id, 650, 20);
    set.run("simulation", mode, f.other.id, 1950, 20);
    f.finder.start(f.me, { mode, ranked: true, budget: "0.01" });
    for (let i = 0; i < 10; i++) {
      f.advance(30000);
      const status = f.finder.status(f.me)!;
      expect(status.offer?.room?.id).not.toBe(room.id);
      expect(status.skillRange).toBeLessThanOrEqual(300);
    }
  },
);

it("includes pending offers when selecting an empty lobby", () => {
  const f = fixture();
  const room = f.store.create(f.other, { mode: "1v1", stake: "0.01" });
  room.members = [];
  f.db
    .prepare("INSERT INTO ranked_ratings VALUES(?,?,?,?,?)")
    .run("simulation", "1v1", f.other.id, 1950, 20);
  f.finder.start(f.me, { mode: "1v1", ranked: true, budget: "0.01" });
  f.finder.start(f.other, { mode: "1v1", ranked: true, budget: "0.01" });
  f.advance(10000);
  expect(f.finder.status(f.me)?.offer?.room?.id).toBe(room.id);
  expect(f.finder.status(f.other)?.offer).toBeNull();
});

it("rejects a lobby whose overall spread exceeds the cap even when its average matches", () => {
  const f = fixture();
  const room = f.store.create(f.other, { mode: "ffa", stake: "0.01" });
  const high = f.store.identity("High");
  f.store.join(high, room.id);
  const set = f.db.prepare("INSERT INTO ranked_ratings VALUES(?,?,?,?,?)");
  set.run("simulation", "ffa", f.other.id, 750, 20);
  set.run("simulation", "ffa", high.id, 1250, 20);
  expect(
    f.finder.start(f.me, { mode: "ffa", ranked: true, budget: "0.01" })?.offer,
  ).toBeNull();
});

it("protects accepted matchmaking lobbies from out-of-range direct joins", () => {
  const f = fixture();
  const room = f.store.create(f.other, { mode: "2v2", stake: "0.01" });
  room.automaticTeams = true;
  const status = f.finder.start(f.me, {
    mode: "2v2",
    ranked: true,
    budget: "0.01",
  })!;
  f.finder.accept(
    f.me,
    status.id,
    status.offer!.id,
    (id) => f.store.join(f.me, id),
    () => {
      throw Error("unexpected");
    },
  );
  expect(room.matchmakingSkillProtected).toBe(true);
  const high = f.store.identity("Diamond");
  f.db
    .prepare("INSERT INTO ranked_ratings VALUES(?,?,?,?,?)")
    .run("simulation", "2v2", high.id, 1950, 20);
  expect(() => f.store.join(high, room.id)).toThrow("outside your skill range");
  expect(room.members).toHaveLength(2);
  expect(f.store.join(f.me, room.id).id).toBe(room.id);
  f.store.join(f.store.identity("Similar"), room.id);
  expect(room.members).toHaveLength(3);
});
it("filters occupied ranked lobbies by mode-specific skill and protects direct joins", () => {
  const f = fixture();
  const room = f.store.create(f.other, { mode: "1v1", stake: "0.01" });
  f.db
    .prepare("INSERT INTO ranked_ratings VALUES(?,?,?,?,?)")
    .run("simulation", "1v1", f.other.id, 1750, 20);
  expect(f.finder.visibleTo(room, f.me)).toBe(false);
  expect(() => f.store.join(f.me, room.id)).toThrow("skill range");
  f.db
    .prepare("INSERT INTO ranked_ratings VALUES(?,?,?,?,?)")
    .run("simulation", "1v1", f.me.id, 1700, 20);
  expect(f.finder.visibleTo(room, f.me)).toBe(true);
  room.ranked = false;
  expect(f.finder.visibleTo(room, null)).toBe(true);
});
it("keeps a wide-gap full party together, matches its strongest Elo, and requires both acceptances", () => {
  const f = fixture();
  const friend = f.store.identity("Friend");
  const insert = f.db.prepare("INSERT INTO ranked_ratings VALUES(?,?,?,?,?)");
  insert.run("simulation", "2v2", f.me.id, 1900, 20);
  insert.run("simulation", "2v2", friend.id, 650, 20);
  insert.run("simulation", "2v2", f.other.id, 1900, 20);
  const room = f.store.create(f.other, { mode: "2v2", stake: "0.01" });
  room.automaticTeams = true;
  const low = f.store.identity("Low");
  insert.run("simulation", "2v2", low.id, 650, 20);
  const easy = f.store.create(low, { mode: "2v2", stake: "0.01" });
  easy.automaticTeams = true;
  const status = f.finder.start(
    f.me,
    { mode: "2v2", ranked: true, budget: "0.01" },
    [f.me, friend],
  )!;
  expect(status.offer?.room?.id).toBe(room.id);
  expect(f.finder.status(friend)?.id).toBe(status.id);
  expect(() => f.store.join(friend, room.id)).toThrow("party");
  const join = (id: string) =>
    f.finder.joinGroup(f.store.rooms.get(id)!, [f.me, friend]);
  expect(() =>
    f.finder.accept(f.me, status.id, status.offer!.id, join, () => {
      throw Error("unexpected");
    }),
  ).toThrow("Both");
  expect(f.finder.confirm(f.me, status.id, status.offer!.id)).toBe(false);
  expect(f.finder.confirm(friend, status.id, status.offer!.id)).toBe(true);
  const joined = f.finder.accept(
    friend,
    status.id,
    status.offer!.id,
    join,
    () => {
      throw Error("unexpected");
    },
  );
  expect(
    joined.members
      .filter((m) => [f.me.id, friend.id].includes(m.id))
      .map((m) => m.team),
  ).toEqual([1, 1]);
  expect(joined.parties).toEqual([[f.me.id, friend.id]]);
  const opponent = f.store.identity("Opponent");
  insert.run("simulation", "2v2", opponent.id, 1900, 20);
  expect(f.finder.visibleTo(joined, opponent)).toBe(true);
  f.store.join(opponent, joined.id);
  expect(joined.members.find((m) => m.id === opponent.id)?.team).toBe(0);
});
it("reserves two seats for a party and cancels its shared ticket when either member cancels", () => {
  const f = fixture(),
    friend = f.store.identity("Friend"),
    solo = f.store.identity("Solo");
  const room = f.store.create(f.other, { mode: "2v2", stake: "0.01" });
  room.automaticTeams = true;
  f.finder.start(f.me, { mode: "2v2", ranked: true, budget: "0.01" }, [
    f.me,
    friend,
  ]);
  expect(
    f.finder.start(solo, { mode: "2v2", ranked: true, budget: "0.01" })?.offer
      ?.room?.id,
  ).toBe(room.id);
  expect(
    f.finder.start(f.store.identity("Extra"), {
      mode: "2v2",
      ranked: true,
      budget: "0.01",
    })?.offer,
  ).toBeNull();
  f.finder.cancel(friend);
  expect(f.finder.status(f.me)).toBeNull();
});
it("separates incompatible simultaneous party new-lobby acceptances", () => {
  const f = fixture();
  const friend = f.store.identity("Friend"),
    second = f.store.identity("Second");
  const set = f.db.prepare("INSERT INTO ranked_ratings VALUES(?,?,?,?,?)");
  set.run("simulation", "2v2", f.me.id, 1900, 20);
  set.run("simulation", "2v2", friend.id, 600, 20);
  f.finder.start(f.me, { mode: "2v2", ranked: true, budget: "0.01" }, [
    f.me,
    friend,
  ]);
  f.finder.start(f.other, { mode: "2v2", ranked: true, budget: "0.01" }, [
    f.other,
    second,
  ]);
  f.advance(30000);
  const accept = (members: (typeof f.me)[]) => {
    const s = f.finder.status(members[0])!;
    for (const m of members) f.finder.confirm(m, s.id, s.offer!.id);
    return f.finder.accept(
      members[0],
      s.id,
      s.offer!.id,
      (id) => f.finder.joinGroup(f.store.rooms.get(id)!, members),
      (input) => f.finder.joinGroup(f.store.create(members[0], input), members),
    );
  };
  const a = accept([f.me, friend]),
    b = accept([f.other, second]);
  expect(a.id).not.toBe(b.id);
});

it("preserves a search across a rate-limit retry window", () => {
  const f = fixture();
  const first = f.finder.start(f.me, {
    mode: "1v1",
    ranked: true,
    budget: "0.01",
  })!;
  f.advance(65000);
  expect(f.finder.status(f.me)?.id).toBe(first.id);
});
it("lets a party review a selected eligible lobby without substituting a different map", () => {
  const f = fixture(),
    friend = f.store.identity("Friend");
  const room = f.store.create(f.other, { mode: "2v2", stake: "0.01" });
  room.automaticTeams = true;
  const status = f.finder.start(
    f.me,
    { mode: "2v2", ranked: true, budget: "0.01", roomID: room.id },
    [f.me, friend],
  )!;
  expect(status.offer?.room?.id).toBe(room.id);
  f.store.rooms.delete(room.id);
  f.advance(30000);
  expect(f.finder.status(f.me)?.offer).toBeNull();
});
