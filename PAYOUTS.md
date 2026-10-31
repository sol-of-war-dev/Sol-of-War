# How funds and payouts work

**Wallet custody depends on the enabled flow.** The new opt-in personal wallet is created under the user’s Privy ownership without a server spending signer. Users approve its transfers and export through Privy. Existing account wallets remain under Sol of War custody until the user approves migration to a new address. Wagered SOL always leaves the personal wallet and enters operator-controlled match pools; trustless escrow is not implemented. See [the migration and verification requirements](USER_OWNED_WALLETS.md). The legacy flow below still applies wherever this feature has not been activated.


Paid matches use native SOL. Eligible entries form the prize pool; the platform
fee is **1% of that pool**, and the winner or winning team receives the remainder.
Cancelled entries are returned in full without that platform fee.

**Sol of War controls the signing keys for account wallets and match pools.**
These are custodial wallets. The server verifies games and authorizes payments;
a trustless escrow smart contract does not adjudicate the outcome.

This guide describes the repository's implementation, reviewed October 29, 2026.
It does not establish the live service's current network, balances or audit status.
See [Payment architecture](PAYMENTS.md) for implementation evidence and known limits.

## Check the network

| Mode | Funds |
| --- | --- |
| Free Play / Solo practice | No entry payment or SOL prize. |
| Simulation | Simulated amounts; no SOL moves and prizes cannot be withdrawn. |
| Devnet | Test SOL on Solana devnet. |
| Mainnet | Real SOL on Solana mainnet. Losing a wager loses that entry. |

Use the address and network shown in the app. Native SOL is the supported asset;
tokens sent to a deposit address are not credited as SOL. Repository examples
and treasury addresses are not personal deposit instructions.

## Follow your funds

When account wallets are enabled:

1. **Top up.** Your external wallet signs a transfer to your dedicated Sol of War
   deposit address. Funding an account does not enter a match. The balance updates
   after Solana finalizes the transfer.
2. **Confirm an entry.** You approve the wager amount in the app. The server reserves
   it and signs a transfer from your account wallet into that match's separate pool.
   This does not require another signature in your external wallet. Sign-in alone
   does not pay an entry.
3. **Start.** Only funded, connected players qualify for the starting roster.
   The server freezes participants, teams, entry amounts and payout wallets.
4. **Verify.** The server replays the recorded game before authorizing a prize.
   A client reporting a win is not enough. An unverifiable result is held for review.
5. **Receive and withdraw.** A prize returns to the wallet that funded the entry.
   For an account-funded entry, that is your Sol of War account wallet. You can
   then withdraw available SOL to your confirmed Solana destination address.

The older direct-entry flow remains supported: an external wallet signs each match
deposit. Its original payout/refund destination stays fixed; enabling account
wallets does not redirect those existing entries.

| Wallet | Controller and purpose |
| --- | --- |
| External wallet | You hold its keys. Used for sign-in and top-ups; the default withdrawal destination. |
| Sol of War account wallet | The application holds its encrypted key. Holds available balance and receives account-funded prizes/refunds. |
| Match pool | Platform-authorized signing through Privy. Holds entries for one match. |
| Treasury | Receives the platform fee on a successfully settled winning result. |
| Network fee payer | Separate platform wallet that pays for supported outgoing transactions. |

## Fees and actual payouts

The displayed **prize pool is gross, before the fee**. A **potential prize pool**
assumes every slot is funded; it is not a promised payout. Settlement uses the
funded roster locked at match start.

| Match | Entry each | Funded players | Gross pool | Platform fee | Prize |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1v1 | 0.25 SOL | 2 | 0.5 SOL | 0.005 SOL | 0.495 SOL to the winner |
| 2v2 | 0.25 SOL | 4 | 1 SOL | 0.01 SOL | 0.495 SOL to each winning teammate |
| FFA | 0.25 SOL | 25 | 6.25 SOL | 0.0625 SOL | 6.1875 SOL to the winner |

