# Deployment and payment evidence

This page separates the running production configuration from developer-run test results. A public repository, a transaction, and a security audit establish different things. These records are not an independent security audit.

## Check the running release

- [Production release metadata](https://solofwar.fun/frontpot/api/release) identifies the source commit and source/build digests.
- [Corresponding source archive](https://solofwar.fun/source) is served by that deployment.
- [Production availability](https://solofwar.fun/frontpot/api/availability) reports paused entries and deployment draining.
- [Public application configuration](https://solofwar.fun/frontpot/api/config) identifies the payment network and enabled wallet mode.

Observed on **October 30, 2026 at 19:31 UTC**: production reported commit `b6defd9d526f9d866e02a89baa2f258ec6448b68`, mainnet payments, user-owned wallets disabled, and entries paused with draining enabled. This dated observation is not a claim that a later deployment has the same settings. Source on another branch is not evidence that a feature is active on the website.

## Real devnet receipts

The [machine-readable rehearsal record](evidence/user-wallet-devnet-2026-10-30.json) contains exact addresses, signatures, finalized slots, amounts, fees, and test limitations. These transactions used **valueless devnet SOL in an isolated development app**, not production deposits.

| Check                        | Observed result                                                                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User-owned withdrawal        | 0.001 test SOL finalized from the fresh personal wallet; user wallet paid the network fee                                                                                                               |
| Legacy migration             | Approved 0.02 test SOL transfer finalized to the registered fresh wallet; legacy balance reached zero                                                                                                   |
| Waiting-match cancellation   | Full 0.001 test SOL entry refunded to its original funding address; no platform fee                                                                                                                     |
| Two-player winner settlement | Two 0.001 test SOL entries funded a 0.002 test SOL pool; server replay verification preceded the finalized 0.00198 prize and 0.00002 platform fee                                                       |
| Settlement conservation      | Prize and platform fee were in one transaction; operator paid the network fee; finalized pool balance was zero                                                                                          |
| Signing authority            | Privy rejected both the app secret alone and the app secret plus the pool authorization key when asked to sign for the approved test user's personal wallet                                             |
| Independent wallet recovery  | User privately exported with Privy, imported into Phantom, and sent 0.001 test SOL while the local application was offline; finalized source, recipient, amount and resulting balance verified on-chain |

Winner-settlement signature: [view on Solana Explorer, devnet](https://explorer.solana.com/tx/5hpEkR1GmB34h23sfiXEBr3cHs8FVbSSHCXpTbGnUdMSfoS7sr5kzfK6cBWxFzjqkVqvQzYb14JNgne3Aku6kHqe?cluster=devnet).

The result came from an actual private two-player test match and the saved replay. The remaining client rejoined through the normal invite-code flow before the result was reported and independently verified. No winner, verification hash, recipient, or settlement amount was inserted into the ledger to make this test pass.

Independent recovery signature: [view on Solana Explorer, devnet](https://explorer.solana.com/tx/f6EinPBT9PQBqyNYC3QUA3v5mjaytqs3fo2anYhnHgP3xhGECB2s4KEnP1GKzmBmGTVUL3NTND5FrkKVV8aMgXr?cluster=devnet). The local application was unavailable before and after chain verification. The recovered wallet paid Phantom's 0.000079934 test SOL network fee, and its finalized balance decreased by exactly the transfer plus that fee. The agent never read or copied the private key.

Late legacy recovery also completed in match `0cb4ca60`. An approved legacy withdrawal emptied the test opponent’s old wallet while the game was running. The replay-verified [late prize payout](https://explorer.solana.com/tx/YoNWCwT54DYBumdTTBxDhLqEPVtiUqWcwx4rpQLaLfctsaHZiLDScynVRpLKxzoVjvsPR6SideyDJKSofgZgEhq?cluster=devnet) returned 0.00198 test SOL to that original funding address. A subsequent approved [registered-wallet migration](https://explorer.solana.com/tx/b7DQaeNp8Lp7UxhgUbN6XJUaJkyMd9tqgnrdy447B8CkxcVmLwWCtCat8QwdPaYU6YeVB8ugtnaPGYVGwgnbU8n?cluster=devnet) moved those proceeds to the fresh personal wallet. Independent RPC checks confirmed transfer order, exact amounts and recipients, and zero final legacy/pool balances. The initial transfer used the legacy withdrawal route; the final recovery used the registered-wallet migration route. This test used one explicitly approved fixture account and valueless devnet SOL.

## Remaining limits

- Earlier expired signed requests remain held for review. A fresh test does not erase an uncertain earlier receipt.
- These devnet receipts do not establish that a production paid match has completed. Mainnet activation and separately approved production checks remain outstanding.
- Fresh personal-wallet ownership does not remove custody of wagered funds. The operator still controls match pools and server game-result verification. On-chain escrow is not implemented.
- The game requires WebGL2. A browser without it cannot independently exercise gameplay; readable source and receipts are supplementary evidence, not a substitute for a supported-browser play test.

See [user-owned wallet controls and activation gates](USER_OWNED_WALLETS.md), [funds and payouts](PAYOUTS.md), and the [payment code and test map](PAYMENTS.md#code-and-test-map).
