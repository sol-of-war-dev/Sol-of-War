import {
  GameMapSize,
  GameMapType,
  maps,
} from "@openfront/engine-api/game/GameTypes";
import { html } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { translateText } from "../client/Utils";
import type { AdminStatsSnapshot } from "./AdminStats";
import { adminStatsView } from "./AdminStatsView";
import type { GlobalQueue } from "./GlobalQueue";
import type { LiveSnapshot } from "./LiveMonitoring";
import { liveMonitoringView } from "./LiveMonitoringView";
import type { OperationsSnapshot } from "./Operations";
import { operationsView, clearOperationsDraft } from "./OperationsView";
import {
  defaultQueueSettings,
  type MatchTemplate,
  type QueueSettings,
} from "./QueueSettings";
import type { Identity } from "./Store";

type Snapshot = ReturnType<GlobalQueue["snapshot"]> & {
  stats?: AdminStatsSnapshot;
  live?: LiveSnapshot;
  operations?: OperationsSnapshot;
};
type Api = <T>(url: string, body?: unknown) => Promise<T>;
let current: Snapshot | null = null;
let draft: QueueSettings | null = null;
let draftRevision = 0;
let failure = "";
let pendingRefresh: Promise<void> | null = null;
let clockOffset = 0;
let message = "";
let disputes: Array<{id: string; match_id: string; reason: string; description: string; email: string; evidence: string; status: string; resolution: string}> = [];
let editingID: string | null = null;
let matchDraft: MatchTemplate = {
  ...defaultQueueSettings().templates[0],
  map: GameMapType.Alps,
};
let selectedMap = GameMapType.Alps;
let sessionGeneration = 0;
export function clearAdmin() {
  clearOperationsDraft();
  sessionGeneration++;
  current = null;
  disputes = [];
  draft = null;
  failure = "";
  message = "";
  editingID = null;
}
const mapName = (value: string) => {
  const entry = maps.find((m) => m.type === value);
  return entry ? translateText(entry.translationKey) : value;
};
export function refreshAdmin(api: Api, reset = false): Promise<void> {
  if (pendingRefresh)
    return reset
      ? pendingRefresh.then(() => refreshAdmin(api, true))
      : pendingRefresh;
  pendingRefresh = (async () => {
    const generation = sessionGeneration;
    try {
      const requestedAt = Date.now();
      const next = await api<Snapshot>("/admin");
      if (generation !== sessionGeneration) return;
      current = next;
      clockOffset = current.serverNow - (requestedAt + Date.now()) / 2;
      failure = "";
      if (!draft || reset) {
        draft = structuredClone(current.settings);
        draftRevision = current.revision;
      }
    } catch (e) {
      if (generation !== sessionGeneration) return;
      if (
        e &&
        typeof e === "object" &&
        "status" in e &&
        (e.status === 401 || e.status === 403)
      ) {
        current = null;
        draft = null;
      }
      failure =
        e instanceof Error ? e.message : "Unable to load administration.";
    } finally {
      pendingRefresh = null;
    }
  })();
  return pendingRefresh;
}

