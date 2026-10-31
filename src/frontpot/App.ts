import { maps } from "@openfront/engine-api/game/GameTypes";
import { EventBus } from "@openfront/shared/EventBus";
import { toWireGameStartInfo } from "@openfront/shared/SharedUtil";
import { GameRecordSchema } from "@openfront/shared/WireSchemas";
import { html, render, svg } from "lit";
import { fetchCosmetics } from "../client/Cosmetics";
import { loadGameClient, prefetchGameClient } from "../client/GameClientLoader";
import type { GameStartingModal } from "../client/GameStartingModal";
import { loadModal } from "../client/LazyModals";
import { UserSettings } from "../client/UserSettings";
import { translateText } from "../client/Utils";
import { adminView, clearAdmin, refreshAdmin } from "./AdminView";
import "./GameSetup";
import { parseSolAmount } from "./Amounts";
import "../client/components/LevelBadge";
import "./PrizePot";
import { requestApi } from "./ApiResponse";
import brandSymbol from "./assets/sol-of-war-symbol.png";
import brandWordmark from "./assets/sol-of-war-wordmark.png";
import { CountdownClock } from "./CountdownClock";
import { gameRulesContent } from "./GameRulesView";
import type { Pool } from "./MatchLedger";
import type { PaymentStatus } from "./payments/DevnetPayments";
import { assertNativeTransfer } from "./payments/NativeTransferPolicy";
import "../client/LangSelector";
import "../client/GameStartingModal";
import "../client/styles.css";
import "./style.css";
import { currencyLabel, type PaymentMode } from "./payments/Network";
import {
  paymentView,
  paymentLabel,
  transactionLink,
} from "./payments/PaymentView";
import { PlayerWalletView } from "./PlayerWalletView";
import type { WalletLogin, WalletCredentials } from "./PrivyLogin";
import type { ProfileIcon, ProfileColor } from "./ProfileTypes";
import { ProfileView, playerIcon, rankedCards } from "./ProfileView";
import { QueueClock } from "./QueueClock";
import { rankBadge, rankLabel } from "./RankBadge";
import { rankedResultView } from "./RankedResultPanel";
import { RANK_TIERS, rankRange, rankTier, type VisibleRank } from "./RankTiers";
import { defaultRules, type Rules } from "./Rules";
import type { SharedMatchmaking as Matchmaking } from "./SharedMatchmaking";
import { ShopView } from "./shop/ShopView";
import type { Identity, Mode, Room } from "./Store";
import { tutorialLobby } from "./TutorialGame";
import { UserWalletView } from "./UserWalletView";
import { setMatchTerms } from "./WinResult";

type PublicRoom = Omit<Room, "members"> & {
  min: number;
  max: number;
  serverNow: number;
  readyCount: number;
  prizeLamports: number;
  members: {
    id: string;
    name: string;
    team: number;
    wallet?: string;
    ready: boolean;
    levelBadge?: { level: number; prestige: number; legend: boolean };
    rank?: VisibleRank;
    icon?: ProfileIcon;
    color?: ProfileColor;
  }[];
};
const root = document.getElementById("frontpot")!;
let mobileExperienceNotice = (() => {
  if (!window.matchMedia("(max-width: 767px)").matches) return false;
  try {
    const key = "solofwar-desktop-tip-shown";
    if (sessionStorage.getItem(key)) return false;
    sessionStorage.setItem(key, "1");
  } catch {
    /* Still show once in this page if session storage is unavailable. */
  }
  return true;
})();
const t = (key: string, params: Record<string, string | number> = {}) =>
  translateText(`frontpot.${key}`, params);
let identity: Identity | null = null;
const previewRequested =
  ["localhost", "127.0.0.1"].includes(location.hostname) &&
  (new URLSearchParams(location.search).get("preview") === "user" ||
    sessionStorage.getItem("sow-user-preview") === "1");
const userPreview = () =>
  previewRequested && authConfig?.paymentsMode === "simulation";

let mode: Mode = "1v1";
let ranked = sessionStorage.getItem("solsiege-match-type") !== "unranked";
const roomWager = (r: Pick<Room, "practice" | "lamports">) =>
  !r.practice && r.lamports > 0;
const roomRanked = (r: Pick<Room, "practice" | "ranked" | "mode">) =>
  !r.practice && r.mode !== "ffa" && r.ranked !== false;
let category: "ranked" | "ffa" | "free" = ranked ? "ranked" : "free";
const categoryLabel = () =>
  category === "ffa"
    ? "FFA Wagers"
    : category === "ranked"
      ? "Ranked"
      : "Free Play";
const inCategory = (
  r: Pick<Room, "practice" | "lamports" | "mode" | "ranked">,
) =>
  category === "free"
    ? !roomWager(r)
    : category === "ffa"
      ? roomWager(r) && r.mode === "ffa"
      : roomRanked(r);
const matchLabel = (
  r: Pick<Room, "practice" | "lamports" | "mode" | "ranked">,
) =>
  r.practice
    ? "Practice"
    : roomRanked(r)
      ? "Ranked"
      : roomWager(r)
        ? "FFA Wager"
        : "Free Play";
const entryLabel = (r: PublicRoom) =>
  roomWager(r) ? `${r.stake} SOL` : "Free";
function matchTypeTabs() {
  return html`<div
    class="fp-match-types"
    role="group"
    aria-label="Game category"
  >
    ${(["ranked", "ffa", "free"] as const).map(
      (value) =>
        html`<button
          type="button"
          aria-pressed=${category === value}
          class=${category === value ? "selected" : ""}
          @click=${() => {
            category = value;
            ranked = value !== "free";
            if (value === "ffa") mode = "ffa";
            else if (value === "ranked" && mode === "ffa") mode = "1v1";
            queueFilter = "all";
            entryFilter = "all";
            paint();
          }}
        >
          <strong
            >${value === "ranked" ? "Ranked" : value === "ffa" ? "FFA Wagers" : "Free Play"}</strong
          ><span
            >${value === "ranked" ? "1v1 and 2v2 · Elo" : value === "ffa" ? "SOL prizes · No Elo" : "All modes · XP"}</span
          >
        </button>`,
    )}
  </div>`;
}

let stake = "0.25";
let name = "";
let authOpen = false;
let authRestoring = true;
let afterSignIn: (() => void | Promise<void>) | null = null;
let authConfig: {
  playerWalletsEnabled?: boolean;
  userOwnedWalletsEnabled?: boolean;
  release?: { available: boolean; sourceCommit?: string | null };
  paymentsMode: PaymentMode;
  minimumEntryLamports: number;
  privyAppID: string | null;
  privyClientID: string | null;
} | null = null;
let walletLogin: Promise<WalletLogin> | null = null;
const isDevnet = () => authConfig?.paymentsMode === "devnet";
const isMainnet = () => authConfig?.paymentsMode === "mainnet";
const isFunded = () => isDevnet() || isMainnet();
const moneyLabel = () =>
  currencyLabel(authConfig?.paymentsMode ?? "simulation");
const modeBadge = () => (isMainnet() ? "SOL" : isDevnet() ? "DEVNET" : "DEMO");
const paymentNotice = () =>
  isMainnet()
    ? "Ranked entries and prizes use real SOL."
    : isDevnet()
      ? "Devnet testing. Test SOL has no monetary value."
      : "Demo only. No real SOL transfers.";
let funding: PaymentStatus | null = null;
let paymentHistory: PaymentStatus[] = [];
async function fundEntry() {
  const target = room,
    player = identity;
  if (!target || !roomWager(target) || !player?.wallet) return;
  // Finish provider initialization and ownership reads before creating the
  // short-lived entry transaction. A loading wallet must not consume its TTL.
  if (authConfig?.userOwnedWalletsEnabled) {
    await userWalletView.refresh();
    const owned = userWalletView.data?.wallet;
    if (!owned) throw new Error("Create your personal wallet before entering.");
    (await getWalletLogin()).assertSigningReady(owned.address);
    if (identity?.id !== player.id || room?.id !== target.id)
      throw new Error("Your account or match changed. No entry was prepared.");
  }
  const prepared = await api<
    PaymentStatus & {
      entryID: string;
      transaction?: string;
      approval?: import("./payments/SpendApproval").SpendApproval;
    }
  >(`/rooms/${target.id}/deposit`, {});
  funding = prepared;
  paint();
  if (prepared.approval) {
    const a = prepared.approval;
    if (
      a.kind !== "wager" ||
      a.playerID !== player.id ||
      a.wallet !== player.wallet ||
      a.matchID !== target.id ||
      a.network !== prepared.network ||
      a.lamports !== target.lamports ||
      a.destination !== prepared.poolAddress ||
      a.requestID !== `deposit:${prepared.entryID}`
    )
      throw new Error(
        "Payment approval does not match this match. No entry was submitted.",
      );
    const approval = await (
      await getWalletLogin()
    ).approvePayment(player.wallet, a);
    if (identity?.id !== player.id || room?.id !== target.id)
      throw new Error("Your account or match changed. No entry was submitted.");
    funding = await api<PaymentStatus>(`/rooms/${target.id}/deposit`, {
      approval,
    });
    paint();
    return;
  }
  if (!prepared.transaction) return;
  let signingAddress = player.wallet;
  if (prepared.fundingSource === "user-wallet") {
    const owned = userWalletView.data?.wallet;
    if (
      !owned ||
      prepared.fundingAddress !== owned.address ||
      !prepared.poolAddress ||
      prepared.lamports !== target.lamports
    )
      throw new Error("Entry does not match your user-owned wallet.");
    signingAddress = owned.address;
    assertNativeTransfer(prepared.transaction, {
      source: signingAddress,
      payer: prepared.feePayer ?? signingAddress,
      transfers: [{ to: prepared.poolAddress, lamports: target.lamports }],
    });
  }
  if (identity?.id !== player.id || room?.id !== target.id)
    throw new Error("Your account or match changed.");
  const signed = await (
    await getWalletLogin()
  ).signDeposit(
    signingAddress,
    prepared.transaction,
    prepared.network,
    !!prepared.feePayer,
  );
  if (identity?.id !== player.id || room?.id !== target.id)
    throw new Error("Your account or match changed. No entry was submitted.");
  const result = await api<PaymentStatus>(`/payments/${target.id}/submit`, {
    entryID: prepared.entryID,
    transaction: signed,
  });
  if (room?.id === target.id) funding = result;
  paint();
}
let privateRoom = false;
let custom = false;
let setupOpen = false;
let practiceSetup = false;
let rules: Rules = defaultRules();
let showProfile =
  location.pathname === "/profile" ||
  /^\/player\/[^/]+$/.test(location.pathname);
let accountMenuOpen = false;
let showWallet = location.pathname === "/wallet";
let balanceCheckedAt = 0;
let balanceRefreshing = false;
let showingLegacyWallet = false;
const legacyWalletView = new PlayerWalletView({
  api,
  act,
  paint,
  identity: () => identity,
  busy: () => busy,
  back: () => {
    if (showingLegacyWallet) {
      showingLegacyWallet = false;
      paint();
    } else goPlay();
  },
  legacyOnly: () => !!authConfig?.userOwnedWalletsEnabled,
  signIn: () => {
    void act(openPlayerWallet);
  },
  enabled: () => !!authConfig?.playerWalletsEnabled,
  approvePayment: async (approval) =>
    (await getWalletLogin()).approvePayment(identity?.wallet ?? "", approval),
});
const userWalletView = new UserWalletView({
  api,
  act,
  paint,
  identity: () => identity,
  busy: () => busy,
  back: goPlay,
  signIn: () => void act(openPlayerWallet),
  walletLogin: getWalletLogin,
  openLegacy: async () => {
    await legacyWalletView.refresh();
    showingLegacyWallet = true;
    paint();
  },
});
const playerWalletView = {
  get data() {
    return authConfig?.userOwnedWalletsEnabled
      ? userWalletView.data
        ? { availableLamports: userWalletView.data.balanceLamports }
        : null
      : legacyWalletView.data;
  },
  clear() {
    showingLegacyWallet = false;
    legacyWalletView.clear();
    userWalletView.clear();
  },
  refresh() {
    return authConfig?.userOwnedWalletsEnabled && !showingLegacyWallet
      ? userWalletView.refresh()
      : legacyWalletView.refresh();
  },
  render() {
    return authConfig?.userOwnedWalletsEnabled && !showingLegacyWallet
      ? userWalletView.render()
      : legacyWalletView.render();
  },
};
async function openPlayerWallet() {
  if (inGame) return;
  viewingRoom = false;
  if (!requireIdentity(openPlayerWallet)) return;
  hideProfile();
  showWallet = true;
  showHistory =
    showLobbies =
    showHowToPlay =
    showTerms =
    showAdmin =
    setupOpen =
      false;
  previewRoom = null;
  history.replaceState(null, "", "/wallet");
  paint();
  await playerWalletView.refresh();
  paint();
}

const initialProfile = location.pathname.startsWith("/player/")
  ? decodeURIComponent(location.pathname.slice(8))
  : "me";
const profiles = new ProfileView({
  api,
  paint,
  identity: () => identity,
  saveIdentity,
  signIn: () => {
    requireIdentity(() => openProfile());
  },
  back: goPlay,
  replay: async (id, name) => {
    await replayMatch({ matchID: id, name });
  },
  mapImage: (value) => mapImage(value),
  mapName: (value) => mapName(value),
});
async function openProfile(target = "me", edit = false) {
  if (inGame) return;
  viewingRoom = false;
  accountMenuOpen = false;
  showWallet = false;
  showProfile = true;
  showHistory =
    showLobbies =
    showHowToPlay =
    showTerms =
    showAdmin =
    setupOpen =
      false;
  previewRoom = null;
  history.replaceState(
    null,
    "",
    target === "me" ? "/profile" : `/player/${encodeURIComponent(target)}`,
  );
  window.scrollTo({ top: 0 });
  await profiles.load(target, edit ? "edit" : "overview");
}
function hideProfile() {
  showMatchmaking = false;
  showWallet = false;
  showProfile = false;
  accountMenuOpen = false;
}
let showHistory = false;
let showLobbies = location.pathname === "/lobbies";
let liveOnly = new URLSearchParams(location.search).get("view") === "live";
let showTerms = location.pathname === "/terms";
const shopView = new ShopView({
  api,
  identity: () => identity,
  walletLogin: getWalletLogin,
  busy: () => busy,
  act,
  paint,
  signIn: () =>
    requireIdentity(async () => {
      await shopView.refresh();
    }),
});
let showHowToPlay = location.pathname === "/how-to-play";
let showAdmin = location.pathname === "/admin";
let queueFilter: Mode | "all" = "all";
let entryFilter = "all";
let serverOffset = 0;
let inviteCode = "";
let roomsLoaded = false;
let roomsError = false;
let availability = { entriesPaused: false, draining: false };
let availabilityCheckedAt = 0;
let matchHistory: Pool[] = [];
const mapInfo = (value: string) => maps.find((m) => m.type === value);
const mapName = (value: string) => {
  const m = mapInfo(value);
  return m ? translateText(m.translationKey) : value;
};
const mapImage = (value: string) =>
  `/maps/${mapInfo(value)?.id.toLowerCase() ?? "europe"}/thumbnail.webp`;
function openSetup(practice = false) {
  hideProfile();
  if (!practice && !requireIdentity(() => openSetup(practice))) return;
  if (!practice) {
    if (category === "ffa") mode = "ffa";
    else if (category === "ranked" && mode === "ffa") mode = "1v1";
    custom = true;
    privateRoom = true;
    rules = defaultRules(mode, false);
    void act(() => quickPlay(false));
    return;
  }
  previewRoom = null;
  showHowToPlay = showTerms = false;
  showAdmin = false;
  history.replaceState(null, "", "/");
  practiceSetup = practice;
  custom = !practice;
  setupOpen = true;
  showHistory = false;
  showLobbies = false;
  rules = defaultRules(mode, practice);
  paint();
  window.scrollTo({ top: 0 });
}
async function openHistory() {
  hideProfile();
  if (!(await ensureIdentity(openHistory))) return;
  previewRoom = null;
  showHowToPlay = showTerms = false;
  showAdmin = false;
  history.replaceState(null, "", "/");
  matchHistory = await api<Pool[]>("/history");
  if (isFunded()) paymentHistory = await api<PaymentStatus[]>("/payments");
  showHistory = true;
  showLobbies = false;
  setupOpen = false;
  paint();
  window.scrollTo({ top: 0 });
}
async function openSettings() {
  await loadModal("user-setting");
  if (inGame) return;
  (
    document.getElementById("menu-settings") as HTMLElement & {
      open: () => void;
    }
  ).open();
}

