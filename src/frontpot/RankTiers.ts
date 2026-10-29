export const RANK_TIERS = [
  "Bronze I",
  "Bronze II",
  "Bronze III",
  "Silver I",
  "Silver II",
  "Silver III",
  "Gold I",
  "Gold II",
  "Gold III",
  "Platinum I",
  "Platinum II",
  "Platinum III",
  "Diamond I",
  "Diamond II",
  "Diamond III",
] as const;
export function rankTier(rating: number): string {
  return RANK_TIERS[
    Math.max(0, Math.min(14, Math.floor((rating - 600) / 100)))
  ];
}
export type VisibleRank = { tier: string; rating: number | null };
export function visibleRank(rank: {
  rating: number;
  provisional: boolean;
}): VisibleRank {
  return rank.provisional
    ? { tier: "Unranked", rating: null }
    : { tier: rankTier(rank.rating), rating: rank.rating };
}

export function rankRange(tier: string): string {
  const index = RANK_TIERS.indexOf(tier as (typeof RANK_TIERS)[number]);
  if (index < 0) return "10 placement matches";
  if (index === 14) return "2,000+ Elo";
  const minimum = index === 0 ? 0 : 600 + index * 100;
  return `${minimum.toLocaleString("en-US")}–${(699 + index * 100).toLocaleString("en-US")} Elo`;
}
