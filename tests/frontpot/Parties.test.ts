import { expect, it } from "vitest";
import { Parties } from "../../src/frontpot/Parties";
import { LobbyStore } from "../../src/frontpot/Store";
it("requires an accepted invite, caps parties at two and restricts starting to the leader", () => {
  const store = new LobbyStore(),
    cancelled: string[] = [];
  const parties = new Parties(store, (p) => cancelled.push(p.id));
  const a = store.identity("A"),
    b = store.identity("B"),
    c = store.identity("C");
  const party = parties.create(a)!;
  expect(() => parties.searchMembers(a)).toThrow("Invite");
  expect(() => parties.join(b, "wrong")).toThrow("expired");
  parties.join(b, party.code);
  expect(parties.searchMembers(a).map((p) => p.id)).toEqual([a.id, b.id]);
  expect(() => parties.searchMembers(b)).toThrow("leader");
  expect(() => parties.join(c, party.code)).toThrow("full");
  parties.leave(b);
  expect(parties.view(a)).toBeNull();
  expect(cancelled).toContain(a.id);
});
it("expires abandoned invitations and refuses members already in a match", () => {
  let now = 0;
  const store = new LobbyStore(),
    parties = new Parties(
      store,
      () => {},
      () => now,
    );
  const a = store.identity("A"),
    b = store.identity("B");
  const code = parties.create(a)!.code;
  now = 31 * 60_000;
  expect(() => parties.join(b, code)).toThrow("expired");
  store.create(b, { mode: "1v1", stake: "0.01" });
  expect(() => parties.create(b)).toThrow("Leave");
});
