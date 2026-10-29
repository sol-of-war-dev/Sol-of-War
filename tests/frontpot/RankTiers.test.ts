import { expect, it } from "vitest";
import {
  RANK_TIERS,
  rankTier,
  rankRange,
  visibleRank,
} from "../../src/frontpot/RankTiers";
it("uses all approved division boundaries", () => {
  expect(rankTier(0)).toBe("Bronze I");
  expect(rankTier(699)).toBe("Bronze I");
  for (let i = 1; i < RANK_TIERS.length; i++) {
    const boundary = 600 + i * 100;
    expect(rankTier(boundary - 1)).toBe(RANK_TIERS[i - 1]);
    expect(rankTier(boundary)).toBe(RANK_TIERS[i]);
  }
  expect(rankTier(5000)).toBe("Diamond III");
});
it("hides Elo until placements are complete", () => {
  expect(visibleRank({ rating: 1320, provisional: true })).toEqual({
    tier: "Unranked",
    rating: null,
  });
  expect(visibleRank({ rating: 1320, provisional: false })).toEqual({
    tier: "Gold II",
    rating: 1320,
  });
});

it("labels Elo ranges consistently with every tier", () => {
  expect(rankRange("Bronze I")).toBe("0–699 Elo");
  expect(rankRange("Silver II")).toBe("1,000–1,099 Elo");
  expect(rankRange("Diamond III")).toBe("2,000+ Elo");
  expect(rankRange("Unranked")).toBe("10 placement matches");
});
