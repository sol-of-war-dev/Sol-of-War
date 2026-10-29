# Local multiplayer capacity baseline

Run from the repository with Node 24 and installed dependencies:

```sh
GAME_ENV=dev GIT_COMMIT=DEV node --import tsx scripts/loadTestLocal.ts
```

Optional settings: `LOAD_LEVELS=25,50,100,150`, `LOAD_SECONDS=105`, and `LOAD_OUTPUT=/absolute/results/path`.

The harness starts the actual application server bound only to localhost, creates test identities directly in a temporary SQLite database, and explicitly starts the server with simulation payments. It supplies a minimal child environment rather than copying payment credentials. No production URLs, mainnet wallets, or authentication bypass endpoints are used. Temporary sessions and databases are removed when each stage completes.

Each stage creates one to three private free FFA matches, up to 50 humans per room, with normal maps, default Tribes/Nations, random spawn and a one-minute match timer. Clients join via HTTP, connect using the real binary WebSocket protocol, send an expansion action and heartbeat every second, and poll their room every two seconds. Ten percent reconnect after twenty seconds. Local forwarded IPs represent independent users behind the same trusted proxy configuration as production; this is not a shared-NAT test.

Metrics include API and ping latency, turn delivery gaps, start success, reconnect latency, socket errors, bytes received, server RSS/CPU and event-loop delay. At 150 players the harness probes whether connection 151 is rejected. At the end it independently replays the captured turn stream through the real engine, submits the resulting winner through the clients, and waits for the application's verification/settlement pipeline. These are free matches: this is not a real SOL transfer test.

Limitations: synthetic expansion is not human strategy; no client rendering or per-client full simulation; this is a short baseline, not an endurance test. Replay runs a real reference simulation, but network clients do not each run the engine. Driver and server share one host. Server telemetry excludes child replay process memory/CPU. Localhost latency excludes Internet, Railway proxy, disk/network and regional effects. No Railway capacity guarantee can be inferred from local results. Mainnet confirmations, wallet provider quotas and browser GPU performance require separate tests. Keep raw performance reports outside the deployment source.

The separate simulated wager settlement check runs with:

```sh
GAME_ENV=dev GIT_COMMIT=DEV node --import tsx scripts/loadTestSettlement.ts
```

It submits three completion requests together, verifies engine results through the serialized replay queue, asserts fee and payout amounts, and repeats settlement to check idempotence. It uses simulation funds only.

For the isolated 500-player stress test:

```sh
GAME_ENV=dev GIT_COMMIT=DEV LOAD_LEVELS=500 LOAD_CONNECTION_CAP=500 LOAD_OUTPUT=/private/tmp/sow-load-results-500 node --import tsx scripts/loadTestLocal.ts
```

This generates a disposable server entry file with only the connection cap changed from 150 to 500, checks that the expected guard still exists, and removes the copy afterward. The production server source stays unchanged. It runs ten 50-player rooms and probes connection 501. The default harness cap remains 150.
