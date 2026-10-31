# Sol of War cosmetic shop

Implementation status: local preview and automated checkout tests. Purchases are
**disabled by default**. Draft prices require approval before activation. No live
shop burn or provider-sponsored Token-2022 rehearsal is claimed by this document.

## Collection and ownership

The shop adapts OpenFront's existing `CosmeticCard`, `CosmeticPreview`, rarity
presentation and in-game flag rendering. It uses a Sol of War catalog and our
account/payment backend instead of OpenFront's currency and commerce APIs.
The initial flags are original vector artwork in `src/frontpot/shop/Catalog.ts`;
no proprietary OpenFront cosmetics are used. Upstream license and attribution
requirements remain in place.

| Flag | Draft price in SOLOFWAR |
| --- | ---: |
| Ember Standard | 1,000 |
| Violet Vanguard | 2,500 |
| Solar Command | 5,000 |

Flags are visual only. They do not affect combat, matchmaking, ranking, win
conditions or payouts. Ownership is a permanent account unlock, not an NFT or
transferable asset. Players can equip or unequip an owned flag in the shop;
the game server loads it from the inventory when they next join. The browser
cannot grant itself a flag by sending cosmetic references in its join message.
Current matches and recorded replays keep their existing appearance.

## Token and checkout

Mainnet mint: `4KdB5zg8VuuUKJEk4DvkVZnrT9DJQxvWbjfDRF4cpump`.
A finalized RPC read on October 30, 2026 verified six decimals and the Token-2022
program `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`. The observed mint had
metadata-pointer and token-metadata extensions, with no mint or freeze authority.
Checkout rereads and validates the mint; unfamiliar mint extensions fail closed.
Devnet uses a separate configured test mint. Classic SPL Token is supported for
devnet fixtures; mainnet is pinned to the Sol of War Token-2022 mint.

1. A signed-in player selects a cosmetic and reviews its token price. Their
   registered user-owned wallet must hold sufficient tokens in one token account.
2. The backend verifies the wallet owner and absence of server delegation using
   the existing wallet verifier, checks the network and finalized token account,
   and persists an immutable purchase quote with a unique reference.
3. The transaction contains exactly one `BurnChecked` instruction and one purchase
   memo. It destroys the quoted tokens, reducing mint supply. It does not send
   tokens to the platform or a so-called burn address.
4. The browser validates the exact transaction against the displayed purchase
   before requesting the user's signature. This grants no continuing spending
   permission. The wallet prompt describes the irreversible burn.
5. The sponsor verifies the user's signature, transaction contents, expiry,
   simulation and fee budget, then co-signs as fee payer. Fully signed bytes are
   persisted before broadcast. There is no fallback to charging the user's SOL.
6. A successful **finalized** receipt grants the cosmetic idempotently. Confirmed,
   pending, failed or uncertain transactions do not grant an item. Purchase history
   links to the transaction. The same item cannot have concurrent purchases for
   one account, and a signature cannot grant multiple purchases.
7. Restart recovery reconciles saved bytes; it does not generate a replacement
   burn. An unsigned request can be cancelled. Submitted requests cannot be
   cancelled. Expired/failed receipts remain under review; late finality can still
   unlock the purchased item. No automated replacement burn is issued.

The burn and account unlock are not one cross-system atomic operation. If the
service goes down after finalization, the persisted purchase allows reconciliation
and entitlement recovery after restart. Inventory and purchase tables live in the
existing backed-up payment database. Losing that database and all backups would
lose account entitlements even though on-chain burn receipts remain public.

## Sponsorship and trust

The platform pays the purchase's Solana network fee. Shop burns share the existing
sponsor's durable budget: up to 20,000 lamports per request, 0.1 SOL per UTC day
across the platform and 0.002 SOL per player per UTC day. Failed sponsorship
attempts retain their budget reservation. External token deposits may have their
own sender-paid fees; the shop does not buy tokens or charge SOL for cosmetics.

Wallet keys remain controlled by the user. Token burns are irreversible. Cosmetic
entitlements and availability are managed by the platform. SOL wagers remain a
separate system with custodial match pools and server-verified results.

## Configuration and activation

- `/shop` is the preview page. Catalog and original artwork are public.
- `SOW_SHOP_CHECKOUT=enabled` explicitly permits purchase preparation/submission.
  Omit this setting to keep checkout disabled. Recovery of already-submitted burns
  and existing inventories continue while checkout is disabled.
- `SOW_SHOP_PRICES` must be a JSON object containing positive integer whole-token
  prices for all three item IDs. Explicit prices are mandatory when enabled.
- `SOW_SHOP_DEVNET_MINT` is mandatory for enabled devnet checkout. Mainnet has no
  mint override.
- User-owned wallets and a configured platform fee sponsor are required.
- Provider signing policy must permit the reviewed Token-2022 `BurnChecked` and
  purchase memo for the fee payer. The existing native-SOL transfer policy is not
  assumed to allow these instructions. Never grant a server signer access to a
  personal wallet to work around a rejected sponsorship request.

Before mainnet activation: approve catalog/prices; rehearse an isolated Token-2022
purchase with the actual provider and user wallet; confirm mint supply and token
balance decrease by the quoted amount, personal-wallet SOL is unchanged, sponsor
pays the fee, inventory grants once, and the flag renders in a match. Exercise
rejection, duplicate submit and recovery. Review the production sponsor policy and
complete the usual deployment/drain process. A preview deployment does not itself
activate purchases.

## Source and verification

- `src/frontpot/shop/`: catalog, artwork, UI, routes, durable purchase/inventory
  service and shared exact-transaction burn validation.
- `src/frontpot/payments/FeeSponsor.ts`: restricted burn sponsorship shares the
  existing signature, simulation, expiry and budget checks.
- `tests/frontpot/CosmeticShop.test.ts`: cryptographically signed fixtures with
  mocked RPC; finality, restart, duplicates, ownership, tampering, Token-2022 and
  unsupported extensions. These are not live-chain receipts.
- `GET /frontpot/api/shop/receipts`: latest 100 finalized shop burns, excluding
  internal player IDs. Personal history also includes pending/review requests.
- `GET /frontpot/api/shop/activity`: total whole tokens burned by finalized shop
  purchases and recent receipts, displayed publicly in the shop. This excludes
  unrelated token burns and all pending/failed purchases.

Solana's [burn instruction documentation](https://solana.com/docs/tokens/basics/burn-tokens)
explains the supply-reduction behavior. Existing code and asset licensing is
specified in [LICENSING.md](LICENSING.md).