let tutorialActive = false;
let busy = false;
let error = "";
let notice = "";
let rooms: PublicRoom[] = [];
let showMatchmaking = location.pathname === "/matchmaking";
let matchSearch: ReturnType<Matchmaking["status"]> = null;
let searchMode: Mode = "1v1";
let searchRanked = true;
let searchWagerFFA = false;
let searchBudget = "0.01";
let searchPolling = false;
let searchReceivedAt = Date.now();
const queueClock = new QueueClock();
let party: {
  code: string;
  leaderID: string;
  members: { id: string; name: string }[];
  readyIDs: string[];
  revision: number;
  settings: { ranked: boolean; budget: string };
} | null = null;
let partyCode =
  new URLSearchParams(location.search).get("party")?.slice(0, 24) ?? "";
if (partyCode) searchMode = "2v2";
let partyCheckedAt = 0;
let activeRoomCheckedAt = 0;
async function createParty() {
  if (!(await ensureIdentity(createParty))) return;
  party = await api("/party", {});
  searchMode = "2v2";
  await savePartySettings();
  paint();
}
const partyInviteLink = () =>
  `${location.origin}/matchmaking?party=${encodeURIComponent(party!.code)}`;
async function copyPartyInvite() {
  await navigator.clipboard.writeText(partyInviteLink());
  notice = "Invite link copied. Send it to your friend to join your 2v2 party.";
}
async function sharePartyInvite() {
  if (!navigator.share) return copyPartyInvite();
  try {
    await navigator.share({
      title: "Join my Sol of War 2v2 party",
      text: "Join my party and ready up for 2v2.",
      url: partyInviteLink(),
    });
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError"))
      throw error;
  }
}
async function joinParty() {
  if (!(await ensureIdentity(joinParty))) return;
  party = await api("/party/join", { code: partyCode.trim() });
  searchMode = "2v2";
  partyCode = "";
  paint();
}
async function leaveParty() {
  await api("/party/leave", {});
  party = null;
  matchSearch = null;
  paint();
}

async function savePartySettings() {
  if (!party) return;
  party = await api("/party/settings", {
    settings: { ranked: searchRanked, budget: searchBudget },
    revision: party.revision,
  });
  paint();
}
async function readyParty() {
  if (!party) return;
  const result = await api<{ party: typeof party; search: typeof matchSearch }>(
    "/party/ready",
    { revision: party.revision, ready: !party.readyIDs.includes(identity!.id) },
  );
  party = result.party;
  matchSearch = result.search;
  searchReceivedAt = Date.now();
  paint();
}
async function startSearch() {
  if (searchMode === "ffa" && !party) {
    category = searchWagerFFA ? "ffa" : "free";
    ranked = searchWagerFFA;
    queueFilter = "ffa";
    entryFilter = searchWagerFFA ? searchBudget : "all";
    showMatchmaking = false;
    browseLobbies();
    return;
  }
  if (!(await ensureIdentity(startSearch))) return;
  if (party) {
    await readyParty();
    return;
  }
  matchSearch = await api("/matchmaking", {
    mode: searchMode,
    ranked: searchRanked,
    budget: searchBudget,
  });
  searchReceivedAt = Date.now();
  paint();
}
async function cancelSearch() {
  if (identity) await api("/matchmaking/cancel", {});
  matchSearch = null;
  paint();
}
async function acceptSearch() {
  if (!matchSearch?.offer) return;
  const joined = await api<PublicRoom | { waitingForParty: true }>(
    "/matchmaking/accept",
    {
      ticketID: matchSearch.id,
      offerID: matchSearch.offer.id,
    },
  );
  if ("waitingForParty" in joined) {
    matchSearch = await api("/matchmaking");
    searchReceivedAt = Date.now();
    paint();
    return;
  }
  matchSearch = null;
  showMatchmaking = false;
  await enter(joined);
}
function openMatchmaking() {
  if (inGame) return;
  hideProfile();
  viewingRoom = false;
  previewRoom = null;
  showHowToPlay =
    showTerms =
    showAdmin =
    showHistory =
    showLobbies =
    setupOpen =
      false;
  showMatchmaking = true;
  history.replaceState(null, "", "/matchmaking");
  paint();
  window.scrollTo({ top: 0 });
}
function matchmakingPanel() {
  const elapsed = queueClock.seconds(matchSearch);
  const offer = matchSearch?.offer;
  return html`<section
    class="fp-help sow-matchmaking"
    id="sow-matchmaking-panel"
  >
    <h2>Find a match</h2>
    <p>
      Choose your mode and entry. For Ranked, we look for nearby skill ratings,
      then widen the range up to 300 Elo while you wait. Full 2v2 parties use
      their stronger player's Elo. Browse lobbies anytime.
    </p>
    ${
      !matchSearch && searchMode === "2v2"
        ? html`<details class="sow-party-panel" ?open=${!!party || !!partyCode}>
            <summary>Play 2v2 with a friend</summary>
            ${
              party
                ? html`<h3>2v2 party · ${party.members.length}/2</h3>
                    <p>
                      ${party.members.map((m) => `${m.name} · ${party!.readyIDs.includes(m.id) ? "Ready" : "Not ready"}`).join(" / ")}
                    </p>
                    <p>
                      Send your friend this link. They can sign in and join your
                      party, then you both ready up.
                    </p>
                    <label
                      >Party invite link<input
                        readonly
                        .value=${partyInviteLink()}
                        @click=${(e: Event) => (e.target as HTMLInputElement).select()}
                    /></label>
                    <div class="sow-matchmaking-actions">
                      <button
                        class="fp-primary"
                        @click=${() => act(sharePartyInvite)}
                      >
                        Send invite
                      </button>
                      <button
                        class="fp-text-button"
                        @click=${() => act(copyPartyInvite)}
                      >
                        Copy invite link
                      </button>
                    </div>
                    <p>Invite code: <code>${party.code}</code></p>
                    <button
                      class="fp-text-button"
                      @click=${() =>
                        act(async () => {
                          await navigator.clipboard.writeText(party!.code);
                          notice = "Party code copied.";
                        })}
                    >
                      Copy party code
                    </button>
                    <button
                      class="fp-text-button"
                      @click=${() => act(leaveParty)}
                    >
                      Leave party
                    </button>
                    <p>
                      Any rank can team up. Opponents are matched to your
                      stronger player's Elo. Both players ready up to search,
                      then all four players accept the match. Each player
                      confirms their own entry.
                    </p>
                    <p>
                      Both players must ready up to start searching. Changing
                      settings clears readiness.
                    </p> `
                : html`<button
                      class="fp-primary"
                      @click=${() => act(createParty)}
                    >
                      Invite a friend
                    </button>
                    <p>
                      Create your party and send an invite link, or join with a
                      code below.
                    </p>
                    <label
                      >Party invite code<input
                        .value=${partyCode}
                        @input=${(e: Event) => {
                          partyCode = (e.target as HTMLInputElement).value;
                        }}
                        autocomplete="off"
                        maxlength="24"
                    /></label>
                    <button
                      class="fp-text-button"
                      @click=${() => act(joinParty)}
                    >
                      Join party
                    </button>`
            }
          </details>`
        : null
    }
    ${
      !matchSearch
        ? html`<fieldset
            ?disabled=${busy || (!!party && party.leaderID !== identity?.id)}
          >
            <label
              >Match type<select
                .value=${searchWagerFFA ? "unranked" : searchRanked ? "ranked" : "free"}
                @change=${(e: Event) => {
                  const value = (e.target as HTMLSelectElement).value;
                  searchWagerFFA = value === "unranked";
                  searchRanked = value === "ranked";
                  if (searchWagerFFA) searchMode = "ffa";
                  else if (searchRanked && searchMode === "ffa")
                    searchMode = "1v1";
                  if (party) void act(savePartySettings);
                  paint();
                }}
              >
                <option value="ranked">Ranked</option>
                <option value="unranked" ?disabled=${!!party}>Unranked</option>
                <option value="free">Free Play</option>
              </select></label
            >
            <label
              >Mode<select
                ?disabled=${!!party}
                .value=${searchMode}
                @change=${(e: Event) => {
                  searchMode = (e.target as HTMLSelectElement).value as Mode;
                  paint();
                }}
              >
                ${
                  !searchWagerFFA
                    ? html`<option value="1v1">1v1</option>
                        <option value="2v2">2v2</option>`
                    : ""
                }
                ${!searchRanked ? html`<option value="ffa">Free-for-all</option>` : ""}
              </select></label
            >
            ${
              searchRanked || searchWagerFFA
                ? html`<label
                    >Entry<select
                      .value=${searchBudget}
                      @change=${(e: Event) => {
                        searchBudget = (e.target as HTMLSelectElement).value;
                        if (party) void act(savePartySettings);
                        paint();
                      }}
                    >
                      ${["0.01", "0.025", "0.05", "0.1", "0.25", "0.5", "1"].map((v) => html`<option value=${v}>${v} SOL</option>`)}
                    </select></label
                  >`
                : ""
            }
            ${searchWagerFFA ? html`<p class="sp-muted">FFA wagers award XP without changing Elo. Choose your entry to browse matching lobbies.</p>` : ""}
          </fieldset>`
        : ""
    }
    ${
      matchSearch
        ? html`
            ${
              offer
                ? html`<div class="sow-match-offer" aria-live="polite">
                    <h3>Match found</h3>
                    <img
                      class="sow-match-map"
                      src=${mapImage(offer.rules.gameMap)}
                      alt=${`${mapName(offer.rules.gameMap)} map preview`}
                    />
                    <h3>
                      ${mapName(offer.rules.gameMap)} ·
                      ${modeLabel(matchSearch.mode)}
                    </h3>
                    <p>
                      ${matchSearch.acceptedIDs.length}/${offer.maxPlayers}
                      accepted · Accept within
                      ${Math.max(0, Math.ceil((offer.expiresAt - Date.now() - (matchSearch.serverNow - searchReceivedAt)) / 1000))}s.
                      Everyone must accept before the match lobby opens.
                    </p>
                    <dl class="sow-match-facts">
                      <div>
                        <dt>Entry</dt>
                        <dd>
                          ${offer.entryLamports ? html`${solIcon()} ${sol(offer.entryLamports)} SOL` : "Free"}
                        </dd>
                      </div>
                      <div>
                        <dt>
                          ${matchSearch.mode === "ffa" ? "Potential prize pool" : "Prize pool"}
                        </dt>
                        <dd>
                          ${offer.entryLamports ? html`${solIcon()} ${sol(offer.entryLamports * offer.maxPlayers)} SOL` : "No wager"}
                        </dd>
                      </div>
                    </dl>
                    <p>
                      ${matchSearch.ranked ? "Ranked" : "Unranked"} ·
                      ${offer.rules.maxTimerValue} min ·
                      ${offer.rules.gameMapSize} map · ${offer.rules.difficulty}
                      difficulty ·
                      ${offer.rules.randomSpawn ? "Random spawn" : "Choose your spawn"}
                    </p>
                    <p>
                      Starting gold: ${offer.rules.startingGold} · Gold
                      multiplier: ${offer.rules.goldMultiplier}× ·
                      ${offer.rules.disabledUnits.length ? `Disabled units: ${offer.rules.disabledUnits.join(", ")}` : "All units available"}.
                      Donate gold: ${offer.rules.donateGold ? "on" : "off"};
                      donate troops: ${offer.rules.donateTroops ? "on" : "off"}.
                    </p>
                    ${matchSearch.mode === "2v2" ? html`<p>The winning team splits the prize equally. ${matchSearch.partyMembers.length === 2 ? "Your party stays on the same team." : "Teams are assigned automatically."}</p>` : ""}
                    <p>
                      ${offer.rules.bots} Tribes ·
                      ${offer.rules.nations === "disabled" ? 0 : offer.rules.nations === "default" ? (mapInfo(offer.rules.gameMap)?.defaultNationCount ?? 0) : offer.rules.nations}
                      Nations.
                    </p>
                    <p>
                      Modifiers:
                      ${
                        [
                          offer.rules.instantBuild && "Instant build",
                          offer.rules.infiniteGold && "Unlimited gold",
                          offer.rules.infiniteTroops && "Unlimited troops",
                          offer.rules.waterNukes && "Water nukes",
                          (matchSearch.mode !== "ffa" ||
                            offer.rules.disableAlliances) &&
                            "Alliances disabled",
                          offer.rules.doomsdayClock.enabled &&
                            `Doomsday clock (${offer.rules.doomsdayClock.speed})`,
                          offer.rules.overtime.enabled &&
                            `Overtime after ${offer.rules.overtime.startMinutes} min`,
                        ]
                          .filter(Boolean)
                          .join(", ") || "None"
                      }.
                    </p>
                    <button
                      class="fp-primary"
                      ?disabled=${busy || matchSearch.acceptedIDs.includes(identity?.id ?? "")}
                      @click=${() => act(acceptSearch)}
                    >
                      ${matchSearch.acceptedIDs.includes(identity?.id ?? "") ? "Waiting for players" : "Accept match"}
                    </button>
                    <p>
                      ${offer.players.map((p) => `${p.name}${matchSearch!.mode === "2v2" ? ` (Team ${p.team === 0 ? "A" : "B"})` : ""} · ${matchSearch!.acceptedIDs.includes(p.id) ? "Accepted" : "Waiting"}`).join(" / ")}
                    </p>
                    <p>
                      ${matchSearch.ranked ? "Review and confirm your entry in the lobby. Searching never spends SOL." : "Verified unranked matches earn XP."}
                    </p>
                  </div>`
                : html`<div
                    class="sow-searching"
                    role="status"
                    aria-live="polite"
                  >
                    <span class="sow-search-spinner" aria-hidden="true"></span>
                    <h3>Finding your match</h3>
                    <p>
                      ${modeLabel(matchSearch.mode)} ·
                      ${matchSearch.ranked ? `${sol(matchSearch.budgetLamports)} SOL entry` : "Free to play"}
                    </p>
                    <p>${elapsed}s elapsed. Looking for compatible players.</p>
                  </div>`
            }
          `
        : ""
    }
    <div class="sow-matchmaking-actions">
      <button
        class=${matchSearch ? "fp-text-button" : "fp-primary"}
        ?disabled=${busy || (!matchSearch && (!!room || (!!party && party.members.length < 2)))}
        @click=${() => act(matchSearch ? cancelSearch : startSearch)}
      >
        ${matchSearch ? "Decline / cancel search" : party ? (party.readyIDs.includes(identity?.id ?? "") ? "Unready" : "Ready up") : searchMode === "ffa" ? (searchWagerFFA ? "Browse Unranked FFA" : "Browse Free FFA") : searchMode === "2v2" ? "Solo queue" : "Ready and search"}
      </button>
      <button class="fp-text-button" @click=${browseLobbies}>
        Browse lobbies
      </button>
    </div>
  </section>`;
}
let liveGames: PublicRoom[] = [];
let watchingLive = false;
let spectatorLoading = false;
let watchedRoom: PublicRoom | null = null;
let room: PublicRoom | null = null;
let previewRoom: PublicRoom | null = null;
let inGame = false;
let prizeReadyMatch = "";
let replayTitle = "Replay";
let connected = false;
let loadingLobby = false;
let handle: ReturnType<
  Awaited<ReturnType<typeof loadGameClient>>["joinLobby"]
> | null = null;
let generation = 0;
const invite = location.pathname.match(/^\/room\/([a-zA-Z0-9]{8,10})$/)?.[1];
let pendingInvite = invite ?? null;

