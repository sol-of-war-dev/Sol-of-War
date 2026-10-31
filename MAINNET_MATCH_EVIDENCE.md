# Completed mainnet paid match: e36bb46d

**A real-SOL 1v1 match completed on Solana mainnet on October 30, 2026
(Pacific time; October 31 UTC). Two 0.01 SOL entries funded a 0.02 SOL pool.
The finalized settlement paid 0.0198 SOL to the winner and 0.0002 SOL to the
treasury.** The platform separately paid the settlement transaction's network fee.

The receipts below verify real mainnet entry transfers and settlement, rather than
devnet transfers, simulated balances, or mocked RPC responses.

## Match and deployed source

| Field | Observed value |
| --- | --- |
| Match | `e36bb46d`, Europe, ranked 1v1 |
| Players shown by the application | GreasedSnorlax and Johnny2Shoes |
| Application winner | GreasedSnorlax |
| Frozen funded roster | Two players, 0.01 SOL each |
| Result behavior | Completed under the existing 12-minute timer rule; this is not a test of the later elimination-win fix |
| Result verification | Application reported server replay verified; payment history then reported “Payout finalized.” |
| Running source during this match | [`20bdfbc3664990e0ba5c06b4206848c3627d45d5`](https://github.com/sol-of-war-dev/Sol-of-War/tree/20bdfbc3664990e0ba5c06b4206848c3627d45d5) |
| Mainnet settlement slot | `463485546` |
| Receipt verification time | `2026-10-31T00:31:14Z` |

The match ID and player names are application metadata; they are not encoded in
these native SOL transfer instructions. Solana independently establishes the
address flows and their finalization. The match/result association above comes
from the live application and its payment history. This evidence does not provide
an independent reconstruction of the recorded game or a third-party audit.

## Follow the SOL

All three transactions have finalized status and no transaction error.
Amounts below are native SOL. Exact addresses and lamport amounts are also in the
[machine-readable receipt record](evidence/mainnet-match-e36bb46d.json).

| Step | From | To | Amount | Mainnet receipt |
| --- | --- | --- | ---: | --- |
| Winner's entry | Personal wallet A (`7Ym72…UGEh`) | Match pool (`CnH9…LZ3p`) | 0.01 SOL | [Entry A](https://explorer.solana.com/tx/XNJ3fex45DrYYyFUXoZ2y6SEBPQobpyUauwBPzTbNbxXfKPoDmgVqSF5LqW8UGCJPrcVL6aUM4qeEeNpWJTtRfF) |
| Opponent's entry | Personal wallet B (`Aegbn…1rbb`) | Same match pool | 0.01 SOL | [Entry B](https://explorer.solana.com/tx/3JKMnLNBmVM7HmrgV41BKJqw3Nq4TkMmGSLgUmhJ9ZPsxyoj6Y9LA4igZYJ9WjoTqzWvgwsySthsay3Fr4zbDXJR) |
| Winner payout | Same match pool | Original funding wallet A | 0.0198 SOL | [Settlement](https://explorer.solana.com/tx/3wHk1g1EG8J6x7r2BFNLVttsUWUFsVPVnvAcetDvQUC3LaeLE8YUadBRkp29vNURhuCU7VffVVG8URCAoUfrgcVN) |
| Platform fee | Same match pool | Treasury (`8B2h…RzES`) | 0.0002 SOL | Same settlement transaction |

The two outgoing instructions are in **one transaction**. The 99% prize plus 1%
platform fee account for the entire 0.02 SOL funded pool. The winner's payout
includes their original entry; it is not 0.0198 SOL of profit.

| Account | Full address |
| --- | --- |
| Personal wallet A / winner recipient | `7Ym72ZtCMhayiMShxTYW5DPZtL4vwfASkyd3xyZ6UGEh` |
| Personal wallet B | `Aegbngs7nyCFqP2xDNUPamZwYfa4wGsocryz3Npw1rbb` |
| Match pool | `CnH9kAv9QDnB2epM8ahetSk2f1dmk8kuZZynBVGdLZ3p` |
| Treasury | `8B2hVW2hDC2jtxunccQoFagoKtLyDDi32eB1YqVbRzES` |
| Platform network-fee payer | `2AQfBHZ12g7NogBgLfia6gzpMueTTz6T4PmzbQmssCG2` |

## What happened between entry and payout

1. Each player approved their entry transfer from their personal wallet into the
   same match pool. The backend checked funding on Solana.
2. The application locked the two funded participants, their entry amounts and
   payout addresses before play.
3. The game completed and displayed GreasedSnorlax as the winner. The server
   reported verification against the recorded replay.
4. Settlement returned the prize to the winner's original funding wallet and
   sent the platform fee to the treasury in one transaction.
5. Payment history reported finalization. A separate read-only RPC check verified
   both deposits and settlement, their amounts, fee payers and finalized status.

Inspect the implementation used for this match:
[entry verification and settlement](https://github.com/sol-of-war-dev/Sol-of-War/blob/20bdfbc3664990e0ba5c06b4206848c3627d45d5/src/frontpot/payments/DevnetPayments.ts),
[frozen roster and payout plan](https://github.com/sol-of-war-dev/Sol-of-War/blob/20bdfbc3664990e0ba5c06b4206848c3627d45d5/src/frontpot/MatchLedger.ts),
[server archive and replay verification path](https://github.com/sol-of-war-dev/Sol-of-War/blob/20bdfbc3664990e0ba5c06b4206848c3627d45d5/src/frontpot/Server.ts).
Despite its historical filename, `DevnetPayments.ts` also implements the configured
mainnet payment path; the receipt verifier checks mainnet's genesis hash.

## Network fees in this particular match

Each entry wallet paid **0.000005 SOL** in network fees. The platform fee-payer
wallet paid **0.00001 SOL** for settlement, separately from the 1% treasury fee.
The winner therefore received a net increase of **0.009795 SOL** across their
entry and payout, after that entry's network fee.

This match predates release `2bed045`, which adds platform sponsorship for newly
prepared in-app entries and withdrawals. Do not describe these older entries as
sponsored. The later sponsorship change has a separate
[finalized devnet receipt](evidence/fee-sponsorship-devnet-2026-10-30.json);
this mainnet match does not prove a subsequent sponsored mainnet withdrawal.

## Reproduce the on-chain checks

Use Node 24 or newer, from this repository:

```sh
node scripts/verifyMainnetMatch.mjs
```

The script is read-only. It checks mainnet genesis, finalized status, transaction
success, exact sources/destinations/amounts, fee payers, network fees and each
account's transaction balance changes. It requires no wallet or signing key and
never submits a transaction. If the public RPC rate-limits or lacks historical
transaction data, set `SOLANA_RPC_URL` to a mainnet RPC with transaction history.
Do not commit an RPC URL containing credentials.

## What this proves, and what it does not

This supplies public evidence of **one completed, funded mainnet 1v1 match with a
verifiable payout**, and its complete entry/pool/settlement money flow. It does
not demonstrate every game mode, every failure/refund scenario, a withdrawal to
an external wallet after the prize, or sustained availability at scale.

Personal wallets and match pools have different trust boundaries. Fresh personal
wallet transfers require user approval; after an entry reaches the pool, the
operator controls pool signing and game-result verification. **The pools remain
custodial. No on-chain escrow or independent security audit is established by
these receipts.** A transaction confirms money movement, not that a game was fair.

This evidence is supplied for independent review.
