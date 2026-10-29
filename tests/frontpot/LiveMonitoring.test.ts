import { describe, expect, it } from "vitest";
import { LiveMonitoring } from "../../src/frontpot/LiveMonitoring";
const state = () => ({ connections: 10, connectionLimit: 150, rooms: [] });
describe("live monitoring", () => {
  it("expires request statistics after sixty seconds instead of presenting stale health", () => {
    let now = 100000;
    const m = new LiveMonitoring(state, () => now);
    m.record(200, 12);
    m.record(503, 80);
    m.record(429, 4);
    expect(m.snapshot().api).toMatchObject({
      requests: 3,
      failures: 1,
      rejected: 1,
      p95Ms: 80,
    });
    now += 60001;
    expect(m.snapshot().api).toMatchObject({
      requests: 0,
      failures: 0,
      p95Ms: null,
    });
    expect(m.snapshot().events).toHaveLength(2);
    m.stop();
  });
  it("bounds incident history and groups bursts without keeping raw request data", () => {
    let now = 100000;
    const m = new LiveMonitoring(state, () => now);
    for (let i = 0; i < 1000; i++) m.event("join_failed");
    expect(m.snapshot().events).toEqual([
      { at: now, kind: "join_failed", count: 1000 },
    ]);
    for (let i = 0; i < 150; i++) {
      now += 10001;
      m.event("socket_error");
    }
    expect(m.snapshot().events).toHaveLength(100);
    const snap = m.snapshot();
    snap.events[0].count = 999;
    expect(m.snapshot().events[0].count).toBe(1);
    m.stop();
  });
  it("bounds request samples under sustained traffic", () => {
    const m = new LiveMonitoring(state, () => 100000);
    for (let i = 0; i < 10050; i++) m.record(200, i);
    expect(m.snapshot().api).toMatchObject({
      requests: 10000,
      samplesDropped: 50,
    });
    m.stop();
  });
});