let apiRetryAt = 0;
let apiActionRetryAt = 0;
let rateLimitMessage = "";
async function api<T>(url: string, body?: unknown): Promise<T> {
  if (userPreview()) {
    if (
      ["/party", "/matchmaking", "/active-room"].includes(url) &&
      body === undefined
    )
      return null as T;
    if (url === "/presence") return {} as T;
    if (url === "/profile" && body === undefined)
      return {
        id: "local-preview",
        name: "JohnTester",
        icon: "shield",
        color: "orange",
        bio: "Local preview player",
        joined: Date.now() - 86400000 * 30,
        own: true,
        progress: {
          level: 12,
          prestige: 0,
          legend: false,
          lifetimeXp: 8200,
          xpInLevel: 320,
          xpForNext: 700,
          canPrestige: false,
        },
        rankedRatings: (["1v1", "2v2"] as const).map((mode, i) => ({
          mode,
          rating: [1268, 1432][i],
          games: [24, 38][i],
          wins: [15, 23][i],
          losses: [9, 15][i],
          provisional: false,
          tier: rankTier([1268, 1432][i]),
        })),
        stats: {
          games: 42,
          wins: 25,
          losses: 17,
          winRate: 60,
          streak: 2,
          bestStreak: 5,
          modes: [{ mode: "ffa", games: 42, wins: 25 }],
        },
        games: [],
        settings: {
          icon: "shield",
          color: "orange",
          bio: "Local preview player",
          showStats: true,
          showLevel: true,
          revision: 0,
          prestige: 0,
          prestigeXp: 0,
        },
        finances: {
          network: "simulation",
          wageredLamports: "0",
          paidLamports: "0",
          pendingLamports: "0",
        },
      } as T;
    if (body !== undefined)
      throw new Error(
        "This is a local visual preview. Joining, queueing, payments and account changes require a real sign-in.",
      );
  }
  const requestedAt = Date.now();
  const requestedMono = performance.now();
  if (requestedAt < (body === undefined ? apiRetryAt : apiActionRetryAt)) {
    rateLimitMessage = `Requests are temporarily limited. Please try again in ${Math.ceil(((body === undefined ? apiRetryAt : apiActionRetryAt) - requestedAt) / 1000)} seconds.`;
    throw Object.assign(new Error(rateLimitMessage), { status: 429 });
  }
  let data;
  try {
    data = await requestApi(`/frontpot/api${url}`, {
      credentials: "omit",
      ...(body === undefined
        ? { method: "GET" }
        : { method: "POST", body: JSON.stringify(body) }),
      headers: {
        "Content-Type": "application/json",
        ...(sessionStorage.getItem("frontpot-session")
          ? {
              Authorization: `Bearer ${sessionStorage.getItem("frontpot-session")}`,
            }
          : {}),
      },
    });
  } catch (e) {
    if (e instanceof Error && "status" in e && e.status === 429) {
      const delay =
        "retryAfterMs" in e && typeof e.retryAfterMs === "number"
          ? e.retryAfterMs
          : 60000;
      if (body === undefined) apiRetryAt = Date.now() + delay;
      else apiActionRetryAt = Date.now() + delay;
      rateLimitMessage = e.message;
    }
    throw e;
  }
  if (error === rateLimitMessage) error = "";
  rateLimitMessage = "";
  const serverNow = Array.isArray(data) ? data[0]?.serverNow : data?.serverNow;
  if (typeof serverNow === "number") {
    serverOffset = serverNow - (requestedAt + Date.now()) / 2;
    lobbyClock.sync(serverNow, performance.now() - requestedMono);
  }
  return data;
}
function saveIdentity(value: Identity) {
  if (identity?.id !== value.id) {
    clearAdmin();
    playerWalletView.clear();
    profiles.clear();
    balanceCheckedAt = 0;
  }
  identity = value;
  sessionStorage.setItem("frontpot-session", value.token);
  localStorage.setItem("frontpot-name", value.name);
}
function clearIdentity() {
  party = null;
  partyCode = "";
  matchSearch = null;
  playerWalletView.clear();
  profiles.clear();
  accountMenuOpen = false;
  clearAdmin();
  identity = null;
  name = "";
  sessionStorage.removeItem("frontpot-session");
  sessionStorage.removeItem("frontpot-room");
  localStorage.removeItem("frontpot-name");
}
function requireIdentity(resume: () => void | Promise<void>) {
  if (
    (identity?.wallet || identity?.guest) &&
    identity.name &&
    identity.expires > Date.now() + 30_000
  )
    return true;
  afterSignIn = resume;
  authOpen = true;
  paint();
  return false;
}
async function ensureIdentity(resume: () => void | Promise<void>) {
  if (identity && identity.expires <= Date.now() + 30_000)
    await refreshIdentity();
  return requireIdentity(resume);
}
function openAccount() {
  afterSignIn = null;
  authOpen = true;
  error = "";
  paint();
}
function closeAccount() {
  authOpen = false;
  afterSignIn = null;
  error = "";
  paint();
}
async function getWalletLogin() {
  authConfig ??= await api("/config");
  if (!authConfig?.privyAppID)
    throw new Error("Wallet sign-in is being set up. Please try again soon.");
  if (!walletLogin) {
    const { initializePrivy } = await import("./PrivyLogin");
    walletLogin = initializePrivy(
      authConfig.privyAppID,
      authConfig.privyClientID,
      () => {
        void api("/logout", {}).catch(() => {});
        clearIdentity();
        if (!tutorialActive) {
          generation++;
          handle?.stop(true);
          handle = null;
          room = null;
          inGame = false;
          document.body.classList.remove("in-game");
        }
        paint();
      },
      !!authConfig.userOwnedWalletsEnabled,
    ).catch((e) => {
      walletLogin = null;
      throw e;
    });
  }
  return walletLogin;
}
async function exchangeIdentity(credentials: WalletCredentials) {
  saveIdentity(await api<Identity>("/session/privy", credentials));
}
async function refreshIdentity() {
  if (userPreview()) return;
  if (identity?.guest) {
    identity = await api<Identity>("/session");
    return;
  }
  const credentials = await (await getWalletLogin()).restore(identity?.wallet);
  if (credentials) await exchangeIdentity(credentials);
  else clearIdentity();
}
async function finishSignIn() {
  authOpen = false;
  const resume = afterSignIn;
  afterSignIn = null;
  paint();
  if (resume) await resume();
  else if (!room && identity?.name) {
    const active = await api<PublicRoom | null>("/active-room");
    if (active) await enter(active, true);
  }
}
async function claimUsername() {
  saveIdentity(await api<Identity>("/profile", { username: name }));
  await finishSignIn();
}
async function signOut() {
  const wasGuest = identity?.guest;
  await api("/logout", {});
  clearIdentity();
  if (!wasGuest) await (await getWalletLogin()).logout();
  closeAccount();
  notice = "You’re signed out.";
  if (showProfile) await profiles.load();
}
async function act(fn: () => Promise<void>) {
  if (busy) return;
  busy = true;
  error = "";
  notice = "";
  paint();
  try {
    await fn();
  } catch (e) {
    error = e instanceof Error ? e.message : t("request_error");
  } finally {
    busy = false;
    paint();
    if (error && !inGame) window.scrollTo({ top: 0 });
  }
}
async function connectWallet() {
  const login = await getWalletLogin();
  // Privy's portal must not sit behind our native modal's top layer.
  authOpen = false;
  paint();
  try {
    const credentials = await login.login();
    if (!credentials) {
      afterSignIn = null;
      return;
    }
    await exchangeIdentity(credentials);
    if (identity?.name) await finishSignIn();
    else {
      name = "";
      authOpen = true;
    }
  } catch (e) {
    authOpen = true;
    throw e;
  }
}
async function startTutorial() {
  if (room)
    throw new Error("Leave your current match before starting the tutorial.");
  await fetchCosmetics();
  const client = await loadGameClient();
  previewRoom = null;
  new UserSettings().setTutorialDismissed(false);
  authOpen = false;
  showHowToPlay = false;
  tutorialActive = true;
  inGame = true;
  document.body.classList.add("in-game");
  history.replaceState(null, "", "/tutorial");
  const loading = document.querySelector(
    "game-starting-modal",
  ) as GameStartingModal;
  loading?.show();
  paint();
  try {
    handle = client.joinLobby(new EventBus(), tutorialLobby());
    await handle.join;
  } catch (e) {
    handle?.stop(true);
    handle = null;
    inGame = false;
    tutorialActive = false;
    document.body.classList.remove("in-game");
    loading?.hide();
    history.replaceState(null, "", "/");
    throw e;
  }
}
let viewingRoom = false;
async function enter(nextRoom: PublicRoom, background = false) {
  if (matchSearch) await cancelSearch();
  if (room?.id === nextRoom.id && handle) {
    if (!background) returnToMatch();
    return;
  }
  if (!background) hideProfile();
  viewingRoom = !background;
  room = nextRoom;
  ranked = roomWager(room);
  category = !ranked ? "free" : room.mode === "ffa" ? "ffa" : "ranked";
  sessionStorage.setItem("solsiege-match-type", ranked ? "ranked" : "unranked");
  funding = null;
  if (!background) previewRoom = null;
  setMatchTerms({
    gameID: room.id,
    mode: room.mode,
    practice: room.practice,
    ranked: roomRanked(room),
    stakeLamports: room.lamports,
    playerName: identity!.name,
    network: roomWager(room)
      ? (authConfig?.paymentsMode ?? "simulation")
      : "simulation",
  });
  custom = false;
  pendingInvite = null;
  connected = false;
  paint();
  window.scrollTo({ top: 0 });
  if (!background) history.replaceState(null, "", `/room/${room.id}`);
  sessionStorage.setItem("frontpot-room", room.id);
  // Restoring membership on a wallet/profile tab must not take over the
  // active game socket in another tab. Connect only on an explicit return.
  if (background) return;
  const requestGeneration = ++generation;
  await fetchCosmetics();
  const client = await loadGameClient();
  if (requestGeneration !== generation) return;
  const lobby = client.joinLobby(new EventBus(), {
    gameID: room.id,
    onGameError: (failure) => {
      if (requestGeneration !== generation || room?.id !== nextRoom.id) return;
      connected = false;
      inGame = false;
      document.body.classList.remove("in-game");
      (document.querySelector("game-starting-modal") as GameStartingModal)?.hide();
      error =
        failure.message.startsWith("WebGL2 unavailable")
          ? "Your browser could not start WebGL2 graphics. Enable WebGL2 or try another browser. You can return to lobbies and retry."
          : failure.message === "full-lobby"
            ? "This lobby is full. Return to lobbies to choose another match."
            : failure.message === "game-started"
              ? "This match has already started. Return to lobbies to choose another match."
              : `Unable to join this match: ${failure.message}`;
      paint();
    },
    onLobbyConnected: () => {
      if (requestGeneration !== generation || connected) return;
      connected = true;
      paint();
    },
    playerName: identity!.name,
    playerClanTag: null,
    playerRole: null,
    cosmetics: {},
    turnstileToken: null,
  });
  handle = lobby;
  paint();
  const showStartedMatch = () => {
    // The lobby connection survives page navigation. Only its current membership
    // may take over the screen; late events from a left/replaced lobby are ignored.
    if (requestGeneration !== generation || room?.id !== nextRoom.id || inGame)
      return;
    hideProfile();
    showHowToPlay =
      showTerms =
      showAdmin =
      showHistory =
      showLobbies =
      setupOpen =
        false;
    showMatchmaking = authOpen = false;
    afterSignIn = null;
    previewRoom = null;
    viewingRoom = true;
    error = notice = "";
    (
      document.getElementById("menu-settings") as
        | (HTMLElement & {
            close?: () => void;
          })
        | null
    )?.close?.();
    inGame = true;
    history.replaceState(null, "", `/room/${nextRoom.id}`);
    document.body.classList.add("in-game");
    (
      document.querySelector("game-starting-modal") as GameStartingModal
    )?.show();
    paint();
    void api<PublicRoom>(`/rooms/${nextRoom.id}`)
      .then((lockedRoom) => {
        if (requestGeneration === generation) {
          room = lockedRoom;
          paint();
        }
      })
      .catch(() => {});
  };
  void lobby.prestart.then(showStartedMatch);
  void lobby.join
    .then(() => {
      if (requestGeneration !== generation || room?.id !== nextRoom.id) return;
      showStartedMatch();
      prizeReadyMatch = nextRoom.id;
      paint();
    })
    .catch((e) => {
      error = String(e);
      paint();
    });
}
async function quickPlay(practice = false) {
  if (practice && (!identity || identity.expires <= Date.now())) {
    const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
    saveIdentity(
      await api<Identity>("/session/guest", { username: `Solo${suffix}` }),
    );
  }
  if (!practice && ranked)
    stake = parseSolAmount(stake, authConfig?.minimumEntryLamports).stake;
  if (!(await ensureIdentity(() => quickPlay(practice)))) return;
  if (!custom && !practice) {
    const current = await api<PublicRoom[]>("/rooms");
    const available = current.find(
      (r) =>
        r.mode === mode &&
        inCategory(r) &&
        (!ranked || Number(r.stake) === Number(stake)) &&
        r.members.length < r.max &&
        (r.startsAt ?? Infinity) > Date.now() + serverOffset,
    );
    if (available) return join(available.id);
  }
  await enter(
    await api<PublicRoom>("/rooms", {
      mode: practice ? "ffa" : mode,
      stake: practice || !ranked ? "0" : stake,
      ranked: !practice && ranked && mode !== "ffa",
      practice,
      rules,
      match: !custom,
      private: custom && privateRoom,
    }),
  );
}
async function join(id: string) {
  if (room?.id === id && handle) {
    returnToMatch();
    return;
  }
  if (!(await ensureIdentity(() => join(id)))) return;
  party = await api("/party");
  if (party) {
    openMatchmaking();
    notice = "Ready up together to find a 2v2 match.";
    paint();
    return;
  }
  await enter(await api<PublicRoom>(`/rooms/${id}/join`, {}));
}
async function watchLive(r: PublicRoom) {
  if (room)
    throw new Error("Leave your current match before watching another game.");
  if (!(await ensureIdentity(() => watchLive(r)))) return;
  await fetchCosmetics();
  const client = await loadGameClient();
  watchingLive = true;
  spectatorLoading = true;
  watchedRoom = r;
  replayTitle = `Watching · ${mapName(r.rules.gameMap)} · ${roomWager(r) ? `${pot(r)} SOL prize` : "Free match"}`;
  inGame = true;
  document.body.classList.add("in-game");
  paint();
  let loadTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const ready = new Promise<void>((resolve, reject) => {
      loadTimeout = setTimeout(
        () =>
          reject(
            new Error(
              "The spectator connection timed out. Please try watching again.",
            ),
          ),
        30_000,
      );
      handle = client.joinLobby(new EventBus(), {
        onGameReady: resolve,
        onGameError: reject,
        gameID: r.id,
        playerName: identity!.name,
        playerClanTag: null,
        playerRole: null,
        cosmetics: {},
        turnstileToken: null,
        spectator: true,
      });
    });
    await ready;
    spectatorLoading = false;
    prizeReadyMatch = r.id;
    paint();
  } catch (e) {
    handle?.stop(true);
    handle = null;
    watchingLive = false;
    spectatorLoading = false;
    watchedRoom = null;
    inGame = false;
    document.body.classList.remove("in-game");
    (
      document.querySelector("game-starting-modal") as GameStartingModal
    )?.hide();
    browseLiveGames();
    throw e;
  } finally {
    clearTimeout(loadTimeout);
  }
}
function stopWatching() {
  // Never wait for the global action lock: loading may still be awaiting a socket.
  try {
    handle?.stop(true);
  } finally {
    location.href = "/lobbies?view=live";
  }
}
function liveGamesView() {
  const activeGames = liveGames.filter((r) => r.status === "playing");
  return html`<main class="sq-page sow-live-games">
    <button class="fp-secondary" @click=${browseLobbies}>
      Back to lobbies
    </button>
    <h1>Live games</h1>
    ${
      activeGames.length
        ? html`<div class="sq-ordered-grid">
            ${activeGames.map(
              (r) =>
                html`<button
                  class="sq-card"
                  ?disabled=${busy}
                  @click=${() => act(() => watchLive(r))}
                  aria-label=${`Watch ${mapName(r.rules.gameMap)} live`}
                >
                  <span class="sq-card-map">
                    <img
                      src=${mapImage(r.rules.gameMap)}
                      alt=""
                      loading="lazy"
                    />
                    <span class="sq-card-badges"
                      ><span class="sq-entry">LIVE</span></span
                    >
                    <span class="sq-card-map-caption">
                      <strong>${mapName(r.rules.gameMap)}</strong>
                      <span
                        >${modeLabel(r.mode)} · ${r.members.length}
                        players</span
                      >
                    </span>
                  </span>
                  <span class="sq-card-bottom">
                    <span>Watch game</span>
                    ${roomWager(r) ? html`<span>${solIcon()} ${pot(r)} SOL</span>` : ""}
                  </span>
                </button>`,
            )}
          </div>`
        : html`<p>
            No games are live right now. Games will appear here when they start.
          </p>`
    }
  </main>`;
}

let leaving = false;
async function leave() {
  if (leaving) return;
  leaving = true;
  try {
    if (room) await api(`/rooms/${room.id}/leave`, {});
    generation++;
    handle?.stop(true);
    handle = null;
    sessionStorage.removeItem("frontpot-room");
    location.href = "/";
  } finally {
    leaving = false;
  }
}
function returnToMatch() {
  if (!room) return;
  if (!handle) {
    const active = room;
    void act(() => enter(active));
    return;
  }
  hideProfile();
  showHowToPlay =
    showTerms =
    showAdmin =
    showHistory =
    showLobbies =
    setupOpen =
      false;
  previewRoom = null;
  viewingRoom = true;
  history.replaceState(null, "", `/room/${room.id}`);
  paint();
}
async function viewLobby(id: string) {
  if (room?.id === id) {
    returnToMatch();
    return;
  }
  viewingRoom = false;
  hideProfile();
  loadingLobby = true;
  error = "";
  paint();
  try {
    previewRoom = await api<PublicRoom>(`/rooms/${id}`);
  } finally {
    loadingLobby = false;
    paint();
  }
  pendingInvite = null;
  history.replaceState(null, "", `/room/${id}`);
  paint();
  window.scrollTo({ top: 0 });
}
async function copyInvite() {
  const id = (viewingRoom ? room : previewRoom)!.id;
  try {
    await navigator.clipboard.writeText(`${location.origin}/room/${id}`);
    notice = t("copied");
  } catch {
    notice = `${location.origin}/room/${id}`;
  }
  paint();
}
const modeLabel = (value: Mode) => (value === "ffa" ? t("ffa") : value);
const sol = (lamports: number) =>
  (lamports / 1e9).toLocaleString("en-US", {
    maximumFractionDigits: 9,
  });
