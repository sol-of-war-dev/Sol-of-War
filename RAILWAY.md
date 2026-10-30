# Railway hosting

The root `Dockerfile` and `Dockerfile.frontpot` both build Sol of War. Railway's default Dockerfile detection therefore selects the application, and the existing service variable `RAILWAY_DOCKERFILE_PATH=Dockerfile.frontpot` remains supported. Both recipes use the same source, lockfile, assets and server entry point; keep them synchronized when changing the container build. The upstream recipe is retained separately as `Dockerfile.openfront` for reference and is not this application's deployment path. Treat the hosting notes below as setup guidance; verify the intended service's current settings before a deployment.

- One Node 24.15.0 service with WebSocket support and the production frontend build.
- Health check: `/healthz`, timeout 120 seconds; restart policy Always; Serverless disabled.
- One replica, with a ceiling of one CPU and 2 GB RAM (2,000,000,000 bytes). Usage is billed by Railway; these resource ceilings are not a monthly spending cap.
- Attach a persistent volume at `/data`. The private SQLite ledger and sessions live at `/data/frontpot` through `FRONTPOT_STATE_DIR`.
- Connect the public domain, then set `APP_ORIGIN` to its HTTPS URL. Website GET/HEAD requests on alternate hosts redirect to this origin while `/healthz` remains available to internal health probes. API writes and WebSockets retain their origin checks.
- Set private `PRIVY_APP_ID` and `PRIVY_APP_SECRET` variables. Allow the service’s HTTPS origin in Privy and enable external Solana wallets. The secret must never be uploaded in source files or exposed to the client. JWT keys are fetched from Privy’s app-specific JWKS endpoint.
- Use `PAYMENTS_MODE=simulation` for an unfunded rehearsal. Mainnet requires explicit production configuration and funded validation; see `MAINNET.md` and `PAYMENTS.md`. This guide does not establish the live payment mode.
- Upload exclusions omit local credentials, SQLite databases, private state, dependencies, Git metadata, and proprietary upstream artwork. Do not upload an existing session database during normal deployments.
- The unchanged map library is excluded from the CLI upload to fit Railway's upload limit. A Docker build stage fetches the pinned upstream commit archive, verifies its SHA-256, and copies all maps into the final image and source archive. When editing maps, update this strategy so the modified assets are included; do not silently deploy an older upstream copy.

Deploy this source through a GitHub source connection or Railway's official CLI. For CLI uploads, use a token restricted to the intended project environment and an explicit service ID. Keep deployment tokens outside this directory. The image includes the corresponding-source archive served at `/source`, the lockfile, and the license served at `/license`.

## Switching the existing service to GitHub

Use `sol-of-war-dev/Sol-of-War`, branch `main`, with the repository root as the source directory. Keep the current production service, domains, `/data` volume, one-replica setting and private variables. Connecting source does not replace these with files from GitHub.

Keep deployment timing manual so a code push cannot unexpectedly restart active matches. Do not enable automatic deployment until a suitable drain workflow is in place. Compare the deployed commit with GitHub after the first repository build. A clean local simulation build does not validate production provider credentials or move funds.

The repository intentionally excludes `.env` files, player/session databases, wallet keys, backups and dependency/build directories. Railway supplies private configuration, the volume supplies existing state, and the Docker build installs locked dependencies and generates the frontend and source archive. None of those private or generated files should be copied into GitHub to make source deployment work.

The hostname remains stable across deployments and is independent of a developer computer. Individual matches are still in process memory. Before a planned update, use `/admin` **Prepare for deployment** and wait for **Ready for a planned restart**: waiting lobbies close, paid entries are refunded, and active games finish normally. The drain flag persists across the deployment. After verification, end preparation and explicitly resume entries. See [OPERATIONS.md](OPERATIONS.md). Forced restarts can still interrupt active games; history, recordings and payment recovery records persist on the volume.

