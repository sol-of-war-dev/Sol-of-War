import { randomUUID } from "node:crypto";
import { Matchmaking, MAX_MATCHMAKING_SPREAD } from "./Matchmaking";
import { Rankings } from "./Rankings";
import { defaultRules, rankedRules, type Rules } from "./Rules";
import {
  InputError,
  isRanked,
  LobbyStore,
  parseStake,
  type Identity,
  type Mode,
  type Room,
} from "./Store";

type Ticket = {
  id: string;
  members: Identity[];
  mode: Mode;
  ranked: boolean;
  entry: number;
  started: number;
  seen: number;
  offer?: Offer;
};
type Offer = {
  id: string;
  tickets: Ticket[];
  members: Identity[];
  accepted: Set<string>;
  teams: Map<string, number>;
  expires: number;
  rules: Rules;
};
/** A match is formed from queued players, never from individually accepted empty rooms. */
export class SharedMatchmaking {
  private tickets = new Map<string, Ticket>();
  private completed = new Map<
    string,
    { offerID: string; ticketID: string; roomID: string; expires: number }
  >();
  private admitting = false;
  private guard: Matchmaking;
  constructor(
    private store: LobbyStore,
    private rankings: Rankings,
    private network: string,
    private now = Date.now,
  ) {
    this.guard = new Matchmaking(store, rankings, network, now);
    const admission = store.assertJoinAdmission!;
    store.assertJoinAdmission = (identity, room) => {
      if (this.admitting) return;
      if (
        !room.private &&
        isRanked(room) &&
        room.members.length === 0 &&
        !room.matchmakingRoster &&
        (room.queueKey || room.host !== identity.id)
      )
        throw new InputError(
          "Use matchmaking to find a ranked game near your Elo.",
        );
      if (
        room.matchmakingRoster &&
        !room.matchmakingRoster.includes(identity.id)
      )
        throw new InputError(
          "This match is reserved for its accepted players.",
        );
      if (this.find(identity))
        throw new InputError(
          "Cancel matchmaking before joining another lobby.",
        );
      admission(identity, room);
    };
  }
  visibleTo(room: Room, identity: Identity | null, party: Identity[] = []) {
    if (room.matchmakingRoster)
      return !!identity && room.matchmakingRoster.includes(identity.id);
    if (!room.private && isRanked(room) && room.members.length === 0)
      return false;
    return this.guard.visibleTo(room, identity, party);
  }
  private find(identity: Identity) {
    return [...this.tickets.values()].find((t) =>
      t.members.some((m) => m.id === identity.id),
    );
  }
  group(identity: Identity) {
    return this.find(identity)?.members ?? [identity];
  }
  private remove(t: Ticket) {
    this.tickets.delete(t.id);
  }
  private dissolve(offer: Offer, cancelled?: Ticket) {
    for (const t of offer.tickets) {
      t.offer = undefined;
      // Keep a party together. A party with a missed acceptance must ready again.
      if (t === cancelled || !t.members.every((m) => offer.accepted.has(m.id)))
        this.remove(t);
      else t.seen = this.now();
    }
  }
  private prune() {
    for (const t of [...this.tickets.values()]) {
      if (t.offer && t.offer.expires <= this.now()) this.dissolve(t.offer);
      if (this.now() - t.seen > 180_000 || this.now() - t.started > 600_000) {
        if (t.offer) this.dissolve(t.offer, t);
        this.remove(t);
      }
    }
    for (const [id, c] of this.completed)
      if (c.expires <= this.now()) this.completed.delete(id);
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
    if (
      !["1v1", "2v2"].includes(String(input.mode)) ||
      typeof input.ranked !== "boolean"
    )
      throw new InputError("Choose 1v1 or 2v2. FFA uses the lobby browser.");
    if (input.roomID)
      throw new InputError(
        "Search for a match with your party from Matchmaking.",
      );
    if (
      ![1, 2].includes(members.length) ||
      new Set(members.map((m) => m.id)).size !== members.length ||
      !members.some((m) => m.id === identity.id) ||
      (members.length === 2 && input.mode !== "2v2")
    )
      throw new InputError("Choose a valid team.");
    if (members.some((m) => this.store.activeRoom(m)))
      throw new InputError("Leave your current match before searching.");
    const entry = input.ranked
      ? parseStake(
          input.budget,
          Math.max(10_000_000, this.store.minimumEntryLamports),
        ).lamports
      : 0;
    if (entry > 1e9) throw new InputError("Entries range from 0.01 to 1 SOL.");
    const existing = this.find(identity);
    if (
      existing &&
      existing.mode === input.mode &&
      existing.ranked === input.ranked &&
      existing.entry === entry &&
      existing.members
        .map((m) => m.id)
        .sort()
        .join() ===
        members
          .map((m) => m.id)
          .sort()
          .join()
    )
      return this.status(identity);
    if (members.some((m) => this.find(m)))
      throw new InputError(
        "Cancel the existing search before changing queue settings.",
      );
    if (this.tickets.size >= 1000)
      throw new InputError("Matchmaking is busy. Try again shortly.");
    const t: Ticket = {
      id: randomUUID(),
      members: [...members],
      mode: input.mode as Mode,
      ranked: input.ranked,
      entry,
      started: this.now(),
      seen: this.now(),
    };
    this.tickets.set(t.id, t);
    return this.status(identity);
  }
  cancel(identity: Identity) {
    const t = this.find(identity);
    if (!t) return;
    if (t.offer) this.dissolve(t.offer, t);
    this.remove(t);
  }
  private rating(t: Ticket) {
    return Math.max(
      ...t.members.map(
        (m) => this.rankings.get(this.network, t.mode, m.id).rating,
      ),
    );
  }
  private range(t: Ticket) {
    const provisional = t.members.some(
      (m) => this.rankings.get(this.network, t.mode, m.id).provisional,
    );
    return Math.min(
      MAX_MATCHMAKING_SPREAD,
      (provisional ? 250 : 150) +
        Math.floor((this.now() - t.started) / 30000) * 25,
    );
  }
  private compatible(a: Ticket, b: Ticket) {
    return (
      a.mode === b.mode &&
      a.ranked === b.ranked &&
      a.entry === b.entry &&
      (!a.ranked ||
        Math.abs(this.rating(a) - this.rating(b)) <=
          Math.min(this.range(a), this.range(b)))
    );
  }
  private form() {
    const waiting = [...this.tickets.values()]
      .filter((t) => !t.offer)
      .sort(
        (a, b) => b.members.length - a.members.length || a.started - b.started,
      );
    for (const anchor of waiting) {
      if (anchor.offer) continue;
      const candidates = waiting
        .filter((t) => t !== anchor && !t.offer && this.compatible(anchor, t))
        .sort(
          (a, b) =>
            (anchor.members.length === 2
              ? b.members.length - a.members.length
              : 0) ||
            Math.abs(this.rating(a) - this.rating(anchor)) -
              Math.abs(this.rating(b) - this.rating(anchor)) ||
            a.started - b.started,
        );
      let chosen: Ticket[] | undefined;
      const count = anchor.mode === "1v1" ? 2 : 4;
      // At most three teammates/opponents are needed; avoid combinatorial scans.
      const group = [anchor];
      let size = anchor.members.length;
      for (const t of candidates) {
        if (
          size + t.members.length > count ||
          !group.every((g) => this.compatible(g, t))
        )
          continue;
        group.push(t);
        size += t.members.length;
        if (size === count) {
          chosen = group;
          break;
        }
      }
      if (!chosen) continue;
      const teams = new Map<string, number>();
      const pairs = chosen.filter((t) => t.members.length === 2);
      if (pairs.length) {
        pairs[0].members.forEach((m) => teams.set(m.id, 0));
        chosen
          .filter((t) => t !== pairs[0])
          .flatMap((t) => t.members)
          .forEach((m) => teams.set(m.id, 1));
      } else {
        const sorted = [...chosen].sort(
          (a, b) => this.rating(b) - this.rating(a),
        );
        sorted.forEach((t, i) =>
          teams.set(
            t.members[0].id,
            count === 4 ? (i === 0 || i === 3 ? 0 : 1) : i,
          ),
        );
      }
      const template = [...this.store.rooms.values()].find(
        (r) => r.mode === anchor.mode && !r.practice && !r.private,
      );
      const rules = anchor.ranked
        ? rankedRules(
            structuredClone(template?.rules ?? defaultRules(anchor.mode)),
            anchor.mode,
          )
        : defaultRules(anchor.mode);
      const offer: Offer = {
        id: randomUUID(),
        tickets: chosen,
        members: chosen.flatMap((t) => t.members),
        accepted: new Set(),
        teams,
        expires: this.now() + 30_000,
        rules,
      };
      chosen.forEach((t) => (t.offer = offer));
    }
  }
  status(identity: Identity) {
    this.prune();
    const t = this.find(identity);
    if (!t) return null;
    t.seen = this.now();
    this.form();
    const offer = t.offer;
    return {
      id: t.id,
      partyMembers: t.members.map((m) => ({ id: m.id, name: m.name })),
      acceptedIDs: [...(offer?.accepted ?? [])],
      mode: t.mode,
      ranked: t.ranked,
      budgetLamports: t.entry,
      elapsedSeconds: Math.floor((this.now() - t.started) / 1000),
      skillRange: this.range(t),
      rating: this.rankings.get(this.network, t.mode, identity.id),
      serverNow: this.now(),
      offer: offer
        ? {
            id: offer.id,
            room: null as ReturnType<LobbyStore["publicRoom"]> | null,
            entryLamports: t.entry,
            create: true,
            rules: offer.rules,
            expiresAt: offer.expires,
            maxPlayers: offer.members.length,
            players: offer.members.map((m) => ({
              id: m.id,
              name: m.name,
              team: offer.teams.get(m.id)!,
            })),
          }
        : null,
    };
  }
  accept(
    identity: Identity,
    ticketID: unknown,
    offerID: unknown,
    validate: (members: Identity[], ranked: boolean) => void,
    prepare: (room: Room) => void,
  ): Room | null {
    this.prune();
    const completed = this.completed.get(identity.id);
    if (
      completed &&
      completed.offerID === offerID &&
      completed.ticketID === ticketID
    ) {
      const existing = this.store.activeRoom(identity);
      if (existing?.id !== completed.roomID)
        throw new InputError("That match is no longer active.");
      return existing;
    }
    const t = this.find(identity),
      offer = t?.offer;
    if (!t || t.id !== ticketID || !offer || offer.id !== offerID)
      throw new InputError(
        "This match offer expired. Ready up to search again.",
      );
    offer.accepted.add(identity.id);
    if (offer.accepted.size !== offer.members.length) return null;
    let room: Room | undefined;
    try {
      if (offer.members.some((m) => this.store.activeRoom(m)))
        throw new InputError("A player is no longer available. Search again.");
      validate(offer.members, t.ranked);
      this.admitting = true;
      room = this.store.create(offer.members[0], {
        mode: t.mode,
        ranked: t.ranked,
        stake: String(t.entry / 1e9),
        rules: offer.rules,
        name: "Matchmaking lobby",
      });
      room.matchmakingRoster = offer.members.map((m) => m.id);
      room.automaticTeams = true;
      room.matchmakingSkillProtected = t.ranked;
      room.parties = offer.tickets
        .filter((t) => t.members.length === 2)
        .map((t) => t.members.map((m) => m.id));
      for (const m of offer.members.slice(1)) this.store.join(m, room.id);
      room.members.forEach((m) => (m.team = offer.teams.get(m.id)!));
      room.allowTeamSelection = false;
      room.teamsLocked = true;
      // Existing lobby start machinery requires the entire roster to connect and fund.
      room.startsAt = this.now() + 120_000;
      prepare(room);
      for (const ticket of offer.tickets) {
        ticket.members.forEach((m) =>
          this.completed.set(m.id, {
            ticketID: ticket.id,
            offerID: offer.id,
            roomID: room!.id,
            expires: this.now() + 180_000,
          }),
        );
        this.remove(ticket);
      }
      return room;
    } catch (error) {
      if (room) this.store.rooms.delete(room.id);
      this.dissolve(offer);
      throw error;
    } finally {
      this.admitting = false;
    }
  }
}
