// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { rankedResultLabel } from "../../src/frontpot/RankedResult";
import { RankedResultPanel } from "../../src/frontpot/RankedResultPanel";
const base = {
  before: 1292,
  after: 1308,
  delta: 16,
  place: 1,
  counted: true,
  beforeTier: "Gold I",
  afterTier: "Gold II",
  gamesAfter: 21,
};
afterEach(() => {
  document.body.replaceChildren();
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("distinguishes promotion, demotion, maintained rank and placements", () => {
  expect(rankedResultLabel(base)).toBe("Ranked up");
  expect(
    rankedResultLabel({
      ...base,
      beforeTier: "Gold II",
      afterTier: "Gold I",
      delta: -16,
    }),
  ).toBe("Ranked down");
  expect(rankedResultLabel({ ...base, afterTier: "Gold I" })).toBe(
    "Rank maintained",
  );
  expect(rankedResultLabel({ ...base, beforeTier: "Unranked" })).toBe(
    "Rank revealed",
  );
  expect(rankedResultLabel({ ...base, afterTier: "Unranked" })).toBe(
    "Placements in progress",
  );
  expect(rankedResultLabel({ ...base, counted: false })).toBe(
    "Rating unchanged",
  );
});
it("fetches the authenticated verified result and shows signed Elo and rank movement", async () => {
  sessionStorage.setItem("frontpot-session", "test-session");
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ state: "settled", ratingChange: base }), {
        status: 200,
      }),
    );
  vi.stubGlobal("fetch", fetcher);
  const panel = new RankedResultPanel();
  panel.gameID = "match";
  panel.active = true;
  document.body.append(panel);
  await vi.waitFor(() => expect(panel.textContent).toContain("Ranked up"));
  expect(panel.textContent).toContain("+16");
  expect(panel.textContent).toContain("1,308");
  expect(fetcher.mock.calls[0][1].headers.Authorization).toBe(
    "Bearer test-session",
  );
});
it("shows awaiting-match status rather than inventing a loss before FFA finishes", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ state: "playing" }), { status: 200 }),
    );
  vi.stubGlobal("fetch", fetcher);
  const panel = new RankedResultPanel();
  panel.gameID = "ffa";
  panel.active = true;
  document.body.append(panel);
  await vi.waitFor(() =>
    expect(panel.textContent).toContain("Awaiting match result"),
  );
  expect(panel.textContent).not.toContain("Elo lost");
  panel.active = false;
  await panel.updateComplete;
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
});
it("does not parse plaintext rate limits or claim a rating change", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response("Too many requests", {
          status: 429,
          headers: { "Retry-After": "60" },
        }),
      ),
  );
  const panel = new RankedResultPanel();
  panel.gameID = "match";
  panel.active = true;
  document.body.append(panel);
  await vi.waitFor(() =>
    expect(panel.textContent).toContain("temporarily limited"),
  );
  expect(panel.textContent).not.toContain("Ranked up");
});
