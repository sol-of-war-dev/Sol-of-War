import { html } from "lit";
import type { LiveSnapshot, LiveEventKind } from "./LiveMonitoring";
const labels: Record<LiveEventKind, string> = {
  api_failure: "Server request failed",
  rate_limited: "API rate limit reached",
  connection_rejected: "Connection rejected (origin, path or capacity)",
  socket_error: "Game socket error",
  unexpected_disconnect: "Game connection ended unexpectedly",
  join_failed: "Game join rejected",
  rejoin_failed: "Game reconnect rejected",
  payment_failure: "Payment worker reported a failure",
  reconciliation_failure: "Payment reconciliation failed",
};
const time = (at: number) => new Date(at).toLocaleTimeString();
export function liveMonitoringView(
  s: LiveSnapshot | undefined,
  failed: boolean,
  now: number,
) {
  if (!s) return html``;
  const stale = failed || now - s.generatedAt > 15000;
  const card = (label: string, value: string | number, detail: string) =>
    html`<div class="sa-stat">
      <dt>${label}</dt>
      <dd>${value}</dd>
      <p>${detail}</p>
    </div>`;
  return html`<section class="sa-monitor" aria-label="Live platform monitoring">
    <div class="sa-stats-heading">
      <div>
        <h2>Live platform</h2>
        <p>
          ${stale ? "Feed stale — showing last successful snapshot" : "Auto-refreshing"}
          · Updated ${time(s.generatedAt)}
        </p>
      </div>
      <strong class=${stale ? "fp-error" : ""}
        >${stale ? "STALE" : "LIVE"}</strong
      >
    </div>
    <dl class="sa-stats-bar">
      ${card("Game connections", `${s.connections} / ${s.connectionLimit}`, "Open sockets, including clients joining")}
      ${card("Active matches", s.rooms.filter((r) => r.status === "playing").length, "Currently playing on this server")}
      ${card("API response p95", s.api.p95Ms === null ? "No traffic" : `${Math.round(s.api.p95Ms)} ms`, "Server processing · last 60 seconds")}
      ${card("Server failures", s.api.failures, "HTTP 5xx · last 60 seconds")}
      ${card("Server memory", `${Math.round(s.process.rssMiB)} MiB`, "Main process; excludes replay workers")}
      ${card("CPU", `${Math.round(s.process.cpuPercent)}%`, "One CPU core · last 5 seconds")}
    </dl>
    <p>
      Event-loop delay p99: ${Math.round(s.process.eventLoopP99Ms)} ms · API
      requests: ${s.api.requests} · Rejected requests (4xx): ${s.api.rejected} ·
      Uptime: ${Math.floor(s.process.uptimeSeconds / 60)} min
    </p>
    ${s.connections >= s.connectionLimit * 0.8 ? html`<p class="fp-message" role="status">Connection capacity is at ${Math.round((s.connections / s.connectionLimit) * 100)}%. The current limit is ${s.connectionLimit} connections.</p>` : ""}
    ${s.api.samplesDropped ? html`<p>High traffic: API metrics use a bounded sample of the latest requests.</p>` : ""}
    <div class="sa-monitor-columns">
      <section>
        <h3>Connections · last 10 minutes</h3>
        <div class="sa-monitor-history" aria-label="Connection history">
          ${s.history.length ? s.history.map((h) => html`<span title=${`${time(h.at)} · ${h.connections} connections · ${h.games} active games`} style=${`height:${Math.max(2, Math.min(100, (h.connections / s.connectionLimit) * 100))}%`}></span>`) : html`<p>Collecting the first sample…</p>`}
        </div>
        <small
          >Scale: 0–${s.connectionLimit} connections. Samples every 5
          seconds.</small
        >
      </section>
      <section>
        <h3>Recent incidents</h3>
        <p>
          Last 100 grouped events since server restart. Rejected joins can be
          normal user errors.
        </p>
        <div class="sa-monitor-events" role="log" aria-live="off">
          ${s.events.length ? s.events.map((e) => html`<p><time>${time(e.at)}</time> ${labels[e.kind]}${e.count > 1 ? ` ×${e.count}` : ""}</p>`) : html`<p>No incidents recorded since startup.</p>`}
        </div>
      </section>
    </div>
    <details>
      <summary>Room activity (${s.rooms.length})</summary>
      <div class="sa-monitor-table">
        <table>
          <thead>
            <tr>
              <th>Room</th>
              <th>Map</th>
              <th>Status</th>
              <th>Players joined</th>
              <th>Type</th>
            </tr>
          </thead>
          <tbody>
            ${s.rooms.map(
              (r) =>
                html`<tr>
                  <td>${r.id}</td>
                  <td>${r.map}</td>
                  <td>${r.status}</td>
                  <td>${r.players}/${r.capacity}</td>
                  <td>${r.ranked ? "Wager" : "Free"}</td>
                </tr>`,
            )}
          </tbody>
        </table>
      </div>
    </details>
    <small
      >Server-local monitoring resets on restart. Active-player totals below
      cover signed-in activity; anonymous browsing and offline clients are not
      counted. This is an in-dashboard feed, not an external outage
      alert.</small
    >
  </section>`;
}