const grossPool = (r: PublicRoom) =>
  r.lamports * (r.locked?.entrants ?? r.readyCount);
const pot = (r: PublicRoom) => sol(grossPool(r));
const potentialPool = (r: PublicRoom) => sol(r.lamports * r.max);
const poolLabel = (r: PublicRoom) =>
  !r.locked && r.mode === "ffa" ? "Potential prize pool" : "Prize pool";
const solIcon = () =>
  html`<svg class="sow-sol-mark" viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="currentColor"
      d="m6 3-4 4h16l4-4H6Zm-4 7 4 4h16l-4-4H2Zm4 7-4 4h16l4-4H6Z"
    />
  </svg>`;
const lobbyClock = new CountdownClock();
const countdown = (r: PublicRoom) => {
  if (r.locked) return "Locked";
  if (r.queueKey && r.startsAt === null)
    return `Queue ${r.queuePosition ?? "…"}`;
  if (!r.startsAt) return r.private && !r.practice ? "Host starts" : "Waiting";
  const seconds = lobbyClock.seconds(r.startsAt);
  return seconds
    ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
    : "Closing…";
};

type IconName =
  | "user"
  | "users"
  | "settings"
  | "help"
  | "swords"
  | "plus"
  | "history"
  | "globe";
function icon(kind: IconName) {
  const paths = {
    user: svg`<circle cx="12" cy="8" r="4" /><path
        d="M4 21v-2a8 8 0 0 1 16 0v2"
      />`,
    users: svg`<circle cx="9" cy="8" r="3" /><path
        d="M2 21v-3a7 7 0 0 1 14 0v3M16 5a3 3 0 0 1 0 6m3 3a6 6 0 0 1 3 5v2"
      />`,
    settings: svg`<circle cx="12" cy="12" r="3" /><path
        d="m9 3 1-1h4l1 3 3 1 3-1 2 4-2 2v3l2 2-2 4-3-1-3 1-1 3h-4l-1-3-3-1-3 1-2-4 2-2v-3L1 9l2-4 3 1 3-1z"
        transform="translate(1 0) scale(.92)"
      />`,
    help: svg`<circle cx="12" cy="12" r="9" /><path
        d="M9.5 9a2.5 2.5 0 1 1 4.3 1.7c-1 .6-1.8 1.1-1.8 2.8M12 17h.01"
      />`,
    swords: svg`<path
      d="m3 3 5 1 13 13-4 4L4 8 3 3Zm11 3 6-3 1 5-4 4M4 14l6 6M3 21l4-4m10-4 5 5"
    />`,
    plus: svg`<path d="M12 4v16M4 12h16" />`,
    history: svg`<path d="M3 10a9 9 0 1 1 0 5M3 4v6h6m3-4v6l4 2" />`,
    globe: svg`<circle cx="12" cy="12" r="9" /><ellipse
        cx="12"
        cy="12"
        rx="4"
        ry="9"
      /><path d="M3 12h18" />`,
  };
  return html`<svg
    class="fp-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    ${paths[kind]}
  </svg>`;
}
function goPlay() {
  if (inGame) return;
  viewingRoom = false;
  hideProfile();
  previewRoom = null;
  showHowToPlay = showTerms = false;
  showAdmin = false;
  history.replaceState(null, "", "/");
  setupOpen = false;
  showHistory = false;
  showLobbies = false;
  custom = false;
  paint();
  void refresh();
  window.scrollTo({ top: 0 });
}
function browseLiveGames() {
  browseLobbies();
  liveOnly = true;
  history.replaceState(null, "", "/lobbies?view=live");
  paint();
}
function browseLobbies() {
  liveOnly = false;
  viewingRoom = false;
  hideProfile();
  previewRoom = null;
  showHowToPlay = showTerms = false;
  showAdmin = false;
  history.replaceState(null, "", "/lobbies");
  setupOpen = false;
  showHistory = false;
  showLobbies = true;
  paint();
  void refresh();
  window.scrollTo({ top: 0 });
}
async function joinByCode() {
  const value = inviteCode.trim();
  const id = value.match(
    /^(?:https?:\/\/[^/]+\/room\/)?([a-zA-Z0-9]{8,10})(?:[?#].*)?$/,
  )?.[1];
  if (!id)
    throw new Error("Enter an 8–10 character lobby code or an invite link.");
  await join(id);
}
function playerBar() {
  return html`<div class="fp-player-bar">
    ${playerIcon(identity?.icon, identity?.color)}
    <div class="fp-player-field">
      <span class="fp-player-label">Player</span>
      <strong class="fp-player-name"
        >${identity?.name.length ? identity.name : "Not signed in"}</strong
      >
    </div>
    <button
      class="fp-identity-tag"
      @click=${() => (identity?.name ? void openProfile("me") : openAccount())}
      ?disabled=${!!room || busy}
    >
      ${identity?.name ? "My profile" : identity ? "Set username" : "Sign in to play"}
    </button>
  </div>`;
}
function accountDialog() {
  const complete = !!identity?.name;
  return html`<dialog
    id="fp-account"
    class="fp-account"
    aria-labelledby="fp-account-title"
    @cancel=${closeAccount}
  >
    <button
      class="fp-account-close fp-text-button"
      @click=${closeAccount}
      ?disabled=${busy}
      aria-label="Close sign-in"
    >
      Close
    </button>
    <img class="fp-account-mark" src=${brandSymbol} alt="" />
    <h2 id="fp-account-title">
      ${complete ? identity!.name : identity ? "Choose a username" : "Sign in to play"}
    </h2>
    ${
      !complete
        ? html`<ol class="fp-auth-steps" aria-label="Sign-in steps">
            <li class=${identity ? "done" : "current"}>
              <span>1</span>Connect wallet
            </li>
            <li class=${identity ? "current" : ""}>
              <span>2</span>Choose username
            </li>
          </ol>`
        : ""
    }
    <p class="fp-account-copy">
      ${complete ? "Your username and connected wallet." : identity ? "Your username appears in lobbies, matches and win cards." : "Play free with a guest username, or sign in with a wallet for wagers and saved progress."}
    </p>
    ${identity && !identity.guest ? html`<div class="fp-account-wallet"><span>Verified Solana wallet</span><code>${identity.wallet}</code></div>` : ""}
    ${error ? html`<p class="fp-auth-error" role="alert">${error}</p>` : ""}
    ${
      !identity
        ? html`<form
            @submit=${(e: SubmitEvent) => {
              e.preventDefault();
              void act(async () => {
                saveIdentity(
                  await api<Identity>("/session/guest", { username: name }),
                );
                category = "free";
                ranked = false;
                searchRanked = false;
                searchWagerFFA = false;
                await finishSignIn();
              });
            }}
          >
            <label for="guest-name">Guest username</label>
            <input
              id="guest-name"
              .value=${name}
              @input=${(e: Event) => {
                name = (e.target as HTMLInputElement).value;
              }}
              minlength="3"
              maxlength="20"
              pattern="[A-Za-z0-9_]{3,20}"
              required
              autocomplete="nickname"
            />
            <button class="fp-primary" ?disabled=${busy}>
              Play free as guest
            </button>
            <small
              >Free Play only. Guest XP, stats and progress are not
              saved.</small
            >
          </form>`
        : identity.guest
          ? html`<p>Guest session · Free Play only · Progress is not saved.</p>
              <button class="fp-primary" @click=${() => act(connectWallet)}>
                Sign in with wallet
              </button>`
          : ""
    }
    ${
      complete
        ? html`<button class="fp-primary" @click=${closeAccount}>
              Back to play</button
            ><button
              class="fp-text-button"
              ?disabled=${busy || !!room}
              @click=${() => act(signOut)}
            >
              Sign out
            </button>`
        : identity
          ? html` <form
                @submit=${(e: SubmitEvent) => {
                  e.preventDefault();
                  void act(claimUsername);
                }}
              >
                <label for="fp-username">Username</label>
                <input
                  id="fp-username"
                  name="username"
                  autocomplete="nickname"
                  autocapitalize="off"
                  spellcheck="false"
                  required
                  minlength="3"
                  maxlength="20"
                  pattern="[A-Za-z0-9_]{3,20}"
                  .value=${name}
                  @input=${(e: Event) => {
                    name = (e.target as HTMLInputElement).value;
                  }}
                  aria-describedby="fp-username-hint"
                />
                <small id="fp-username-hint"
                  >3–20 letters, numbers or underscores. Usernames are
                  unique.</small
                >
                <button class="fp-primary" type="submit" ?disabled=${busy}>
                  ${busy ? "Saving…" : "Save username and continue"}
                </button>
              </form>
              <button
                class="fp-text-button"
                ?disabled=${busy}
                @click=${() => act(signOut)}
              >
                Use a different wallet
              </button>`
          : html` <button
                class="fp-primary"
                ?disabled=${busy}
                @click=${() => act(connectWallet)}
              >
                ${busy ? "Opening Privy…" : "Sign in with wallet"}
              </button>
              <small class="fp-auth-note"
                >Secure sign-in by Privy. Signing in does not request a
                payment.</small
              >`
    }
  </dialog>`;
}
let potPreviewRun = 0;
let rankPreviewPlaced = false;
let rankResultPreview = false;
function paint() {
  if (
    ["localhost", "127.0.0.1"].includes(location.hostname) &&
    authConfig?.paymentsMode === "simulation" &&
    new URLSearchParams(location.search).get("preview") === "pot"
  ) {
    render(
      html`<main
        class="sp-page"
        style="max-width:720px;margin:40px auto;text-align:center"
      >
        <p class="sp-muted">
          Local animation preview · Sample prize · No SOL is spent
        </p>
        <h1>SOL prize pot</h1>
        <p>Watch the prize pool tally up to 4.5 SOL.</p>
        <div style="display:flex;justify-content:center;padding:64px 24px 40px">
          <sow-prize-pot
            .match=${potPreviewRun ? `preview-${potPreviewRun}` : ""}
            .lamports=${potPreviewRun ? 4500000000 : 0}
          ></sow-prize-pot>
        </div>
        <button
          class="fp-primary"
          @click=${() => {
            potPreviewRun++;
            paint();
          }}
        >
          ${potPreviewRun ? "Replay animation" : "Play animation"}
        </button>
      </main>`,
      root,
    );
    return;
  }

  if (
    ["localhost", "127.0.0.1"].includes(location.hostname) &&
    authConfig?.paymentsMode === "simulation" &&
    new URLSearchParams(location.search).get("preview") === "ranks"
  ) {
    render(
      html`<main class="sp-page sp-rank-preview">
        <p class="sp-muted">
          Local design preview · Sample data · No wallet required
        </p>
        <div class="sp-actions">
          <h1>Ranked progression</h1>
          <button
            class="fp-primary"
            @click=${() => {
              rankPreviewPlaced = !rankPreviewPlaced;
              paint();
            }}
          >
            ${rankPreviewPlaced ? "Show new player" : "Show sample ranks"}
          </button>
        </div>
        <button
          class="fp-primary"
          @click=${() => {
            rankResultPreview = !rankResultPreview;
            paint();
          }}
        >
          ${rankResultPreview ? "Hide match results" : "Preview match results"}
        </button>
        ${
          rankResultPreview
            ? html`<section style="max-width:680px;margin:24px auto">
                <h2>Sample ranked results</h2>
                ${rankedResultView({ before: 1292, after: 1308, delta: 16, place: 1, counted: true, beforeTier: "Gold I", afterTier: "Gold II", gamesAfter: 25 })}
                ${rankedResultView({ before: 1308, after: 1292, delta: -16, place: 2, counted: true, beforeTier: "Gold II", afterTier: "Gold I", gamesAfter: 26 })}
                ${rankedResultView({ before: 1268, after: 1252, delta: -16, place: 2, counted: true, beforeTier: "Gold I", afterTier: "Gold I", gamesAfter: 27 })}
              </section>`
            : null
        }
        ${rankedCards((["1v1", "2v2"] as const).map((mode, i) => ({ mode, rating: rankPreviewPlaced ? [1268, 1432, 1084][i] : 1000, games: rankPreviewPlaced ? [24, 38, 7][i] : 0, wins: rankPreviewPlaced ? [15, 23, 2][i] : 0, losses: rankPreviewPlaced ? [9, 15, 5][i] : 0, provisional: !rankPreviewPlaced || i === 2, tier: rankPreviewPlaced ? rankTier([1268, 1432, 1084][i]) : "Unranked" })))}
      </main>`,
      root,
    );
    return;
  }
  const prizeRoom = room ?? (watchingLive ? watchedRoom : null);
  render(
    html`
      ${accountDialog()}
      ${
        mobileExperienceNotice && !inGame
          ? html`<aside
              class="sow-mobile-tip"
              aria-label="Desktop experience tip"
            >
              <p role="status">For the best experience, play on desktop.</p>
              <button
                @click=${() => {
                  mobileExperienceNotice = false;
                  paint();
                }}
              >
                Got it
              </button>
            </aside>`
          : ""
      }
      <div class="fp-shell ${inGame ? "fp-off" : ""}">
        <header class="fp-nav">
          <div class="fp-nav-inner">
            <a
              href="/"
              @click=${(e: MouseEvent) => {
                if (!e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
                  e.preventDefault();
                  goPlay();
                }
              }}
              class="fp-brand"
              aria-label="Sol of War home"
            >
              <img class="sow-symbol" src=${brandSymbol} alt="" />
              <img class="sow-wordmark" src=${brandWordmark} alt="Sol of War" />
            </a>
            <nav class="fp-site-nav" aria-label="Game navigation">
              <button
                class=${location.pathname !== "/shop" && !showLobbies && !showHistory && !showTerms && !showAdmin && !showProfile && !showWallet ? "active" : ""}
                ?disabled=${inGame}
                aria-current=${location.pathname !== "/shop" && !showLobbies && !showHistory && !showProfile && !showWallet ? "page" : "false"}
                @click=${goPlay}
              >
                Play
              </button>
              <button
                class=${showLobbies && !liveOnly ? "active" : ""}
                ?disabled=${inGame}
                @click=${browseLobbies}
              >
                Lobbies
              </button>
              <button
                class=${showLobbies && liveOnly ? "active" : ""}
                ?disabled=${inGame}
                aria-current=${showLobbies && liveOnly ? "page" : "false"}
                @click=${browseLiveGames}
              >
                Watch
                live${liveGames.length ? html` (${liveGames.length})` : ""}
              </button>
              <button
                ?disabled=${inGame || busy}
                class=${location.pathname === "/shop" ? "active" : ""}
                @click=${() => location.assign("/shop")}
              >
                Shop
              </button>
            </nav>
            <div class="fp-nav-right">
              ${room && room.status !== "finished" ? html`<button class="sp-match-badge" @click=${returnToMatch} aria-label="Return to your match" title="Your seat is reserved. Return to match"><span>YOUR MATCH</span><strong>${room.locked ? "In progress" : countdown(room)}</strong></button>` : ""}
              <button
                class="fp-icon-button"
                aria-label="How to play"
                title="How to play"
                ?disabled=${busy || !!room}
                @click=${() => location.assign("/how-to-play")}
              >
                ${icon("help")}
              </button>
              <button
                class="fp-icon-button"
                aria-label="Settings"
                title="Settings"
                @click=${() => act(openSettings)}
              >
                ${icon("settings")}
              </button>
              ${
                identity?.name && authConfig?.playerWalletsEnabled
                  ? html`<button
                      class="sp-balance-badge"
                      title="Available platform balance · Open wallet"
                      aria-label=${`Wallet balance: ${playerWalletView.data ? `${(playerWalletView.data.availableLamports / 1e9).toLocaleString("en-US", { maximumFractionDigits: 9 })} SOL` : "unavailable"}. Open wallet`}
                      ?disabled=${busy || inGame}
                      @click=${() => act(openPlayerWallet)}
                    >
                      <svg
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        aria-hidden="true"
                      >
                        <path
                          d="m6 3-4 4h16l4-4H6Zm-4 7 4 4h16l-4-4H2Zm4 7-4 4h16l4-4H6Z"
                        /></svg
                      ><span
                        >${playerWalletView.data ? (playerWalletView.data.availableLamports / 1e9).toLocaleString("en-US", { maximumFractionDigits: 9 }) : balanceRefreshing || !balanceCheckedAt ? "Loading…" : "Unavailable"}${playerWalletView.data ? " SOL" : ""}</span
                      >
                    </button>`
                  : ""
              }
              <div class="sp-account">
                <button
                  class="fp-wallet"
                  ?disabled=${authRestoring || busy || inGame}
                  aria-expanded=${accountMenuOpen}
                  aria-controls="sp-account-menu"
                  @click=${() => {
                    if (!identity?.name) {
                      openAccount();
                      return;
                    }
                    accountMenuOpen = !accountMenuOpen;
                    paint();
                  }}
                >
                  ${icon("user")}<span
                    >${identity && identity.name.length > 0 ? identity.name : authRestoring ? "Loading…" : "Sign in"}</span
                  >
                </button>
                ${
                  accountMenuOpen && identity?.name
                    ? html`<div
                        id="sp-account-menu"
                        class="sp-account-menu"
                        aria-label="Account"
                      >
                        <strong>Signed in as ${identity.name}</strong>
                        ${authConfig?.playerWalletsEnabled ? html`<button @click=${() => act(openPlayerWallet)}>Wallet</button>` : ""}
                        <button @click=${() => openProfile()}>
                          My profile
                        </button>
                        <button @click=${() => act(openHistory)}>
                          Match and payment history
                        </button>
                        <button
                          @click=${() => {
                            accountMenuOpen = false;
                            paint();
                            void act(openSettings);
                          }}
                        >
                          Settings
                        </button>
                        <button @click=${() => act(signOut)}>Sign out</button>
                      </div>`
                    : ""
                }
              </div>
            </div>
          </div>
        </header>
        <div class="fp-content">
          ${!showAdmin && availability.entriesPaused ? html`<div class="fp-message" role="status">${availability.draining ? "Matches are paused for an update. Games already in progress continue. The free tutorial remains available." : "New match entries are temporarily paused. Existing games and the free tutorial continue."}</div>` : ""}
          ${
            error && !authOpen
              ? html`<div
                  class="fp-message fp-error fp-dismissible"
                  role="alert"
                >
                  <span>${error}</span
                  ><button
                    type="button"
                    @click=${() => {
                      error = "";
                      paint();
                    }}
                  >
                    Dismiss
                  </button>
                </div>`
              : ""
          }
          ${
            notice
              ? html`<div class="fp-message fp-dismissible" role="status">
                  <span>${notice}</span
                  ><button
                    type="button"
                    @click=${() => {
                      notice = "";
                      paint();
                    }}
                  >
                    Dismiss
                  </button>
                </div>`
              : ""
          }
          ${
            authRestoring && (showWallet || showProfile)
              ? html`<main class="sc-account">
                  <p role="status">Loading your account…</p>
                </main>`
              : showAdmin
                ? adminView({
                    identity,
                    busy,
                    api,
                    act,
                    paint,
                    signIn: () => {
                      requireIdentity(async () => {
                        await refreshAdmin(api, true);
                        paint();
                      });
                    },
                  })
                : showWallet
                  ? playerWalletView.render()
                  : showProfile
                    ? profiles.render()
                    : location.pathname === "/shop"
                      ? shopView.render()
                      : showHowToPlay
                        ? howToPlayView()
                        : showTerms
                          ? termsView()
                          : loadingLobby
                            ? html`<div
                                class="sow-queue-loading"
                                aria-busy="true"
                              >
                                <div inert>
                                  ${showLobbies ? lobbiesView() : homeView()}
                                </div>
                                <span
                                  class="sow-queue-loading-label"
                                  role="status"
                                  >Loading lobby…</span
                                >
                              </div>`
                            : (room && viewingRoom) || previewRoom
                              ? roomView()
                              : showHistory
                                ? historyView()
                                : setupOpen
                                  ? setupView()
                                  : showLobbies
                                    ? lobbiesView()
                                    : showMatchmaking
                                      ? html`<main class="sow-matchmaking-page">
                                          ${matchmakingPanel()}
                                        </main>`
                                      : homeView()
          }
        </div>
        <footer class="fp-footer">
          <div class="fp-footer-top">
            <span class="fp-footer-brand"
              ><img class="fp-footer-symbol" src=${brandSymbol} alt="" /><img
                class="fp-footer-wordmark"
                src=${brandWordmark}
                alt="Sol of War"
              /><small>ALPHA</small></span
            >
            <nav class="fp-footer-socials" aria-label="Community links">
              <a
                href="https://github.com/sol-of-war-dev/Sol-of-War"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Sol of War on GitHub"
                title="Sol of War on GitHub"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
                  <path
                    d="M12 .5a12 12 0 0 0-3.793 23.385c.6.111.82-.261.82-.577v-2.234c-3.338.726-4.043-1.416-4.043-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.09-.745.083-.729.083-.729 1.205.085 1.839 1.237 1.839 1.237 1.07 1.835 2.807 1.305 3.492.998.108-.776.419-1.305.762-1.605-2.665-.303-5.467-1.334-5.467-5.931 0-1.31.469-2.381 1.236-3.221-.124-.303-.536-1.524.117-3.176 0 0 1.008-.322 3.301 1.23a11.5 11.5 0 0 1 6.006 0c2.291-1.552 3.297-1.23 3.297-1.23.655 1.652.243 2.873.119 3.176.769.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.625-5.479 5.922.43.372.823 1.102.823 2.222v3.292c0 .319.216.694.825.576A12 12 0 0 0 12 .5Z"
                  />
                </svg>
              </a>
              <a
                href="https://x.com/solofwar"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Sol of War on X"
                title="Sol of War on X"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
                  <path
                    d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.64 7.584H.47l8.6-9.835L0 1.154h7.594l5.243 6.932 6.064-6.933Zm-1.29 19.49h2.039L6.487 3.24H4.3l13.31 17.403Z"
                  />
                </svg>
              </a>
              <a
                href="https://pump.fun/coin/4KdB5zg8VuuUKJEk4DvkVZnrT9DJQxvWbjfDRF4cpump"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Sol of War token on pump.fun"
                title="Sol of War on pump.fun"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <g transform="rotate(45 12 12)">
                    <rect
                      x="6"
                      y="1.5"
                      width="12"
                      height="21"
                      rx="6"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2.5"
                    />
                    <path
                      d="M6 12h12v4.5a6 6 0 0 1-12 0Z"
                      fill="currentColor"
                    />
                  </g>
                </svg>
              </a>
            </nav>
            <button
              ?disabled=${busy || !!room}
              @click=${() => location.assign("/how-to-play")}
              class="fp-text-button"
            >
              How to play
            </button>
          </div>
          <div class="fp-footer-bottom">
            <a href="https://openfront.io/" target="_blank" rel="noreferrer"
              >${t("powered_by")}</a
            >
            <div class="fp-footer-links">
              <a
                href=${authConfig?.release?.sourceCommit && /^[a-f0-9]{40}$/.test(authConfig.release.sourceCommit) ? `https://github.com/sol-of-war-dev/Sol-of-War/tree/${authConfig.release.sourceCommit}` : "https://github.com/sol-of-war-dev/Sol-of-War"}
                target="_blank"
                rel="noreferrer"
                >${authConfig?.release?.sourceCommit && /^[a-f0-9]{40}$/.test(authConfig.release.sourceCommit) ? `Deployed source ${authConfig.release.sourceCommit.slice(0, 7)}` : "Sol of War source"}</a
              >
              <a href="/source">Download running source</a>
              <a
                href="https://github.com/openfrontio/OpenFrontIO"
                target="_blank"
                rel="noreferrer"
                >OpenFront source</a
              ><a href="/terms" target="_blank" rel="noreferrer"
                >Terms of Service</a
              ><a href="/license">${t("license")}</a
              ><a href="/privacy">Privacy Policy</a>
              <a href="mailto:team@solofwar.fun">Contact</a>
              <span>© 2026 Sol of War inc.</span>
              <span>© OpenFront and Contributors</span>
            </div>
          </div>
        </footer>
      </div>
      ${
        inGame
          ? html`${
                watchingLive && spectatorLoading
                  ? html`<div class="sow-spectator-loading" role="status">
                      <span class="sow-lobby-spinner" aria-hidden="true"></span>
                      <p>Connecting to live game…</p>
                      <button class="fp-secondary" @click=${stopWatching}>
                        Cancel
                      </button>
                    </div>`
                  : ""
              }
              <div class="fp-game-bar">
                <img
                  class="sow-game-wordmark"
                  src=${brandWordmark}
                  alt="Sol of War"
                />
                <span
                  >${tutorialActive ? "Tutorial · Free, no account" : room?.practice ? t("practice") : room ? `${modeLabel(room.mode)} · ${matchLabel(room)}` : replayTitle}</span
                >
                ${
                  prizeRoom &&
                  roomWager(prizeRoom) &&
                  prizeRoom.locked &&
                  prizeReadyMatch === prizeRoom.id
                    ? html`<sow-prize-pot
                        .match=${prizeRoom.id}
                        .lamports=${grossPool(prizeRoom)}
                      ></sow-prize-pot>`
                    : ""
                }
                ${room && roomRanked(room) && !watchingLive ? rankLabel(room.members.find((m) => m.id === identity?.id)?.rank) : ""}
                <button
                  @click=${() => (watchingLive ? stopWatching() : act(leave))}
                >
                  ${tutorialActive ? "Exit tutorial" : watchingLive ? "Stop watching" : t("leave_match")}
                </button>
              </div>
              <footer class="fp-game-credit">
                <a href="https://openfront.io/" target="_blank" rel="noreferrer"
                  >${t("powered_by")}</a
                ><a href="mailto:team@solofwar.fun">Contact</a><span>© 2026 Sol of War inc.</span><span>© OpenFront and Contributors</span
                ><a
                  href="https://github.com/openfrontio/OpenFrontIO"
                  target="_blank"
                  rel="noreferrer"
                  >${t("source")}</a
                >
              </footer>`
          : ""
      }
    `,
    root,
  );
  const dialog = document.getElementById("fp-account") as HTMLDialogElement;
  if (authOpen && !dialog.open) {
    dialog.showModal();
    if (identity && !identity.name)
      dialog.querySelector<HTMLInputElement>("#fp-username")?.focus();
  } else if (!authOpen && dialog.open) dialog.close();
}
function lobbyCard(r: PublicRoom) {
  return html`<button
    class="sq-card"
    ?disabled=${busy}
    @click=${() => act(() => viewLobby(r.id))}
    aria-label=${`View ${mapName(r.rules.gameMap)}, ${modeLabel(r.mode)}, ${matchLabel(r)}, ${entryLabel(r)} entry`}
  >
    <span class="sq-card-map">
      <img src=${mapImage(r.rules.gameMap)} alt="" loading="lazy" />
      <span class="sq-card-badges">
        ${roomWager(r) ? html`<span class="sq-entry"><small>${matchLabel(r).toUpperCase()}</small>${entryLabel(r)}</span>` : ""}
        <span
          class="sq-countdown"
          aria-label=${r.startsAt ? "Time until start" : "Queue position"}
          >${countdown(r)}</span
        >
      </span>
      <span class="sq-card-map-caption">
        <strong>${mapName(r.rules.gameMap)}</strong>
        <span
          >${modeLabel(r.mode)} · ${r.rules.gameMapSize} ·
          ${r.rules.maxTimerValue}
          min${r.rules.goldMultiplier === 2 ? " · 2× GOLD" : ""}${r.queueKey ? "" : " · Custom lobby"}</span
        >
      </span>
    </span>
    <span class="sq-card-bottom">
      <span
        ><small>${roomWager(r) ? poolLabel(r).toUpperCase() : "UNRANKED"}</small
        ><strong
          >${roomWager(r) ? html`${solIcon()}${r.locked ? pot(r) : potentialPool(r)} <span>SOL</span>` : html`Free <span>to play</span>`}</strong
        ></span
      >
      <span class="sq-card-count"
        >${icon("users")}<span
          >${r.readyCount}<small>/${r.max}</small></span
        ></span
      >
    </span>
  </button>`;
}
function homeView() {
  const available = [...rooms].sort(
    (a, b) =>
      (a.queuePosition ?? Number.MAX_SAFE_INTEGER) -
      (b.queuePosition ?? Number.MAX_SAFE_INTEGER),
  );
  const featured = available[0];
  const upcoming = available.slice(1, 3);
  return html`<main class="sow-home">
    <h1 class="fp-sr-only">Play Sol of War</h1>
    ${pendingInvite ? html`<div class="fp-invite"><span>${t("invited")}</span><button class="fp-primary" ?disabled=${busy} @click=${() => act(() => join(pendingInvite!))}>Join invited lobby</button></div>` : ""}
    <div class="fp-news sow-home-news">
      <span class="fp-news-tag">ALPHA</span>
      <div>
        <strong>Sol of War</strong>
        <p>Play for free or wager SOL.</p>
      </div>
      <button
        class="fp-text-button"
        ?disabled=${busy}
        @click=${() => location.assign("/how-to-play")}
      >
        How to play
      </button>
    </div>
    ${playerBar()}
    <div class="sow-home-games">
      <section class="sow-home-featured" aria-label="Featured game">
        ${featured ? homeLobbyCard(featured) : html`<div class="sow-home-empty" role="status">${roomsError ? "Unable to load games." : roomsLoaded ? (category === "ranked" ? "Find a ranked match with players near your Elo." : "No open games yet.") : "Loading games…"}${category === "ranked" ? html`<button class="fp-primary" @click=${openMatchmaking}>Start matchmaking</button>` : ""}<button class="fp-text-button" @click=${() => void refresh()}>Refresh games</button></div>`}
      </section>
      <aside class="sow-home-upcoming" aria-label="Upcoming games">
        <button class="fp-upcoming-heading" @click=${browseLobbies}>
          <span class="fp-upcoming-title">Upcoming</span>
          <span class="fp-upcoming-see-all">See all ${available.length}</span>
        </button>
        <div class="sow-home-upcoming-cards">
          ${upcoming.map(homeLobbyCard)}${!upcoming.length ? html`<div class="sow-home-empty">More games will appear here.</div>` : ""}
        </div>
      </aside>
    </div>
    <div class="sow-home-play-actions">
      <button
        class="sow-home-solo"
        ?disabled=${busy}
        @click=${() => openSetup(true)}
      >
        Solo
      </button>
      <button
        class="sow-home-tutorial"
        ?disabled=${busy}
        @click=${() => act(startTutorial)}
      >
        Tutorial
      </button>
    </div>
    <div class="sow-home-actions">
      <div class="sow-home-primary-actions">
        <button ?disabled=${busy} @click=${() => openSetup(false)}>
          Create lobby
        </button>
        <button ?disabled=${busy} @click=${openMatchmaking}>Matchmaking</button>
      </div>
      <button ?disabled=${busy} @click=${browseLobbies}>
        Join
        lobby${available.length ? html`<span class="fp-count">${available.length}</span>` : ""}
      </button>
    </div>
  </main>`;
}
function homeLobbyCard(r: PublicRoom) {
  return lobbyCard(r);
}
function lobbiesView() {
  return liveOnly ? liveGamesView() : queueView(true);
}
function queueView(withInvite: boolean) {
  const visible = rooms.filter(
    (r) =>
      inCategory(r) &&
      (queueFilter === "all" || r.mode === queueFilter) &&
      (entryFilter === "all" || r.stake === entryFilter),
  );
  const fees = [
    ...new Set([
      ...rooms.filter(roomWager).map((r) => r.stake),
      ...(entryFilter === "all" ? [] : [entryFilter]),
    ]),
  ].sort((a, b) => Number(a) - Number(b));

  return html`<main class="sq-queue">
    <div class="sq-page-heading">
      <div>
        <p class="fp-eyebrow">MULTIPLAYER</p>
        <h1>${categoryLabel()} lobbies</h1>
      </div>
      <button
        class="fp-create"
        @click=${() => openSetup(false)}
        ?disabled=${busy}
      >
        ${icon("plus")}Create lobby
      </button>
    </div>
    ${matchTypeTabs()}
    <div class="sq-queue-note">
      <span><i></i>${categoryLabel()} · 2-minute countdown</span
      ><span
        >${ranked ? paymentNotice() : "Free multiplayer. No deposit needed."}</span
      >
    </div>
    ${pendingInvite ? html`<div class="fp-invite"><span>${t("invited")}</span><button class="fp-primary" @click=${() => act(() => join(pendingInvite!))}>Join invited lobby</button></div>` : ""}
    <div class="sq-toolbar">
      <div class="sq-filter-tabs" role="group" aria-label="Filter game mode">
        ${(["all", "ffa", "1v1", "2v2"] as const)
          .filter(
            (m) =>
              m === "all" ||
              category === "free" ||
              (category === "ffa" ? m === "ffa" : m !== "ffa"),
          )
          .map(
            (m) =>
              html`<button
                aria-pressed=${queueFilter === m}
                class=${queueFilter === m ? "selected" : ""}
                @click=${() => {
                  queueFilter = m;
                  paint();
                }}
              >
                ${m === "all" ? "All games" : modeLabel(m)}
              </button>`,
          )}
      </div>
      ${
        ranked
          ? html`<label class="sq-entry-filter"
              >Entry<select
                .value=${entryFilter}
                @change=${(e: Event) => {
                  entryFilter = (e.target as HTMLSelectElement).value;
                  paint();
                }}
              >
                <option value="all">All amounts</option>
                ${fees.map((f) => html`<option value=${f}>${f} SOL</option>`)}
              </select></label
            >`
          : ""
      }
    </div>
    ${roomsError ? html`<div class="fp-message fp-error" role="status">Refreshing games is temporarily unavailable. <button @click=${() => void refresh()}>Retry</button></div>` : ""}
    <div
      class=${roomsError || !roomsLoaded ? "sow-queue-stale" : ""}
      aria-busy=${!roomsLoaded}
      ?inert=${roomsError}
    >
      ${
        !roomsLoaded && !visible.length
          ? html`<div class="sq-ordered-grid" aria-label="Loading games">
              ${Array.from(
                { length: 6 },
                () =>
                  html`<div class="sq-card sow-queue-placeholder">
                    <div class="sq-card-map"></div>
                    <div class="sq-card-bottom">Loading game…</div>
                  </div>`,
              )}
            </div>`
          : visible.length
            ? html`<div class="sq-ordered-grid" aria-label="Global match queue">
                  ${visible
                    .filter((r) => r.queueKey)
                    .sort(
                      (a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0),
                    )
                    .map(lobbyCard)}
                </div>
                ${
                  visible.some((r) => !r.queueKey)
                    ? html`<h2 class="sq-custom-heading">Custom lobbies</h2>
                        <div class="sq-ordered-grid">
                          ${visible.filter((r) => !r.queueKey).map(lobbyCard)}
                        </div>`
                    : ""
                }`
            : html`<p class="sq-empty">
                No lobbies match these filters. Choose another entry amount or
                create a lobby.
              </p>`
      }
    </div>
    ${
      withInvite
        ? html`<form
            class="fp-join-form"
            @submit=${(e: Event) => {
              e.preventDefault();
              void act(joinByCode);
            }}
          >
            <label for="invite-code">Have an invite?</label>
            <div>
              <input
                id="invite-code"
                class="fp-input"
                placeholder="Lobby code or invite link"
                .value=${inviteCode}
                @input=${(e: Event) => {
                  inviteCode = (e.target as HTMLInputElement).value;
                }}
              />
              <button class="fp-primary" ?disabled=${busy}>Join by code</button>
            </div>
          </form>`
        : ""
    }
    <div class="sq-secondary-actions">
      <button @click=${() => location.assign("/how-to-play")} ?disabled=${busy}>
        ${icon("help")}How to play<small>Game rules and free tutorial</small>
      </button>
      <button @click=${() => openSetup(true)} ?disabled=${busy}>
        ${icon("user")}Solo practice<small
          >Choose from ${maps.length} maps</small
        >
      </button>
    </div>
  </main>`;
}
async function updateLobby(r: PublicRoom, patch: Record<string, unknown>) {
  room = await api<PublicRoom>(`/rooms/${r.id}/settings`, {
    mode: r.mode,
    stake: r.stake,
    ranked: roomWager(r) && (patch.mode ?? r.mode) !== "ffa",
    private: r.private,
    rules: r.rules,
    ...patch,
  });
  ranked = roomWager(room);
  category = !ranked ? "free" : room.mode === "ffa" ? "ffa" : "ranked";
  setMatchTerms({
    gameID: room.id,
    mode: room.mode,
    practice: false,
    ranked: roomRanked(room),
    stakeLamports: room.lamports,
    playerName: identity!.name,
    network: ranked ? (authConfig?.paymentsMode ?? "simulation") : "simulation",
  });
}
function lobbySettings(r: PublicRoom) {
  const locked =
    busy || r.members.length > 1 || !!funding?.poolAddress || !!r.locked;
  return html`<section class="sow-lobby-settings" aria-label="Lobby settings">
    <p class="fp-small">
      ${locked && !busy ? "Settings are locked after another player joins or a deposit is prepared." : "Choose the settings, then invite players using your lobby link."}
    </p>
    <fieldset ?disabled=${busy || (!!r.startsAt && r.members.length > 1)}>
      <h2>Custom countdown</h2>
      <p class="fp-small">
        Start automatically after 10–3600 seconds. Players must be connected and
        entries confirmed. The countdown cannot be changed after guests join.
      </p>
      <input
        id="sow-countdown-seconds"
        type="number"
        min="10"
        max="3600"
        value="120"
        aria-label="Countdown in seconds"
      />
      <button
        @click=${() =>
          act(async () => {
            const seconds = Number(
              (
                document.getElementById(
                  "sow-countdown-seconds",
                ) as HTMLInputElement
              ).value,
            );
            room = await api<PublicRoom>(`/rooms/${r.id}/countdown`, {
              seconds,
            });
          })}
      >
        Start countdown
      </button>
    </fieldset>
    <fieldset ?disabled=${locked}>
      <h2>Visibility</h2>
      <div class="sow-setting-options">
        ${[true, false].map((value) => html`<button class=${r.private === value ? "selected" : ""} @click=${() => act(() => updateLobby(r, { private: value }))}>${value ? "Private" : "Public"}</button>`)}
      </div>
      <h2>Match type</h2>
      <div class="sow-setting-options">
        ${[true, false].map((value) => html`<button class=${roomWager(r) === value ? "selected" : ""} @click=${() => act(() => updateLobby(r, { ranked: value, stake: value ? stake : "0" }))}>${value ? "Ranked · Wager SOL" : "Unranked · Free"}</button>`)}
      </div>
      <h2>Mode</h2>
      <div class="sow-setting-options">
        ${(["ffa", "1v1", "2v2"] as Mode[]).map((value) => html`<button class=${r.mode === value ? "selected" : ""} @click=${() => act(() => updateLobby(r, { mode: value, rules: { ...r.rules, ...defaultRules(value, false), gameMap: r.rules.gameMap } }))}>${modeLabel(value)}</button>`)}
      </div>
      ${
        roomWager(r)
          ? html`<h2>Entry amount</h2>
              <div class="sow-setting-options">
                ${["0.01", "0.1", "0.25"].map((value) => html`<button class=${r.stake === value ? "selected" : ""} @click=${() => act(() => updateLobby(r, { stake: value }))}>${value} SOL</button>`)}<label
                  >Custom amount (SOL)<input
                    inputmode="decimal"
                    .value=${r.stake}
                    @change=${(e: Event) => act(() => updateLobby(r, { stake: (e.target as HTMLInputElement).value }))}
                /></label>
              </div>`
          : ""
      }
      <frontpot-game-setup
        .ranked=${roomWager(r)}
        .mode=${r.mode}
        .rules=${r.rules}
        @rules-changed=${(e: CustomEvent<Rules>) => act(() => updateLobby(r, { rules: e.detail }))}
      ></frontpot-game-setup>
    </fieldset>
  </section>`;
}
function lobbyConnecting() {
  return html`<div
    class="sow-lobby-connecting"
    role="status"
    aria-live="polite"
  >
    <span class="sow-lobby-spinner" aria-hidden="true"></span>
    <p>Connecting to lobby…</p>
  </div>`;
}
async function updateTeamOptions(
  r: PublicRoom,
  options: { allowTeamSelection?: boolean; teamsLocked?: boolean },
) {
  const updated = await api<PublicRoom>(`/rooms/${r.id}/team-options`, options);
  if (room?.id === r.id) room = updated;
}
function roomView() {
  const r = (viewingRoom ? room : previewRoom)!;
  const joined = room?.id === r.id;
  const open = ["waiting", "countdown"].includes(r.status);
  const full = r.members.length >= r.max;
  const customLobby =
    !r.queueKey && !r.automaticTeams && !r.matchmakingRoster && !r.practice;
  return html`<main class="sq-waiting">
    <header class="sq-lobby-heading">
      <button class="fp-primary" @click=${browseLobbies}>Back to games</button>
      <h1>
        ${r.locked ? "Game started" : joined && customLobby && r.host === identity?.id ? "Your lobby" : "Waiting for game start"}
      </h1>
      ${
        customLobby
          ? html`<button
              class="sow-lobby-id"
              @click=${copyInvite}
              title="Copy invite link"
            >
              ${r.id} · Copy invite
            </button>`
          : html`<span class="sow-lobby-id">Match ${r.id}</span>`
      }
      <span class="fp-pill">${matchLabel(r)}</span>
      ${
        joined
          ? html`<button
              class="fp-text-button"
              ?disabled=${busy}
              @click=${() => {
                if (
                  window.confirm(
                    r.locked
                      ? "Leave this match? Your entry is already locked."
                      : "Leave this match and cancel your entry? Any funded entry will be refunded.",
                  )
                )
                  void act(leave);
              }}
            >
              Leave match
            </button>`
          : ""
      }
    </header>
    ${
      joined && !connected && !error
        ? lobbyConnecting()
        : html`<div class="sq-lobby-body">
            <div class="sq-lobby-title">
              <h2>${mapName(r.rules.gameMap)}</h2>
              <span>${modeLabel(r.mode)}</span
              ><span>${r.queueKey ? "Global queue" : r.name}</span>
            </div>
            <div class="sq-lobby-layout">
              <div class="sq-lobby-map">
                <img
                  src=${mapImage(r.rules.gameMap)}
                  alt=${`${mapName(r.rules.gameMap)} map preview`}
                />
                <span class="sq-card-badges"
                  ><span class="sq-entry"
                    ><small>ENTRY</small>${entryLabel(r)}</span
                  >
                  <span class="sq-countdown">${countdown(r)}</span></span
                >
              </div>
              <aside
                class="sq-prize"
                aria-label=${roomWager(r) ? poolLabel(r) : "Free match"}
              >
                <span class="sq-prize-label"
                  >${roomWager(r) ? poolLabel(r).toUpperCase() : matchLabel(r).toUpperCase()}</span
                ><strong class="sq-prize-total"
                  >${roomWager(r) ? html`${solIcon()}${r.locked ? pot(r) : potentialPool(r)} <small>SOL</small>` : "Free to play"}</strong
                >
                ${r.locked || !roomWager(r) ? html`<span class="sq-pool-status ${r.locked ? "locked" : ""}"><i></i>${r.locked ? "Players locked at game start" : "No deposit needed"}</span>` : ""}
                <p>
                  ${!roomWager(r) ? "No entry fee or prize pool." : r.mode === "2v2" ? "The winning team splits the prize equally." : r.mode === "ffa" ? "Final prize depends on paid entries." : "Winner takes the prize pool."}
                </p>
                <dl>
                  <div>
                    <dt>Players ready (minimum ${r.min})</dt>
                    <dd>${r.readyCount} / ${r.max}</dd>
                  </div>
                  <div>
                    <dt>Game length</dt>
                    <dd>${r.rules.maxTimerValue} min</dd>
                  </div>
                  <div>
                    <dt>Map size</dt>
                    <dd>${r.rules.gameMapSize}</dd>
                  </div>
                </dl>
                ${roomWager(r) ? html`<small class="sq-demo-disclosure">${paymentNotice()}</small>` : ""}
                <a
                  class="sq-terms-link"
                  href="/terms"
                  target="_blank"
                  rel="noreferrer"
                  >Game terms</a
                >
              </aside>
            </div>
            <div class="sq-rules">
              ${r.rules.goldMultiplier === 2 ? html`<span>2× GOLD · Special rules</span>` : ""}
              <span
                >${r.rules.bots} Tribes ·
                ${r.rules.nations === "disabled" ? 0 : r.rules.nations === "default" ? (mapInfo(r.rules.gameMap)?.defaultNationCount ?? 0) : r.rules.nations}
                Nations</span
              ><span
                >${r.rules.randomSpawn ? "Random spawn" : "Choose your spawn"}</span
              >${r.private ? html`<span>Invite only</span>` : ""}
            </div>
            ${joined && customLobby && r.host === identity?.id && open ? lobbySettings(r) : ""}
            ${
              joined && customLobby && r.mode === "2v2"
                ? html`<section
                    class="sow-team-picker"
                    aria-label="Choose your team"
                  >
                    <h3>Teams${r.teamsLocked ? " · Locked" : ""}</h3>
                    ${
                      r.host === identity?.id
                        ? html`<section class="sow-team-host">
                            <label
                              ><input
                                type="checkbox"
                                .checked=${r.allowTeamSelection !== false}
                                ?disabled=${busy || !open}
                                @change=${(e: Event) => act(() => updateTeamOptions(r, { allowTeamSelection: (e.target as HTMLInputElement).checked }))}
                              />
                              Allow players to choose teams</label
                            >
                            <button
                              class="fp-primary"
                              ?disabled=${busy || !open}
                              @click=${() => act(() => updateTeamOptions(r, { teamsLocked: !r.teamsLocked }))}
                            >
                              ${r.teamsLocked ? "Unlock teams" : "Lock teams"}
                            </button>
                            ${r.members.map(
                              (m) =>
                                html`<label
                                  >${m.name}<select
                                    aria-label=${`Move ${m.name}`}
                                    ?disabled=${busy || !open || r.teamsLocked}
                                    .value=""
                                    @change=${(e: Event) => {
                                      const value = (
                                        e.target as HTMLSelectElement
                                      ).value;
                                      if (!value) return;
                                      const [team, swapWith] = value.split(":");
                                      void act(async () => {
                                        const updated = await api<PublicRoom>(
                                          `/rooms/${r.id}/team`,
                                          {
                                            team: Number(team),
                                            playerID: m.id,
                                            ...(swapWith ? { swapWith } : {}),
                                          },
                                        );
                                        if (room?.id === r.id) room = updated;
                                      });
                                    }}
                                  >
                                    <option value="">
                                      Team ${m.team === 0 ? "A" : "B"}
                                    </option>
                                    ${r.members.filter((p) => p.team !== m.team).length < 2 ? html`<option value=${String(1 - m.team)}>Move to Team ${m.team === 0 ? "B" : "A"}</option>` : ""}
                                    ${r.members.filter((p) => p.team !== m.team).map((p) => html`<option value=${`${p.team}:${p.id}`}>Swap with ${p.name}</option>`)}
                                  </select></label
                                >`,
                            )}
                          </section>`
                        : ""
                    }
                    ${r.allowTeamSelection === false ? html`<p>The host is assigning teams.</p>` : ""}
                    <p>
                      Playing with a friend? Copy the invite and choose the same
                      team before the match starts. Otherwise, keep your
                      automatic team assignment.
                    </p>
                    <div>
                      ${[0, 1].map((team) => {
                        const members = r.members.filter(
                          (m) => m.team === team,
                        );
                        const selected = members.some(
                          (m) => m.id === identity?.id,
                        );
                        return html`<button
                          class="fp-create"
                          aria-pressed=${selected}
                          ?disabled=${busy || !open || r.teamsLocked === true || (r.allowTeamSelection === false && r.host !== identity?.id) || selected || members.length >= 2}
                          @click=${() =>
                            act(async () => {
                              const updated = await api<PublicRoom>(
                                `/rooms/${r.id}/team`,
                                { team },
                              );
                              if (room?.id === r.id) room = updated;
                            })}
                        >
                          <strong
                            >Team
                            ${team === 0 ? "A" : "B"}${selected ? " · Your team" : ""}</strong
                          ><span
                            >${members.length}/2 ·
                            ${members.map((m) => m.name).join(", ") || "Open"}</span
                          >
                        </button>`;
                      })}
                    </div>
                  </section>`
                : ""
            }
            <section class="sq-players" aria-label="Lobby players">
              <div class="sq-players-heading">
                <h3>
                  ${r.members.length} PLAYERS
                  <span>· ${r.readyCount} READY</span>
                </h3>
                ${customLobby ? html`<button class="fp-text-button" @click=${copyInvite}>Copy invite</button>` : ""}
              </div>
              <div class="sq-player-list">
                ${
                  r.members.length
                    ? r.members.map(
                        (m) =>
                          html`<div class="sq-player ${m.ready ? "ready" : ""}">
                            <a
                              class="sp-lobby-player"
                              href=${`/player/${encodeURIComponent(m.id)}`}
                              target="_blank"
                              rel="noopener"
                              aria-label=${`View ${m.name}'s profile in a new tab`}
                              ><span class="sq-player-badges">
                                ${
                                  m.levelBadge
                                    ? html`<level-badge
                                        .level=${m.levelBadge.level}
                                        .prestige=${m.levelBadge.prestige}
                                        ?legend=${m.levelBadge.legend}
                                        size="44"
                                      ></level-badge>`
                                    : ""
                                }
                                ${rankBadge(m.rank?.tier ?? "Unranked")} </span
                              ><span
                                ><strong
                                  >${m.name}${m.id === identity?.id ? " (you)" : ""}</strong
                                >
                                ${html`<small>${m.rank?.tier ?? "Unranked"}${typeof m.rank?.rating === "number" ? ` · ${m.rank.rating.toLocaleString()} Elo` : ""}</small>`}
                                <small
                                  >${customLobby && m.id === r.host ? "Host · " : ""}${r.mode === "2v2" ? `Team ${m.team === 0 ? "A" : "B"} · ` : ""}${m.ready ? "Ready" : isFunded() && roomWager(r) ? "Waiting for funded entry" : "Connecting…"}</small
                                ></span
                              ></a
                            >
                          </div>`,
                      )
                    : html`<p>No players yet. Be the first to join.</p>`
                }
              </div>
            </section>
            <div class="sq-lobby-entry">
              ${joined && isFunded() && roomWager(r) ? paymentView(funding, r.stake, () => void act(fundEntry), busy, isMainnet() ? "mainnet" : "devnet", !!authConfig?.playerWalletsEnabled && !authConfig?.userOwnedWalletsEnabled && funding?.fundingSource !== "external") : ""}
            </div>
          </div>`
    }
    <footer class="sq-lobby-footer">
      <div>
        <small>STATUS</small
        ><strong
          >${r.status === "finished" ? "Match complete" : r.locked ? "Match started" : joined && !connected ? "Connecting to game…" : r.startsAt ? (countdown(r) === "Closing…" ? "Closing entries…" : `Starting in ${countdown(r)}`) : r.queueKey ? `${countdown(r)} · Waiting for earlier games` : r.private ? "Waiting for host to start" : "Waiting for players"}</strong
        >
      </div>
      ${
        joined && customLobby && r.private && open && r.host === identity?.id
          ? html`<button
              class="fp-primary"
              ?disabled=${busy || !connected || r.readyCount < r.min || r.readyCount !== r.members.length}
              @click=${() =>
                act(async () => {
                  room = await api<PublicRoom>(`/rooms/${r.id}/start`, {});
                })}
            >
              Start match
            </button>`
          : joined
            ? html`<span class="sq-seated"
                >${r.locked ? "In game" : "You're in the lobby"}</span
              >`
            : html`<button
                class="fp-primary"
                ?disabled=${busy || !open || full || countdown(r) === "Closing…"}
                @click=${() => act(() => join(r.id))}
              >
                ${!open ? "Entries closed" : full ? "Lobby full" : identity?.name ? "Join game" : "Sign in to join"}
              </button>`
      }
      <span
        class="sq-lobby-capacity"
        aria-label="${r.members.length} of ${r.max} player seats filled"
        >${icon("users")}${r.members.length}/${r.max}</span
      >
    </footer>
  </main>`;
}
function howToPlayView() {
  return html`<main class="sq-terms">
    <a class="fp-primary" href="/">Back to games</a>
    <p class="fp-eyebrow">SOL OF WAR</p>
    <h1>How to Play</h1>
    <p>
      Choose a spawn, expand your territory and eliminate the opposition. Learn
      the controls in the free tutorial, then review the rules below before
      joining a match.
    </p>
    <button
      class="fp-primary"
      ?disabled=${busy || !!room}
      @click=${() => act(startTutorial)}
    >
      Start free tutorial
    </button>
    ${gameRulesContent()}
    <p><a href="/terms">Payment information and terms</a></p>
  </main>`;
}
function termsView() {
  return html`<main class="sq-terms">
    <a class="fp-primary" href="/">Back to games</a>
    <p class="fp-eyebrow">SOL OF WAR · ${modeBadge()}</p>
    <h1>Terms of Service</h1>
    <p class="sq-terms-date">Updated October 31, 2026</p>
    <h2>Using Sol of War and contacting us</h2>
    <p>Sol of War inc., a California corporation, operates Sol of War at solofwar.fun.
    These terms govern accounts,
    games, wallets and cosmetics. By using the service you agree to these terms.
    You must be able to enter this agreement. Paid play is for adults of at least
    18 years old, or the higher applicable legal age, and only where participation
    is lawful. Availability of a feature is not confirmation that you are eligible.</p>
    <p>For account support, payment questions or concerns about these terms,
    email <a href="mailto:team@solofwar.fun">team@solofwar.fun</a>.
    Our <a href="/privacy">Privacy Policy</a> explains information handling.</p>
    <h2>Accounts, cosmetics and uploaded content</h2>
    <p>Use accounts you control, keep sign-in methods secure and report suspected
    compromise. Never send support your private key or recovery phrase.</p>
    <p>Cosmetics are optional and do not provide gameplay advantages. The shop
    displays the price in $SOLOFWAR before approval. A purchase burns the specified
    tokens on Solana; it is not a SOL payment or a payment of tokens to the operator.
    An entitlement is granted after the purchase is verified. The platform sponsors
    supported purchase network fees subject to availability and limits; buying tokens
    or sending funds through external services may incur separate fees.</p>
    <p>A finalized burn cannot be reversed on-chain. Contact support about failed
    delivery, duplicate charges or other purchase problems; this does not exclude
    statutory remedies or rights that cannot lawfully be waived. A cosmetic purchase
    does not convey ownership of the platform or promise resale value, investment
    returns, token price or future features.</p>
    <p>You retain rights you hold in uploaded images and must have permission to use
    them. You grant Sol of War a non-exclusive permission to store, process and display
    them as needed to provide previews, purchased cosmetics and gameplay. Do not upload
    unlawful, infringing, abusive or malicious content. We may restrict content or accounts
    for rights complaints, abuse or security reasons. Contact support to report a concern
    or request review of a moderation decision, identifying the item and relevant rights.</p>
    <h2>Availability, external services and changes</h2>
    <p>Features may change or become unavailable. Keep copies of your uploaded work
    and protect wallet recovery information. External wallets, Privy and linked services
    have their own terms. No uninterrupted service, game outcome or token value is promised.
    Nothing in these terms removes rights or protections that cannot lawfully be excluded.</p>
    <p>You may stop using the service and contact us to request account deletion.
    Unsettled payments, disputes and records required for legal or security purposes
    may need to be resolved or retained, as explained in the Privacy Policy. Material
    changes to these terms will receive notice or consent where required.</p>
    <p>© 2026 Sol of War inc.</p>

    ${
      authConfig?.userOwnedWalletsEnabled
        ? html`<h2>Personal wallets and legacy balances</h2>
            <p>
              Your new wallet is owned by your Privy account. Sol of War
              registers no server spending signer. You approve transfers through
              your wallet and can export your key through Privy’s protected
              interface. Protect your sign-in methods and device; this does not
              remove provider, account compromise or website risks. Sol of War
              sponsors network fees for new in-app entries and withdrawals,
              subject to availability and usage limits. External wallet funding
              and transfers made outside the app may still charge your wallet.
            </p>
            <p>
              Older account wallets remain under platform custody until you
              approve migration to your new wallet. Existing match refunds and
              payouts keep their original destinations. Sol of War retains
              legacy keys and backups; exporting an old key would not eliminate
              that custody.
            </p>`
        : authConfig?.playerWalletsEnabled
          ? html`<h2>Sol of War wallets</h2>
              <p>
                Sol of War creates and manages a dedicated Solana wallet for
                your account and controls its signing keys. Funding your wallet
                does not join a match. Confirming a Ranked entry authorizes its
                transfer to that match’s pool. Withdrawals require your
                confirmation and return available SOL to your verified connected
                wallet or another valid destination you select. The platform
                currently covers outgoing network fees. SOL sent to your deposit
                address appears after final confirmation; unsupported tokens are
                not credited.
              </p>`
          : ""
    }
    <h2>Custodial match pools</h2>
    <p>
      Wagering transfers SOL into match pools controlled by Sol of War. The
      operator retains signing authority for these pools and platform systems
      determine game results. Trustless escrow is not implemented, and no
      independent security audit has been completed.
    </p>
    <h2>Ranked, FFA Wagers and Free Play</h2>
    <p>
      Ranked offers paid 1v1 and 2v2 with separate Elo ratings. FFA Wagers have
      a SOL entry fee and prize pool but no Elo. Free Play offers all three
      modes without an entry fee or prize. Verified Free Play and FFA Wagers
      earn XP. SOL wagers and saved progression require a signed-in profile;
      guests can play free, and the tutorial requires no account.
    </p>
    ${
      isDevnet()
        ? html`<h2>Devnet test</h2>
            <p>
              This invitation-only test transfers devnet SOL, which has no
              monetary value and cannot be redeemed. Each entry needs a separate
              wallet approval. Only finalized deposits from connected players
              count toward the prize. Late, cancelled and excluded entries are
              refunded without a platform fee. New supported in-app entries and
              withdrawals use platform-paid network fees. External deposit
              network fees are not refundable. The platform also covers payout
              and refund transaction fees. A result is not paid until its
              transaction is finalized; failed or expired transactions require
              reconciliation. Do not send mainnet SOL or transfers outside the
              entry button.
            </p>`
        : ""
    }
    ${
      isMainnet()
        ? html`<h2>Real SOL entries</h2>
            <p>
              Wagered matches use SOL on Solana mainnet. Each entry requires a
              ${authConfig?.playerWalletsEnabled && !authConfig?.userOwnedWalletsEnabled ? "confirmation using your legacy Sol of War balance." : "separate wallet approval."}
              Winnings and refunds return to the wallet that funded the entry.
              Only finalized deposits qualify. Late or cancelled entries are
              refunded in full without a platform fee. New supported in-app
              entries and withdrawals use platform-paid network fees, subject to
              availability and limits. External direct deposits and older
              prepared requests may charge the sender; those network fees are
              not refunded. The platform pays payout and refund network fees.
              Prizes remain pending until platform systems verify the result and
              the payout transaction is finalized. The tutorial is free.
            </p>`
        : ""
    }
    ${
      !isFunded()
        ? html`<h2>Simulation mode</h2>
            <p>
              In simulation mode, Sol of War uses simulated SOL. Entry amounts,
              prize pools and payouts have no monetary value. No real SOL is
              collected or transferred, and demo prizes cannot be redeemed.
              Wallet sign-in verifies your identity; it does not authorize a
              payment. The tutorial is free and requires no account.
            </p>`
        : ""
    }
    <h2>Guest Free Play</h2>
    <p>
      Guests can choose a temporary username and play Free Play without a
      wallet. Guest sessions do not save XP, profile statistics or ranked
      progression. Guest sessions expire and may end when the service restarts.
      SOL wagers and account features require verified wallet sign-in.
    </p>
    <h2>Entry and prize pools</h2>
    <p>
      The displayed entry amount applies to each player. The prize pool equals
      the total eligible entries before the 1% platform fee. Potential prize
      pools show full-capacity entries before the fee; they are not guaranteed
      payouts. The winner’s end card shows the platform fee and final payout
      after that deduction. The fee is deducted from the pool, not added to the
      entry amount.
    </p>
    <div class="sq-terms-example">
      <strong>Example</strong>
      <p>
        25 players × 0.25 SOL = 6.25 SOL in entries.<br />1% platform fee =
        0.0625 SOL.<br /><b>Winner payout after fee = 6.1875 SOL.</b>
      </p>
    </div>
    <h2>Matchmaking acceptance</h2>
    <p>
      Choose an exact entry and mode. Both friends must ready up to queue as a
      party. Changing party settings clears readiness. A complete match gets one
      30-second acceptance deadline: both 1v1 players or all four 2v2 players
      must accept. Declined or expired offers are cancelled without charging an
      entry. Accepted solo players and fully accepted parties resume searching;
      others must ready up again. After acceptance, everyone has up to two
      minutes to connect and confirm funding. The match starts when the entire
      roster is ready; otherwise it closes and funded entries are refunded. A
      disconnect after the match starts does not cancel the game or erase its
      result.
    </p>
    <h2>Countdown and lock</h2>
    <p>
      The first game in the global queue has a two-minute countdown. Later games
      show their queue position and accept players while waiting. Any public
      lobby starts immediately when every player slot is connected and ready,
      including finalized deposits for all paid games, regardless of queue
      position. When the first game starts or closes, it leaves the queue, the
      next game gets a full two-minute countdown and a replacement is generated
      at the end. Each lobby shows its minimum and capacity. 1v1 requires 2
      players and 2v2 requires 4, with 2 on each team. If the minimum is not met
      at zero, the lobby closes, paid entries are refunded without a fee, and
      the queue advances. The countdown does not restart. Custom public lobbies
      have their own two-minute countdown. Invite-only matches start when the
      host chooses, after all players are connected and entries confirmed.
    </p>
    <p>
      Only authenticated players with a username and an active game connection
      count toward the prize. Tribes, Nations, spectators and unfinished
      connections do not contribute. Before zero, the displayed pool can
      increase or decrease as players connect or leave. At zero, the server
      locks the eligible roster, payout wallet addresses and prize amount. Late
      entries cannot alter them. Disconnecting after the lock does not reduce
      the pool.
    </p>
    ${gameRulesContent()}
    <h2>Settlement and payout rounding</h2>
    <p>
      Free-for-all and 1v1 award the whole net prize to the winner. In 2v2, the
      two winning teammates split it equally. Calculations use whole lamports (1
      SOL = 1,000,000,000 lamports). Any indivisible remainder goes to the first
      winning player in the locked roster. Results are replayed and verified by
      the server before
      ${isFunded() ? "a payout is authorized. Payment is complete only after the transaction finalizes." : "a simulated payout is recorded."}
    </p>
    <h2>Cancelled or interrupted games</h2>
    <p>
      You may leave before the lock without a platform fee. An abandoned
      connection is removed before a game starts. Cancelled games and games with
      no eligible human winner return ${isFunded() ? "funded" : "simulated"}
      entries with no platform fee. If the result cannot be verified, it is
      marked for review and no payout is authorized. Server restarts may
      interrupt matches; interrupted entries are refunded.
    </p>
    <h2>Levels, ratings and matchmaking</h2>
    <p>
      Verified Free Play and FFA Wagers earn 100 XP for completion and a 150 XP
      win bonus. Ranked uses separate 1v1 and 2v2 Elo, starting at 1,000 with
      ten placement matches. Only verified, settled Ranked results affect Elo.
    </p>
    <p>
      Private, cancelled, refunded and unverified matches do not affect ranked
      ratings. Repeated opponents have reduced rating weight within 24 hours:
      full, half, quarter, then zero. Matchmaking widens its skill range with
      waiting time up to a hard 300-Elo spread between solo players and party
      skill ratings, matches your exact entry amount, and asks every participant
      to accept one shared match offer. Established players start within 150
      Elo; placement players start within 250. The search expands by 25 Elo
      every 30 seconds, never beyond 300. Public Ranked lobbies are filtered to
      your skill and enforce the same cap on direct joins. Private custom games
      are unrated. A full two-player party can queue 2v2 with any internal Elo
      gap. Both players accept the same offer and stay on one team. The party
      uses its stronger player's Elo to find opponents; solo players still have
      skill limits.
    </p>
    <h2>Ranked Elo and placements</h2>
    <p>
      Each player has a separate skill rating for 1v1 and 2v2. FFA does not
      change Elo. Each mode starts internally at 1,000 Elo. Your badge and Elo
      remain Unranked until you complete 10 counted placement matches in that
      mode. Ranked Elo is separate from Unranked XP, levels and prestige. Entry
      amount never increases rating rewards.
    </p>
    <p>
      Ratings update after a public, paid Ranked match has a verified result and
      finalized settlement. Private matches, Free matches, practice, cancelled
      or refunded matches, pending settlements and unverified results do not
      count. Each result is applied only once.
    </p>
    <h3>How the calculation works</h3>
    <p>
      We compare your result with the result expected from the ratings before
      the match. Beating a stronger opponent earns more Elo; losing to a weaker
      opponent costs more. The expected score is 1 / (1 + 10^((opponent rating −
      your rating) / 400)). The actual comparison score is 1 for finishing
      ahead, 0 for finishing behind, and 0.5 for a tied placing.
    </p>
    <p>
      For each opponent comparison, the change is repeat weight × K × (actual
      score − expected score), divided by the mode's comparison count. K is 48
      if either player in that comparison is still in placements, otherwise 32.
      We add the comparisons, round the resulting change to a whole point, and
      keep ratings at or above zero.
    </p>
    <ul>
      <li>
        <strong>1v1:</strong> one opponent comparison. At equal ratings with no
        repeat reduction, a win earns 24 Elo during placements or 16 Elo when
        both players have completed placements; a loss costs the same amount.
      </li>
      <li>
        <strong>2v2:</strong> expected scores use each team's average rating for
        solo teams, or the stronger player's rating for a full premade party.
        Each player is compared with both opposing players, and each comparison
        is divided by two. Winning teammates receive a win. Placement status and
        repeat-opponent history are still evaluated per player comparison, so
        teammates can receive different changes.
      </li>
    </ul>
    <h3>Repeat opponents and counted matches</h3>
    <p>
      Against the same opponent in the same mode and network within a rolling
      24-hour window, comparisons receive full weight the first time, half
      weight the second, quarter weight the third, and zero weight thereafter. A
      match advances your placements and win–loss record only if at least one
      opponent comparison has nonzero weight. A counted match may still produce
      a zero-point rating change. Partially reduced matches still count as one
      match.
    </p>
    <h3>Rank divisions</h3>
    <p>
      After placements, your current Elo determines your badge. Division III is
      higher than II, and II is higher than I. Crossing a threshold changes your
      badge in either direction.
    </p>
    <ul>
      ${RANK_TIERS.map((tier) => html`<li><strong>${tier}:</strong> ${rankRange(tier)}</li>`)}
    </ul>
    <h2>Fair play and accounts</h2>
    <p>
      Keep access to your wallet secure. Do not impersonate other players,
      cheat, exploit software bugs, interfere with matches or manipulate
      results. These rules apply to both Free and Wager games.
    </p>
    <p>
      Automated match-integrity checks flag results that cannot be verified for
      internal review. A flag alone is not proof of cheating. Our team reviews
      flagged cases and reports of suspected cheating or exploiting before
      deciding whether a violation occurred.
    </p>
    <p>
      Players found to be cheating, exploiting bugs or manipulating matches may
      have their accounts suspended or permanently banned from Sol of War,
      including both Free and Wager games.
    </p>
    <p>
      Usernames and game activity are visible to other players. The service may
      change or become unavailable as development continues.
    </p>
    ${
      !isMainnet()
        ? html`<h2>Real-money play</h2>
            <p>
              Real-money entry and payouts are not available under these demo
              terms. Any future release involving real funds will require
              separate published terms, eligibility rules and payment details
              before players can participate.
            </p>`
        : ""
    }
  </main>`;
}
function setupView() {
  return html`<main class="fp-setup-page">
    <button
      class="fp-text-button"
      @click=${() => {
        goPlay();
      }}
    >
      Back to play
    </button>
    <p class="fp-eyebrow">${practiceSetup ? "Single player" : "Multiplayer"}</p>
    <h1>
      ${practiceSetup ? "Practice your strategy" : "Create your battlefield"}
    </h1>
    <p class="fp-intro">
      ${maps.length} maps. The original game settings. Your rules.
    </p>
    ${playerBar()} ${!practiceSetup ? matchTypeTabs() : ""}
    <div class="fp-setup-controls">
      ${
        !practiceSetup
          ? html`<label
                >Mode<select
                  .value=${mode}
                  @change=${(e: Event) => {
                    mode = (e.target as HTMLSelectElement).value as Mode;
                    paint();
                  }}
                >
                  ${category !== "ranked" ? html`<option value="ffa">Free for all</option>` : ""}
                  ${
                    category !== "ffa"
                      ? html`<option value="1v1">1v1</option>
                          <option value="2v2">2v2</option>`
                      : ""
                  }
                </select></label
              >
              ${
                ranked
                  ? html`<label
                      >Entry stake (${moneyLabel()})<input
                        inputmode="decimal"
                        .value=${stake}
                        @input=${(e: Event) => {
                          stake = (e.target as HTMLInputElement).value;
                          paint();
                        }}
                    /></label> `
                  : html`<p>Unranked · Free multiplayer</p>`
              }
              <label class="fp-checkbox"
                ><input
                  type="checkbox"
                  .checked=${privateRoom}
                  @change=${(e: Event) => {
                    privateRoom = (e.target as HTMLInputElement).checked;
                  }}
                />Invite only</label
              >`
          : html`<p>Free practice. No entry stake.</p>`
      }
    </div>
    ${mode !== "ffa" && !practiceSetup ? html`<p class="fp-small">${mode} uses 100 tribes on Compact maps or 400 on Normal maps, with nations disabled. Only human players can win. Other rules below apply.</p>` : ""}
    <frontpot-game-setup
      .ranked=${!practiceSetup && ranked}
      .mode=${practiceSetup ? "ffa" : mode}
      .rules=${rules}
      @rules-changed=${(e: CustomEvent<Rules>) => {
        rules = e.detail;
        paint();
      }}
    ></frontpot-game-setup>
    <div class="fp-setup-bottom">
      <span>${mapName(rules.gameMap)} · ${rules.gameMapSize}</span
      ><button
        class="fp-primary"
        ?disabled=${busy}
        @click=${() => act(() => quickPlay(practiceSetup))}
      >
        ${practiceSetup ? "Start practice" : "Create lobby"}
      </button>
    </div>
  </main>`;
}
async function replayMatch(pool: Pick<Pool, "matchID" | "name">) {
  if (room || inGame)
    throw new Error("Leave your current match before watching a replay.");
  const record = GameRecordSchema.parse(
    await api(`/history/${pool.matchID}/replay`),
  );
  await fetchCosmetics();
  const client = await loadGameClient();
  // Joining a match while the replay loads must not replace its live connection.
  if (room || inGame)
    throw new Error("Leave your current match before watching a replay.");
  replayTitle = `Replay · ${pool.name}`;
  inGame = true;
  document.body.classList.add("in-game");
  try {
    handle = client.joinLobby(new EventBus(), {
      gameID: record.info.gameID,
      playerName: identity!.name,
      playerClanTag: null,
      playerRole: null,
      cosmetics: {},
      turnstileToken: null,
      gameStartInfo: toWireGameStartInfo(record.info),
      gameRecord: record,
      spectator: true,
    });
  } catch (e) {
    inGame = false;
    document.body.classList.remove("in-game");
    throw e;
  }
  paint();
  void handle.join.catch((e) => {
    error = String(e);
    inGame = false;
    document.body.classList.remove("in-game");
    paint();
  });
}
function historyView() {
  return html`<main class="fp-setup-page">
    <button
      class="fp-text-button"
      @click=${() => {
        showHistory = false;
        paint();
      }}
    >
      Back to play
    </button>
    <p class="fp-eyebrow">Your matches</p>
    <h1>Match history</h1>
    <p class="fp-intro">
      ${isMainnet() ? "Verified match results and Solana payment receipts." : isDevnet() ? "Server-verified results and devnet transaction receipts. Test SOL has no monetary value." : "Server-verified results and simulated payouts. No real SOL is transferred."}
    </p>
    ${
      paymentHistory.length && isFunded()
        ? html`<section class="fp-help" aria-label="Payment receipts">
            <h2>Entry payments</h2>
            ${paymentHistory.map(
              (p) =>
                html`<article class="fp-history-card">
                  <div>
                    <strong>Match ${p.matchID}</strong>
                    <p>
                      ${paymentLabel(p.state)} · ${p.lamports / 1e9}
                      ${currencyLabel(p.network)}
                    </p>
                  </div>
                  <div>
                    ${p.depositSignature ? html`<a href=${transactionLink(p.depositSignature, p.network)} target="_blank" rel="noreferrer">Deposit</a>` : ""}
                    ${p.refundSignature ? html`<a href=${transactionLink(p.refundSignature, p.network)} target="_blank" rel="noreferrer">Refund</a>` : ""}
                  </div>
                </article>`,
            )}
          </section>`
        : ""
    }
    ${
      matchHistory.length
        ? matchHistory.map((p) => {
            const payout = p.payouts.find((x) => x.playerID === identity?.id);
            return html`<article class="fp-history-card">
              <div>
                <h2>${p.name}</h2>
                <p>
                  ${mapName(p.map)} ·
                  ${p.practice ? "Practice" : p.ranked ? "Ranked" : p.stakeLamports > 0 ? "FFA Wager" : "Free Play"}
                  · ${modeLabel(p.mode)} ·
                  ${new Date(p.created).toLocaleString()}
                </p>
                <p>${p.reason}</p>
              </div>
              <div>
                <strong>${p.state}</strong>
                <p>
                  ${p.stakeLamports === 0 ? "Free match" : payout ? `${(payout.lamports / 1e9).toLocaleString("en-US", { maximumFractionDigits: 9 })} ${currencyLabel(p.network)}` : "No payout recorded"}
                </p>
                ${p.stakeLamports > 0 ? html`<small>Pool ${p.poolID.slice(0, 8)}</small>` : ""}
                ${p.signature ? html`<a href=${transactionLink(p.signature, p.network === "mainnet" ? "mainnet" : "devnet")} target="_blank" rel="noreferrer">View payout</a>` : ""}
                ${p.replayAvailable ? html`<button class="fp-create" @click=${() => act(() => replayMatch(p))}>Watch replay</button>` : ""}
              </div>
            </article>`;
          })
        : html`<section class="fp-help">
            <p>Your matches appear here after they start.</p>
            <button class="fp-primary" @click=${() => openSetup(true)}>
              Play a practice match
            </button>
          </section>`
    }
  </main>`;
}
let refreshing = false;
let listsCheckedAt = 0;
async function refresh() {
  if (
    refreshing ||
    Date.now() < apiRetryAt ||
    (document.hidden && !room && !matchSearch)
  )
    return;
  refreshing = true;
  const roomID = room?.id;
  const previewID = previewRoom?.id;
  try {
    if (identity && !inGame && !busy && Date.now() - partyCheckedAt > 5000) {
      partyCheckedAt = Date.now();
      party = await api("/party");
      if (party) {
        searchMode = "2v2";
        searchWagerFFA = false;
        searchRanked = party.settings.ranked;
        searchBudget = party.settings.budget;
      }
    }
    if (identity && !inGame && !searchPolling && !busy) {
      searchPolling = true;
      const owner = identity.id;
      try {
        const next =
          await api<ReturnType<Matchmaking["status"]>>("/matchmaking");
        if (identity?.id === owner) {
          const previous = matchSearch;
          matchSearch = next;
          searchReceivedAt = Date.now();
          if (!next && !room && Date.now() - activeRoomCheckedAt > 5000) {
            activeRoomCheckedAt = Date.now();
            const active = await api<PublicRoom | null>("/active-room");
            if (active) {
              showMatchmaking = false;
              await enter(active, !previous?.offer);
              return;
            }
            if (previous?.offer)
              notice =
                "The match was cancelled because not everyone accepted. Ready up to search again.";
          }
        }
        paint();
      } finally {
        searchPolling = false;
      }
    }
    if (!inGame && Date.now() - availabilityCheckedAt > 15_000) {
      availabilityCheckedAt = Date.now();
      const next = await api<typeof availability>("/availability").catch(
        () => null,
      );
      if (next) availability = next;
    }
    if (
      identity?.name &&
      !inGame &&
      authConfig?.playerWalletsEnabled &&
      !balanceRefreshing &&
      Date.now() - balanceCheckedAt > (showWallet ? 5000 : 15000)
    ) {
      balanceCheckedAt = Date.now();
      balanceRefreshing = true;
      void playerWalletView
        .refresh()
        .catch(() => {
          // Preserve the last verified balance, including zero, during RPC retries.
        })
        .finally(() => {
          balanceRefreshing = false;
          paint();
        });
    }
    if (room && !inGame) {
      const next = await api<PublicRoom>(`/rooms/${roomID}`);
      if (room?.id !== roomID) return;
      room = next;
      if (isFunded() && roomWager(next)) {
        const status = await api<PaymentStatus>(`/payments/${roomID}`);
        if (room?.id === roomID) funding = status;
      }
      paint();
    }
    if (showAdmin && !inGame) {
      await refreshAdmin(api);
      paint();
    } else if (showHistory && !inGame) {
      matchHistory = await api<Pool[]>("/history");
      if (isFunded()) paymentHistory = await api<PaymentStatus[]>("/payments");
      paint();
    } else if (previewRoom && !inGame) {
      const next = await api<PublicRoom>(`/rooms/${previewID}`);
      if (previewRoom?.id !== previewID) return;
      previewRoom = next;
      paint();
    } else if (
      !inGame &&
      !showMatchmaking &&
      !showWallet &&
      !showProfile &&
      !showTerms &&
      !setupOpen &&
      (!room || !viewingRoom) &&
      Date.now() - listsCheckedAt >= 5000
    ) {
      listsCheckedAt = Date.now();
      [rooms, liveGames] = await Promise.all([
        api<PublicRoom[]>("/rooms"),
        api<PublicRoom[]>("/live-games"),
      ]);
      roomsLoaded = true;
      roomsError = false;
      paint();
    }
  } catch (e) {
    if (e instanceof Error && "status" in e && e.status === 429) {
      // Background polling retries automatically; keep the search and last good data visible.
      if (error === rateLimitMessage) error = "";
      paint();
      return;
    }
    if (
      roomID &&
      room?.id === roomID &&
      !inGame &&
      e instanceof Error &&
      "status" in e &&
      e.status === 404
    ) {
      generation++;
      room = null;
      handle?.stop(true);
      handle = null;
      sessionStorage.removeItem("frontpot-room");
      error = "";
      notice =
        "That lobby is no longer available. Browse the latest games below.";
      browseLobbies();
      return;
    }
    if (previewID && previewRoom?.id === previewID) {
      error = e instanceof Error ? e.message : t("request_error");
      previewRoom = null;
      browseLobbies();
      return;
    }
    if (!room && !inGame) {
      roomsError = true;
      paint();
    }
    if (room && !inGame) {
      error = e instanceof Error ? e.message : t("request_error");
      paint();
    }
  } finally {
    refreshing = false;
  }
}
window.addEventListener("exit-game-to-home", (event) => {
  event.preventDefault();
  void act(leave);
});
document.addEventListener("leave-lobby", () => void act(leave));
window.showPage = () => {
  if (inGame || room) void leave();
};
// Language initialization completes asynchronously, even with bundled English.
await new Promise((resolve) => setTimeout(resolve, 50));
paint();
window.dispatchEvent(new Event("sow:ready"));
if (location.pathname === "/tutorial") void act(startTutorial);
document.addEventListener("start-tutorial", () => void act(startTutorial));
// Restore only server-validated sessions; guests remain restricted to free play.
try {
  authConfig = await api("/config");
  if (userPreview()) {
    sessionStorage.setItem("sow-user-preview", "1");
    identity = {
      id: "local-preview",
      token: "",
      name: "JohnTester",
      wallet: "preview-only",
      expires: Date.now() + 86400000,
      icon: "shield",
      color: "orange",
    };
    notice = "Local signed-in preview · Sample data · No real wallet or SOL";
  } else {
    if (sessionStorage.getItem("frontpot-session")) {
      try {
        identity = await api<Identity>("/session");
      } catch {
        clearIdentity();
      }
    }
    if (!identity?.guest && authConfig?.privyAppID) await refreshIdentity();
    else if (!identity?.guest) clearIdentity();
  }
} catch {
  clearIdentity();
}
authRestoring = false;
setInterval(() => {
  if (identity)
    void refreshIdentity().catch(() => {
      if (identity && identity.expires <= Date.now()) {
        clearIdentity();
        paint();
      }
    });
}, 5 * 60_000);
paint();
if (showProfile) await profiles.load(initialProfile);
if (location.pathname === "/shop") await act(() => shopView.refresh());
setInterval(() => {
  if (location.pathname === "/shop" && !document.hidden && !busy)
    void shopView.refresh().catch(() => {});
}, 10_000);
await refresh();
if (invite) await act(() => viewLobby(invite));
setInterval(() => void refresh(), 2000);
const heartbeat = () => {
  if (identity?.name && !document.hidden)
    void api("/presence", {}).catch(() => {});
};
setInterval(heartbeat, 30_000);
document.addEventListener("visibilitychange", () => {
  heartbeat();
  if (!document.hidden) void refresh();
});
window.addEventListener("online", () => void refresh());
heartbeat();
setInterval(() => {
  if (!document.hidden && !inGame && !showTerms && !authOpen) paint();
}, 250);
prefetchGameClient();
// Restore membership from the authenticated server, never leave because a page loaded.
if (identity?.name) {
  try {
    const active = await api<PublicRoom | null>("/active-room");
    if (active) await enter(active, active.id !== invite);
    else sessionStorage.removeItem("frontpot-room");
  } catch (e) {
    error = e instanceof Error ? e.message : "Could not restore your match.";
    paint();
  }
}

document.addEventListener("click", (event) => {
  const accountLink = (event.target as Element).closest<HTMLAnchorElement>(
    'a[href="/profile"], a[href="/wallet"]',
  );
  if (
    accountLink &&
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  ) {
    event.preventDefault();
    if (accountLink.getAttribute("href") === "/wallet")
      void act(openPlayerWallet);
    else void openProfile();
    return;
  }
  if (accountMenuOpen && !(event.target as Element).closest(".sp-account")) {
    accountMenuOpen = false;
    paint();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && accountMenuOpen) {
    accountMenuOpen = false;
    paint();
    document
      .querySelector<HTMLButtonElement>(".sp-account .fp-wallet")
      ?.focus();
  }
});
