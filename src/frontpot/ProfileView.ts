import { html, svg } from "lit";
import { pixelRating } from "./PixelRating";
import {
  PROFILE_COLORS,
  PROFILE_ICONS,
  type PlayerProfile,
  type ProfileColor,
  type ProfileIcon,
} from "./ProfileTypes";
import { rankBadge } from "./RankBadge";
import "../client/components/ProfileCard";
import { RANK_TIERS, rankRange, visibleRank } from "./RankTiers";
import type { Identity } from "./Store";
import "./ProfileView.css";
import "./AccountCards.css";

export function rankedCards(
  ratings: NonNullable<PlayerProfile["rankedRatings"]>,
  showGuide = true,
) {
  return html`<section
    class="sp-ranked-section"
    aria-label="Ranked progression"
  >
    <header class="sp-ranked-heading">
      <div>
        <h2>Ranked</h2>
        <p>Your competitive record, by mode.</p>
      </div>
      <span>SKILL RATING</span>
    </header>
    <div class="sp-ranked-grid">
      ${ratings
        .filter((r) => r.mode !== "ffa")
        .map(
          (r) =>
            html`<article class="sp-rank-card">
              <header>
                <div>
                  <span class="sp-rank-kicker"
                    >${r.mode === "ffa" ? "EVERY PLAYER FOR THEMSELVES" : r.mode === "2v2" ? "TEAM BATTLES" : "HEAD TO HEAD"}</span
                  >
                  <h3>${r.mode === "ffa" ? "Free-for-all" : r.mode}</h3>
                </div>
                ${rankBadge(visibleRank(r).tier)}
              </header>
              <div class="sp-rank-score">
                <strong
                  class=${r.provisional ? "sp-elo-number sp-elo-unranked" : "sp-elo-number"}
                  >${r.provisional ? "Unranked" : pixelRating(r.rating)}</strong
                >${r.provisional ? "" : html`<span>Elo</span>`}
              </div>
              <span class="sp-rank-tier"
                >${r.provisional ? "Placement matches" : visibleRank(r).tier}</span
              >
              ${r.provisional ? "" : html`<p class="sp-rank-range">${rankRange(visibleRank(r).tier)}</p>`}
              <div class="sp-rank-record" aria-label="Win–loss record">
                <span><strong>${r.wins}</strong> Wins</span>
                <span><strong>${r.losses}</strong> Losses</span>
              </div>
              <footer>
                <div>
                  <span
                    >${r.provisional ? "Placement matches" : "Rated matches"}</span
                  ><strong
                    >${r.provisional ? `${Math.min(r.games, 10)} / 10` : r.games}</strong
                  >
                </div>
                ${
                  r.provisional
                    ? html`<div
                          class="sp-rank-track"
                          role="progressbar"
                          aria-label=${`${r.mode} placement matches`}
                          aria-valuemin="0"
                          aria-valuemax="10"
                          aria-valuenow=${Math.min(r.games, 10)}
                        >
                          ${Array.from({ length: 10 }, (_, i) => html`<span class=${i < r.games ? "complete" : ""}></span>`)}
                        </div>
                        <p>Complete placements to reveal your rank.</p>`
                    : html`<p>Placements complete. Keep climbing.</p>`
                }
              </footer>
            </article>`,
        )}
    </div>
    ${
      showGuide
        ? html`<details class="sp-rank-explainer">
              <summary>How ranked progression works</summary>
              <p>
                Each mode has its own rating. Verified results and opponent
                strength determine changes; entry size never increases rating
                rewards. FFA Wagers and Free Play earn XP without Elo. Private,
                cancelled, refunded and unverified matches are unrated.
              </p>
              <p>
                Repeat opponents earn full, half, then quarter rating weight
                within 24 hours; later repeats are unrated.
              </p>
            </details>
            <h3 class="sp-rank-list-heading">Rank tiers and Elo ranges</h3>
            <div class="sp-rank-gallery">
              ${RANK_TIERS.map(
                (tier) =>
                  html`<div>
                    ${rankBadge(tier)}<span
                      >${tier}<small>${rankRange(tier)}</small></span
                    >
                  </div>`,
              )}
            </div>`
        : ""
    }
  </section>`;
}