These payouts include the winner's original entry; they are not net profit.
Both registered winning teammates are paid in 2v2, including a teammate eliminated
or disconnected after the roster locked.

New multiplayer matches also end when only one human player remains alive (1v1
and FFA), or only one human team remains alive (2v2). A single surviving teammate
wins for the registered team. Losing a connection alone is not elimination.
Practice does not end simply because it has one human player. Existing territory
and time-limit rules remain available. The elimination rule is saved in the match
configuration; recordings created before this change retain their original rules.

Calculations use whole lamports (1 SOL = 1,000,000,000 lamports). The fee is rounded
down to a whole lamport. An indivisible prize remainder follows frozen winning
roster order and does not become an extra platform fee.

| Transfer | Network fee |
| --- | --- |
| External top-up or direct match deposit | Paid by the sending external wallet. Not returned with an entry refund. |
| New in-app user-owned wallet entry or withdrawal | Paid by the platform after the user signs, subject to sponsorship availability and limits. Previously prepared requests retain their original fee payer; prepare a new request for sponsorship. |
| Managed account-wallet entry, payout, refund or withdrawal | Paid by the platform's separate fee payer. No extra withdrawal commission is implemented. |

## Refunds and disconnects

| Situation | Outcome |
| --- | --- |
| Declining an offer before paying | No entry charge. |
| A funded lobby closes, or you leave before lock | Full funded entry queued for refund; no platform fee. |
| A deposit finalizes after exclusion or closure | Still tracked and queued for a full refund. |
| A verified game has no eligible human winner | Original entries queued for full refunds; no platform fee. |
| You disconnect after the game starts | The entry stays locked. No automatic refund of a losing entry. |
| Server restart during an unfinished game | Durable records drive interrupted-match refunds; recorded results or uncertain transfers may need verification/reconciliation. |
| Result cannot be verified | No winner payout authorized. Operator review is required; a refund is not immediate or unconditional. |

Refunds return to the original funding wallet and complete only when their
transactions finalize. A closed lobby or a refund-pending message is not proof
that SOL has arrived.

## Withdrawals and pending funds

Confirm both amount and destination. The connected wallet is the default, but you
can choose a different valid Solana address. Validation checks address format,
not whether you control it. An authenticated account session authorizes the server
to sign withdrawals; protect that session as well as your external wallet.

The minimum is 0.001 SOL, or your entire available balance if smaller. Transfers
that leave an unsupported below-rent remainder are rejected. Funds in a match or
reserved by an unresolved transfer cannot be spent again.

Uncertain transfers retain their reservation across restarts. A timeout does not
prove failure: the worker checks the original signature and reuses saved bytes.
There is no guaranteed completion time. Result checks, Solana finality, RPC or
signing outages, fee-payer funding and payment reviews can delay completion.

## Verify a receipt

Use **Match history** for entry/refund links and **View payout**. The account
wallet's recent transfers also link to receipts. On the matching Solana network,
check successful finalization, source, destination and native-SOL amounts.
A signature alone does not establish finalization.

The treasury fee and every winner prize are sent in one atomic transaction: those
transfers succeed or fail together. Separate deposits, refunds and the entire game
are not one atomic operation. Receipts prove transfers, not game fairness or the
operator's overall solvency.

For a payment review, retain the match ID, network, receipt signature, amount and
approximate time. Never include seed phrases, private keys or session tokens in
a report. Do not send another payment solely because the first one timed out.

## Safeguards and trust limits

The code verifies funding, freezes payout destinations, checks recorded results,
persists signed transfers before broadcast and reserves unresolved spending.
Account keys are encrypted at rest. An offsite backup containing a new account
wallet is required before its deposit address is exposed.

The application can decrypt account keys to sign. Control of its runtime and
keyring can therefore mean control of funds. Pool-signing authority and server
result verification are also trusted components. The repository contains no
independent custody/security audit or complete public mainnet rehearsal record.
Fixture tests do not guarantee protection against compromise or loss. Review
the [code, tests and known recovery limits](PAYMENTS.md) before treating a
documented safeguard as a verified production assurance.
