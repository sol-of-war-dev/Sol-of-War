import type { DatabaseSync } from "node:sqlite";
import { LobbyRotation, rotationMaps } from "./LobbyRotation";
import {
  defaultQueueSettings,
  MatchTemplateSchema,
  QueueSettingsSchema,
  type MatchTemplate,
} from "./QueueSettings";
import { parseRules, rankedRules } from "./Rules";
import {
  InputError,
  LobbyStore,
  LOBBY_COUNTDOWN_MS,
  matchAmount,
  isWager as isRanked,
  type Room,
} from "./Store";

/** Independent Free/Wager FIFOs per mode; the target is shared by both lanes. */
export class GlobalQueue {
  private settings = defaultQueueSettings();
  private rotation = new LobbyRotation();
  private rotationIndex: Record<string, number> = {};
  private templateCursor = 0;
  private mapCursor = 0;
  private unrankedCursor = 0;
  private nextOrder = 0;
  private revision = 0;
  constructor(
    private readonly store: LobbyStore,
    private readonly db?: DatabaseSync,
    private readonly draining = () => false,
  ) {
    db?.exec(`CREATE TABLE IF NOT EXISTS queue_rotation (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS queue_settings (
      id INTEGER PRIMARY KEY CHECK(id=1), settings TEXT NOT NULL,
      template_cursor INTEGER NOT NULL, map_cursor INTEGER NOT NULL, revision INTEGER NOT NULL
    ); CREATE TABLE IF NOT EXISTS queue_admin_audit (
      id INTEGER PRIMARY KEY, at INTEGER NOT NULL, actor TEXT NOT NULL,
      action TEXT NOT NULL, detail TEXT NOT NULL
    );`);
    if (
      db &&
      !db
        .prepare("PRAGMA table_info(queue_settings)")
        .all()
        .some((c) => c.name === "unranked_cursor")
    )
      db.exec(
        "ALTER TABLE queue_settings ADD COLUMN unranked_cursor INTEGER NOT NULL DEFAULT 0",
      );
    const rotation = db
      ?.prepare("SELECT state FROM queue_rotation WHERE id=1")
      .get();
    if (rotation) {
      const state = JSON.parse(String(rotation.state));
      Object.assign(this.rotation.recent, state.recent);
      this.rotationIndex = state.indices;
    }
    const saved = db?.prepare("SELECT * FROM queue_settings WHERE id=1").get();
    let upgradeMaps = !saved;
    if (saved) {
      const input = JSON.parse(String(saved.settings));
      upgradeMaps = input.variety === undefined;
      // Upgrade older installations without changing their existing wager terms.
      if (
        input.templates.every(
          (t: { ranked?: boolean }) => t.ranked === undefined,
        )
      )
        input.templates.push(
          ...defaultQueueSettings().templates.filter((t) => !t.ranked),
        );
      for (const t of input.templates) {
        if (t.ranked !== false)
          t.stake = String(Math.min(1, Math.max(0.01, Number(t.stake))));
      }
      this.settings = QueueSettingsSchema.parse(input);
      this.unrankedCursor = Number(saved.unranked_cursor ?? 0);
      this.templateCursor = Number(saved.template_cursor);
      this.mapCursor = Number(saved.map_cursor);
      this.revision = Number(saved.revision);
    }
    if (
      upgradeMaps &&
      JSON.stringify(this.settings.maps) ===
        JSON.stringify(defaultQueueSettings().maps)
    )
      this.settings.maps = rotationMaps;
    for (const template of this.settings.templates)
      matchAmount(
        template.ranked,
        template.stake,
        this.store.minimumEntryLamports,
      );
  }
  private persist() {
    this.db
      ?.prepare(
        "INSERT INTO queue_rotation(id,state) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state",
      )
      .run(
        JSON.stringify({
          recent: this.rotation.recent,
          indices: this.rotationIndex,
        }),
      );
    this.db
      ?.prepare(`INSERT INTO queue_settings(id,settings,template_cursor,map_cursor,revision,unranked_cursor) VALUES(1,?,?,?,?,?) ON CONFLICT(id)
      DO UPDATE SET settings=excluded.settings,template_cursor=excluded.template_cursor,
      map_cursor=excluded.map_cursor,revision=excluded.revision,unranked_cursor=excluded.unranked_cursor`)
      .run(
        JSON.stringify(this.settings),
        this.templateCursor,
        this.mapCursor,
        this.revision,
        this.unrankedCursor,
      );
  }
  private audit(actor: string, action: string, detail: unknown) {
    this.db
      ?.prepare(
        "INSERT INTO queue_admin_audit(at,actor,action,detail) VALUES(?,?,?,?)",
      )
      .run(this.store.now(), actor, action, JSON.stringify(detail));
  }
  snapshot() {
    return {
      settings: structuredClone(this.settings),
      minimumEntryLamports: this.store.minimumEntryLamports,
      revision: this.revision,
      nextTemplate: this.templateCursor % this.settings.templates.length,
      rooms: this.pending().map((r) => this.store.publicRoom(r)),
      serverNow: this.store.now(),
    };
  }
  pending(ranked?: boolean, mode?: MatchTemplate["mode"]): Room[] {
    return [...this.store.rooms.values()]
      .filter(
        (r) =>
          r.queueKey &&
          ["waiting", "countdown"].includes(r.status) &&
          (ranked === undefined || isRanked(r) === ranked) &&
          (mode === undefined || r.mode === mode),
      )
      .sort((a, b) => (a.queueOrder ?? 0) - (b.queueOrder ?? 0));
  }
  saveSettings(input: unknown, revision: unknown, actor: string) {
    if (revision !== this.revision)
      throw new InputError(
        "Settings changed in another window. Reload before saving.",
      );
    const parsed = QueueSettingsSchema.safeParse(input);
    if (!parsed.success)
      throw new InputError(
        "Check the queue settings, player limits and entry amounts.",
      );
    for (const template of parsed.data.templates)
      matchAmount(
        template.ranked,
        template.stake,
        this.store.minimumEntryLamports,
      );
    this.settings = parsed.data;
    this.templateCursor = 0;
    this.unrankedCursor = 0;
    this.mapCursor = 0;
    this.revision++;
    this.persist();
    this.audit(actor, "settings", this.settings);
    this.replenish();
  }
  private terms(input: unknown) {
    const result = MatchTemplateSchema.safeParse(input);
    if (!result.success)
      throw new InputError(
        "Choose valid match settings. 1v1 needs 2 players and 2v2 needs 4.",
      );
    matchAmount(
      result.data.ranked,
      result.data.stake,
      this.store.minimumEntryLamports,
    );
    return result.data;
  }
  private resolve(template: MatchTemplate, automatic = false) {
    if (automatic && this.settings.variety && template.map === null) {
      const lane = `${template.mode}:${template.ranked}`;
      const index = this.rotationIndex[lane] ?? 0;
      this.rotationIndex[lane] = index + 1;
      return this.rotation.rules(
        template,
        this.settings.maps,
        this.pending(),
        index,
      );
    }
    const map =
      template.map ??
      this.settings.maps[this.mapCursor++ % this.settings.maps.length];
    return parseRules(
      {
        gameMap: map,
        gameMapSize: template.size,
        maxPlayers: template.maxPlayers,
        maxTimerValue: template.minutes,
      },
      template.mode,
      false,
    );
  }
  private append(template: MatchTemplate, automatic = false) {
    if (automatic && template.ranked && this.settings.variety) {
      const stakes = ["0.01", "0.05", "0.1", "0.25", "0.5", "1"];
      const key = `stakes:${template.mode}`;
      const index = this.rotationIndex[key] ?? 0;
      this.rotationIndex[key] = index + 1;
      template = { ...template, stake: stakes[index % stakes.length] };
    }
    if (
      this.store.rooms.size >= 40 ||
      this.pending(template.ranked, template.mode).length >= 18
    )
      throw new InputError(
        "The queue is full. Wait for a match to start or remove an empty match.",
      );
    const room = this.store.createQueue(
      `${template.ranked ? "" : "unranked:"}${template.mode}:${template.stake}`,
      template.mode,
      template.stake,
      this.resolve(template, automatic),
      template.ranked,
    );
    room.minPlayers = template.minPlayers;
    room.queueOrder = this.nextOrder++;
    return room;
  }
  enqueue(input: unknown, actor: string) {
    if (this.draining())
      throw new InputError(
        "Match creation is paused for deployment preparation.",
      );
    const room = this.append(this.terms(input));
    this.persist();
    this.audit(actor, "create", { id: room.id, input });
    this.promote();
    return room;
  }
  edit(id: string, input: unknown, actor: string) {
    const room = this.editable(id);
    const template = this.terms(input);
    const resolved = this.resolve(template);
    const rules = template.ranked
      ? rankedRules(resolved, template.mode, true)
      : resolved;
    Object.assign(room, {
      mode: template.mode,
      ...matchAmount(
        template.ranked,
        template.stake,
        this.store.minimumEntryLamports,
      ),
      ranked: template.ranked && template.mode !== "ffa",
      queueKey: `${template.ranked ? "" : "unranked:"}${template.mode}:${template.stake}`,
      startsAt:
        isRanked(room) === template.ranked && room.mode === template.mode
          ? room.startsAt
          : null,
      rules,
      rulesKey: JSON.stringify(rules),
      minPlayers: template.minPlayers,
    });
    this.persist();
    this.audit(actor, "edit", { id, input });
    this.replenish();
    return room;
  }
  private editable(id: string) {
    const room = this.pending().find((r) => r.id === id);
    if (!room)
      throw new InputError("This match already started or left the queue.");
    if (room.members.length || room.poolID)
      throw new InputError(
        "A player has joined this match. Its entry terms cannot be changed or removed.",
      );
    if (room.startsAt !== null && room.startsAt <= this.store.now())
      throw new InputError("This match is closing. Refresh the queue.");
    return room;
  }
  remove(id: string, actor: string) {
    const room = this.editable(id);
    this.store.rooms.delete(room.id);
    this.audit(actor, "remove", { id });
    this.replenish();
  }
  private promote() {
    for (const mode of ["ffa", "1v1", "2v2"] as const)
      for (const ranked of [true, false])
        this.pending(ranked, mode).forEach((room, position) => {
          room.queuePosition = position;
          if (position === 0) {
            room.startsAt ??= this.store.now() + LOBBY_COUNTDOWN_MS;
            room.status = "countdown";
          } else {
            room.startsAt = null;
            room.status = "waiting";
          }
        });
  }
  replenish(): Room[] {
    if (this.draining()) return [];
    const created: Room[] = [];
    for (const mode of ["ffa", "1v1", "2v2"] as const) {
      const available = [false, true].filter((ranked) =>
        this.settings.templates.some(
          (t) => t.mode === mode && t.ranked === ranked,
        ),
      );
      for (const [index, ranked] of available.entries()) {
        const target =
          Math.floor(this.settings.targetSize / available.length) +
          (index < this.settings.targetSize % available.length ? 1 : 0);
        const templates = this.settings.templates.filter(
          (t) => t.ranked === ranked && t.mode === mode,
        );
        while (
          this.settings.enabled &&
          this.pending(ranked, mode).length < target &&
          this.store.rooms.size < 40
        ) {
          const cursor = ranked ? this.templateCursor++ : this.unrankedCursor++;
          created.push(this.append(templates[cursor % templates.length], true));
        }
      }
    }
    if (created.length) this.persist();
    this.promote();
    return created;
  }
}