const drawings = {
  shield: svg`<path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z"/><path d="m8 12 3 3 5-6"/>`,
  castle: svg`<path d="M4 21V4h4v4h3V4h2v4h3V4h4v17H4Z"/><path d="M10 21v-6a2 2 0 0 1 4 0v6M6 11h2m8 0h2"/>`,
  anchor: svg`<circle cx="12" cy="5" r="2"/><path d="M12 7v14M8 10h8M4 14v3c0 5 16 5 16 0v-3M2 16l2-2 2 2m12 0 2-2 2 2"/>`,
  crown: svg`<path d="m3 6 5 4 4-7 4 7 5-4-2 12H5L3 6Zm2 15h14"/>`,
  bolt: svg`<path d="m13 2-9 12h7l-1 8 10-13h-8l1-7Z"/>`,
  globe: svg`<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18M5 6h14M5 18h14"/>`,
};
export function playerIcon(
  icon: ProfileIcon = "shield",
  color: ProfileColor = "orange",
  large = false,
) {
  return html`<span
    class="sp-avatar sp-${color} ${large ? "sp-avatar-large" : ""}"
    aria-hidden="true"
    ><svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      ${drawings[icon] ?? drawings.shield}
    </svg></span
  >`;
}
const sol = (amount: string | number) => {
  const value = BigInt(amount);
  const fraction = String(value % 1_000_000_000n)
    .padStart(9, "0")
    .replace(/0+$/, "");
  return `${value / 1_000_000_000n}${fraction ? `.${fraction}` : ""}`;
};
const date = (at: number) =>
  new Date(at).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
type Tab = "overview" | "games" | "progression" | "edit";
type Hooks = {
  api: <T>(url: string, body?: unknown) => Promise<T>;
  paint: () => void;
  identity: () => Identity | null;
  saveIdentity: (identity: Identity) => void;
  signIn: () => void;
  back: () => void;
  replay: (id: string, name: string) => Promise<void>;
  mapImage: (map: string) => string;
  mapName: (map: string) => string;
};

export class ProfileView {
  private profile: PlayerProfile | null = null;
  private tab: Tab = "overview";
  private loading = false;
  private saving = false;
  private error = "";
  private message = "";
  private target = "me";
  private request = 0;
  private draft:
    | (NonNullable<PlayerProfile["settings"]> & { username: string })
    | null = null;
  private confirmingPrestige = false;
  constructor(private hooks: Hooks) {}

