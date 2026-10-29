import { expect, it } from "vitest";
import { canSpectate, spectatorIdentity } from "../../src/frontpot/Spectating";
import type { Room } from "../../src/frontpot/Store";
const room = {
  private: false,
  practice: false,
  status: "playing",
  members: [{ id: "entrant" }],
  departedIDs: ["departed"],
} as Room;
it("admits observers only for public live matches without admitting entrants", () => {
  expect(canSpectate(room, "viewer")).toBe(true);
  for (const id of ["entrant", "departed"])
    expect(canSpectate(room, id)).toBe(false);
  for (const patch of [
    { private: true },
    { practice: true },
    { status: "waiting" },
    { status: "finished" },
  ])
    expect(canSpectate({ ...room, ...patch } as Room, "viewer")).toBe(false);
  expect(canSpectate(undefined, "viewer")).toBe(false);
  expect(spectatorIdentity("viewer")).not.toBe("viewer");
});
