import { html } from "lit";

/** Shared by How to Play and the payment terms. Keep aligned with GAME_RULES.md. */
export function gameRulesContent() {
  return html`
    <h2 id="game-rules">Tribes and nations</h2>
    <p>
      Ranked 1v1, Ranked 2v2 and FFA Wagers use 100 tribes on Compact maps and
      400 on Normal maps. Nations are disabled in all wager modes. Tribes are
      neutral AI countries; they never pay an entry or receive a prize.
    </p>
    <p>
      Casual FFA keeps map-default nations and defaults to 100 tribes on Compact
      maps or 400 on Normal maps. Compact nation counts are one quarter of the
      map default, rounded down; maps without nations spawn none. Custom casual
      settings can override these defaults. Free 1v1 and 2v2 also use 100 / 400
      tribes with nations disabled. Solo practice and tutorial use their own
      settings.
    </p>
    <h2>How to win</h2>
    <p>
      <strong>1v1:</strong> eliminate the other human player. The last human
      with territory wins, even if tribes remain.
    </p>
    <p>
      <strong>2v2:</strong> eliminate both players on the opposing team. Play
      continues at 1v2 or 1v1 while both teams have a survivor. One surviving
      player can win for the whole team. Both registered winning teammates share
      the prize, including an eliminated or disconnected teammate.
    </p>
    <p>
      <strong>FFA:</strong> the last human player with territory wins. Surviving
      tribes or nations do not prevent a human elimination victory. FFA Wagers
      have SOL prizes but do not affect Elo.
    </p>
    <p>
      Disconnecting alone is not elimination. Elimination checks wait until the
      spawn phase ends and every human in the game roster has spawned. If all
      humans are eliminated, there is no winner. Practice does not automatically
      end just because it has one human.
    </p>
    <h2>Territory and time limits</h2>
    <p>
      A human player or human team can also win by exceeding the territory
      threshold, normally 80% of non-fallout land. At the match time limit, the
      largest eligible human player or human team wins. AI territory cannot win
      or block the human timer result. The engine also has a 170-minute hard
      limit. Custom casual overtime can lower the territory threshold; standard
      wagers disable overtime.
    </p>
    <p>
      Check the timer shown in your lobby. Varied scheduled 1v1 and 2v2 matches
      use 10 minutes on Compact maps and 15 on Normal maps; varied FFA matches
      use 15 and 30 minutes. Custom lobbies and administrator templates can
      differ. Existing recordings keep their original rules.
    </p>
    <h2>Prizes by mode</h2>
    <p>
      The gross pool contains the eligible finalized human entries locked at
      match start. The standard platform fee is 1%; the remaining 99% goes to
      one winner in 1v1 or FFA Wagers, or is split between both registered
      winning teammates in 2v2. Free Play, practice and tutorial have no SOL
      entry or prize.
    </p>
    <p>
      At 0.01 SOL per player: 1v1 has a 0.02 SOL pool, a 0.0002 SOL fee and a
      0.0198 SOL winner payout. 2v2 has a 0.04 SOL pool, a 0.0004 SOL fee and
      pays 0.0198 SOL to each winning teammate. A ten-player FFA wager has a
      0.10 SOL pool, a 0.001 SOL fee and a 0.099 SOL winner payout.
    </p>
    <p>
      Payouts include the winner's original entry; they are not net profit.
      Potential pools assume full capacity and are not guaranteed. Whole-lamport
      rounding follows the frozen winning roster, with no extra platform fee.
      The server verifies the match replay before authorizing payout to the
      original funding wallets. Payment completes only after Solana
      finalization.
    </p>
    <p>
      Eligible cancelled or excluded entries and verified games without a human
      winner receive full entry refunds without a platform fee. Unverifiable
      results are held for review. Disconnecting after lock does not
      automatically refund a losing entry.
    </p>
    <p>
      New supported in-app entries and withdrawals use platform-paid network
      fees, subject to sponsorship availability and limits. The platform also
      pays payout and refund fees. External wallet top-ups and direct deposits
      may charge the sender; older prepared requests retain their original fee
      payer. Wagered funds remain in operator-controlled match pools, with
      server-side result verification. Trustless escrow is not implemented.
    </p>
    <p>
      <a
        href="https://github.com/sol-of-war-dev/Sol-of-War/blob/main/GAME_RULES.md"
        target="_blank"
        rel="noreferrer"
        >Read the full game rules on GitHub</a
      >
    </p>
  `;
}
