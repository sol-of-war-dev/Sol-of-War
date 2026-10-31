# Sol of War cosmetic shop

Implementation status: local preview, automated checkout tests, and a completed
[isolated devnet burn and sponsorship rehearsal](SHOP_DEVNET_EVIDENCE.md). Purchases
are **disabled by default**. Draft prices require approval before activation.
The rehearsal used a separate test mint; it was not a mainnet purchase.

## Collection and ownership

The shop adapts OpenFront's existing `CosmeticCard`, `CosmeticPreview`, rarity
presentation, game previews, and in-game appearance rendering. It uses a Sol of War catalog and our
account/payment backend instead of OpenFront's currency and commerce APIs.
The catalog contains **39 original cosmetics and 3 bundles**, arranged into Ember,
Violet, and Solar collections. Artwork and effect definitions are authored in
`src/frontpot/shop/Catalog.ts`; no premium store artwork is copied. The complete
item and draft-price list is in [COSMETIC_CATALOG.md](COSMETIC_CATALOG.md).

| Category           | Choices | Equip behavior                                                |
| ------------------ | ------: | ------------------------------------------------------------- |
| Flags              |       3 | One flag beside your commander’s name                         |
| Territory patterns |       3 | Shares the territory slot with skins                          |
| Skins              |       3 | Shares the territory slot with patterns                       |
| Crowns             |       3 | One ornamental crown                                          |
| Effects            |      27 | Three choices in each of nine effect slots                    |
| Bundles            |       3 | Thirteen permanent item unlocks; equip the items individually |

Effect slots cover transport-ship wakes, missile trails, atomic/hydrogen/MIRV
explosions, structures, warships, trains, and railroads. All supported effect
types have original options. Effects change appearance only; explosion size and
color settings do not change damage or gameplay radius. Combat indicators and
team-color rules remain controlled by the existing game renderer.

Players can preview every category, filter to owned items, and equip or unequip
individual slots. A flag, territory appearance, crown, and nine effects can be
combined. Patterns and skins replace one another. Bundles cannot be purchased
when any member is already owned or covered by an outstanding purchase: buy the
remaining items individually instead. No partial-ownership discount is implied.

Ownership is a permanent account unlock, not an NFT or transferable asset. It
does not affect combat, matchmaking, ranking, win conditions, or payouts. The
game server loads the owned loadout when a player next joins; client-supplied
cosmetic references cannot grant ownership. Current matches and recorded replays
keep their existing appearance. The renderer loads Sol of War’s own catalog and
art endpoints, rather than the upstream store’s commerce backend.

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
6. A successful **finalized** receipt grants the cosmetic idempotently. Bundles
   snapshot their contents in the purchase quote and grant every entitlement in
   one database transaction. One bundle counts as one burn receipt. Confirmed,
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

## Custom artwork

Players can upload their own flags, territory patterns, skins, and crowns for
**500,000 $SOLOFWAR per item**. This custom-item price is fixed on the server and
was selected by the project owner; ordinary catalog prices remain drafts.
The complete price is burned, and the platform sponsors the network fee using
exactly the existing user-signed checkout route. Uploading a draft is free.

- Sign in, choose a category, name the artwork, upload a static PNG, and confirm
  permission to use it publicly. Preview the result before approving a burn.
- Inputs are limited to 128 KB and 512 by 512 pixels. The server validates the
  PNG structure, bounds decompression, decodes pixels, and re-encodes the result
  without changing pattern pixels (up to 512 by 512); other categories are resized
  to at most 256 by 256. Metadata is discarded. SVGs, remote URLs,
  animations, duplicate headers, and malformed files are rejected.
- Uploaded territory patterns repeat the full PNG across owned territory at its
  native pixel dimensions, including non-square images. Original RGB and alpha
  are retained; transparent and translucent pixels blend over the territory
  underneath. They are not reduced to two colors or tinted by team color.
  Normal game visibility, hover, defense and accessibility overlays still apply.
  The shop shows a repeating swatch and offers an in-game preview before purchase.
  Live games and replays share the same tile metadata and territory shader.
  Existing predefined two-color patterns and single-stamp skins keep their behavior.
- Free, unquoted drafts from the initial two-color upload prototype are upgraded
  using their saved PNG. Purchased or pending artwork is never rewritten.
- Draft artwork is private to its uploader. Other accounts cannot purchase,
  delete, or equip it. Public image and renderer-catalog routes include it only
  after a finalized burn grants ownership. Custom items are not resold to other
  players or transferred between accounts.
- Each upload has an immutable generated identity and server-held image. The
  purchase binds that identity and its fixed price. Purchased artwork cannot be
  replaced or deleted through the draft API; different artwork requires a new
  purchase. Re-uploading identical normalized artwork in the same category
  returns the existing item instead of creating another charge.
- An account may hold up to three unpaid drafts and 32 custom items total.
  There is an initial 1,000-upload service cap and a four-per-minute upload
  request limit per IP, alongside the existing authenticated API limits.
  Delete an unused draft to free its slot. Cancel an unsigned purchase before
  deleting its draft; pending or finalized purchases cannot be deleted.
- Images and metadata are stored in the backed-up application database.
  Equipping still requires server-verified ownership. Flags and crowns use
  their own slots; patterns and skins share the territory slot. Changes apply
  on the next match join.

Routes: authenticated `POST /frontpot/api/shop/upload` (name, category, PNG data
URL, rights acknowledgement), `POST /frontpot/api/shop/delete-upload` (id), and
owner-only draft metadata in the inventory response. Paid PNG assets are served
from `/frontpot/api/shop/custom-art/:id.png` with PNG content type, `nosniff`, and
restrictive content-security headers. No user filename becomes a filesystem path.

Custom-upload privacy, fixed-price signed checkout, finality, persistence, equip
ownership, draft caps, and invalid-image cases have automated tests. The earlier
[devnet receipts](SHOP_DEVNET_EVIDENCE.md) cover predefined items, not a 500,000
$SOLOFWAR custom-upload burn. Production checkout remains disabled; a custom-item
devnet rehearsal and the production release checks remain before activation.
