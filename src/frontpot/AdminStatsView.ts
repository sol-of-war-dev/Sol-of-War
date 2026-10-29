import { html } from "lit";
import type { AdminStatsSnapshot } from "./AdminStats";

let period: "allTime" | "last24Hours" = "allTime";
export function formatAdminSol(lamports: string) {
  const value = BigInt(lamports);
  const fraction = (value % 1_000_000_000n)
    .toString()
    .padStart(9, "0")
    .replace(/0+$/, "");
  return (
    (value / 1_000_000_000n).toLocaleString("en-US") +
    (fraction ? `.${fraction}` : "")
  );
}
const count = (n: number) => n.toLocaleString("en-US");
const when = (n: number) => new Date(n).toLocaleString();
const stateLabel = (state: string) =>
  ({
    playing: "In game",
    verifying: "Verifying",
    payout_pending: "Payout pending",
    refund_pending: "Refund pending",
    review: "Needs review",
    settled: "Paid out",
    refunded: "Refunded",
  })[state] ?? state;
function metric(label: string, value: string, detail: string, sol = false) {
  return html`<div class="sa-stat">
    <dt>${label}</dt>
    <dd>
      ${value}${sol ? html`<small>SOL</small>` : ""}
      <p>${detail}</p>
    </dd>
  </div>`;
}
export function adminStatsView(
  stats: AdminStatsSnapshot | undefined,
  paint: () => void,
  failed: boolean,
  serverNow = Date.now(),
) {
  if (!stats)
    return html`<p class="fp-message" role="status">Stats are unavailable.</p>`;
  const totals = stats[period];
  const label = period === "allTime" ? "All time" : "Last 24 hours";
  const stale = failed || serverNow - stats.generatedAt > 15_000;
  const needsReview = stats.reviewMatches + stats.delayedVerifications;
  return html`<section class="sa-overview" aria-labelledby="sa-overview-title">
    <div class="sa-stats-heading">
      <div>
        <h2 id="sa-overview-title">Overview</h2>
        <p class=${stale ? "sa-stats-status stale" : "sa-stats-status"}>
          <i></i>${stale ? "Updates interrupted" : "Live"} · Updated
          ${new Date(stats.generatedAt).toLocaleTimeString()}
        </p>
      </div>
      <div
        class="sa-period"
        role="group"
        aria-label="Financial reporting period"
      >
        ${(["allTime", "last24Hours"] as const).map(
          (p) =>
            html`<button
              aria-pressed=${period === p}
              @click=${() => {
                period = p;
                paint();
              }}
            >
              ${p === "allTime" ? "All time" : "Last 24 hours"}
            </button>`,
        )}
      </div>
    </div>
    <dl class="sa-stats-bar">
      ${metric("Active players", count(stats.activePlayers), "Unique players · last 90 seconds")}
      ${metric("Registered players", count(stats.registeredPlayers), "Wallet and username · all time")}
      ${metric("Total wagered", formatAdminSol(totals.wageredLamports), `${label} · locked entries`, true)}
      ${metric("Paid out", formatAdminSol(totals.paidOutLamports), `${label} · winner payouts`, true)}
      ${metric("Fees collected", formatAdminSol(totals.feesLamports), `${label} · settled matches`, true)}
      ${metric("Unsettled pools", formatAdminSol(stats.unsettledLamports), "Current · playing or awaiting result", true)}
    </dl>
    <dl class="sa-activity-bar">
      ${[
        ["Players in games", stats.playersInGames],
        ["Players in lobbies", stats.playersInLobbies],
        ["Live Ranked", stats.rankedLiveMatches],
        ["Live Unranked", stats.unrankedLiveMatches],
        ["Queued games", stats.queuedMatches],
        ["Verifying results", stats.verifyingMatches],
        ["Need attention", needsReview],
      ].map(
        ([text, value]) =>
          html`<div
            class=${text === "Need attention" && needsReview ? "attention" : ""}
          >
            <dt>${text}</dt>
            <dd>${count(Number(value))}</dd>
          </div>`,
      )}
    </dl>
    <div class="sa-stat-notes">
      <span class="fp-pill"
        >${stats.paymentsMode === "mainnet" ? "SOL" : stats.paymentsMode === "devnet" ? "DEVNET SOL" : "DEMO SOL"}</span
      ><span
        >${stats.paymentsMode === "mainnet" ? "Real SOL. Payout and fee totals count finalized transfers." : stats.paymentsMode === "devnet" ? "Test SOL only. Payout and fee totals count finalized transfers." : "All amounts are simulated. No real funds have moved."}</span
      ><span>Totals refresh every few seconds.</span>
    </div>
    <div class="sa-settlement-summary">
      <span
        ><strong>${count(totals.startedMatches)}</strong> matches started</span
      ><span><strong>${count(totals.settledMatches)}</strong> settled</span
      ><span
        ><strong>${formatAdminSol(totals.refundedLamports)} SOL</strong>
        refunded across ${count(totals.refundedMatches)}
        ${totals.refundedMatches === 1 ? "match" : "matches"}</span
      ><span>${label.toLowerCase()}</span>
    </div>
    ${
      needsReview
        ? html`<div class="sa-attention" role="status">
            <h3>
              ${count(needsReview)}
              ${needsReview === 1 ? "match needs" : "matches need"} attention
            </h3>
            <p>
              ${count(stats.reviewMatches)} awaiting review ·
              ${count(stats.delayedVerifications)} verifying for over 5 minutes.
              Payouts remain held.
            </p>
            <ul>
              ${stats.issues.map(
                (m) =>
                  html`<li>
                    <strong>${m.name} · ${m.id}</strong
                    ><span
                      >${stateLabel(m.state)} ·
                      ${formatAdminSol(m.poolLamports)} SOL ·
                      ${when(m.updated)}</span
                    >
                    <p>${m.reason}</p>
                  </li>`,
              )}
            </ul>
            ${needsReview > stats.issues.length ? html`<p>Showing the ${stats.issues.length} most recently updated issues.</p>` : ""}
          </div>`
        : html`<p class="sa-no-issues">No settlements need attention.</p>`
    }
    <details class="sa-recent">
      <summary>Recent match activity</summary>
      <div class="sa-table-scroll">
        <table class="sa-table">
          <caption>
            Latest 8 wagered matches, including unsettled results.
          </caption>
          <thead>
            <tr>
              <th scope="col">Match</th>
              <th scope="col">Players</th>
              <th scope="col">Pool</th>
              <th scope="col">Status</th>
              <th scope="col">Updated</th>
            </tr>
          </thead>
          <tbody>
            ${
              stats.activity.length
                ? stats.activity.map(
                    (m) =>
                      html`<tr>
                        <td>${m.name}<small>${m.id} · ${m.mode}</small></td>
                        <td>${m.players}</td>
                        <td>${formatAdminSol(m.poolLamports)} SOL</td>
                        <td>
                          <span class="sa-match-state ${m.state}"
                            >${stateLabel(m.state)}</span
                          ><small>${m.reason}</small>
                        </td>
                        <td>${when(m.updated)}</td>
                      </tr>`,
                  )
                : html`<tr>
                    <td colspan="5">No wagered matches have started yet.</td>
                  </tr>`
            }
          </tbody>
        </table>
      </div>
    </details>
    <details class="sa-stat-definitions">
      <summary>What these stats count</summary>
      <p>
        Active players are unique signed-in players seen in the last 90 seconds
        or connected to a lobby or game. Anonymous visitors and the free
        tutorial are excluded. Registered players have both a verified wallet
        and a username; ${count(stats.incompleteProfiles)} wallet profiles still
        need a username.
      </p>
      <p>
        Wagers count when the roster and prize pool lock. Payouts and fees count
        only after verified settlement. Refunds are separate from winner
        payouts. Unsettled pools show gross entries still in play or awaiting
        verification or review. Free practice and unfunded cancellations are
        excluded from financial activity.
      </p>
      <p>
        The 24-hour view uses each event's own time: match start for wagers,
        settlement for payouts and fees, and refund time for refunds. Player
        counts and unsettled pools always show the current state.
      </p>
      <p>
        ${count(stats.customLobbies)} custom lobbies open · Server uptime
        ${Math.floor(stats.uptimeSeconds / 3600)}h
        ${Math.floor(stats.uptimeSeconds / 60) % 60}m. Financial totals persist
        across server restarts.
      </p>
    </details>
  </section>`;
}
