# Sol of War account wallets

## User-owned wallet migration

The opt-in user-owned wallet flow is documented in [USER_OWNED_WALLETS.md](USER_OWNED_WALLETS.md). New wallets are created in the user’s Privy account without added server signers, and sensitive key export stays in Privy’s protected interface. Registration checks linked ownership, a sole user owner, no additional signers and no restrictive wallet policies. Unknown metadata fails closed. Existing balances move only after exact, signed user approval; match pools remain custodial. For dated production activation checks and the completed mainnet match, see [deployment evidence](SECURITY_EVIDENCE.md) and [mainnet receipts](MAINNET_MATCH_EVIDENCE.md). Source code alone does not establish a deployment's configuration.

The remainder of this document describes the **legacy custodial wallets**, retained for recovery and old match payouts.

Read [How funds and payouts work](PAYOUTS.md) for the player-facing overview. Privy authenticates the external login wallet. When account wallets are enabled, the application generates a separate Solana keypair per account. Account ID, login wallet, personal deposit wallet and each match pool are distinct. Only native SOL is credited. Funded-match admission follows the configured invite/public policy; creating an account wallet does not by itself grant access to a wagered match. These are implementation details, not a claim about live deployment settings.

## Money flow

- A finalized chain balance is the source of truth. There is no client-supplied balance or off-chain credit.
- The user explicitly confirms each paid entry in the app. The server reserves its amount, builds an exact transfer into the match wallet, signs with the player key and the existing fee payer, and persists fully signed bytes before broadcast. The sign-in wallet must sign an exact, expiring authorization for a new transfer. This message binds the source, destination, amount, network, request ID and wager terms. Its consumption and transfer reservation are atomic. This safeguard runs in the application process and does not remove operator custody.
- Reservations serialize spending; pending and unknown transactions remain held across restarts. Each transfer includes a unique memo to distinguish identical amounts in the same block. A retried HTTP request reuses its transfer ID and signed bytes.
- Balances are read at finalized commitment with a minimum slot covering completed debits. A stale RPC response cannot release a reservation against an older balance.
- The confirmed funding address becomes the immutable ledger payout destination. Winnings and full refunds return there. The 1% treasury fee and verified-result requirement are unchanged.
- Withdrawals default to the external wallet verified at sign-in, but the user can choose a different valid Solana address. The UI requires confirmation of the address and amount and a signature from the verified sign-in wallet. The authenticated session selects the spending account; the request cannot select another owner. Address validation does not prove recipient ownership. The minimum is 0.001 SOL (or the full available balance), with rate limiting and rent-remainder checks. The platform pays the network fee; no additional withdrawal commission is implemented.
- Existing externally funded entries preserve their original source/refund/payout destination. Enabling user-owned wallets never migrates existing funds automatically. Users must approve each migration, and old match destinations stay frozen.

## Keys and deployment

`SOLSIEGE_PLAYER_WALLETS=enabled` enables the feature. `SOLSIEGE_WALLET_KEYRING` is private server JSON with `active` (key version) and `keys` (version to base64 32-byte wrapping key). Generate wrapping keys with a cryptographically secure RNG. Never place this value in source, build variables exposed to the client, logs or database backups.

The database contains AES-256-GCM encrypted Ed25519 PKCS8 keys. Authenticated encryption binds each record to its owner ID, public address, network and format version; swapped ciphertext and wrong keys fail closed. The signing method is internal only. Neither private keys nor arbitrary signing endpoints are exposed through HTTP.

The initial implementation runs this signing module in the application process; it is not an HSM or an isolated remote signer. Someone controlling the application runtime and its keyring can control these wallets. A dedicated signing service/KMS and independent security review remain production-hardening work before a broad public custody rollout.

Keep an independent recovery copy of every wrapping key version in an operator-controlled secret store. Existing encrypted offsite database backups include wallet records. The deposit address is not displayed and account spending is not admitted until an offsite snapshot has been uploaded after that wallet was created. Losing both the keyring and its recovery copy permanently loses access to the wallets. Keep old wrapping key versions for older backups; do not replace or delete them casually.

Restore the database, its original network binding and all required wrapping key versions together. Existing restore reconciliation holds remain in force. Startup validates every wallet key against its saved address. Never delete/recreate a player wallet to recover a key failure. Do not roll back to a release without wallet support after accepting funds.

## Scope of verification

Automated tests use generated Ed25519 keys, real Solana transaction encoding/signature verification and mocked RPC responses. They cover simultaneous spending, ciphertext tampering, wrong networks, stale balances, ambiguous sends, restart recovery, authenticated ownership, selected withdrawal destinations, immutable retry terms, legacy entry compatibility, refunds and 99% prize settlements. They are not evidence of a successful mainnet transfer. [Manual result-review tests](tests/frontpot/PlayerWallets.test.ts) also cover account-funded and mixed legacy rosters: replay eligibility, full refunds to frozen funding addresses, restart recovery and rejection of altered recipients, cancelled entries, unfinalized deposits or existing refunds. See [Payment architecture](PAYMENTS.md#verification-and-known-limits) for the scope of this verification.

Deployment evidence should identify the release and network and include actual native-SOL top-up, entry, refund, winner payout and withdrawal receipts. No complete public rehearsal record is bundled here. The fee payer and game-pool wallets use the configured Privy signer; account wallets do not use Privy wallet provisioning.
