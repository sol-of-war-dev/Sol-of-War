/** Server-authoritative time, interpolated locally between fresh responses. */
export class CountdownClock {
  private sample: { server: number; local: number } | null = null;
  private latestTimestamp = -Infinity;
  constructor(private now = () => performance.now()) {}
  sync(serverNow: number, roundTripMs = 0) {
    if (!Number.isFinite(serverNow) || serverNow <= this.latestTimestamp)
      return;
    this.latestTimestamp = serverNow;
    this.sample = {
      server: serverNow + Math.max(0, roundTripMs) / 2,
      local: this.now(),
    };
  }
  seconds(deadline: number): number {
    if (!this.sample) return 0;
    const serverNow = this.sample.server + this.now() - this.sample.local;
    return Math.max(0, Math.ceil((deadline - serverNow) / 1000));
  }
}
