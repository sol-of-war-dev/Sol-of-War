# User-owned wallets and legacy migration

## Implementation and activation

The source includes an opt-in migration flow. It is not proof of a deployed feature, an independent audit, successful mainnet transactions, or trustless escrow. Enable `SOLSIEGE_USER_OWNED_WALLETS=enabled` only after the provider configuration and a real test-user rehearsal below have been verified. Default behavior remains the legacy mode until that flag is set.

1. A user explicitly creates a fresh embedded Solana wallet through Privy’s React SDK. No server keypair is generated, no old key is imported, and the application never adds a session signer or spending delegation.
2. The server reads Privy metadata to check the authenticated account, linked embedded wallet, address, owner quorum, sole user membership, threshold of one, empty authorization-key and nested-quorum sets, empty additional signers/policies, and absence of import/archive metadata. Unsupported or unavailable metadata prevents registration and new funding. The database stores only public wallet identifiers. Existing registrations cannot silently change wallets.
3. User-owned withdrawals and game entries are signed by the user’s wallet. The client checks exact native-transfer instructions before asking for approval; the backend independently validates submitted signatures. Fully signed transactions are durably saved before broadcast. Retries reuse the recorded transaction. The user wallet pays its transaction fee. Account-scoped withdrawal history stores public receipts across reloads and remains readable during a provider outage. An unsubmitted request can be cancelled; cancellation and signed-transaction persistence are checked under the same SQLite write lock, including requests still preparing or verifying signatures. A recorded payment cannot be cancelled. Cancellation in this application cannot revoke a user signature shared with another app.
4. Private-key export calls Privy’s `useExportWallet().exportWallet({address})`, which opens the provider’s protected interface and returns no key to our application. There is no application API for exporting private keys. Export is still available for a previously registered wallet if ownership verification becomes unavailable. Anyone with the exported key can spend the funds.
5. Legacy migrations are separate withdrawals with an explicit, expiring signature from the sign-in wallet. The server derives the destination from the registered new wallet and binds the exact amount, source, network and request ID. Merely registering, signing in or viewing a balance moves no funds. Reservations and existing pending transfers remain enforced. Sol of War pays the legacy migration network fee.

## Provider prerequisites

Use a separate development Privy app for rehearsal. Verify TEE user-owned wallets are supported and that client-created wallets expose an owner quorum containing only the authenticated user. The strict verifier intentionally rejects legacy or unknown metadata layouts; do not loosen it merely to make a dashboard look green. Configure no automatic additional/session signers, no platform authorization key in the user owner quorum, and no wallet policies restricting user export. Force provider wallet confirmation UIs on.

Enable **Return user data in an identity token** in Privy’s Authentication / Advanced settings. In user-owned mode the browser sends an identity token to the application session endpoint, never the Privy access token used for wallet operations. The server verifies signature, issuer, audience, expiry and identity-token claims and fetches current linked accounts. Existing access-token clients must refresh after rollout. In user-owned mode, the SDK is configured with `sessions.cookieWriteBehavior: "never"`; application API calls use `credentials: "omit"` and the application bearer session. Keep Privy spending tokens out of application logs, monitoring and request capture. Check deployment cookie/domain configuration too: it must not automatically forward wallet access tokens to the application server.

Metadata is rechecked before new funding, withdrawal and migration operations. The verifier performs read-only provider calls and does not change owner quorums, configure signers, export keys or sign transactions. Missing permission to inspect metadata is a rollout blocker, not permission to bypass it.

## Legacy funds and match pools

Keep legacy keyrings, wrapping-key versions, encrypted backups and recovery procedures. A copied or exported legacy key does not remove operator control or copies in backups. A wallet is out of that custody only after its funds move to the newly created address under user approval. Old matches retain their original funding/refund/payout destinations, so later proceeds may require another approved migration. Legacy withdrawals remain accessible in the Wallet page even if new-wallet verification fails. New user-owned mode stops creating or advertising new legacy deposit wallets.

Wagered SOL enters custodial match pools controlled by Sol of War. The operator signs their refunds and payouts, and platform systems verify game results. User ownership of the personal wallet does not make these pools trustless. Independently reviewed on-chain escrow, game-result authorization, timeouts and user recovery remain separate work.

A user-owned wallet also depends on Privy, account authentication, the browser/device and the application delivered to that browser. This release does not justify an absolute claim that a compromised website or stolen provider session could never affect funds.

## Evidence required before activation

- Verify provider configuration and a real test-user wallet’s owner/quorum metadata without displaying or recording private keys.
- Confirm registration refuses a foreign, delegated, imported, server-owned or uninspectable wallet.
- Have the user open protected export themselves; do not capture the key in logs, screenshots or test artifacts.
- On devnet, approve a withdrawal, cancel an approval, retry after a lost response, fund a match, and verify refund and winner-payout destinations.
- Rehearse a legacy migration with explicit approval, pending-transfer reservations and an old-match payout arriving after migration. Record public transaction signatures and network, never keys.
- Verify identity-only login and absence of access tokens in application traffic; confirm export/recovery survives an application outage.
- Compare canonical source and release input with `node scripts/release-manifest.mjs compare <other-root>`. Build from that source. Production startup verifies the manifest against runtime and frontend files. `/frontpot/api/release` reports source and asset digests. Runtime maps are separately pinned by Dockerfile archive checksum; offline map-generator input assets are not deployment inputs and are excluded. This detects accidental drift; a hostile operator can replace both the code and manifest, so it is not independent deployment attestation.
- Follow deployment drain and encrypted-backup checks before publishing. Preserve the active legacy recovery path. Record live release digests and later separately approved mainnet test receipts.

Local automated tests use generated keys and mocked RPC/provider responses. They establish regression coverage, not successful live provider access or mainnet custody safety.

## Primary provider references

- [Wallet export](https://docs.privy.io/wallets/wallets/export)
- [Get wallet metadata](https://docs.privy.io/api-reference/wallets/get)
- [Get key quorum](https://docs.privy.io/api-reference/key-quorums/get)
- [Identity tokens](https://docs.privy.io/user-management/users/identity-tokens)
- [Wallet policies and controls](https://docs.privy.io/security/wallet-infrastructure/policy-and-controls)
