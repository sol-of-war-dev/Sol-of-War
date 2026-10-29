import { RANK_TIERS } from "./RankTiers";

/** Immutable snapshot recorded in the same transaction as the Elo update. */
export type RankedResult = {
  before: number;
  after: number;
  delta: number;
  place: number;
  counted: boolean;
  beforeTier?: string;
  afterTier?: string;
  gamesAfter?: number;
};
export function rankedResultLabel(result: RankedResult): string {
  if (!result.counted) return "Rating unchanged";
  if (!result.afterTier || result.afterTier === "Unranked")
    return "Placements in progress";
  if (result.beforeTier === "Unranked") return "Rank revealed";
  if (!result.beforeTier) return "Rank updated";
  const before = RANK_TIERS.indexOf(
    result.beforeTier as (typeof RANK_TIERS)[number],
  );
  const after = RANK_TIERS.indexOf(
    result.afterTier as (typeof RANK_TIERS)[number],
  );
  return after > before
    ? "Ranked up"
    : after < before
      ? "Ranked down"
      : "Rank maintained";
}
