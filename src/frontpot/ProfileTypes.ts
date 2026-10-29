import type { RankedRecord } from "./Rankings";
import type { Mode } from "./Store";
export const PROFILE_ICONS = [
  "shield",
  "castle",
  "anchor",
  "crown",
  "bolt",
  "globe",
] as const;
export const PROFILE_COLORS = [
  "orange",
  "blue",
  "green",
  "violet",
  "rose",
  "silver",
] as const;
export type ProfileIcon = (typeof PROFILE_ICONS)[number];
export type ProfileColor = (typeof PROFILE_COLORS)[number];
export type ProfileSettings = {
  icon: ProfileIcon;
  color: ProfileColor;
  bio: string;
  showStats: boolean;
  showLevel: boolean;
  revision: number;
  prestige: number;
  prestigeXp: number;
  unrankedPrestige?: number;
  unrankedPrestigeXp?: number;
};
export const defaultProfileSettings = (): ProfileSettings => ({
  icon: "shield",
  color: "orange",
  bio: "",
  showStats: true,
  showLevel: true,
  revision: 0,
  prestige: 0,
  prestigeXp: 0,
});
export type PlayerProgress = {
  level: number;
  prestige: number;
  legend: boolean;
  lifetimeXp: number;
  xpInLevel: number;
  xpForNext: number;
  canPrestige: boolean;
};
export type ProfileGame = {
  ranked: boolean;
  practice: boolean;
  id?: string;
  map: string;
  mode: Mode;
  at: number;
  result:
    | "Won"
    | "Lost"
    | "Cancelled"
    | "Refunded"
    | "Refund pending"
    | "In progress"
    | "Under review";
  xp: number;
  ratingChange?: {
    before: number;
    after: number;
    delta: number;
    place: number;
    counted: boolean;
  };
  entryLamports?: number;
  payoutLamports?: number;
  paymentState?: string;
  replayAvailable?: boolean;
};
export type PlayerProfile = {
  id: string;
  name: string;
  icon: ProfileIcon;
  color: ProfileColor;
  bio: string;
  joined: number;
  own: boolean;
  progress: PlayerProgress | null;
  rankedRatings?: RankedRecord[] | null;
  legacyProgress?: PlayerProgress;
  stats: null | {
    games: number;
    wins: number;
    losses: number;
    winRate: number;
    streak: number;
    bestStreak: number;
    modes: Array<{ mode: Mode; games: number; wins: number }>;
  };
  games: ProfileGame[];
  settings?: ProfileSettings;
  finances?: {
    network: string;
    wageredLamports: string;
    paidLamports: string;
    pendingLamports: string;
  };
};
