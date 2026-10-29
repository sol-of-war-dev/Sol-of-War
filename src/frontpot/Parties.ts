import { randomBytes } from "node:crypto";
import { InputError, type Identity, type LobbyStore } from "./Store";
export type PartySettings = { ranked: boolean; budget: string };
type Party = {
  code: string;
  members: Identity[];
  updated: number;
  ready: string[];
  revision: number;
  settings: PartySettings;
};
/** Invitation acceptance is required: a client cannot supply arbitrary teammate IDs. */
export class Parties {
  private parties = new Map<string, Party>();
  constructor(
    private store: LobbyStore,
    private cancel: (identity: Identity) => void,
    private now = Date.now,
  ) {}
  get(identity: Identity) {
    for (const [code, p] of this.parties)
      if (this.now() - p.updated > 30 * 60_000) {
        this.cancel(p.members[0]);
        this.parties.delete(code);
      }
    const p = [...this.parties.values()].find((p) =>
      p.members.some((m) => m.id === identity.id),
    );
    if (p) p.updated = this.now();
    return p;
  }
  view(identity: Identity) {
    const p = this.get(identity);
    return p
      ? {
          code: p.code,
          leaderID: p.members[0].id,
          readyIDs: [...p.ready],
          revision: p.revision,
          settings: { ...p.settings },
          members: p.members.map((m) => ({ id: m.id, name: m.name })),
        }
      : null;
  }
  create(identity: Identity) {
    if (this.store.activeRoom(identity))
      throw new InputError("Leave your match before creating a party.");
    const existing = this.get(identity);
    if (existing) return this.view(identity);
    this.cancel(identity);
    if (this.parties.size >= 1000)
      throw new InputError("Parties are busy. Try again shortly.");
    const code = randomBytes(12).toString("hex");
    this.parties.set(code, {
      code,
      members: [identity],
      updated: this.now(),
      ready: [],
      revision: 0,
      settings: { ranked: true, budget: "0.01" },
    });
    return this.view(identity);
  }
  join(identity: Identity, code: unknown) {
    if (this.store.activeRoom(identity))
      throw new InputError("Leave your match before joining a party.");
    const existing = this.get(identity);
    if (existing) {
      if (existing.code === code) return this.view(identity);
      throw new InputError("Leave your current party first.");
    }
    const p = typeof code === "string" ? this.parties.get(code.trim()) : null;
    if (!p || p.members.length !== 1 || this.store.activeRoom(p.members[0]))
      throw new InputError("This party invite expired or the party is full.");
    this.cancel(identity);
    this.cancel(p.members[0]);
    p.members.push(identity);
    p.ready = [];
    p.revision++;
    p.updated = this.now();
    return this.view(identity);
  }
  leave(identity: Identity) {
    const p = this.get(identity);
    if (!p) return;
    this.cancel(p.members[0]);
    // Disband a two-player party rather than silently changing its ownership.
    this.parties.delete(p.code);
  }
  configure(identity: Identity, input: PartySettings, revision: unknown) {
    const p = this.get(identity);
    if (!p || p.members[0].id !== identity.id)
      throw new InputError("Only the party leader changes queue settings.");
    if (revision !== p.revision)
      throw new InputError(
        "Party settings changed. Review them before continuing.",
      );
    if (
      !input ||
      typeof input.ranked !== "boolean" ||
      typeof input.budget !== "string"
    )
      throw new InputError("Choose valid queue settings.");
    const amount = Number(input.budget);
    if (!Number.isFinite(amount) || amount < 0.01 || amount > 1)
      throw new InputError("Entries range from 0.01 to 1 SOL.");
    this.cancel(p.members[0]);
    p.settings = { ranked: input.ranked, budget: input.budget };
    p.ready = [];
    p.revision++;
    return this.view(identity);
  }
  ready(
    identity: Identity,
    revision: unknown,
    ready: unknown,
    start: (members: Identity[], settings: PartySettings) => void,
  ) {
    const p = this.get(identity);
    if (!p || p.members.length !== 2)
      throw new InputError("Invite your teammate before readying up.");
    if (revision !== p.revision || typeof ready !== "boolean")
      throw new InputError(
        "Party settings changed. Review them and ready up again.",
      );
    if (!ready) {
      this.cancel(identity);
      p.ready = p.ready.filter((id) => id !== identity.id);
    } else if (!p.ready.includes(identity.id)) p.ready.push(identity.id);
    if (p.ready.length === 2) {
      try {
        start(p.members, p.settings);
      } finally {
        p.ready = [];
        p.revision++;
      }
    }
    return this.view(identity);
  }
  searchMembers(identity: Identity): Identity[] {
    const p = this.get(identity);
    if (!p) return [identity];
    if (p.members[0].id !== identity.id)
      throw new InputError("Your party leader starts matchmaking.");
    if (p.members.length !== 2)
      throw new InputError("Invite your teammate before searching as a party.");
    return p.members;
  }
}
