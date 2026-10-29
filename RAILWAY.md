# Railway hosting

Deploy Sol of War using `Dockerfile.frontpot`. Set the Railway service variable `RAILWAY_DOCKERFILE_PATH=Dockerfile.frontpot` and configure the following settings in the dashboard. Treat the hosting notes below as setup guidance; verify the intended service's current settings before a deployment.

- One Node 24.15.0 service with WebSocket support and the production frontend build.
- Health check: `/healthz`, timeout 120 seconds; restart policy Always; Serverless disabled.
- One replica, with a ceiling of one CPU and 2 GB RAM (2,000,000,000 bytes). Usage is billed by Railway; these resource ceilings are not a monthly spending cap.
- Attach a persistent volume at `/data`. The private SQLite ledger and sessions live at `/data/frontpot` through `FRONTPOT_STATE_DIR`.
- Connect the public domain, then set `APP_ORIGIN` to its HTTPS URL. Website GET/HEAD requests on alternate hosts redirect to this origin while `/healthz` remains available to internal health probes. API writes and WebSockets retain their origin checks.
- Set private `PRIVY_APP_ID` and `PRIVY_APP_SECRET` variables. Allow the service’s HTTPS origin in Privy and enable external Solana wallets. The secret must never be uploaded in source files or exposed to the client. JWT keys are fetched from Privy’s app-specific JWKS endpoint.
- Use `PAYMENTS_MODE=simulation` for an unfunded rehearsal. Mainnet requires explicit production configuration and funded validation; see `MAINNET.md` and `PAYMENTS.md`. This guide does not establish the live payment mode.
- Upload exclusions omit local credentials, SQLite databases, private state, dependencies, Git metadata, and proprietary upstream artwork. Do not upload an existing session database during normal deployments.
- The unchanged map library is excluded from the CLI upload to fit Railway's upload limit. A Docker build stage fetches the pinned upstream commit archive, verifies its SHA-256, and copies all maps into the final image and source archive. When editing maps, update this strategy so the modified assets are included; do not silently deploy an older upstream copy.

Deploy changes with Railway's official CLI from this source directory using a token restricted to the intended project environment and an explicit service ID. Keep deployment tokens outside this directory. Never deploy the upstream root Dockerfile; the service variable explicitly selects `Dockerfile.frontpot`. The image includes the corresponding-source archive served at `/source`.

The hostname remains stable across deployments and is independent of a developer computer. Individual matches are still in process memory. Before a planned update, use `/admin` **Prepare for deployment** and wait for **Ready for a planned restart**: waiting lobbies close, paid entries are refunded, and active games finish normally. The drain flag persists across the deployment. After verification, end preparation and explicitly resume entries. See [OPERATIONS.md](OPERATIONS.md). Forced restarts can still interrupt active games; history, recordings and payment recovery records persist on the volume.

Before calling a deployment ready, check `/healthz`, the homepage, a map asset, `/source`, a multiplayer WebSocket start, and browser gameplay. Verify the volume mount and restart recovery. No hosting platform guarantees uninterrupted availability.

## Current hosting

Primary URL: https://solofwar.fun

Railway project: Frontpot. Environment: production. Service: frontpot. Region: US West. Persistent volume: frontpot-volume at `/data`. This deployment uses CLI source uploads; GitHub autodeploy is not configured.

Public branding is Sol of War. Name.com hosts DNS: solofwar.fun apex ANAME points to `cuvaw3wg.up.railway.app`; www CNAME points to `39fe64wz.up.railway.app`. Preserve Railway ownership TXT records `_railway-verify` and `_railway-verify.www`. Both domains route to port 8080 with Railway-managed HTTPS. `APP_ORIGIN=https://solofwar.fun`; apex and www are allowed in the existing Privy app. The old solsiege.fun domains and Railway hostname remain connected and redirect website requests to the new apex, preserving paths and queries. Existing users, wallet addresses and balances remain in the same service/database. Browser sessions may require sign-in again on the new origin.

The public `/tutorial` route is anonymous and runs locally. Guest sessions can also use Free Play and Solo. SOL wagers and account-wallet features require verified wallet sign-in and a claimed username. Verify that guest sessions cannot fund entries, withdraw another account's balance or access administrator operations.

Queue administration: set `SOLSIEGE_ADMIN_WALLETS` to the administrator public wallet address (comma-separated for multiple explicitly authorized owners). It is server-only; `/admin` requires verified Privy login and a username. Settings and audit records live in the existing SQLite database on `/data`. Queued demo matches are regenerated on service restart.
