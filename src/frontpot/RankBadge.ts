import { html } from "lit";
import rankAtlas from "./assets/rank-badges-pixel-v2.png";
import unrankedBadge from "./assets/rank-unranked-pixel.png";
import { RANK_TIERS, rankRange, type VisibleRank } from "./RankTiers";
import "./RankBadge.css";

/** Pixel-art atlas: columns are divisions, rows are rank families. */
export function rankBadge(tier: string) {
  const index = RANK_TIERS.indexOf(tier as (typeof RANK_TIERS)[number]);
  if (index < 0)
    return html`<span
      class="sow-rank-badge sow-rank-pixel unranked"
      role="img"
      aria-label="Unranked"
      ><img src=${unrankedBadge} alt="" aria-hidden="true"
    /></span>`;
  const columns = [
    [40, 280],
    [365, 295],
    [690, 320],
  ];
  const rows = [
    [30, 275],
    [320, 275],
    [605, 280],
    [895, 285],
    [1185, 300],
  ];
  const [x, width] = columns[index % 3];
  const [y, height] = rows[Math.floor(index / 3)];
  return html`<span
    class="sow-rank-badge sow-rank-pixel"
    role="img"
    aria-label=${tier}
    title=${`${tier} · ${rankRange(tier)}`}
    ><svg viewBox=${`${x} ${y} ${width} ${height}`} aria-hidden="true">
      <svg
        x=${x}
        y=${y}
        width=${width}
        height=${height}
        viewBox=${`${x} ${y} ${width} ${height}`}
        overflow="hidden"
      >
        <image href=${rankAtlas} width="1024" height="1536" />
      </svg></svg
  ></span>`;
}
export function rankLabel(rank: VisibleRank | undefined) {
  const value = rank ?? { tier: "Unranked", rating: null };
  return html`<span class="sow-player-rank"
    >${rankBadge(value.tier)}<span
      >${value.tier}${value.rating === null ? "" : html`<small>${value.rating.toLocaleString()} Elo</small>`}</span
    ></span
  >`;
}
