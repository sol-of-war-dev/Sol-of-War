import { expect, it } from "vitest";
import { CountdownClock } from "../../src/frontpot/CountdownClock";
it("ticks each second between fresh server responses and ignores stale responses", () => {
  let now = 0;
  const clock = new CountdownClock(() => now);
  clock.sync(100000);
  expect(clock.seconds(110000)).toBe(10);
  now = 1000;
  expect(clock.seconds(110000)).toBe(9);
  now = 2000;
  clock.sync(102000);
  expect(clock.seconds(110000)).toBe(8);
  now = 3000;
  clock.sync(100000);
  expect(clock.seconds(110000)).toBe(7);
});
it("reconciles drift and updated deadlines after returning or reconnecting", () => {
  let now = 0;
  const clock = new CountdownClock(() => now);
  clock.sync(100000);
  now = 1000;
  clock.sync(107000);
  expect(clock.seconds(110000)).toBe(3);
  expect(clock.seconds(120000)).toBe(13);
  now += 5000;
  expect(clock.seconds(110000)).toBe(0);
  clock.sync(120000, 200);
  expect(clock.seconds(125000)).toBe(5);
});