Before calling a deployment ready, check `/healthz`, the homepage, a map asset, `/source`, a multiplayer WebSocket start, and browser gameplay. Verify the volume mount and restart recovery. No hosting platform guarantees uninterrupted availability.

## Current hosting

Primary URL: https://solofwar.fun

Railway project: Frontpot. Environment: production. Service: frontpot. Region: US West. Persistent volume: frontpot-volume at `/data`. The service builds from `sol-of-war-dev/Sol-of-War`; production releases are manually selected by exact commit after deployment preparation. GitHub autodeploy remains disabled.

Public branding is Sol of War. Name.com hosts DNS: solofwar.fun apex ANAME points to `cuvaw3wg.up.railway.app`; www CNAME points to `39fe64wz.up.railway.app`. Preserve Railway ownership TXT records `_railway-verify` and `_railway-verify.www`. Both domains route to port 8080 with Railway-managed HTTPS. `APP_ORIGIN=https://solofwar.fun`; apex and www are allowed in the existing Privy app. The old solsiege.fun domains and Railway hostname remain connected and redirect website requests to the new apex, preserving paths and queries. Existing users, wallet addresses and balances remain in the same service/database. Browser sessions may require sign-in again on the new origin.

The public `/tutorial` route is anonymous and runs locally. Guest sessions can also use Free Play and Solo. SOL wagers and account-wallet features require verified wallet sign-in and a claimed username. Verify that guest sessions cannot fund entries, withdraw another account's balance or access administrator operations.

Queue administration: set `SOLSIEGE_ADMIN_WALLETS` to the administrator public wallet address (comma-separated for multiple explicitly authorized owners). It is server-only; `/admin` requires verified Privy login and a username. Settings and audit records live in the existing SQLite database on `/data`. Queued demo matches are regenerated on service restart.

## Source identity and verification

The GitHub workflow `.github/workflows/verify.yml` checks application/payment tests, TypeScript, the frontend build and runtime/source-archive integrity using simulation fixtures and no production secrets. It does not deploy. Keep the production source on `sol-of-war-dev/Sol-of-War`, branch `main`, and leave automatic deployment disabled until the drain workflow is integrated.

Railway supplies `RAILWAY_GIT_COMMIT_SHA` to the Docker builder. The build records that revision plus content digests in `dist-demo/release-manifest.json`. A conflicting or dirty local checkout cannot claim a supplied commit. Production startup checks the runtime and served assets, including the downloadable source archive. The public `/frontpot/api/release` endpoint reports the revision and digests, and the footer links to that exact GitHub revision when available. CLI uploads without source metadata report no commit instead of inventing one. These records detect accidental mismatch; the operator still controls the server and they are not independent deployment attestation.

After a repository deployment, compare the Railway deployment revision, public release revision, and the files in `/source` with that GitHub commit. Verify the real site health and preserve the existing volume, private variables, domain, and legacy recovery keys.

## GitHub Production deployment history

The **Record Production deployment** workflow maintains GitHub's **Deployments / Production** section and links it to https://solofwar.fun. It checks the public health and release endpoints, requires successful main-branch verification for a newly observed commit, and creates the record against that live commit, even when GitHub main has newer changes. It never deploys code, calls Railway's API, accesses wallet credentials, or moves funds. Its short-lived GitHub token can read repository/Actions metadata and write deployment records; it cannot change source code.

Run it from GitHub Actions after verifying a production release for an immediate update. A scheduled check also runs approximately every 15 minutes, subject to GitHub scheduling delays and inactivity limits. Unchanged releases do not create duplicate records. Rollbacks create a new record; superseded records from this workflow become inactive. This records observed release changes, not every Railway container restart, and can miss a release replaced between checks.

The green status means the release identity and public health check passed when recorded. It is not a continuous uptime guarantee, financial safety certification, or independent hosting attestation. Keep the existing source-archive comparison and payment/provider checks in the release procedure. The About sidebar's **Deployments** option must be enabled for this history to appear.
