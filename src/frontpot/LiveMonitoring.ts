import type { RequestHandler } from "express";
import { monitorEventLoopDelay } from "node:perf_hooks";

export type LiveRoom = {
  id: string;
  map: string;
  status: string;
  players: number;
  capacity: number;
  ranked: boolean;
};
export type LiveEventKind =
  | "api_failure"
  | "rate_limited"
  | "connection_rejected"
  | "socket_error"
  | "unexpected_disconnect"
  | "join_failed"
  | "rejoin_failed"
  | "payment_failure"
  | "reconciliation_failure";
export type LiveSnapshot = ReturnType<LiveMonitoring["snapshot"]>;
/** Bounded, process-local telemetry. Never accepts raw errors, URLs or credentials. */
export class LiveMonitoring {
  private requests: { at: number; ms: number; status: number }[] = [];
  private events: { at: number; kind: LiveEventKind; count: number }[] = [];
  private history: { at: number; connections: number; games: number }[] = [];
  private startedAt: number;
  private samplesDropped = 0;
  private prunedAt = 0;
  private cpu = process.cpuUsage();
  private cpuAt = performance.now();
  private cpuPercent = 0;
  private lagMs = 0;
  private timer?: ReturnType<typeof setInterval>;
  private lag = monitorEventLoopDelay({ resolution: 20 });
  constructor(
    private state: () => {
      connections: number;
      connectionLimit: number;
      rooms: LiveRoom[];
    },
    private now = Date.now,
  ) {
    this.startedAt = now();
  }
  start() {
    this.lag.enable();
    this.timer = setInterval(() => {
      const time = performance.now(),
        cpu = process.cpuUsage();
      this.cpuPercent =
        (cpu.user - this.cpu.user + (cpu.system - this.cpu.system)) /
        (time - this.cpuAt) /
        10;
      this.cpu = cpu;
      this.cpuAt = time;
      this.lagMs = this.lag.percentile(99) / 1e6;
      this.lag.reset();
      const state = this.state();
      this.history.push({
        at: this.now(),
        connections: state.connections,
        games: state.rooms.filter((r) => r.status === "playing").length,
      });
      if (this.history.length > 120) this.history.shift();
    }, 5000);
    this.timer.unref();
  }
  stop() {
    clearInterval(this.timer);
    this.lag.disable();
  }
  event(kind: LiveEventKind) {
    const at = this.now(),
      last = this.events[0];
    if (last?.kind === kind && at - last.at < 10000) {
      last.count++;
      last.at = at;
    } else {
      this.events.unshift({ at, kind, count: 1 });
      this.events.length = Math.min(this.events.length, 100);
    }
  }
  record(status: number, ms: number) {
    const at = this.now();
    if (at - this.prunedAt >= 1000) {
      this.requests = this.requests.filter((r) => at - r.at < 60000);
      this.prunedAt = at;
    }
    this.requests.push({ at, ms, status });
    if (this.requests.length > 10000) {
      this.requests.shift();
      this.samplesDropped++;
    }
    if (status >= 500) this.event("api_failure");
    if (status === 429) this.event("rate_limited");
  }
  middleware: RequestHandler = (req, res, next) => {
    if (
      req.path.startsWith("/frontpot/api/") &&
      !req.path.startsWith("/frontpot/api/admin")
    ) {
      const start = performance.now();
      res.once("finish", () =>
        this.record(res.statusCode, performance.now() - start),
      );
    }
    next();
  };
  snapshot() {
    const at = this.now(),
      state = this.state();
    const requests = this.requests.filter((r) => at - r.at < 60000);
    const durations = requests.map((r) => r.ms).sort((a, b) => a - b);
    return {
      generatedAt: at,
      startedAt: this.startedAt,
      ...state,
      api: {
        requests: requests.length,
        failures: requests.filter((r) => r.status >= 500).length,
        rejected: requests.filter((r) => r.status >= 400 && r.status < 500)
          .length,
        p95Ms: durations.length
          ? durations[
              Math.min(
                durations.length - 1,
                Math.floor(durations.length * 0.95),
              )
            ]
          : null,
        samplesDropped: this.samplesDropped,
      },
      process: {
        rssMiB: process.memoryUsage().rss / 2 ** 20,
        cpuPercent: this.cpuPercent,
        eventLoopP99Ms: this.lagMs,
        uptimeSeconds: Math.floor((at - this.startedAt) / 1000),
      },
      events: this.events.map((e) => ({ ...e })),
      history: this.history.map((h) => ({ ...h })),
    };
  }
}
