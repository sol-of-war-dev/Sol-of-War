import { describe, expect, it } from "vitest";
import { QueueClock } from "../../src/frontpot/QueueClock";

describe("queue display clock", () => {
  it("ticks each second between two-second polls without resetting on responses", () => {
    let now = 0;
    const clock = new QueueClock(() => now);
    const search = { id: "queue-a", elapsedSeconds: 0 };
    expect(clock.seconds(search)).toBe(0);
    now = 1000;
    expect(clock.seconds(search)).toBe(1);
    now = 2000;
    expect(clock.seconds({ ...search, elapsedSeconds: 2 })).toBe(2);
    now = 3000;
    expect(clock.seconds({ ...search, elapsedSeconds: 2 })).toBe(3);
    now = 4000;
    expect(clock.seconds({ ...search, elapsedSeconds: 2 })).toBe(4);
  });
  it("restores elapsed time, catches up after a hidden tab, and resets for another search", () => {
    let now = 100;
    const clock = new QueueClock(() => now);
    expect(clock.seconds({ id: "a", elapsedSeconds: 15 })).toBe(15);
    now += 65000;
    expect(clock.seconds({ id: "a", elapsedSeconds: 15 })).toBe(80);
    expect(clock.seconds(null)).toBe(0);
    expect(clock.seconds({ id: "b", elapsedSeconds: 0 })).toBe(0);
  });
});
