import { prizeSplit } from "./Rules";
import type { Mode } from "./Store";

export type MatchTerms = {
  gameID: string;
  mode: Mode;
  practice: boolean;
  ranked?: boolean;
  stakeLamports: number;
  playerName: string;
  network?: "simulation" | "devnet" | "mainnet";
};
export type ResultPlayer = {
  clientID: string | null;
  human: boolean;
  team: string | null;
};
export type DemoWinResult = Readonly<
  MatchTerms & {
    entrants: number;
    winners: number;
    poolLamports: number;
    feeLamports: number;
    prizeLamports: number;
    profitLamports: number;
  }
>;

let matchTerms: Readonly<MatchTerms> | null = null;
export function setMatchTerms(terms: MatchTerms): void {
  matchTerms = Object.freeze({ ...terms });
}
export function getMatchTerms(gameID: string): Readonly<MatchTerms> | null {
  return matchTerms?.gameID === gameID ? matchTerms : null;
}

// Only a simulated display calculation. Never an authorization to transfer SOL.
// The game's fixed human roster includes eliminated/disconnected players and
// excludes bots; the changing lobby member list must not determine the prize.
export function buildWinResult(
  terms: Readonly<MatchTerms>,
  roster: ResultPlayer[],
  winnerClientID: string | null,
): DemoWinResult | null {
  const humans = roster.filter((p) => p.human && p.clientID !== null);
  const winner = humans.find((p) => p.clientID === winnerClientID);
  if (!winner || new Set(humans.map((p) => p.clientID)).size !== humans.length)
    return null;
  const entrants = humans.length;
  const winners =
    terms.mode === "2v2"
      ? humans.filter((p) => p.team === winner.team).length
      : 1;
  if (!Number.isSafeInteger(terms.stakeLamports) || terms.stakeLamports < 0)
    return null;
  if (terms.practice) {
    if (terms.stakeLamports !== 0 || entrants !== 1) return null;
  } else if (
    (terms.ranked === false
      ? terms.mode !== "ffa" && terms.stakeLamports !== 0
      : terms.stakeLamports === 0) ||
    terms.stakeLamports > 100e9 ||
    (terms.mode === "1v1" && entrants !== 2) ||
    (terms.mode === "2v2" &&
      (entrants !== 4 || winners !== 2 || winner.team === null)) ||
    (terms.mode === "ffa" && (entrants < 2 || entrants > 100))
  )
    return null;
  const { poolLamports, feeLamports, payouts } = prizeSplit(
    terms.stakeLamports,
    entrants,
    winners,
  );
  const prizeLamports = payouts[0];
  if (!Number.isSafeInteger(prizeLamports)) return null;
  return Object.freeze({
    ...terms,
    entrants,
    winners,
    poolLamports,
    feeLamports,
    prizeLamports,
    profitLamports: prizeLamports - terms.stakeLamports,
  });
}

export function formatSol(lamports: number): string {
  return (lamports / 1e9).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 9,
  });
}
