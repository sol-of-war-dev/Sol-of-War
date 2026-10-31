# Sol of War game rules

These rules describe the implementation deployed in release
[`46bf8e9`](https://github.com/sol-of-war-dev/Sol-of-War/commit/46bf8e964746179970bf89f80b0739c038aa1585)
on October 30, 2026 (Pacific time). Check the lobby's displayed map, entry,
capacity and timer before joining. Archived matches retain their recorded rules.

Read these rules on the site in [How to Play](https://solofwar.fun/how-to-play)
and [payment information](https://solofwar.fun/terms#game-rules).

## Modes, tribes and nations

Tribes are the small neutral AI countries (`bots` in the code). Nations are the
separate AI countries supplied by a map. Neither pays an entry or receives a prize.

| Mode | Human roster | Tribes: Compact / Normal | Nations | SOL prize | Elo |
| --- | --- | --- | --- | --- | --- |
| Ranked 1v1 | 2 players | 100 / 400 | Disabled | Entire net pool to the winner | Separate 1v1 rating |
| Ranked 2v2 | 4 players, 2 per team | 100 / 400 | Disabled | Net pool split between both winning teammates | Separate 2v2 rating |
| FFA Wagers | Eligible funded players, up to the lobby capacity | 100 / 400 | Disabled | Entire net pool to the winner | None |
| Casual FFA / Free Play | Lobby minimum and capacity | 100 / 400 by default | Map defaults | None | None |
| Free 1v1 / 2v2 | 2 / 4 players | 100 / 400 | Disabled | None | None |
| Solo practice / tutorial | One human | Practice/tutorial configuration | Practice/tutorial configuration | None | None |

**FFA Wagers are paid but unranked:** they do not affect Elo. Their nations remain
disabled regardless of that unranked label. Paid lobby creation and edits enforce
the wager population rules; host input cannot turn nations back on or change the
fixed tribe count.

Casual FFA retains nations: Normal maps use the map's default nation count;
Compact maps use one quarter of that count, rounded down. Maps with no applicable
nations spawn none. Custom casual settings may override population defaults;
consult the lobby settings. Practice and tutorial are separate from wager rules.

## How a multiplayer match is won

| Mode | Elimination victory | Prize recipients for a paid match |
| --- | --- | --- |
| 1v1 | One human remains alive after the opponent loses all territory | The surviving human |
| 2v2 | Only one human team has any living players | Both registered players on that team |
| FFA | One human remains alive | The surviving human |

A 2v2 game continues at 1v2 or 1v1 while both teams still have a living player.
When the last opposing player is eliminated, the surviving player's team wins.
An eliminated or disconnected winning teammate still receives their share.

Living tribes or nations do not keep an otherwise won multiplayer match running.
Only humans are eligible winners. Losing a network connection alone is not
elimination: a disconnected human with territory still counts as alive. The
elimination check waits until the spawn phase has ended and every human in the
engine roster has spawned. If all humans are eliminated, it declares no winner.
Solo practice does not auto-win just because only one human is present.

### Territory and time limits

Elimination is not the only finish condition. The existing territory threshold
and match timer still apply:

- A human player, or the combined human territory of a team, can win by exceeding
  the configured share of non-fallout land (normally 80%).
- At the configured time limit, the largest eligible human player or human team
  wins. Neutral AI territory cannot win or block the human timer result.
- The engine also has a 170-minute hard limit. Custom casual overtime settings
  can lower the territory threshold over time; standard wagers disable overtime.

The timer is part of the match's saved configuration. Automatically varied
competitive 1v1/2v2 lobbies use 10 minutes on Compact maps and 15 on Normal maps;
varied FFA lobbies use 15 and 30 minutes respectively. Other lobby creation paths
and administrator templates can set different timers. Use the displayed lobby
terms rather than assuming every match shares one duration.

## Entries and payouts

Only finalized, eligible human entries form a paid match's pool. Before play, the
server freezes the funded roster, teams, entry terms and payout destinations.
Spectators, tribes, nations and excluded or late entries do not enlarge that
locked prize pool. A later disconnect does not remove an already locked entry.

The standard platform fee is **1% of the gross pool**. The remaining **99%** is
awarded as follows:

| Mode | Example entries | Gross pool | Platform fee | Winner payout |
| --- | --- | --- | --- | --- |
| 1v1 | 2 × 0.01 SOL | 0.02 SOL | 0.0002 SOL | 0.0198 SOL to one winner |
| 2v2 | 4 × 0.01 SOL | 0.04 SOL | 0.0004 SOL | 0.0198 SOL to each winning teammate |
| FFA Wagers | 10 × 0.01 SOL | 0.10 SOL | 0.001 SOL | 0.099 SOL to one winner |
| Free Play / practice / tutorial | No paid entry | None | None | No SOL payout |

Payout includes the winner's original entry; it is not net profit. Calculations
use whole lamports. The platform fee rounds down; any indivisible team-prize
remainder goes to winning players in frozen roster order, not to an extra fee.
A potential full-capacity pool is not a guaranteed payout.

The server replays the recorded match and verifies the result before authorizing
settlement. Recipients must match the locked human roster. Prizes return to the
wallets that funded the entries. The winner prizes and treasury fee are submitted
in one atomic settlement transaction; payment is complete only after finalization.

New supported in-app entries and withdrawals use platform network-fee sponsorship
while users approve their personal-wallet transfers. Payout and refund network
fees are also paid by the platform. External-wallet top-ups/direct deposits and
older prepared requests can have different fee payers; see [fees and actual
payouts](PAYOUTS.md#fees-and-actual-payouts) for the exact boundaries.

## Cancellations, refunds and trust

Cancelled matches and eligible excluded or late entries receive full entry
refunds without the platform fee. Verified games with no eligible human winner
also refund entries. Unverifiable results are held for review, with no winner
payout authorized. Disconnecting after lock does not automatically refund a
losing entry. Uncertain transactions are reconciled rather than blindly repeated.
See [refunds and disconnects](PAYOUTS.md#refunds-and-disconnects).

Personal user-owned wallets require user-approved spending, but **wagered funds
are held in operator-controlled match pools**. Game-result verification is also
performed by the platform. These rules do not implement trustless on-chain escrow.
See [wallet ownership](USER_OWNED_WALLETS.md) and [payment architecture](PAYMENTS.md).

## Implementation and regression checks

- [Population and wager normalization](src/frontpot/Rules.ts),
  [lobby creation and edits](src/frontpot/Store.ts),
  [scheduled lobbies](src/frontpot/GlobalQueue.ts) and
  [map/timer rotation](src/frontpot/LobbyRotation.ts).
- [Human elimination, territory and timer decisions](packages/engine/src/execution/WinCheckExecution.ts).
- [Frozen roster, winner validation and payout allocation](src/frontpot/MatchLedger.ts).
- [Population tests](tests/frontpot/Rules.test.ts),
  [queue tests](tests/frontpot/GlobalQueue.test.ts),
  [tribe-safe victory tests](tests/frontpot/EliminationVictory.test.ts) and
  [payout tests](tests/frontpot/MatchLedger.test.ts).
- [Completed mainnet match receipts](MAINNET_MATCH_EVIDENCE.md). That historical
  match used its own recorded rules; it is not a live test of every rule above.

## Match receipts and disputes

The source now includes public match receipts, a public replay viewer for eligible
recordings, and participant-only result disputes with administrator review.
Production deployment and live acceptance testing are pending. See
[Match receipts and disputes](MATCH_RECEIPTS.md) for access, workflow and limitations.
Disputes do not reverse finalized transfers or replace the settlement rules.