function fields(value: MatchTemplate, prefix: string, paint: () => void) {
  const number = (key: "minPlayers" | "maxPlayers" | "minutes", e: Event) => {
    value[key] = Number((e.target as HTMLInputElement).value);
  };
  return html`<div class="sa-fields">
    <label
      >Match type<select
        .value=${value.ranked ? "ranked" : "unranked"}
        @change=${(e: Event) => {
          value.ranked = (e.target as HTMLSelectElement).value === "ranked";
          value.stake = value.ranked ? "0.25" : "0";
          paint();
        }}
      >
        <option value="ranked" ?selected=${value.ranked}>
          Ranked · Wager SOL
        </option>
        <option value="unranked" ?selected=${!value.ranked}>
          Unranked · Free
        </option>
      </select></label
    >
    <label for=${`${prefix}-mode`}
      >Mode<select
        id=${`${prefix}-mode`}
        .value=${value.mode}
        @change=${(e: Event) => {
          value.mode = (e.target as HTMLSelectElement)
            .value as MatchTemplate["mode"];
          value.minPlayers = value.mode === "2v2" ? 4 : 2;
          value.maxPlayers = value.mode === "ffa" ? 100 : value.minPlayers;
          paint();
        }}
      >
        <option value="ffa">Free-for-all</option>
        <option value="1v1">1v1</option>
        <option value="2v2">2v2</option>
      </select></label
    >
    ${
      value.ranked
        ? html`<label for=${`${prefix}-entry`}
            >Entry (SOL)<input
              id=${`${prefix}-entry`}
              type="number"
              min=${value.ranked ? "0.01" : "0"}
              max="1"
              step="0.000000001"
              required
              .value=${value.stake}
              @input=${(e: Event) => {
                value.stake = (e.target as HTMLInputElement).value;
              }}
          /></label> `
        : html`<p>Free entry · No prize pool</p>`
    }
    <label class="sa-map-field" for=${`${prefix}-map`}
      >Map<select
        id=${`${prefix}-map`}
        .value=${value.map ?? "rotation"}
        @change=${(e: Event) => {
          const map = (e.target as HTMLSelectElement).value;
          value.map = map === "rotation" ? null : (map as GameMapType);
        }}
      >
        <option value="rotation" ?selected=${value.map === null}>
          Use map rotation
        </option>
        ${maps.map((m) => html`<option value=${m.type} ?selected=${value.map === m.type}>${mapName(m.type)}</option>`)}
      </select></label
    >
    <label for=${`${prefix}-size`}
      >Map size<select
        id=${`${prefix}-size`}
        .value=${value.size}
        @change=${(e: Event) => {
          value.size = (e.target as HTMLSelectElement).value as GameMapSize;
        }}
      >
        ${Object.values(GameMapSize).map((size) => html`<option value=${size} ?selected=${value.size === size}>${size}</option>`)}
      </select></label
    >
    <label for=${`${prefix}-min`}
      >Minimum players<input
        id=${`${prefix}-min`}
        type="number"
        min="2"
        max="100"
        required
        ?disabled=${value.mode !== "ffa"}
        .value=${String(value.minPlayers)}
        @input=${(e: Event) => number("minPlayers", e)}
    /></label>
    <label for=${`${prefix}-max`}
      >Player limit<input
        id=${`${prefix}-max`}
        type="number"
        min="2"
        max="100"
        required
        ?disabled=${value.mode !== "ffa"}
        .value=${String(value.maxPlayers)}
        @input=${(e: Event) => number("maxPlayers", e)}
    /></label>
    <label for=${`${prefix}-minutes`}
      >Match length (min)<input
        id=${`${prefix}-minutes`}
        type="number"
        min="1"
        max="120"
        required
        .value=${String(value.minutes)}
        @input=${(e: Event) => number("minutes", e)}
    /></label>
  </div>`;
}
export function adminView(ctx: {
  identity: Identity | null;
  busy: boolean;
  api: Api;
  act: (fn: () => Promise<void>) => Promise<void>;
  paint: () => void;
  signIn: () => void;
}) {
  const { identity, busy, api, act, paint, signIn } = ctx;
  const submit = (fn: () => Promise<void>) => (e: Event) => {
    e.preventDefault();
    void act(fn);
  };
  if (!identity?.name || !current || !draft)
    return html`<main class="sa-access">
      <p class="fp-eyebrow">ADMINISTRATION</p>
      <h1>Manage Sol of War</h1>
      <p>
        ${!identity?.name ? "Sign in with your administrator wallet to manage the queue." : failure || "Loading queue controls…"}
      </p>
      ${
        !identity?.name
          ? html`<button class="fp-primary" @click=${signIn}>
              Sign in with wallet
            </button>`
          : html`<button
              class="fp-create"
              @click=${() =>
                act(async () => {
                  await refreshAdmin(api, true);
                })}
            >
              Retry
            </button>`
      }<a class="fp-primary" href="/">Back to games</a>
    </main>`;
  const settings = draft;
  return html`<main class="sa-admin">
    <header class="sq-page-heading">
      <div>
        <p class="fp-eyebrow">ADMINISTRATION</p>
        <h1>Admin dashboard</h1>
        <p class="sa-subtitle">
          Player activity, match totals and queue controls.
        </p>
      </div>
      <a class="fp-create" href="/">View games</a>
    </header>
    ${failure ? html`<p class="fp-message fp-error" role="alert">Couldn't refresh the dashboard. Showing the last successful update. ${failure}</p>` : ""}
    ${liveMonitoringView(current.live, !!failure, Date.now() + clockOffset)}
    ${adminStatsView(current.stats, paint, !!failure, Date.now() + clockOffset)}
    <div class="sa-summary">
      <span
        ><i></i
        >${current.settings.enabled ? "Automatic generation on" : "Automatic generation off"}</span
      ><span>${current.rooms.length} queued games</span
      ><span>2-minute countdown</span
      ><span
        >${current.stats?.paymentsMode === "mainnet" ? "SOL" : current.stats?.paymentsMode === "devnet" ? "Devnet test SOL" : "Demo SOL"}</span
      >
    </div>
    ${message ? html`<p class="fp-message" role="status">${message}</p>` : ""}
    <section class="sa-panel"><h2>Result disputes</h2>
      <button class="fp-primary" ?disabled=${busy} @click=${() => act(async () => { const generation = sessionGeneration; const result = await api<typeof disputes>("/admin/disputes"); if (generation === sessionGeneration) disputes = result; })}>Load disputes</button>
      ${disputes.map(d => html`<form class="sow-dispute-form" @submit=${(event: Event) => {
        event.preventDefault(); const form = new FormData(event.currentTarget as HTMLFormElement);
        void act(async () => { const generation = sessionGeneration; await api(`/admin/disputes/${d.id}`, Object.fromEntries(form)); const updated = await api<typeof disputes>("/admin/disputes"); if (generation !== sessionGeneration) return; disputes = updated; message = "Review saved. The conclusion is public; funds were not moved."; });
      }}><h3>${d.reason} · ${d.status}</h3><a href=${`/matches/${d.match_id}`} target="_blank" rel="noopener">Match receipt</a><p>${d.description}</p><p>${d.evidence}</p><p>Private contact: ${d.email || "Not supplied"}</p>
      <label>Status<select name="status" class="fp-input"><option value="reviewing">Reviewing</option><option value="resolved">Resolved</option><option value="declined">Declined</option></select></label>
      <label>Public conclusion (no contact details)<textarea class="fp-input" name="resolution" required minlength="10" maxlength="2000" .value=${d.resolution}></textarea></label><button class="fp-primary" ?disabled=${busy}>Save review</button></form>`)}
    </section>
    ${operationsView(
      current.operations,
      busy,
      (url, body) =>
        act(async () => {
          const generation = sessionGeneration;
          const next = await api<Snapshot>(url, body);
          if (generation !== sessionGeneration) return;
          current = next;
          clearOperationsDraft();
          message = "Operations updated.";
        }),
      paint,
      Date.now() + clockOffset,
    )}
    <section class="sa-panel">
      <div class="sa-section-heading">
        <div>
          <h2>Live queue</h2>
          <p>
            Each queue has its own countdown. Players can join any queued game.
          </p>
        </div>
      </div>
      <div class="sa-table-scroll">
        <table class="sa-table">
          <thead>
            <tr>
              <th scope="col">Position</th>
              <th scope="col">Match</th>
              <th scope="col">Entry</th>
              <th scope="col">Players</th>
              <th scope="col">Size</th>
              <th scope="col">Manage</th>
            </tr>
          </thead>
          <tbody>
            ${repeat(
              current.rooms,
              (r) => r.id,
              (r) => {
                const seconds = Math.max(
                  0,
                  Math.ceil(
                    ((r.startsAt ?? 0) - Date.now() - clockOffset) / 1000,
                  ),
                );
                const editable = !r.members.length && !r.poolID;
                return html`<tr>
                  <td>
                    <span
                      class=${r.queuePosition === 0 ? "sa-live" : "sa-position"}
                      >${r.queuePosition === 0 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : `Queue ${r.queuePosition}`}</span
                    >
                  </td>
                  <td>
                    <a href=${`/room/${r.id}`} target="_blank" rel="noreferrer"
                      >${mapName(r.rules.gameMap)}</a
                    ><small
                      >${r.lamports === 0 ? "Free Play" : r.mode === "ffa" ? "FFA Wager" : "Ranked"}
                      · ${r.mode === "ffa" ? "Free-for-all" : r.mode} ·
                      ${r.rules.maxTimerValue} min</small
                    >
                  </td>
                  <td>${r.lamports === 0 ? "Free" : `${r.stake} SOL`}</td>
                  <td>
                    ${r.readyCount}/${r.max}<small>Minimum ${r.min}</small>
                  </td>
                  <td>${r.rules.gameMapSize}</td>
                  <td>
                    <div class="sa-row-actions">
                      <button
                        type="button"
                        ?disabled=${busy || !editable}
                        title=${editable ? "Edit match" : "Terms are fixed after a player joins"}
                        @click=${() => {
                          editingID = r.id;
                          matchDraft = {
                            mode: r.mode,
                            ranked: r.lamports > 0,
                            stake: r.stake,
                            map: r.rules.gameMap,
                            size: r.rules.gameMapSize,
                            minPlayers: r.min,
                            maxPlayers: r.max,
                            minutes: r.rules.maxTimerValue,
                          };
                          paint();
                          document
                            .getElementById("sa-match-editor")
                            ?.scrollIntoView({ block: "center" });
                        }}
                      >
                        Edit</button
                      ><button
                        type="button"
                        ?disabled=${busy || !editable}
                        @click=${() =>
                          act(async () => {
                            await api(`/admin/matches/${r.id}/remove`, {});
                            if (editingID === r.id) editingID = null;
                            await refreshAdmin(api);
                            message = "Match removed. The queue has updated.";
                          })}
                      >
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>`;
              },
            )}
          </tbody>
        </table>
      </div>
      <p class="sa-help">
        Entry terms become fixed once someone joins. Removing an empty match
        adds a replacement when automatic generation is on.
      </p>
    </section>
    <section class="sa-panel" id="sa-match-editor">
      <div class="sa-section-heading">
        <div>
          <h2>${editingID ? "Edit queued match" : "Create a match"}</h2>
          <p>
            ${editingID ? "Changes apply to this empty match only. Its place in the queue stays the same." : "Add a match to the end of its Ranked or Unranked queue immediately."}
          </p>
        </div>
        ${
          editingID
            ? html`<button
                class="fp-text-button"
                @click=${() => {
                  editingID = null;
                  paint();
                }}
              >
                Cancel edit
              </button>`
            : ""
        }
      </div>
      <form
        @submit=${submit(async () => {
          const editing = editingID;
          await api(
            editing ? `/admin/matches/${editing}/edit` : "/admin/matches",
            matchDraft,
          );
          editingID = null;
          await refreshAdmin(api);
          message = editing
            ? "Match updated."
            : "Match added to the end of the queue.";
        })}
      >
        ${fields(matchDraft, "match", paint)}
        <div class="sa-form-actions">
          <span>1v1 uses 2 players. 2v2 uses 4.</span
          ><button class="fp-primary" ?disabled=${busy}>
            ${editingID ? "Save match" : "Add to queue"}
          </button>
        </div>
      </form>
    </section>
    <form
      class="sa-panel"
      @submit=${submit(async () => {
        await api("/admin/settings", { settings, revision: draftRevision });
        await refreshAdmin(api, true);
        message =
          "Generation settings saved. Existing matches keep their terms.";
      })}
    >
      <div class="sa-section-heading">
        <div>
          <h2>Automatic generation</h2>
          <p>
            Saved settings apply to newly generated games and survive restarts.
          </p>
        </div>
        <button
          class="fp-text-button"
          type="button"
          ?disabled=${busy}
          @click=${() =>
            act(async () => {
              await refreshAdmin(api, true);
              message = "Loaded saved settings.";
            })}
        >
          Reload saved settings
        </button>
      </div>
      ${current.revision !== draftRevision ? html`<p class="fp-error" role="alert">Settings changed in another window. Reload before saving.</p>` : ""}
      <div class="sa-generation-controls">
        <label class="sa-checkbox"
          ><input
            type="checkbox"
            .checked=${settings.variety}
            @change=${(e: Event) => {
              settings.variety = (e.target as HTMLInputElement).checked;
            }}
          />Vary automatic maps, capacity and duration (Free FFA may use double
          gold)</label
        >
        <label class="sa-checkbox"
          ><input
            type="checkbox"
            .checked=${settings.enabled}
            @change=${(e: Event) => {
              settings.enabled = (e.target as HTMLInputElement).checked;
            }}
          />Automatically replenish the queue</label
        ><label for="sa-target"
          >Queued games per mode (Free + Wager)<input
            id="sa-target"
            type="number"
            min="1"
            max="18"
            required
            .value=${String(settings.targetSize)}
            @input=${(e: Event) => {
              settings.targetSize = Number(
                (e.target as HTMLInputElement).value,
              );
            }}
        /></label>
      </div>
      <p class="sa-help">
        Turning this off stops new automatic games. Existing games still run.
        Reducing the target does not remove games already queued. Each mode
        splits its slots evenly between Free and Wager when both are enabled; an
        odd extra slot goes to Free.
      </p>
      <h3>Match rotation</h3>
      <p class="sa-help">
        Templates repeat in this order. Saving starts the next generation at the
        first template of each match type. A replacement is added after a game
        starts, up to the queue target.
      </p>
      <div class="sa-templates">
        ${settings.templates.map(
          (template, index) =>
            html`<fieldset class="sa-template">
              <legend>Template ${index + 1}</legend>
              ${fields(template, `template-${index}`, paint)}
              <div class="sa-template-actions">
                <button
                  type="button"
                  ?disabled=${index === 0 || busy}
                  @click=${() => {
                    [settings.templates[index - 1], settings.templates[index]] =
                      [template, settings.templates[index - 1]];
                    paint();
                  }}
                >
                  Move earlier</button
                ><button
                  type="button"
                  ?disabled=${settings.templates.length === 1 || busy}
                  @click=${() => {
                    settings.templates.splice(index, 1);
                    paint();
                  }}
                >
                  Remove template
                </button>
              </div>
            </fieldset>`,
        )}
      </div>
      <button
        class="fp-create"
        type="button"
        ?disabled=${settings.templates.length >= 36 || busy}
        @click=${() => {
          settings.templates.push({ ...defaultQueueSettings().templates[0] });
          paint();
        }}
      >
        Add template
      </button>
      <h3>Map rotation</h3>
      <p class="sa-help">
        Templates set to “Use map rotation” take the next map below, then
        repeat. Fixed maps do not advance this rotation. Map size is selected in
        each template; player limits are set explicitly, not inferred from map
        area.
      </p>
      <ol class="sa-map-rotation">
        ${settings.maps.map(
          (map, index) =>
            html`<li>
              <span>${index + 1}. ${mapName(map)}</span>
              <div>
                <button
                  type="button"
                  aria-label=${`Move ${mapName(map)} earlier`}
                  ?disabled=${index === 0 || busy}
                  @click=${() => {
                    [settings.maps[index - 1], settings.maps[index]] = [
                      map,
                      settings.maps[index - 1],
                    ];
                    paint();
                  }}
                >
                  Earlier</button
                ><button
                  type="button"
                  aria-label=${`Remove ${mapName(map)}`}
                  ?disabled=${settings.maps.length === 1 || busy}
                  @click=${() => {
                    settings.maps.splice(index, 1);
                    paint();
                  }}
                >
                  Remove
                </button>
              </div>
            </li>`,
        )}
      </ol>
      <div class="sa-add-map">
        <label for="sa-add-map"
          >Add a map<select
            id="sa-add-map"
            .value=${selectedMap}
            @change=${(e: Event) => {
              selectedMap = (e.target as HTMLSelectElement)
                .value as GameMapType;
            }}
          >
            ${maps.map((m) => html`<option value=${m.type} ?selected=${selectedMap === m.type}>${mapName(m.type)}</option>`)}
          </select></label
        ><button
          class="fp-create"
          type="button"
          ?disabled=${busy}
          @click=${() => {
            if (!settings.maps.includes(selectedMap))
              settings.maps.push(selectedMap);
            paint();
          }}
        >
          Add map
        </button>
      </div>
      <div class="sa-save">
        <span
          >Existing matches keep their entry fee, map and player limits.</span
        ><button
          class="fp-primary"
          ?disabled=${busy || current.revision !== draftRevision}
        >
          Save generation settings
        </button>
      </div>
    </form>
  </main>`;
}
