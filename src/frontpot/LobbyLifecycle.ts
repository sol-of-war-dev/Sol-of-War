import { limits, LOBBY_COUNTDOWN_MS, type Room, type Seat } from "./Store";

type LockPool = (
  room: Room,
  seats: Seat[],
) => { poolLamports: number; feeLamports: number };

/** Called before admission/leave and on the server tick. No await may occur
 * between the ready-roster snapshot, ledger lock and transition to playing. */
export function advanceLobby(
  room: Room,
  readyIDs: string[],
  now: number,
  lockPool: LockPool,
  fundedIDs?: string[],
  reservedIDs: string[] = fundedIDs ?? [],
) {
  if (!["waiting", "countdown"].includes(room.status)) return "unchanged";
  const ready = new Set(readyIDs);
  room.members = room.members.filter(
    (m) =>
      ready.has(m.id) || reservedIDs.includes(m.id) || now - m.joined < 60_000,
  );
  const entrants = room.members.filter(
    (m) => ready.has(m.id) && (!fundedIDs || fundedIDs.includes(m.id)),
  );
  room.readyIDs = entrants.map((m) => m.id);
  // A full public roster can start from any queue position. Pending deposits,
  // spectators and disconnected seats never count toward capacity.
  const full =
    !room.private &&
    !room.practice &&
    entrants.length === limits(room).max &&
    (room.mode !== "2v2" ||
      [0, 1].every(
        (team) => entrants.filter((seat) => seat.team === team).length === 2,
      ));
  if (full) room.startsAt = now;
  // Underfilled queued lobbies still wait for promotion before their clock starts.
  if (room.queueKey && room.startsAt === null) return "queued";
  if (room.practice && entrants.length < 1) {
    room.status = "waiting";
    room.startsAt = null;
    return "waiting";
  }
  if (room.private && !room.practice && room.startsAt === null) {
    room.status = "waiting";
    return "waiting";
  }
  room.startsAt ??= now + (room.practice ? 4_000 : LOBBY_COUNTDOWN_MS);
  room.status = "countdown";
  if (now < room.startsAt) return "countdown";
  if (
    entrants.length < limits(room).min ||
    (room.mode === "2v2" &&
      [0, 1].some((t) => entrants.filter((s) => s.team === t).length !== 2))
  ) {
    room.members = room.members.filter(
      (m) => entrants.some((e) => e.id === m.id) || reservedIDs.includes(m.id),
    );
    if (room.private && !room.practice) {
      room.status = "waiting";
      room.startsAt = null;
      return "waiting";
    }
    // Public lobbies get exactly one deadline. The server cancels the pool
    // through the durable refund path before removing the room and advancing.
    room.status = "finished";
    room.result =
      "Not enough ready players. Lobby closed; paid entries are refunded without a fee.";
    return "expired";
  }
  const pool = lockPool(room, entrants);
  room.members = entrants;
  room.locked = {
    at: now,
    entrants: entrants.length,
    prizeLamports: pool.poolLamports - pool.feeLamports,
  };
  room.status = "playing";
  return "locked";
}
