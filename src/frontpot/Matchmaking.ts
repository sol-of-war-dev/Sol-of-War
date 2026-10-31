import { randomUUID } from "node:crypto";
import { Rankings } from "./Rankings";
import { defaultRules, parseRules, rankedRules } from "./Rules";
import {
  InputError,
  isRanked,
  limits,
  LobbyStore,
  LOBBY_COUNTDOWN_MS,
  parseStake,
  type Identity,
  type Mode,
  type Room,
} from "./Store";
type Ticket = {
  id: string;
  mode: Mode;
  ranked: boolean;
  budget: number;
  members: Identity[];
  accepted: string[];
  targetRoomID?: string;
  started: number;
  seen: number;
  offer?: {
    roomID: string | null;
    lamports: number;
    rules: Room["rules"];
    expires: number;
  };
};
export const MAX_MATCHMAKING_SPREAD = 300;
export class Matchmaking {
  private formingGroup: string[] = [];
  private tickets = new Map<string, Ticket>();
  constructor(
    private store: LobbyStore,
    private rankings: Rankings,
    private network: string,
    private now: () => number = Date.now,
  ) {
    store.assertJoinAdmission = (identity, room) => {
      const group = this.group(identity);
      if (
        group.length === 2 &&
        !(
          room.members.length === 0 &&
          room.host === identity.id &&
          this.formingGroup.includes(identity.id)
        ) &&
        !room.parties?.some((p) => group.every((m) => p.includes(m.id)))
      )
        throw new InputError(
          "Accept the match with your party, or cancel the search before joining alone.",
        );
      if (
        !room.private &&
        isRanked(room) &&
        !this.skillCompatible(
          identity.id,
          room.mode,
          room,
          MAX_MATCHMAKING_SPREAD,
        )
      )
        throw new InputError(
          "This matchmaking lobby is outside your skill range. Find a similar-skill match.",
        );
    };
  }
  private owner(identity: Identity) {
    return (
      [...this.tickets.values()].find((t) =>
        t.members.some((m) => m.id === identity.id),
      )?.members[0] ?? identity
    );
  }
  private effectiveRating(id: string, mode: Mode, room?: Room): number {
    const group =
      mode === "2v2"
        ? (room?.parties?.find(
            (p) =>
              p.includes(id) &&
              p.every((member) => room.members.some((m) => m.id === member)),
          ) ??
          [...this.tickets.values()]
            .find(
              (t) =>
                t.mode === mode &&
                t.members.length === 2 &&
                t.members.some((m) => m.id === id),
            )
            ?.members.map((m) => m.id))
        : undefined;
    return Math.max(
      ...(group ?? [id]).map(
        (member) => this.rankings.get(this.network, mode, member).rating,
      ),
    );
  }
  visibleTo(room: Room, identity: Identity | null, party: Identity[] = []) {
    if (
      !isRanked(room) ||
      room.private ||
      room.members.some((m) => m.id === identity?.id)
    )
      return true;
    // Guests can browse neutral empty rooms; personalized occupied rooms require sign-in.
    if (!identity) return room.members.length === 0;
    return this.skillCompatible(
      identity.id,
      room.mode,
      room,
      MAX_MATCHMAKING_SPREAD,
      room.mode === "2v2" && party.length === 2
        ? Math.max(
            ...party.map(
              (m) => this.rankings.get(this.network, "2v2", m.id).rating,
            ),
          )
        : undefined,
    );
  }
  group(identity: Identity) {
    return this.tickets.get(this.owner(identity).id)?.members ?? [identity];
  }
  confirm(identity: Identity, ticketID: unknown, offerID: unknown) {
    this.prune();
    const t = this.tickets.get(this.owner(identity).id);
    if (
      !t ||
      t.id !== ticketID ||
      !t.offer ||
      t.offer.expires <= this.now() ||
      offerID !==
        `${t.id}:${t.offer.roomID ?? "new"}:${t.offer.lamports}:${t.offer.expires}`
    )
      throw new InputError(
        "This match offer expired. Review the current match.",
      );
    if (!t.accepted.includes(identity.id)) t.accepted.push(identity.id);
    return t.members.every((m) => t.accepted.includes(m.id));
  }
  joinGroup(room: Room, members: Identity[]) {
    if (members.length === 1) return this.store.join(members[0], room.id);
    if (room.mode !== "2v2" || members.length !== 2)
      throw new InputError("Parties require 2v2.");
    if (
      members.some((m) => {
        const active = this.store.activeRoom(m);
        return active && active.id !== room.id;
      })
    )
      throw new InputError("A party member is already in another match.");
    const others = room.members.filter(
      (m) => !members.some((p) => p.id === m.id),
    );
    const team = [0, 1].find((t) => !others.some((m) => m.team === t));
    if (team === undefined || others.length > 2)
      throw new InputError(
        "There is no full team available. Continue searching.",
      );
    const beforeMembers = structuredClone(room.members),
      beforeParties = structuredClone(room.parties);
    room.parties = [
      ...(room.parties ?? []).filter(
        (g) => !g.some((id) => members.some((m) => m.id === id)),
      ),
      members.map((m) => m.id),
    ];
    try {
      for (const member of members) this.store.join(member, room.id);
      for (const member of room.members)
        if (members.some((m) => m.id === member.id)) member.team = team;
      room.automaticTeams = true;
      return room;
    } catch (error) {
      room.members = beforeMembers;
      room.parties = beforeParties;
      throw error;
    }
  }
  private skillRange(id: string, mode: Mode, started: number) {
    const provisional = this.rankings.get(this.network, mode, id).provisional;
    return Math.min(
      MAX_MATCHMAKING_SPREAD,
      (provisional ? 250 : 150) +
        Math.floor(Math.max(0, this.now() - started) / 30000) * 25,
    );
  }
  private skillCompatible(
    id: string,
    mode: Mode,
    room: Room,
    range: number,
    incomingRating?: number,
  ) {
    const ids = new Set(room.members.map((p) => p.id));
    for (const [otherID, ticket] of this.tickets)
      if (
        ticket.offer?.roomID === room.id &&
        ticket.offer.expires > this.now() &&
        this.now() - ticket.seen <= 180000
      )
        ids.add(otherID);
    ids.add(id);
    const ratings = [...ids].map((player) => ({
      id: player,
      rating:
        player === id && incomingRating !== undefined
          ? incomingRating
          : this.effectiveRating(player, mode, room),
    }));
    if (
      Math.max(...ratings.map((r) => r.rating)) -
        Math.min(...ratings.map((r) => r.rating)) >
      MAX_MATCHMAKING_SPREAD
    )
      return false;
    const mine = ratings.find((r) => r.id === id)!.rating;
    return ratings.every((other) => {
      const ticket = this.tickets.get(other.id);
      const otherRange =
        ticket && ticket.mode === mode && ticket.ranked
          ? this.skillRange(other.id, mode, ticket.started)
          : MAX_MATCHMAKING_SPREAD;
      return Math.abs(other.rating - mine) <= Math.min(range, otherRange);
    });
  }
  private prune() {
    for (const [id, t] of this.tickets)
      if (this.now() - t.seen > 180000 || this.now() - t.started > 600000)
        this.tickets.delete(id);
  }
  start(
    identity: Identity,
    input: {
      mode?: unknown;
      ranked?: unknown;
      budget?: unknown;
      roomID?: unknown;
    },
    members: Identity[] = [identity],
  ) {
    this.prune();
    if (members.some((m) => this.store.activeRoom(m)))
      throw new InputError(
        "Every party member must leave their current match before matchmaking.",
      );
    if (members.length > 1 && input.mode !== "2v2")
      throw new InputError("Parties can search 2v2 only.");
    if (
      !["1v1", "2v2", "ffa"].includes(String(input.mode)) ||
      typeof input.ranked !== "boolean"
    )
      throw new InputError("Choose a mode and match type.");
    const budget = input.ranked
      ? parseStake(
          input.budget,
          Math.max(10000000, this.store.minimumEntryLamports),
        ).lamports
      : 0;
    if (budget > 1e9)
      throw new InputError(
        "Matchmaking entry budgets range from 0.01 to 1 SOL.",
      );
    const existing = this.tickets.get(identity.id);
    if (
      existing &&
      existing.mode === input.mode &&
      existing.ranked === input.ranked &&
      existing.budget === budget &&
      existing.targetRoomID === input.roomID
    )
      return this.status(identity);
    if (this.tickets.size >= 1000 && !existing)
      throw new InputError("Matchmaking is busy. Please try again shortly.");
    this.tickets.set(identity.id, {
      id: randomUUID(),
      mode: input.mode as Mode,
      ranked: input.ranked,
      budget,
      members,
      accepted: [],
      targetRoomID: typeof input.roomID === "string" ? input.roomID : undefined,
      started: this.now(),
      seen: this.now(),
    });
    return this.status(identity);
  }
  cancel(identity: Identity) {
    this.tickets.delete(this.owner(identity).id);
  }
  status(identity: Identity) {
    this.prune();
    identity = this.owner(identity);
    const t = this.tickets.get(identity.id);
    if (!t) return null;
    if (this.store.activeRoom(identity)) {
      this.cancel(identity);
      return null;
    }
    t.seen = this.now();
    const elapsed = this.now() - t.started;
    const rating = this.rankings.get(this.network, t.mode, identity.id);
    const range = t.targetRoomID
      ? MAX_MATCHMAKING_SPREAD
      : this.skillRange(identity.id, t.mode, t.started);
    const eligible = (r: Room) =>
      (!t.targetRoomID || t.targetRoomID === r.id) &&
      !r.locked &&
      (r.mode !== "2v2" || !!r.queueKey || r.automaticTeams === true) &&
      !r.private &&
      !r.practice &&
      r.mode === t.mode &&
      isRanked(r) === t.ranked &&
      r.lamports <= t.budget &&
      r.lamports >=
        (t.ranked ? Math.max(10000000, this.store.minimumEntryLamports) : 0) &&
      ["waiting", "countdown"].includes(r.status) &&
      (!r.startsAt || r.startsAt > this.now() + 5000) &&
      (t.members.length === 1 ||
        [0, 1].some((team) => !r.members.some((m) => m.team === team))) &&
      r.members.length +
        t.members.length -
        1 +
        [...this.tickets.entries()]
          .filter(
            ([id, other]) =>
              id !== identity.id &&
              other.offer?.roomID === r.id &&
              other.offer.expires > this.now(),
          )
          .reduce((n, [, ticket]) => n + ticket.members.length, 0) <
        limits(r).max;
    const candidates = [...this.store.rooms.values()]
      .filter(eligible)
      .filter(
        (r) =>
          (r.members.length > 0 || elapsed >= 10000 || !!t.targetRoomID) &&
          (!t.ranked || this.skillCompatible(identity.id, t.mode, r, range)),
      )
      .sort((a, b) => {
        const distance = (r: Room) =>
          r.members.length
            ? Math.abs(
                r.members.reduce(
                  (n, p) =>
                    n + this.rankings.get(this.network, t.mode, p.id).rating,
                  0,
                ) /
                  r.members.length -
                  rating.rating,
              )
            : 100000;
        return (
          (t.ranked
            ? distance(a) - distance(b)
            : b.members.length - a.members.length) ||
          (a.queuePosition ?? 0) - (b.queuePosition ?? 0) ||
          a.created - b.created
        );
      });
    // Keep the displayed map and price stable while the player decides.
    const selected =
      candidates.find(
        (r) =>
          r.id === t.offer?.roomID &&
          t.offer.expires > this.now() &&
          r.lamports === t.offer.lamports &&
          JSON.stringify(r.rules) === JSON.stringify(t.offer.rules),
      ) ?? candidates[0];
    const canCreate =
      !t.targetRoomID &&
      !selected &&
      elapsed >= 30000 &&
      this.store.rooms.size < 40;
    let rules =
      selected?.rules ??
      [...this.store.rooms.values()].find(
        (r) =>
          r.mode === t.mode &&
          isRanked(r) === t.ranked &&
          !r.private &&
          !r.practice,
      )?.rules ??
      defaultRules(t.mode);
    if (!selected) {
      rules = parseRules(rules, t.mode, false);
      if (t.ranked) rules = rankedRules(rules, t.mode);
    }
    if (
      !t.offer ||
      t.offer.expires <= this.now() ||
      t.offer.roomID !== (selected?.id ?? null) ||
      t.offer.lamports !== (selected?.lamports ?? t.budget) ||
      JSON.stringify(t.offer.rules) !== JSON.stringify(rules)
    ) {
      t.accepted = [];
      t.offer =
        selected || canCreate
          ? {
              roomID: selected?.id ?? null,
              lamports: selected?.lamports ?? t.budget,
              rules: structuredClone(rules),
              expires: this.now() + 30000,
            }
          : undefined;
    }
    if (!selected && !canCreate) t.offer = undefined;
    return {
      id: t.id,
      partyMembers: t.members.map((m) => ({ id: m.id, name: m.name })),
      acceptedIDs: t.accepted,
      mode: t.mode,
      ranked: t.ranked,
      budgetLamports: t.budget,
      elapsedSeconds: Math.floor(elapsed / 1000),
      skillRange: range,
      rating,
      offer: t.offer
        ? {
            id: `${t.id}:${t.offer.roomID ?? "new"}:${t.offer.lamports}:${t.offer.expires}`,
            room: selected ? this.store.publicRoom(selected) : null,
            entryLamports: t.offer.lamports,
            create: canCreate,
            rules: t.offer.rules,
            expiresAt: t.offer.expires,
            maxPlayers: selected
              ? limits(selected).max
              : limits({ mode: t.mode, practice: false, rules: t.offer.rules })
                  .max,
          }
        : null,
    };
  }
  accept(
    identity: Identity,
    ticketID: unknown,
    offerID: unknown,
    join: (id: string) => Room,
    create: (input: {
      mode: Mode;
      ranked: boolean;
      stake: string;
      rules?: Room["rules"];
      name: string;
    }) => Room,
  ) {
    this.prune();
    identity = this.owner(identity);
    const t = this.tickets.get(identity.id);
    if (!t || t.id !== ticketID || !t.offer || t.offer.expires <= this.now())
      throw new InputError("This match offer expired. Search again.");
    if (
      t.members.length === 2 &&
      !t.members.every((m) => t.accepted.includes(m.id))
    )
      throw new InputError("Both party members must accept this match.");
    if (t.members.some((m) => this.store.activeRoom(m)))
      throw new InputError("A party member is already in a match.");
    const offer = t.offer;
    if (
      offerID !==
      `${t.id}:${offer.roomID ?? "new"}:${offer.lamports}:${offer.expires}`
    )
      throw new InputError(
        "Your match offer changed. Review the updated entry before joining.",
      );
    let result: Room;
    if (offer.roomID) {
      const r = this.store.rooms.get(offer.roomID);
      if (
        !r ||
        (r.mode === "2v2" && !r.queueKey && !r.automaticTeams) ||
        r.private ||
        r.practice ||
        r.mode !== t.mode ||
        isRanked(r) !== t.ranked ||
        r.lamports !== offer.lamports ||
        r.lamports > t.budget ||
        JSON.stringify(r.rules) !== JSON.stringify(offer.rules) ||
        !["waiting", "countdown"].includes(r.status) ||
        r.locked ||
        (r.startsAt !== null && r.startsAt <= this.now()) ||
        r.members.length + t.members.length > limits(r).max
      ) {
        t.offer = undefined;
        throw new InputError(
          "That lobby changed or filled. Continue searching.",
        );
      }
      if (
        t.ranked &&
        !this.skillCompatible(
          identity.id,
          t.mode,
          r,
          t.targetRoomID
            ? MAX_MATCHMAKING_SPREAD
            : this.skillRange(identity.id, t.mode, t.started),
        )
      ) {
        t.offer = undefined;
        throw new InputError(
          "The players in that lobby changed. Continue searching.",
        );
      }
      if (t.ranked) r.matchmakingSkillProtected = true;
      result = join(r.id);
    } else {
      // Another searcher may have accepted the same new-lobby offer first.
      // Reuse that exact configuration rather than splitting them across rooms.
      const existing = [...this.store.rooms.values()].find(
        (r) =>
          !r.private &&
          !r.practice &&
          !r.locked &&
          (r.mode !== "2v2" || !!r.queueKey || r.automaticTeams === true) &&
          r.mode === t.mode &&
          isRanked(r) === t.ranked &&
          r.lamports === offer.lamports &&
          JSON.stringify(r.rules) === JSON.stringify(offer.rules) &&
          ["waiting", "countdown"].includes(r.status) &&
          (!r.startsAt || r.startsAt > this.now() + 5000) &&
          r.members.length + t.members.length <= limits(r).max &&
          (t.members.length === 1 ||
            [0, 1].some((team) => !r.members.some((m) => m.team === team))) &&
          (!t.ranked ||
            this.skillCompatible(
              identity.id,
              t.mode,
              r,
              t.targetRoomID
                ? MAX_MATCHMAKING_SPREAD
                : this.skillRange(identity.id, t.mode, t.started),
            )),
      );
      if (existing) {
        if (t.ranked) existing.matchmakingSkillProtected = true;
        result = join(existing.id);
      } else {
        this.formingGroup = t.members.map((m) => m.id);
        try {
          result = create({
            mode: t.mode,
            ranked: t.ranked,
            stake: String(offer.lamports / 1e9),
            rules: offer.rules,
            name: "Matchmaking lobby",
          });
        } finally {
          this.formingGroup = [];
        }
        result.automaticStart = true;
        result.startsAt = this.now() + LOBBY_COUNTDOWN_MS;
        result.status = "countdown";
        result.automaticTeams = true;
        result.matchmakingSkillProtected = t.ranked;
      }
    }
    this.cancel(identity);
    return result;
  }
}
