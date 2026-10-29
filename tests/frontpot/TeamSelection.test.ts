import { expect, it } from "vitest";
import { LobbyStore, limits } from "../../src/frontpot/Store";
it("lets friends pick the same team and assigns remaining solo players to open seats", () => {
  const store = new LobbyStore(() => 1000);
  const a = store.identity("A"),
    b = store.identity("B"),
    c = store.identity("C"),
    d = store.identity("D");
  const room = store.create(a, { mode: "2v2", ranked: false, stake: "0" });
  store.join(b, room.id);
  store.selectTeam(b, room.id, 0);
  store.join(c, room.id);
  store.join(d, room.id);
  expect(room.members.map((m) => m.team)).toEqual([0, 0, 1, 1]);
  expect(limits(room)).toEqual({ min: 4, max: 4 });
  expect(() => store.selectTeam(c, room.id, 0)).toThrow("full");
  expect(() =>
    store.selectTeam(store.identity("Outsider"), room.id, 1),
  ).toThrow("Join");
  expect(() => store.selectTeam(c, room.id, 2)).toThrow("Choose");
  room.locked = { at: 1000, entrants: 4, prizeLamports: 0 };
  expect(() => store.selectTeam(b, room.id, 1)).toThrow("locked");
});
it("rejects team changes at the deadline and outside 2v2", () => {
  let now = 1000;
  const store = new LobbyStore(() => now);
  const a = store.identity("A");
  const room = store.create(a, { mode: "2v2", ranked: false, stake: "0" });
  room.startsAt = 2000;
  now = 2000;
  expect(() => store.selectTeam(a, room.id, 1)).toThrow("locked");
  room.startsAt = null;
  room.mode = "1v1";
  expect(() => store.selectTeam(a, room.id, 1)).toThrow("2v2");
});
it("limits manual moves to the host, supports swaps, and enforces locks", () => {
  const store = new LobbyStore(() => 1000);
  const host = store.identity("Host"),
    guest = store.identity("Guest"),
    a = store.identity("A"),
    b = store.identity("B");
  const room = store.create(host, {
    mode: "2v2",
    ranked: false,
    stake: "0",
    private: true,
  });
  store.join(guest, room.id);
  store.join(a, room.id);
  store.join(b, room.id);
  expect(() =>
    store.configureTeams(guest, room.id, { teamsLocked: true }),
  ).toThrow("host");
  expect(() => store.selectTeam(guest, room.id, 1, a.id)).toThrow("host");
  store.configureTeams(host, room.id, { allowTeamSelection: false });
  expect(() => store.selectTeam(guest, room.id, 0)).toThrow("host");
  store.selectTeam(host, room.id, 0, guest.id, a.id);
  expect(room.members.map((m) => m.team)).toEqual([0, 0, 1, 1]);
  store.configureTeams(host, room.id, { teamsLocked: true });
  expect(() => store.selectTeam(host, room.id, 1, guest.id, a.id)).toThrow(
    "locked",
  );
  store.configureTeams(host, room.id, {
    teamsLocked: false,
    allowTeamSelection: true,
  });
  store.selectTeam(host, room.id, 1, guest.id, a.id);
  expect(room.members.map((m) => m.team)).toEqual([0, 1, 0, 1]);
  room.automaticTeams = true;
  expect(() =>
    store.configureTeams(host, room.id, { teamsLocked: false }),
  ).toThrow("automatic");
  expect(() => store.selectTeam(host, room.id, 1)).toThrow("automatic");
  room.automaticTeams = false;
  room.queueKey = "public";
  expect(() => store.selectTeam(host, room.id, 1)).toThrow("automatic");
});