  async load(target = "me", tab: Tab = "overview") {
    const request = ++this.request;
    const retain =
      this.target === target &&
      this.profile &&
      (target !== "me" || this.profile.id === this.hooks.identity()?.id);
    this.target = target;
    this.tab = tab;
    if (!retain) this.profile = null;
    this.draft = null;
    this.error = "";
    this.message = "";
    this.confirmingPrestige = false;
    this.loading = !retain;
    if (retain) this.resetDraft();
    this.hooks.paint();
    try {
      if (target === "me" && !this.hooks.identity()?.name) return;
      const profile = await this.hooks.api<PlayerProfile>(
        target === "me" ? "/profile" : `/players/${encodeURIComponent(target)}`,
      );
      if (request !== this.request) return;
      this.profile = profile;
      this.resetDraft();
    } catch (e) {
      if (request === this.request)
        this.error =
          e instanceof Error ? e.message : "Couldn't load this profile.";
    } finally {
      if (request === this.request) {
        this.loading = false;
        this.hooks.paint();
      }
    }
  }
  clear() {
    this.request++;
    this.profile = null;
    this.draft = null;
  }
  private resetDraft() {
    const p = this.profile;
    this.draft = p?.settings ? { ...p.settings, username: p.name } : null;
  }
  private async save() {
    if (!this.draft || this.saving) return;
    const request = this.request;
    this.saving = true;
    this.error = "";
    this.message = "";
    this.hooks.paint();
    try {
      const { username, icon, color, bio, showStats, showLevel, revision } =
        this.draft;
      const next = await this.hooks.api<{
        identity: Identity;
        profile: PlayerProfile;
      }>("/profile/settings", {
        username,
        icon,
        color,
        bio,
        showStats,
        showLevel,
        revision,
      });
      if (
        request !== this.request ||
        this.hooks.identity()?.id !== next.identity.id
      )
        return;
      this.profile = next.profile;
      this.hooks.saveIdentity(next.identity);
      this.resetDraft();
      this.message = "Profile saved.";
    } catch (e) {
      this.error =
        e instanceof Error ? e.message : "Couldn't save your profile.";
    } finally {
      this.saving = false;
      this.hooks.paint();
    }
  }
  private async prestige() {
    if (!this.profile?.settings || this.saving) return;
    const request = this.request;
    this.saving = true;
    this.error = "";
    this.hooks.paint();
    try {
      const next = await this.hooks.api<PlayerProfile>("/profile/prestige", {
        revision: this.profile.settings.revision,
      });
      if (request !== this.request || this.hooks.identity()?.id !== next.id)
        return;
      this.profile = next;
      this.resetDraft();
      this.confirmingPrestige = false;
      this.message = "Prestige increased. Your new level is 1.";
    } catch (e) {
      this.error =
        e instanceof Error ? e.message : "Couldn't update your rank.";
    } finally {
      this.saving = false;
      this.hooks.paint();
    }
  }
  private async share() {
    try {
      const url = `${location.origin}/player/${encodeURIComponent(this.profile!.id)}`;
      if (navigator.share)
        await navigator.share({
          title: `${this.profile!.name} · Sol of War`,
          url,
        });
      else {
        await navigator.clipboard.writeText(url);
        this.message = "Profile link copied.";
      }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError"))
        this.error =
          "Couldn't share the link. Copy the profile address from your browser.";
    }
    this.hooks.paint();
  }
  render() {
    const p = this.profile;
    return html`<main class="sp-page sc-account">
      <div class="sp-page-heading">
        <button class="fp-text-button" @click=${this.hooks.back}>
          Back to play</button
        ><span class="fp-eyebrow">PLAYER PROFILE</span>
      </div>
      ${this.error ? html`<div class="fp-message fp-error" role="alert">${this.error} <button class="fp-text-button" ?disabled=${this.saving} @click=${() => this.load(this.target, this.tab)}>Reload profile</button></div>` : ""}
      ${this.message ? html`<div class="fp-message" role="status">${this.message}</div>` : ""}
      ${
        this.loading
          ? html`<section class="sp-empty" role="status">
              Loading profile…
            </section>`
          : !p
            ? html`<section class="sp-empty">
                <h1>
                  ${this.target === "me" ? "Your profile" : "Player profile"}
                </h1>
                <p>
                  ${this.target === "me" && !this.hooks.identity()?.name ? "Sign in and choose a username to view your profile." : "This profile is unavailable."}
                </p>
                ${this.target === "me" && !this.hooks.identity()?.name ? html`<button class="fp-primary" @click=${this.hooks.signIn}>Sign in with wallet</button>` : ""}
              </section>`
            : html`
                <header class="sp-header">
                  <div class="sp-person">
                    ${playerIcon(p.icon, p.color, true)}
                    <div>
                      <h1>${p.name}</h1>
                      <p>
                        Joined
                        ${date(p.joined)}${p.own ? " · Your profile" : ""}
                      </p>
                      ${p.bio ? html`<p class="sp-bio">${p.bio}</p>` : ""}
                    </div>
                  </div>
                  <button class="sp-secondary" @click=${() => this.share()}>
                    Share profile
                  </button>
                </header>
                <h2>Stats</h2>
                ${this.stats()}
              `
      }
    </main>`;
  }
  private stats() {
    const p = this.profile!,
      s = p.stats;
    return html`${
      s
        ? html`
            <section class="sp-stats" aria-label="Player statistics">
              ${[
                [s.games, "Matches"],
                [s.wins, "Wins"],
                [`${s.winRate}%`, "Win rate"],
                [s.streak, "Win streak"],
              ].map(
                ([value, label]) =>
                  html`<div>
                    <strong>${value}</strong><span>${label}</span>
                  </div>`,
              )}
            </section>
            <section class="sp-panel">
              <div class="sp-section-heading">
                <h2>Results by mode</h2>
                <span>Best streak: ${s.bestStreak}</span>
              </div>
              <div class="sp-mode-stats">
                ${s.modes.map(
                  (m) =>
                    html`<div>
                      <h3>${m.mode === "ffa" ? "Free-for-all" : m.mode}</h3>
                      <strong>${m.wins}<small> wins</small></strong>
                      <p>${m.games} matches · ${m.games - m.wins} losses</p>
                    </div>`,
                )}
              </div>
              ${!s.games ? html`<p class="sp-muted">Your first verified multiplayer result will appear here.</p>` : ""}
            </section>
            ${
              p.finances
                ? html`<section class="sp-panel">
                    <div class="sp-section-heading">
                      <h2>Your match totals</h2>
                      <span
                        >Only visible to
                        you${p.finances.network === "mainnet" ? "" : p.finances.network === "devnet" ? " · Devnet test SOL" : " · Simulated SOL"}</span
                      >
                    </div>
                    <div class="sp-finances">
                      ${[
                        [p.finances.wageredLamports, "Wagered"],
                        [p.finances.paidLamports, "Prizes paid"],
                        [p.finances.pendingLamports, "Prizes pending"],
                      ].map(
                        ([n, label]) =>
                          html`<div>
                            <span>${label}</span
                            ><strong
                              ><svg
                                class="sp-finance-sol"
                                viewBox="0 0 24 24"
                                aria-hidden="true"
                              >
                                <path
                                  fill="currentColor"
                                  d="m6 3-4 4h16l4-4H6Zm-4 7 4 4h16l-4-4H2Zm4 7-4 4h16l4-4H6Z"
                                /></svg
                              >${sol(n)} <small>SOL</small></strong
                            >
                          </div>`,
                      )}
                    </div>
                    <p class="sp-muted">
                      Paid prizes count finalized settlements. Pending prizes
                      are awaiting payment.
                    </p>
                  </section>`
                : ""
            }
            <p class="sp-muted sp-explainer">
              Statistics count verified multiplayer matches. Practice, tutorials
              and cancelled matches do not award wins or XP.
            </p>
          `
        : html`<section class="sp-empty">
            This player keeps their statistics and match history private.
          </section>`
    }`;
  }
  private rankedProgress(showGuide = true) {
    const ratings = this.profile?.rankedRatings;
    if (!ratings)
      return html`<section class="sp-panel">
        <h2>Ranked</h2>
        <p class="sp-muted">This player keeps their ranked ratings private.</p>
      </section>`;
    return rankedCards(ratings, showGuide);
  }

