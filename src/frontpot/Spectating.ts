import type { Room } from "./Store";
/** Public live matches only. An entrant cannot switch to an all-map observer. */
export function canSpectate(room: Room | undefined, playerID: string): boolean {
  return (
    !!room &&
    !room.private &&
    !room.practice &&
    room.status === "playing" &&
    !room.members.some((m) => m.id === playerID) &&
    !room.departedIDs?.includes(playerID)
  );
}
export const spectatorIdentity = (playerID: string) => `watch:${playerID}`;
