# Sol of War mainnet configuration

This is a setup guide, not a record of current activation or custody assurance. The default local mode is `simulation`; the live mode must be checked separately. For payment behavior and evidence limits, see [PAYOUTS.md](PAYOUTS.md) and [PAYMENTS.md](PAYMENTS.md). The October 27 setup notes below are historical, not current balances or a completed funded rehearsal.

## Configuration completed October 27, 2026

The operator approved a separate mainnet signer, native-SOL transfer policy and empty fee payer. Their configuration is saved in private Railway variables; the temporary local credential file is removed after verification. The prepared admission setting is invite-only and the state directory is `/data/solsiege-mainnet`. The official public mainnet RPC is used for setup checks; production RPC capacity/history still needs validation.

- Mainnet fee payer: `2AQfBHZ12g7NogBgLfia6gzpMueTTz6T4PmzbQmssCG2`.
- Unfunded signing-test pool: `5YVbjLhpeNsATMAoHFWTbZjJUf9CbAJePKEUU8NGKdiy` (not a playable match; do not deposit).
- Verified mainnet genesis, managed pool creation/lookup and exact pool/fee-payer signatures for multiple recipients, including a 100.1 SOL instruction without a business cap. No transaction was broadcast.
- Provider rejected non-transfer System instructions, a transfer mixed with an unrelated program, and message signing. Policy explicitly denies private-key export; no export was attempted.
- Fee payer and treasury were funded and verified at 0.01 SOL each on October 27. The fee-payer provider signature passed an RPC simulation with signature verification; no transaction was broadcast and its balance was unchanged. The signing-test pool remains unfunded. End-to-end deposits, gameplay and payouts still need validation.
- Private backup encryption and monitor tokens are configured. An encrypted offsite Railway bucket is configured, with a separate secure recovery copy of the decryption key. External notification delivery and mainnet restore/chain reconciliation remain outstanding.

## Separate production custody

Create a dedicated P-256 authorization key/owner, native-SOL transfer policies and fee-payer wallet in the existing Privy app. Save the key only in private service variables and a separately secured recovery copy; never in source, browser code, logs or chat. Rotate the previously shared app secret before funded use.

The intended policy permits only `signTransaction` for System Program `Transfer` instructions. It does not permit private-key export, message signing or unrelated programs. Production cannot use the test policy's 1 SOL/test-recipient restrictions. The application derives destinations from immutable entry/refund/settlement records. This policy does not independently verify a game result; a compromised signing authority can authorize transfers, so independent custody/security review remains necessary. Solana signing policies are not inherently a network lock. The application checks genesis and uses separate test/production wallets.

Setup creates empty resources; it neither funds them nor activates wagering. Validate allowed transfers and rejected instruction types through the real provider before a funded test.

## Private service settings

| Setting | Purpose |
| --- | --- |
| `PRIVY_APP_ID`, `PRIVY_APP_SECRET` | Existing application credentials; server only |
| `PRIVY_MAINNET_POOL_OWNER_ID` | Dedicated production owner/quorum |
| `PRIVY_MAINNET_POOL_AUTHORIZATION_KEY` | Dedicated production authorization private key |
| `PRIVY_MAINNET_POOL_POLICY_IDS` | Comma-separated production transfer policies |
| `PRIVY_MAINNET_FEE_PAYER_ID` | Dedicated production managed wallet ID |
| `MAINNET_FEE_PAYER_ADDRESS` | Its public address; distinct from treasury |
| `MAINNET_TREASURY_WALLET` | `8B2hVW2hDC2jtxunccQoFagoKtLyDDi32eB1YqVbRzES` |
| `SOLANA_MAINNET_RPC_URL` | Production HTTPS RPC with historical transaction access |
| `MAINNET_STATE_DIR` | Fresh absolute path on the volume, e.g. `/data/solsiege-mainnet` |
| `MAINNET_ADMISSION` | Explicitly `invite` or `public`; invite for the controlled check |
| `MAINNET_PLAYER_WALLETS` | Approved public wallet addresses when admission is `invite` |
| `SOLSIEGE_BACKUP_KEY` | Independent base64-encoded 32-byte backup encryption key |
| `SOLSIEGE_BACKUP_DIR` | Defaults to `backups` under the state directory |
| `SOLSIEGE_MONITOR_TOKEN` | Private bearer token for `/readinessz` monitoring |

Only activation selects `PAYMENTS_MODE=mainnet`. Missing settings, reused configured test custody, wrong genesis and wrong-network database bindings fail closed. Treasury must be rent-exempt and the fee payer needs at least 0.01 SOL at startup. Do not fund addresses on the wrong network.

The operator requested no business entry/prize caps. Leave `MAINNET_MAX_ENTRY_LAMPORTS`, `MAINNET_MAX_POOL_LAMPORTS`, `MAINNET_MAX_HELD_LAMPORTS` and `MAINNET_MAX_OPEN_POOLS` unset. Optional caps require the complete coherent set. Precision checks still reject unrepresentable values. Simulation entries start at 0.0001 SOL. Funded entries start at 0.001 SOL for account-rent handling; the server applies this minimum to custom rooms, queued matches and saved generation settings before accepting them. This is a technical minimum, not a business maximum.

## Evidence before activation

- Production key/policy isolation, provider rejection tests and app-secret rotation.
- Production RPC, separate funded fee payer, rent-exempt treasury and actual wallet approvals.
- Funded deposit, roster lock, independent replay, final payout and exact 1% receipts in every mode; cancellation/late-entry refunds, restarts and provider failure cases.
- Offsite backup retention and external alert delivery; restore plus chain reconciliation; reviewed unresolved-payment procedures and independent security/load validation.
- Production terms and operating/eligibility/provider review, with support and dispute procedures.

Switching network/state starts a separate ledger and may require users to claim profiles again. Do not copy simulated/test payment rows into mainnet. Preserve the old database for history. Only one replica may own each state volume.

References: [Privy authorization keys](https://docs.privy.io/controls/authorization-keys/keys/create/key), [key quorum API](https://docs.privy.io/api-reference/key-quorums/create), [Solana policy examples](https://docs.privy.io/controls/policies/example-policies/solana), [Solana genesis RPC](https://solana.com/docs/rpc/http/getgenesishash).


The source includes encrypted offsite backup support, direct unmatched-deposit returns and constrained review of unverified results. See `OPERATIONS.md` for review/recovery controls and `PAYMENTS.md` for implementation and verification evidence. This guide does not establish whether a particular release, provider plan or real-SOL mode is active. A successful RPC simulation is not proof of a real deposit or payout.