  private progression() {
    const p = this.profile!;
    if (!p.progress) return "";
    return html` <section class="sp-panel">
        <h2>Level track · ${p.progress.prestige ? `Prestige ${p.progress.prestige}` : "First run"}</h2>
        <p>Level ${p.progress.level} of 100 · ${p.progress.lifetimeXp.toLocaleString()} lifetime XP</p>
        <progress class="sp-level-track-progress" max="100" value=${p.progress.level} aria-label="Progress to level 100"></progress>
        <div class="sp-level-track" tabindex="0" aria-label="Level progression track">
          ${Array.from({length: 100}, (_, i) => i + 1).map(level => html`<div class=${level === p.progress!.level ? "current" : level < p.progress!.level ? "earned" : ""} aria-current=${level === p.progress!.level ? "step" : "false"}>
            <level-badge .level=${level} .prestige=${p.progress!.prestige} .size=${44}></level-badge>
            <strong>${level}</strong><small>${level === p.progress!.level ? "You" : level < p.progress!.level ? "Reached" : `${(100 * (level - 1) ** 2).toLocaleString()} XP`}</small>
          </div>`)}
        </div>
        <p class="sp-muted">XP thresholds are for this prestige run. Reach level 100 to unlock prestige; lifetime XP stays with you.</p>
        <h2>Unranked level milestones</h2>
        ${p.own && p.legacyProgress && p.legacyProgress.lifetimeXp > p.progress.lifetimeXp ? html`<p class="sp-muted">Combined lifetime record: ${p.legacyProgress.lifetimeXp.toLocaleString()} lifetime XP. Your unranked level and ranked ratings progress separately.</p>` : ""}
        <div class="sp-milestones">
          ${[1, 10, 25, 50, 75, 100].map((level) => html`<div class=${p.progress!.level >= level ? "earned" : ""}><level-badge .level=${level} .prestige=${p.progress!.prestige} .size=${64}></level-badge><span>Level ${level}</span>${p.progress!.level >= level ? html`<small>Reached</small>` : html`<small>Locked</small>`}</div>`)}
        </div>
      </section>
      <section class="sp-panel">
        <h2>Earning XP</h2>
        <div class="sp-xp-rules">
          <div>
            <strong>100 XP</strong
            ><span>Complete a verified unranked multiplayer match</span>
          </div>
          <div><strong>+150 XP</strong><span>Win the match</span></div>
        </div>
        <p>
          Both winning teammates receive the win bonus in 2v2. Ranked matches
          affect your skill rating instead of XP.
        </p>
        <p class="sp-muted">
          These are Sol of War's progression rules. Level 100 unlocks prestige:
          restart at level 1 with a new rank, up to prestige 10. Reach level 100
          at prestige 10 to become a Legend. Lifetime XP is always preserved.
        </p>
      </section>`;
  }
  private games() {
    const p = this.profile!;
    if (!p.stats)
      return html`<section class="sp-empty">
        This player keeps their match history private.
      </section>`;
    return html`<section class="sp-panel">
      <div class="sp-section-heading">
        <h2>Recent games</h2>
        <span>Latest ${p.games.length} matches</span>
      </div>
      ${
        p.games.length
          ? html`<div class="sp-games">
              ${p.games.map(
                (g) =>
                  html`<article class="sp-game">
                    <img
                      src=${this.hooks.mapImage(g.map)}
                      alt=""
                      loading="lazy"
                    />
                    <div class="sp-game-info">
                      <h3>${this.hooks.mapName(g.map)}</h3>
                      <p>
                        ${g.mode === "ffa" ? "Free-for-all" : g.mode} ·
                        ${date(g.at)}
                      </p>
                      <small
                        >${g.practice ? "Practice" : g.ranked ? "Ranked" : (g.entryLamports ?? 0) > 0 ? "FFA Wager" : "Unranked"}${p.own && (g.entryLamports ?? 0) > 0 ? ` · ${sol(g.entryLamports ?? 0)} SOL entry` : ""}</small
                      >
                    </div>
                    <div class="sp-result">
                      <strong class=${g.result === "Won" ? "sp-win" : ""}
                        >${g.result}</strong
                      ><span
                        >${g.ratingChange ? `${g.ratingChange.delta >= 0 ? "+" : ""}${g.ratingChange.delta} rating · Place ${g.ratingChange.place}` : g.xp ? `+${g.xp} Unranked XP` : "No XP"}</span
                      >${p.own && (g.payoutLamports ?? 0) > 0 ? html`<small>${sol(g.payoutLamports!)} SOL paid</small>` : ""}
                    </div>
                    ${
                      g.replayAvailable && g.id
                        ? html`<button
                            class="sp-secondary"
                            @click=${async () => {
                              try {
                                await this.hooks.replay(
                                  g.id!,
                                  this.hooks.mapName(g.map),
                                );
                              } catch (e) {
                                this.error =
                                  e instanceof Error
                                    ? e.message
                                    : "Replay unavailable.";
                                this.hooks.paint();
                              }
                            }}
                          >
                            Replay
                          </button>`
                        : ""
                    }
                  </article>`,
              )}
            </div>`
          : html`<div class="sp-empty">
              <h3>No matches yet</h3>
              <p>Completed multiplayer games will appear here.</p>
            </div>`
      }
    </section>`;
  }
  private editor() {
    const d = this.draft;
    if (!d) return "";
    return html`<form
      class="sp-panel sp-editor"
      @submit=${(e: Event) => {
        e.preventDefault();
        void this.save();
      }}
    >
      <fieldset ?disabled=${this.saving}>
        <legend>Player details</legend>
        <div class="sp-editor-preview">
          ${playerIcon(d.icon, d.color, true)}
          <div>
            <strong>${d.username || "Your name"}</strong
            ><span>Shown on your profile and in lobbies</span>
          </div>
        </div>
        <label for="sp-name">Username</label
        ><input
          id="sp-name"
          autocomplete="nickname"
          required
          minlength="3"
          maxlength="20"
          pattern="[A-Za-z0-9_]{3,20}"
          .value=${d.username}
          @input=${(e: Event) => {
            d.username = (e.target as HTMLInputElement).value;
            this.hooks.paint();
          }}
          aria-describedby="sp-name-hint"
        /><small id="sp-name-hint"
          >3–20 letters, numbers or underscores. Usernames are unique.</small
        >
        <label for="sp-bio">Bio <span>Optional</span></label
        ><textarea
          id="sp-bio"
          rows="3"
          maxlength="160"
          .value=${d.bio}
          @input=${(e: Event) => {
            d.bio = (e.target as HTMLTextAreaElement).value;
            this.hooks.paint();
          }}
        ></textarea
        ><small>${d.bio.length}/160 characters</small>
        <div class="sp-label">Player icon</div>
        <div class="sp-icon-options" role="group" aria-label="Player icon">
          ${PROFILE_ICONS.map(
            (icon) =>
              html`<button
                type="button"
                aria-label=${icon}
                aria-pressed=${d.icon === icon}
                class=${d.icon === icon ? "selected" : ""}
                @click=${() => {
                  d.icon = icon;
                  this.hooks.paint();
                }}
              >
                ${playerIcon(icon, d.color)}<span>${icon}</span>
              </button>`,
          )}
        </div>
        <div class="sp-label">Icon colour</div>
        <div class="sp-colors" role="group" aria-label="Icon colour">
          ${PROFILE_COLORS.map(
            (color) =>
              html`<button
                type="button"
                class="sp-${color} ${d.color === color ? "selected" : ""}"
                aria-pressed=${d.color === color}
                aria-label=${color}
                @click=${() => {
                  d.color = color;
                  this.hooks.paint();
                }}
              >
                <span></span>
              </button>`,
          )}
        </div>
        <div class="sp-privacy">
          <h2>Public profile</h2>
          <label
            ><input
              type="checkbox"
              .checked=${d.showStats}
              @change=${(e: Event) => {
                d.showStats = (e.target as HTMLInputElement).checked;
              }}
            />Show statistics and match history</label
          ><label
            ><input
              type="checkbox"
              .checked=${d.showLevel}
              @change=${(e: Event) => {
                d.showLevel = (e.target as HTMLInputElement).checked;
              }}
            />Show level and progression</label
          >
          <p class="sp-muted">
            Your wallet address and payment totals are never shown on your
            public profile.
          </p>
        </div>
        <div class="sp-actions">
          <button type="submit" class="fp-primary">
            ${this.saving ? "Saving…" : "Save changes"}</button
          ><button
            type="button"
            class="sp-secondary"
            @click=${() => {
              this.resetDraft();
              this.hooks.paint();
            }}
          >
            Reset changes
          </button>
        </div>
      </fieldset>
    </form>`;
  }
}
