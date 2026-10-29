import { html } from "lit";
import type { OperationsSnapshot } from "./Operations";
import { explorerTransaction } from "./payments/Network";

let reason = "";
export function clearOperationsDraft() {
  reason = "";
}
const time = (n: number | null) =>
  n ? new Date(n).toLocaleString() : "Not checked yet";
const labels: Record<string, string> = {
  deposit: "Entry",
  withdrawal: "Player withdrawal",
  refund: "Refund",
  settlement: "Prize payout",
  return: "Returned deposit",
  return_unmatched: "Returned unmatched deposit",
  review_replay: "Requested replay verification",
  review_refund: "Requested full match refund",
  pending: "Confirming",
  review: "Needs review",
  finalized: "Finalized",
  expired_unconfirmed: "Expired without confirmation",
  transaction_failed: "Transaction failed",
  pause_entries: "Paused entries",
  resume_entries: "Resumed entries",
  check_signature: "Checked payment",
  provider_unavailable: "Network unavailable",
  checking: "Check started",
  saved: "Saved",
  begin_drain: "Started deployment preparation",
  end_drain: "Ended deployment preparation",
  retry_failed_payment: "Retried failed payment",
  retry_not_completed: "Retry not completed",
};
export function operationsView(
  data: OperationsSnapshot | undefined,
  busy: boolean,
  change: (url: string, body: unknown) => Promise<void>,
  paint: () => void,
  now = Date.now(),
) {
  if (!data) return "";
  const paused = data.control.paused;
  const deployment = data.deployment;
  const stale =
    data.mode !== "simulation" &&
    (!data.worker.lastAttempt || now - data.worker.lastAttempt > 30_000);
  const worker =
    data.mode === "simulation"
      ? "Payments disabled in simulation"
      : stale
        ? "Worker has not reported recently"
        : data.worker.failures
          ? "Payment processing needs attention"
          : "Payment worker running";
  return html`<section
    class="sa-panel sa-operations"
    aria-labelledby="sa-operations-heading"
  >
    <div class="sa-section-heading">
      <div>
        <h2 id="sa-operations-heading">Payment operations</h2>
        <p>${worker}</p>
      </div>
      <span class="fp-pill">${data.mode.toUpperCase()}</span>
    </div>
    ${
      data.playerWallets
        ? html`<dl class="sa-activity-bar">
            <div>
              <dt>Player wallets</dt>
              <dd>${data.playerWallets.accounts}</dd>
            </div>
            <div>
              <dt>Pending wallet transfers</dt>
              <dd>${data.playerWallets.pending}</dd>
            </div>
            <div>
              <dt>Wallet transfers needing review</dt>
              <dd>${data.playerWallets.review}</dd>
            </div>
          </dl>`
        : ""
    }
    <label class="sa-operation-reason" for="operation-reason"
      >Reason for this action
      <input
        id="operation-reason"
        maxlength="240"
        minlength="5"
        .value=${reason}
        placeholder="For example: checking a delayed payout"
        @input=${(e: Event) => {
          reason = (e.target as HTMLInputElement).value;
          paint();
        }}
      />
      <small
        >Required for deployment preparation, pause, resume and payment checks.
        Saved with your administrator wallet.</small
      ></label
    >
    ${
      deployment
        ? html`<section
            class="sa-deployment"
            aria-labelledby="sa-deployment-heading"
          >
            <div class="sa-section-heading">
              <div>
                <h3 id="sa-deployment-heading">Deployment preparation</h3>
                <p>
                  ${deployment.enabled ? (deployment.ready ? "Ready for a planned restart" : "Waiting for games and payments to finish") : "Normal operation"}
                </p>
              </div>
              <button
                class="fp-create"
                ?disabled=${busy || reason.trim().length < 5}
                @click=${() => change("/admin/operations/deployment", { enabled: !deployment.enabled, revision: data.control.revision, reason })}
              >
                ${deployment.enabled ? "End preparation" : "Prepare for deployment"}
              </button>
            </div>
            ${reason.trim().length < 5 ? html`<p class="sa-help">Enter a reason of at least 5 characters above to enable deployment preparation.</p>` : ""}
            <p class="sa-help">
              Preparation closes waiting lobbies and refunds paid entries.
              Active games finish normally. New server matches and queue
              generation stop; the free tutorial remains available.
            </p>
            ${
              deployment.enabled
                ? html`<dl class="sa-activity-bar">
                      <div>
                        <dt>Active games</dt>
                        <dd>${deployment.activeGames}</dd>
                      </div>
                      <div>
                        <dt>Waiting lobbies</dt>
                        <dd>${deployment.waitingLobbies}</dd>
                      </div>
                      <div>
                        <dt>Result checks</dt>
                        <dd>${deployment.verifications}</dd>
                      </div>
                      <div>
                        <dt>Unsettled funded matches</dt>
                        <dd>${deployment.unsettledMatches}</dd>
                      </div>
                    </dl>
                    <p class="sa-help">
                      This does not deploy or restart the server. After the
                      update, end preparation and resume entries. Closed lobbies
                      are not restored.
                    </p>`
                : ""
            }
          </section>`
        : ""
    }
    <div class=${paused ? "sa-entry-control paused" : "sa-entry-control"}>
      <div>
        <strong>${paused ? "New entries paused" : "New entries open"}</strong>
        <p>
          Pausing stops new match entries and deposit requests. Existing games,
          signed deposits, payouts, refunds and the tutorial continue.
        </p>
        ${data.control.reason ? html`<small>Last change: ${data.control.reason} · ${time(data.control.at)}</small>` : ""}
      </div>
      <button
        class="fp-create"
        ?disabled=${busy || reason.trim().length < 5 || data.control.draining}
        @click=${() => change("/admin/operations/admissions", { paused: !paused, revision: data.control.revision, reason })}
      >
        ${paused ? "Resume entries" : "Pause new entries"}
      </button>
    </div>
    <dl class="sa-activity-bar">
      <div>
        <dt>Confirming</dt>
        <dd>${data.counts.pending}</dd>
      </div>
      <div class=${data.counts.review ? "attention" : ""}>
        <dt>Need review</dt>
        <dd>${data.counts.review}</dd>
      </div>
      <div class=${data.counts.signingFailures ? "attention" : ""}>
        <dt>Signing issues</dt>
        <dd>${data.counts.signingFailures}</dd>
      </div>
      <div>
        <dt>Finalized transfers</dt>
        <dd>${data.counts.finalized}</dd>
      </div>
    </dl>
    ${
      data.signingIssues.length
        ? html`<div class="sa-attention" role="status">
            <strong>Payout signing needs attention</strong>
            <p>
              Check the signer configuration, transfer policy and fee-payer
              balance. Saved transfers are retained for retry.
            </p>
            <ul>
              ${data.signingIssues.map((i) => html`<li>Match ${i.matchID} · ${time(i.at)}</li>`)}
            </ul>
          </div>`
        : ""
    }
    ${
      data.monitoring
        ? html`<h3>Payment health</h3>
            <p class="sa-help">
              Fee payer:
              ${data.monitoring.feePayer.lamports === null ? "Checking" : `${Number(data.monitoring.feePayer.lamports) / 1e9} SOL`}
              · Last backup:
              ${time(data.monitoring.backup?.lastSuccess ?? null)} · Verified
              offsite backup:
              ${time(data.monitoring.backup?.offsite?.lastSuccess ?? null)}
            </p>
            ${
              data.alerts.length
                ? html`<ul>
                    ${data.alerts.map((a) => html`<li>${a.replace(/_/g, " ")}</li>`)}
                  </ul>`
                : html`<p>Payment checks are up to date.</p>`
            }
            ${
              data.monitoring.reconciliation.unmatched.length
                ? html`<h4>Unmatched pool transfers</h4>
                    <p class="sa-help">
                      These transfers are recorded for reconciliation and do not
                      increase a match's prize. A verified direct SOL deposit
                      can be returned in full to its original sender. Other
                      transfers remain held for review.
                    </p>
                    <ul>
                      ${data.monitoring.reconciliation.unmatched.map(
                        (t) =>
                          html`<li>
                            Match ${t.matchID} · ${Number(t.delta) / 1e9} SOL ·
                            ${t.state}
                            <a
                              href=${explorerTransaction(t.signature, data.mode === "mainnet" ? "mainnet" : "devnet")}
                              target="_blank"
                              rel="noreferrer"
                              >Receipt</a
                            >
                            ${t.state === "unreviewed" && BigInt(t.delta) > 0n ? html`<button ?disabled=${busy || reason.trim().length < 5} @click=${() => change(`/admin/operations/returns/${encodeURIComponent(t.matchID)}/${encodeURIComponent(t.signature)}`, { reason })}>Return to sender</button>` : ""}
                          </li>`,
                      )}
                    </ul>`
                : ""
            } `
        : ""
    }
    ${
      data.matchReviews?.length
        ? html`<h3>Match result review</h3>
            <p class="sa-help">
              Retry verification using the saved game. If its result cannot be
              recovered, return the original entries in full. Matches with an
              existing payout decision must use payment recovery.
            </p>
            <ul>
              ${data.matchReviews.map(
                (m) =>
                  html`<li>
                    <strong>${m.name}</strong> · ${m.matchID}
                    <p>${m.reason}</p>
                    ${m.blocked ? html`<p>${m.blocked}</p>` : ""}
                    <button
                      ?disabled=${busy || !m.canReplay || reason.trim().length < 5}
                      @click=${() => change(`/admin/operations/matches/${encodeURIComponent(m.matchID)}/review`, { action: "replay", reason })}
                    >
                      Verify saved game
                    </button>
                    <button
                      ?disabled=${busy || !m.canRefund || reason.trim().length < 5}
                      @click=${() => change(`/admin/operations/matches/${encodeURIComponent(m.matchID)}/review`, { action: "refund", reason })}
                    >
                      ${m.ranked ? "Refund original entries" : "Cancel free match"}
                    </button>
                  </li>`,
              )}
            </ul>`
        : ""
    }
    <h3>Payment queue</h3>
    <p class="sa-help">
      Latest 50 transfers, with held payments first. Check status looks up the
      saved signature. Retry failed payment requires a finalized failure and
      preserves the original recipients and amounts. Unknown or expired
      transfers remain held.
    </p>
    ${
      data.jobs.length
        ? html`<div class="sa-table-scroll">
            <table class="sa-table">
              <thead>
                <tr>
                  <th scope="col">Payment</th>
                  <th scope="col">Status</th>
                  <th scope="col">Last checked</th>
                  <th scope="col">Manage</th>
                </tr>
              </thead>
              <tbody>
                ${data.jobs.map(
                  (j) =>
                    html`<tr>
                      <td>
                        ${labels[j.kind] ?? j.kind}<small
                          >Match ${j.matchID ?? "unknown"}</small
                        >
                      </td>
                      <td>
                        ${labels[j.state]}${j.reason ? html`<small>${labels[j.reason]}</small>` : ""}
                      </td>
                      <td>${time(j.checkedAt)}</td>
                      <td>
                        <div class="sa-row-actions">
                          <a
                            href=${explorerTransaction(j.signature, data.mode === "mainnet" ? "mainnet" : "devnet")}
                            target="_blank"
                            rel="noopener noreferrer"
                            >Receipt</a
                          >
                          <button
                            ?disabled=${busy || j.state === "finalized" || reason.trim().length < 5}
                            @click=${() => change(`/admin/operations/payments/${encodeURIComponent(j.id)}/check`, { reason })}
                          >
                            Check status
                          </button>
                          ${j.reason === "transaction_failed" && j.kind !== "deposit" && j.kind !== "withdrawal" ? html`<button ?disabled=${busy || reason.trim().length < 5} @click=${() => change(`/admin/operations/payments/${encodeURIComponent(j.id)}/retry`, { reason })}>Retry failed payment</button>` : ""}
                        </div>
                      </td>
                    </tr>`,
                )}
              </tbody>
            </table>
          </div>`
        : html`<p class="sa-empty-payments">
            No payment transactions
            recorded${data.mode === "simulation" ? " in simulation" : " yet"}.
          </p>`
    }
    <details class="sa-operation-history">
      <summary>Recent admin actions (${data.audit.length})</summary>
      ${
        data.audit.length
          ? html`<ol>
              ${data.audit.map(
                (a) =>
                  html`<li>
                    <strong
                      >${labels[a.action] ?? a.action} ·
                      ${labels[a.result] ?? a.result}</strong
                    >
                    <p>${a.reason}</p>
                    <small>${time(a.at)} · ${a.actor}</small>
                  </li>`,
              )}
            </ol>`
          : html`<p>No operations actions recorded yet.</p>`
      }
    </details>
  </section>`;
}
