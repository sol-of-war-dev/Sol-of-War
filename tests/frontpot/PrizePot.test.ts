// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { PrizePot } from "../../src/frontpot/PrizePot";
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
it("shows the exact server prize without motion for reduced-motion users", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const pot = new PrizePot();
  pot.match = "ranked-match";
  pot.lamports = 4455000000;
  document.body.append(pot);
  await pot.updateComplete;
  await pot.updateComplete;
  expect(pot.shadowRoot?.textContent).toContain("4.455 SOL");
  expect(pot.shadowRoot?.querySelector(".celebration")).toBeNull();
  expect(
    pot.shadowRoot?.querySelector(".badge")?.getAttribute("aria-label"),
  ).toBe("Prize pool: 4.455 SOL");
});
it("tallies to the locked prize and stops the celebration without replaying on updates", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    frames.push(fn);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const pot = new PrizePot();
  pot.match = "match";
  pot.lamports = 990000000;
  document.body.append(pot);
  await pot.updateComplete;
  frames.shift()!(0);
  await pot.updateComplete;
  frames.shift()!(1000);
  await pot.updateComplete;
  expect(pot.shadowRoot?.textContent).toContain("0.86625 SOL");
  frames.shift()!(2700);
  await pot.updateComplete;
  await pot.updateComplete;
  expect(pot.shadowRoot?.textContent).toContain("0.99 SOL");
  expect(pot.shadowRoot?.querySelector(".celebration")).toBeNull();
  pot.requestUpdate();
  await pot.updateComplete;
  expect(frames).toHaveLength(0);
});
