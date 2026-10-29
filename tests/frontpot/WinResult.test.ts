import { describe, expect, it } from "vitest";
import {
  buildWinResult,
  formatSol,
  getMatchTerms,
  setMatchTerms,
  type MatchTerms,
  type ResultPlayer,
} from "../../src/frontpot/WinResult";

const terms: MatchTerms = {
  gameID: "match-a",
  mode: "1v1",
  practice: false,
  stakeLamports: 250_000_000,
  playerName: "Pilot",
};
const human = (id: string, team: string | null = null): ResultPlayer => ({
  clientID: id,
  human: true,
  team,
});

describe("victory prizes", () => {
  it("preserves the real-SOL network and exact settled-size prize", () => {
    const result = buildWinResult(
      { ...terms, network: "mainnet", stakeLamports: 10_000_000 },
      [human("a"), human("b")],
      "a",
    )!;
    expect(result.network).toBe("mainnet");
    expect(result.prizeLamports).toBe(19_800_000);
    expect(result.profitLamports).toBe(9_800_000);
  });
  it("separates the returned stake from the winner's net profit", () => {
    const result = buildWinResult(terms, [human("a"), human("b")], "a")!;
    expect(result.prizeLamports).toBe(495_000_000);
    expect(result.profitLamports).toBe(245_000_000);
  });
  it("splits the 2v2 pool between both winning teammates", () => {
    const result = buildWinResult(
      { ...terms, mode: "2v2" },
      [
        human("a", "red"),
        human("b", "blue"),
        human("c", "red"),
        human("d", "blue"),
      ],
      "a",
    )!;
    expect(result.poolLamports).toBe(1_000_000_000);
    expect(result.winners).toBe(2);
    expect(result.prizeLamports).toBe(495_000_000);
    expect(result.profitLamports).toBe(245_000_000);
  });
  it("excludes bots from an FFA pool and keeps all human entries", () => {
    const roster = [
      human("a"),
      human("b"),
      human("c"),
      { clientID: null, human: false, team: null },
    ];
    const result = buildWinResult({ ...terms, mode: "ffa" }, roster, "a")!;
    expect(result.entrants).toBe(3);
    expect(result.prizeLamports).toBe(742_500_000);
  });
  it("never invents a stake or winnings for practice", () => {
    const result = buildWinResult(
      { ...terms, mode: "ffa", practice: true, stakeLamports: 0 },
      [human("a")],
      "a",
    )!;
    expect(result.prizeLamports).toBe(0);
    expect(result.profitLamports).toBe(0);
  });
  it("preserves four-decimal stakes without floating-point payout math", () => {
    const result = buildWinResult(
      { ...terms, stakeLamports: 100_000 },
      [human("a"), human("b")],
      "a",
    )!;
    expect(formatSol(result.prizeLamports)).toBe("0.000198");
    expect(formatSol(result.profitLamports)).toBe("0.000098");
    expect(formatSol(500_000_000)).toBe("0.50");
  });
  it("withholds an amount for spectators, incomplete teams or invalid stakes", () => {
    expect(buildWinResult(terms, [human("a"), human("b")], null)).toBeNull();
    expect(
      buildWinResult(
        { ...terms, mode: "2v2" },
        [human("a", "red"), human("b", "blue")],
        "a",
      ),
    ).toBeNull();
    expect(
      buildWinResult(
        { ...terms, stakeLamports: NaN },
        [human("a"), human("b")],
        "a",
      ),
    ).toBeNull();
    expect(buildWinResult(terms, [human("a"), human("a")], "a")).toBeNull();
  });
  it("does not reuse another match's stake or a mutable lobby reference", () => {
    const input = { ...terms };
    setMatchTerms(input);
    input.stakeLamports = 1;
    expect(getMatchTerms("match-a")?.stakeLamports).toBe(250_000_000);
    expect(getMatchTerms("match-b")).toBeNull();
  });
});
