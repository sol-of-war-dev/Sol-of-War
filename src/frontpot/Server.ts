import { GameEnv } from "@openfront/shared/configuration/Env";
import { decodeClientMessage } from "@openfront/shared/ZbinWire";
import compression from "compression";
import express, { type Request } from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import winston from "winston";
import { WebSocketServer, WebSocket } from "ws";
import { Client } from "../server/Client";
import { GameServer } from "../server/GameServer";
import { registerAdminRoutes } from "./AdminRoutes";
import { AdminStats } from "./AdminStats";
import {
  FUNDED_MIN_ENTRY_LAMPORTS,
  SIMULATION_MIN_ENTRY_LAMPORTS,
} from "./Amounts";
import { apiRateLimits } from "./ApiRateLimits";
import { bearerToken, registerAuthRoutes } from "./AuthRoutes";
import { PaymentBackups, RESTORE_HOLD } from "./Backups";
import { backupStorage } from "./BackupStorage";
import { canonicalDomain } from "./CanonicalDomain";
import { DeploymentDrain } from "./DeploymentDrain";
import { GlobalQueue } from "./GlobalQueue";
import { LiveMonitoring } from "./LiveMonitoring";
import { advanceLobby } from "./LobbyLifecycle";
import { assertWagerAccess } from "./MatchAccess";
import { MatchLedger, type Pool } from "./MatchLedger";
import { MatchReview } from "./MatchReview";
import { Operations } from "./Operations";
import { Parties } from "./Parties";
import { PaymentMonitoring } from "./PaymentMonitoring";
import { registerPlayerWalletRoutes } from "./payments/PlayerWalletRoutes";
import { PlayerWallets } from "./payments/PlayerWallets";
import {
  PlayerWalletVault,
  type WalletKeyring,
} from "./payments/PlayerWalletVault";
import { PoolReconciliation } from "./payments/PoolReconciliation";
import { SpendAuthorizations } from "./payments/SpendAuthorizations";
import { PlayerAuth, AuthError } from "./PlayerAuth";
import { PrivyIdentity } from "./PrivyIdentity";
import { Profiles, registerProfileRoutes } from "./Profiles";
import { visibleRank } from "./RankTiers";
import { releaseIntegrity } from "./ReleaseIntegrity";
import { verifyRecordedGame } from "./ResultVerification";
import { gameConfig as makeGameConfig, PLATFORM_FEE_BPS } from "./Rules";
import { SharedMatchmaking } from "./SharedMatchmaking";
import { registerShopRoutes } from "./shop/Routes";
import { CosmeticShop, shopConfig } from "./shop/Shop";
import { canSpectate, spectatorIdentity } from "./Spectating";
import {
  isRanked,
  isWager,
  matchAmount,
  LobbyStore,
  InputError,
  type Room,
} from "./Store";

import { DevnetPayments } from "./payments/DevnetPayments";
import { DevnetRPC, DevnetTransactions } from "./payments/DevnetTransactions";
import { paymentConfig } from "./payments/PaymentConfig";
import { registerPaymentRoutes } from "./payments/PaymentRoutes";
import { PrivyPoolWallets } from "./payments/PrivyPoolWallets";
import { PrivyTransactionSigner } from "./payments/PrivyTransactionSigner";

import {
  UserOwnedWallets,
  PrivyUserWalletVerifier,
} from "./payments/UserOwnedWallets";
import { registerUserWalletRoutes } from "./payments/UserWalletRoutes";

const root = process.cwd();
const release = releaseIntegrity(root, process.env.NODE_ENV === "production");
const paymentSettings = paymentConfig();
const stateDir =
  paymentSettings?.stateDir ??
  process.env.FRONTPOT_STATE_DIR ??
  path.join(root, ".frontpot-state");
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
if (existsSync(path.join(stateDir, RESTORE_HOLD)))
  throw new Error(
    "Restored payment data requires chain reconciliation before startup.",
  );
const ledger = new MatchLedger(
  path.join(stateDir, "matches.sqlite"),
  paymentSettings?.network ?? "simulation",
);
ledger.recoverInterrupted();
const payments = paymentSettings
  ? new DevnetPayments(
      ledger.db,
      new DevnetTransactions(
        ledger.db,
        new DevnetRPC(paymentSettings.rpcURL, fetch, paymentSettings.network),
      ),
      new PrivyPoolWallets(paymentSettings.wallets),
      new PrivyTransactionSigner(
        paymentSettings.wallets.appID,
        paymentSettings.wallets.appSecret,
        paymentSettings.authorizationKey,
      ),
      paymentSettings.payer,
      paymentSettings.treasury,
      () => operations.assertAdmissions(),
      paymentSettings.limits,
    )
  : null;
const walletKeyring = process.env.SOLSIEGE_WALLET_KEYRING;
if (
  process.env.SOLSIEGE_PLAYER_WALLETS === "enabled" &&
  (!walletKeyring || !payments || !process.env.SOLSIEGE_BACKUP_KEY)
)
  throw new Error(
    "Player wallets require funded network configuration, a keyring and encrypted backups",
  );
const playerWallets =
  process.env.SOLSIEGE_PLAYER_WALLETS === "enabled" &&
  payments &&
  paymentSettings &&
  walletKeyring
    ? new PlayerWallets(
        ledger.db,
        new PlayerWalletVault(
          ledger.db,
          paymentSettings.network,
          JSON.parse(walletKeyring) as WalletKeyring,
        ),
        payments.transactions,
        paymentSettings.payer,
        new PrivyTransactionSigner(
          paymentSettings.wallets.appID,
          paymentSettings.wallets.appSecret,
          paymentSettings.authorizationKey,
        ),
        async (created) => {
          if (!backups) throw new Error("Player wallet backups unavailable");
          await backups.ensureContains(created);
        },
        new SpendAuthorizations(
          ledger.db,
          paymentSettings.network,
          process.env.APP_ORIGIN ?? "http://localhost:3000",
        ),
      )
    : null;
const userOwnedWalletsEnabled =
  process.env.SOLSIEGE_USER_OWNED_WALLETS === "enabled";
if (
  userOwnedWalletsEnabled &&
  (!payments || !process.env.PRIVY_APP_ID || !process.env.PRIVY_APP_SECRET)
)
  throw new Error(
    "User-owned wallets require Privy and a verified Solana payment network",
  );
const userOwnedWallets =
  userOwnedWalletsEnabled && payments
    ? new UserOwnedWallets(
        ledger.db,
        new PrivyUserWalletVerifier({
          appID: process.env.PRIVY_APP_ID!,
          appSecret: process.env.PRIVY_APP_SECRET!,
        }),
        payments.transactions,
        playerWallets,
        payments.feeSponsor,
      )
    : null;
const cosmeticShop = new CosmeticShop(
  ledger.db,
  shopConfig(process.env, payments?.transactions.rpc.network),
  userOwnedWallets,
);
const reconciliation = payments
  ? new PoolReconciliation(ledger.db, payments.transactions.rpc, (id, wire) =>
      payments.importExternalDeposit(id, wire),
    )
  : null;
const store = new LobbyStore(
  Date.now,
  payments ? FUNDED_MIN_ENTRY_LAMPORTS : SIMULATION_MIN_ENTRY_LAMPORTS,
);
const drain = new DeploymentDrain(store, ledger, payments);
const backups = process.env.SOLSIEGE_BACKUP_KEY
  ? new PaymentBackups(
      ledger.db,
      process.env.SOLSIEGE_BACKUP_DIR ?? path.join(stateDir, "backups"),
      process.env.SOLSIEGE_BACKUP_KEY,
      paymentSettings?.network ?? "simulation",
      backupStorage(),
    )
  : null;
const monitoring =
  payments && paymentSettings && reconciliation
    ? new PaymentMonitoring(
        payments.transactions.rpc,
        paymentSettings.payer.address,
        backups,
        reconciliation,
      )
    : null;
const operations = new Operations(
  ledger.db,
  payments,
  Date.now,
  (enabled) => drain.snapshot(enabled, queuedVerifications.size),
  monitoring ? () => monitoring.snapshot() : undefined,
  new MatchReview(ledger, payments, (id) => {
    void verifyMatch(id);
  }),
);
payments?.recover((id) => ledger.get(id));
if (payments && paymentSettings) {
  await payments.transactions.rpc.check();
  const rpc = payments.transactions.rpc;
  const rent = await rpc.call<number>("getMinimumBalanceForRentExemption", [0]);
  const payer = await rpc.call<{ value: number }>("getBalance", [
    paymentSettings.payer.address,
    { commitment: "finalized" },
  ]);
  const treasury = await rpc.call<{ value: number }>("getBalance", [
    paymentSettings.treasury,
    { commitment: "finalized" },
  ]);
  if (payer.value < 10_000_000 || treasury.value < rent || rent > 1_000_000)
    throw new Error(
      "Payments need a funded fee payer (0.01 SOL on the selected network), rent-exempt treasury, and supported rent minimum.",
    );
}
const queue = new GlobalQueue(
  store,
  ledger.db,
  () => operations.control().draining,
);
queue.replenish();
function publicPool(pool: Pool | null, playerID: string) {
  if (!pool) return null;
  return {
    ...pool,
    replayAvailable: ledger.hasRecord(pool.matchID),
    ratingChange: ledger.rankings.result(pool.matchID, playerID),
    xpChange: profiles.xpResult(pool, playerID),
    participants: pool.participants.map((s) => ({
      ...s,
      wallet: s.id === playerID ? s.wallet : undefined,
    })),
    payouts: pool.payouts.map((p) => ({
      ...p,
      wallet: p.playerID === playerID ? p.wallet : undefined,
    })),
  };
}
const auth = new PlayerAuth(ledger.db);
const profiles = new Profiles(ledger, auth, payments?.network ?? "simulation");
const matchmaking = new SharedMatchmaking(
  store,
  ledger.rankings,
  payments?.network ?? "simulation",
);
const parties = new Parties(store, (identity) => matchmaking.cancel(identity));
function publicRoom(room: Parameters<typeof store.publicRoom>[0]) {
  const result = store.publicRoom(room);
  return {
    ...result,
    members: result.members.map((member) => ({
      ...member,
      levelBadge: profiles.badge(member.id),
      rank:
        room.mode === "ffa"
          ? { tier: "Unranked", rating: null }
          : visibleRank(
              ledger.rankings.get(
                payments?.network ?? "simulation",
                room.mode,
                member.id,
              ),
            ),
    })),
  };
}
const privy =
  process.env.PRIVY_APP_ID && process.env.PRIVY_APP_SECRET
    ? new PrivyIdentity({
        appID: process.env.PRIVY_APP_ID,
        appSecret: process.env.PRIVY_APP_SECRET,
        identityOnly: userOwnedWalletsEnabled,
        verificationKey: process.env.PRIVY_VERIFICATION_KEY?.replace(
          /\\n/g,
          "\n",
        ),
      })
    : null;
const games = new Map<string, GameServer>();
const teamPins = new Map<string, string[][]>();
const logger = winston.createLogger({
  level: "warn",
  format: winston.format.simple(),
  transports: [new winston.transports.Console()],
});
const live = new LiveMonitoring(() => ({
  connections: wss.clients.size,
  connectionLimit: 150,
  rooms: [...store.rooms.values()].map((r) => ({
    id: r.id,
    map: r.rules.gameMap,
    status: r.status,
    players: r.members.length,
    capacity: r.rules.maxPlayers,
    ranked: isRanked(r),
  })),
}));
const app = express();
app.get("/frontpot/api/release", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(release);
});
app.use(live.middleware);
app.disable("x-powered-by");
// Railway and the optional local tunnel each contribute one trusted proxy hop.
app.set("trust proxy", 1);
app.use(canonicalDomain(process.env.APP_ORIGIN));
app.use(compression());
app.use(
  "/frontpot/api/shop/upload",
  express.json({ limit: "256kb", inflate: false }),
);
app.use(express.json({ limit: "8kb", inflate: false }));
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});
// Verified account budgets isolate players sharing one IP and separate reads from actions.
app.use("/frontpot/api", ...apiRateLimits((req) => identityFor(req).id));
app.use("/frontpot/api", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  const origin = req.get("origin");
  if (origin && origin !== originFor(req))
    return res
      .status(403)
      .json({ error: "This request must come from the game website." });
  next();
});
function originFor(req: Request): string {
  return process.env.APP_ORIGIN ?? `${req.protocol}://${req.get("host")}`;
}
function identityFor(req: Request) {
  return auth.auth(bearerToken(req), true, true);
}
function startGameServer(room: Room): GameServer {
  let game = games.get(room.id);
  if (game) return game;
  const teams = room.mode === "2v2" ? ([[], []] as string[][]) : undefined;
  if (teams) teamPins.set(room.id, teams);
  const gameConfig = makeGameConfig(room.rules, room.mode, room.practice);
  game = new GameServer(
    {
      id: room.id,
      managedMatch: true,
      log: logger,
      createdAt: room.created,
      gameConfig,
      matchmakingTeams: teams,
    },
    {
      env: () => GameEnv.Dev,
      turnIntervalMs: () => 100,
      fetchTribes: async () => [],
      // Always independently replay before recording a simulated payout. Neither
      // majority client votes nor statsAgreed authorize settlement.
      archive: async (record) => {
        room.status = "finished";
        room.result = "Verifying match result.";
        try {
          ledger.saveRecord(record);
          ledger.verifying(room.id);
          await verifyMatch(room.id);
          room.result = ledger.get(room.id)?.reason ?? "No prize pool.";
        } catch {
          ledger.review(
            room.id,
            "Result verification failed. No payout authorized.",
          );
          room.result = "Result needs review. No payout authorized.";
        }
      },
      // Avoid a second upstream replay; archive above always replays itself.
      replayWinner: async () => null,
      replayPending: () => 100,
    },
  );
  games.set(room.id, game);
  if (room.startsAt) game.setStartsAt(room.startsAt);
  return game;
}
function advanceRoom(room: Room, now = Date.now()) {
  if (operations.control().draining) {
    applyDrain();
    return;
  }
  if (!["waiting", "countdown"].includes(room.status)) return;
  const game = games.get(room.id);
  game?.pruneStaleClients();
  const readyIDs = (game?.activeClients() ?? [])
    .filter((c) => c.ws.readyState === WebSocket.OPEN && !c.spectator)
    .map((c) => c.persistentID);
  const action = advanceLobby(
    room,
    readyIDs,
    now,
    (r, seats) => {
      if (isWager(r)) payments?.lock(r, seats);
      return ledger.lock(
        r,
        isWager(r) && payments ? payments.payoutSeats(r.id, seats) : seats,
      );
    },
    payments && isWager(room) ? payments.fundedIDs(room.id) : undefined,
    payments && isWager(room) ? payments.reservedIDs(room.id) : undefined,
  );
  if (payments && isWager(room) && ["expired", "locked"].includes(action)) {
    // Entries removed from an underfilled/disconnected roster remain durable.
    for (const entry of ledger.db
      .prepare("SELECT player_id FROM devnet_entries WHERE match_id=?")
      .all(room.id))
      if (!room.members.some((m) => m.id === entry.player_id))
        payments.cancelEntry(room.id, String(entry.player_id));
  }
  if (action === "expired") {
    if (isWager(room)) payments?.cancel(room.id);
    if (ledger.get(room.id)?.state === "waiting")
      ledger.refund(
        room.id,
        "Not enough ready players at the deadline. Entries refunded; no platform fee.",
      );
    void game?.end();
    store.rooms.delete(room.id);
    games.delete(room.id);
    teamPins.delete(room.id);
    queue.replenish();
    return;
  }
  if (room.startsAt) game?.setStartsAt(room.startsAt);
  if (action === "locked" && game) {
    // Ensure the engine and the ledger start with exactly the same humans,
    // including when a close event is still queued on the socket.
    for (const c of game.activeClients())
      if (!room.members.some((m) => m.id === c.persistentID) || c.spectator)
        game.kickClient(c.clientID);
    if (room.mode === "2v2") {
      const pins = teamPins.get(room.id)!;
      for (let team = 0; team < 2; team++)
        pins[team].splice(
          0,
          pins[team].length,
          ...room.members.filter((m) => m.team === team).map((m) => m.id),
        );
    }
    game.prestart();
    game.start();
    queue.replenish();
  }
}
// Saved recordings survive restarts. One replay at a time bounds CPU use while
// the durable verifying state lets a new process resume unfinished work.
let verificationTail = Promise.resolve();
const queuedVerifications = new Set<string>();
function applyDrain() {
  if (operations.control().draining) {
    drain.closeWaiting((id) => {
      void games.get(id)?.end();
      games.delete(id);
      teamPins.delete(id);
    });
  } else queue.replenish();
}
function verifyMatch(id: string): Promise<void> {
  if (queuedVerifications.has(id)) return verificationTail;
  queuedVerifications.add(id);
  verificationTail = verificationTail
    .catch((error) => {
      logger.error("Previous verification could not be recorded", {
        error: String(error),
      });
    })
    .then(async () => {
      try {
        if (ledger.get(id)?.state !== "verifying") return;
        const record = ledger.record(id);
        if (!record) throw new Error("Missing saved recording");
        ledger.settle(record, await verifyRecordedGame(record));
      } catch {
        ledger.review(id, "Result verification failed. No payout authorized.");
      } finally {
        queuedVerifications.delete(id);
      }
    });
  return verificationTail;
}
for (const id of ledger.pendingVerification()) void verifyMatch(id);
app.get("/readinessz", (req, res) => {
  const configured = process.env.SOLSIEGE_MONITOR_TOKEN;
  if (!configured) return res.sendStatus(404);
  const provided = Buffer.from(req.get("authorization") ?? ""),
    expected = Buffer.from(`Bearer ${configured}`);
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  )
    return res.sendStatus(401);
  const snapshot = operations.snapshot();
  res.setHeader("Cache-Control", "no-store");
  return res.status(snapshot.alerts.length ? 503 : 200).json({
    network: payments?.network ?? "simulation",
    alerts: snapshot.alerts,
    worker: snapshot.worker,
    counts: snapshot.counts,
    backups: backups?.status() ?? null,
  });
});
app.get("/healthz", (_req, res) =>
  res.json({
    ok: true,
    mode: payments?.network ?? "demo",
    rooms: store.rooms.size,
  }),
);
registerAuthRoutes(
  app,
  auth,
  privy,
  (id) => {
    for (const game of games.values())
      for (const client of game.activeClients())
        if (client.persistentID === id) client.ws.close(1008, "Signed out");
  },
  (id) => {
    // User-owned mode creates personal wallets only through the provider UI.
    // Keep existing legacy wallets available without creating new custody keys.
    if (!userOwnedWalletsEnabled) playerWallets?.vault.ensure(id);
  },
);
const adminStats = new AdminStats(
  ledger.db,
  auth,
  store,
  () =>
    [...games].flatMap(([roomID, game]) =>
      game
        .activeClients()
        .filter((c) => c.ws.readyState === WebSocket.OPEN && !c.spectator)
        .map((c) => ({ id: c.persistentID, roomID })),
    ),
  Date.now,
  payments?.network ?? "simulation",
);
setInterval(() => void backups?.run(), 5 * 60_000).unref();
void backups?.run();
registerProfileRoutes(app, profiles, auth, store);
registerAdminRoutes(
  app,
  auth,
  queue,
  process.env.SOLSIEGE_ADMIN_WALLETS ?? "",
  () => ({ ...adminStats.snapshot(), backup: backups?.status() ?? null }),
  operations,
  applyDrain,
  () => live.snapshot(),
);
app.get("/frontpot/api/availability", (_req, res) => {
  const control = operations.control();
  res.json({
    entriesPaused: control.paused,
    draining: control.draining,
    serverNow: Date.now(),
  });
});
app.get("/frontpot/api/config", (_req, res) =>
  res.json({
    release,
    playerWalletsEnabled: !!playerWallets || !!userOwnedWallets,
    userOwnedWalletsEnabled: !!userOwnedWallets,
    paymentsMode: payments?.network ?? "simulation",
    feeBps: PLATFORM_FEE_BPS,
    minimumEntryLamports: store.minimumEntryLamports,
    walletLoginRequired: true,
    privyAppID: privy ? process.env.PRIVY_APP_ID : null,
    privyClientID: privy ? (process.env.PRIVY_CLIENT_ID ?? null) : null,
  }),
);
app.get("/frontpot/api/rooms", (req, res) => {
  let viewer: ReturnType<typeof identityFor> | null = null;
  try {
    viewer = identityFor(req);
  } catch {
    /* Public guest listing. */
  }
  const members = viewer ? parties.get(viewer)?.members : undefined;
  res.json(
    [...store.rooms.values()]
      .filter(
        (r) =>
          !r.private &&
          !r.practice &&
          ["waiting", "countdown"].includes(r.status) &&
          matchmaking.visibleTo(r, viewer, members),
      )
      .map((r) => publicRoom(r)),
  );
});
app.get("/frontpot/api/live-games", (_req, res) =>
  res.json(
    [...store.rooms.values()]
      .filter((r) => !r.private && !r.practice && r.status === "playing")
      .map((r) => publicRoom(r)),
  ),
);
app.get("/frontpot/api/active-room", (req, res) => {
  const identity = identityFor(req);
  const room = store.activeRoom(identity);
  res.json(room ? publicRoom(room) : null);
});
function requireFundedPlayer(
  identity: ReturnType<typeof identityFor>,
  practice = false,
) {
  assertWagerAccess(
    identity.wallet,
    !practice,
    paymentSettings ? paymentSettings.allowed : null,
    identity.guest === true,
  );
}
app.get("/frontpot/api/party", (req, res) =>
  res.json(parties.view(identityFor(req))),
);
app.post("/frontpot/api/party", (req, res) =>
  res.json(parties.create(identityFor(req))),
);
app.post("/frontpot/api/party/join", (req, res) =>
  res.json(parties.join(identityFor(req), req.body.code)),
);
app.post("/frontpot/api/party/leave", (req, res) => {
  parties.leave(identityFor(req));
  res.json({ ok: true });
});
app.post("/frontpot/api/matchmaking", (req, res) => {
  operations.assertAdmissions();
  const identity = identityFor(req);
  if (parties.get(identity))
    throw new InputError(
      "Both party members must ready up in the party lobby.",
    );
  requireFundedPlayer(identity, req.body.ranked === false);
  res.json(matchmaking.start(identity, req.body));
});
app.post("/frontpot/api/party/settings", (req, res) => {
  res.json(
    parties.configure(identityFor(req), req.body.settings, req.body.revision),
  );
});
app.post("/frontpot/api/party/ready", (req, res) => {
  operations.assertAdmissions();
  const identity = identityFor(req);
  const party = parties.ready(
    identity,
    req.body.revision,
    req.body.ready,
    (members, settings) => {
      for (const member of members)
        requireFundedPlayer(
          auth.auth(member.token, true, true),
          !settings.ranked,
        );
      matchmaking.start(
        members[0],
        { mode: "2v2", ranked: settings.ranked, budget: settings.budget },
        members,
      );
    },
  );
  res.json({ party, search: matchmaking.status(identity) });
});
app.get("/frontpot/api/matchmaking", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(matchmaking.status(identityFor(req)));
});
app.post("/frontpot/api/matchmaking/cancel", (req, res) => {
  matchmaking.cancel(identityFor(req));
  res.json({ ok: true });
});
app.post("/frontpot/api/matchmaking/accept", (req, res) => {
  operations.assertAdmissions();
  const identity = identityFor(req);
  const joined = matchmaking.accept(
    identity,
    req.body.ticketID,
    req.body.offerID,
    (members, ranked) => {
      for (const member of members)
        requireFundedPlayer(auth.auth(member.token, true, true), !ranked);
    },
    (room) => {
      room.poolID = ledger.open(room).poolID;
      startGameServer(room);
    },
  );
  res.json(joined ? publicRoom(joined) : { waitingForParty: true });
});

app.post("/frontpot/api/rooms", (req, res) => {
  const identity = identityFor(req);
  for (const existing of store.rooms.values()) advanceRoom(existing);
  operations.assertAdmissions(req.body.practice === true);
  if (req.body.practice !== true)
    matchAmount(
      req.body.ranked,
      req.body.stake,
      store.minimumEntryLamports,
      req.body.mode,
    );
  requireFundedPlayer(
    identity,
    req.body.practice === true || Number(req.body.stake) === 0,
  );
  const room = store.create(identity, req.body, req.body.match === true);
  room.poolID = ledger.open(room).poolID;
  startGameServer(room);
  res.json(publicRoom(room));
});
app.post("/frontpot/api/rooms/:id/join", (req, res) => {
  const identity = identityFor(req);
  const existing = store.rooms.get(req.params.id);
  if (!existing?.members.some((m) => m.id === identity.id))
    operations.assertAdmissions(existing?.practice);
  if (existing) advanceRoom(existing);
  requireFundedPlayer(identity, !!existing && !isWager(existing));
  const room = store.join(identity, req.params.id);
  room.poolID = ledger.open(room).poolID;
  startGameServer(room);
  res.json(publicRoom(room));
});
app.post("/frontpot/api/rooms/:id/team-options", (req, res) => {
  const identity = identityFor(req);
  const existing = store.rooms.get(req.params.id);
  if (existing) advanceRoom(existing);
  res.json(publicRoom(store.configureTeams(identity, req.params.id, req.body)));
});
app.post("/frontpot/api/rooms/:id/team", (req, res) => {
  const identity = identityFor(req);
  const existing = store.rooms.get(req.params.id);
  if (existing) advanceRoom(existing);
  const room = store.selectTeam(
    identity,
    req.params.id,
    req.body.team,
    req.body.playerID,
    req.body.swapWith,
  );
  const game = startGameServer(room);
  const pins = teamPins.get(room.id)!;
  for (let team = 0; team < 2; team++)
    pins[team].splice(
      0,
      pins[team].length,
      ...room.members.filter((m) => m.team === team).map((m) => m.id),
    );
  game.setLobbyTeams(pins);
  res.json(publicRoom(room));
});
app.post("/frontpot/api/rooms/:id/settings", (req, res) => {
  const identity = identityFor(req);
  operations.assertAdmissions();
  const existing = store.rooms.get(req.params.id);
  if (existing) advanceRoom(existing);
  if (payments?.match(req.params.id))
    throw new InputError(
      "Settings are locked because a deposit has been prepared.",
    );
  requireFundedPlayer(identity, Number(req.body.stake) === 0);
  const room = store.updateSettings(identity, req.params.id, req.body);
  ledger.updateSettings(room);
  const game = startGameServer(room);
  game.gameConfig = makeGameConfig(room.rules, room.mode, false);
  const teams = room.mode === "2v2" ? [[identity.id], []] : undefined;
  if (teams) teamPins.set(room.id, teams);
  else teamPins.delete(room.id);
  game.setLobbyTeams(teams);
  game.setStartsAt(room.startsAt ?? Date.now() + 365 * 86400_000);
  res.json(publicRoom(room));
});
app.post("/frontpot/api/rooms/:id/countdown", (req, res) => {
  const identity = identityFor(req);
  const existing = store.rooms.get(req.params.id);
  if (existing) advanceRoom(existing);
  const room = store.requestCountdown(
    identity,
    req.params.id,
    req.body.seconds,
  );
  startGameServer(room).setStartsAt(room.startsAt!);
  res.json(publicRoom(room));
});
app.post("/frontpot/api/rooms/:id/start", (req, res) => {
  const identity = identityFor(req);
  const existing = store.rooms.get(req.params.id);
  if (existing) advanceRoom(existing);
  const room = store.requestStart(identity, req.params.id);
  advanceRoom(room);
  res.json(publicRoom(room));
});
app.get("/frontpot/api/rooms/:id", (req, res) => {
  const room = store.rooms.get(req.params.id);
  if (!room)
    return res.status(404).json({ error: "This room no longer exists." });
  if (room.private && !room.members.some((m) => m.id === identityFor(req).id))
    return res
      .status(403)
      .json({ error: "Join this room using its invite link." });
  res.json(publicRoom(room));
});
app.post("/frontpot/api/rooms/:id/leave", (req, res) => {
  const identity = identityFor(req);
  const room = store.rooms.get(req.params.id);
  if (room) advanceRoom(room);
  const game = games.get(req.params.id);
  game
    ?.activeClients()
    .filter((c) => c.persistentID === identity.id)
    .forEach((c) => c.ws.close(1000));
  if (room && isWager(room)) payments?.cancelEntry(req.params.id, identity.id);
  store.leave(identity, req.params.id);
  if (
    !store.rooms.has(req.params.id) &&
    ledger.get(req.params.id)?.state === "waiting"
  )
    ledger.refund(req.params.id, "Lobby cancelled. No platform fee.");
  res.json({ ok: true });
});
registerPlayerWalletRoutes(
  app,
  playerWallets,
  (req) => auth.auth(bearerToken(req)),
  !!userOwnedWallets,
);
if (userOwnedWallets)
  registerUserWalletRoutes(app, userOwnedWallets, (req) =>
    auth.auth(bearerToken(req)),
  );
registerShopRoutes(app, cosmeticShop, (req) => auth.auth(bearerToken(req)));
registerPaymentRoutes(app, {
  payments,
  accounts: playerWallets,
  userWalletFor: userOwnedWallets
    ? async (req) =>
        (await userOwnedWallets.verified(auth.auth(bearerToken(req)))).address
    : undefined,
  identityFor: (req) => auth.auth(bearerToken(req)),
  allowed: paymentSettings ? paymentSettings.allowed : new Set(),
  roomFor: (id) => store.rooms.get(id),
  advanceRoom,
  assertAdmissions: () => operations.assertAdmissions(),
});
app.get("/frontpot/api/history", (req, res) => {
  const identity = identityFor(req);
  res.json(ledger.history(identity.id).map((p) => publicPool(p, identity.id)));
});
app.get("/frontpot/api/rooms/:id/pool", (req, res) => {
  const identity = identityFor(req);
  const pool = ledger.get(req.params.id);
  const room = store.rooms.get(req.params.id);
  if (
    !pool ||
    !(
      pool.participants.some((p) => p.id === identity.id) ||
      room?.members.some((p) => p.id === identity.id)
    )
  )
    return res.status(404).json({ error: "Match not found." });
  res.json(publicPool(pool, identity.id));
});
app.get("/frontpot/api/history/:id/replay", (req, res) => {
  const identity = identityFor(req);
  const pool = ledger.get(req.params.id);
  if (!pool?.participants.some((p) => p.id === identity.id))
    return res.status(404).json({ error: "Replay not found." });
  const record = ledger.record(req.params.id);
  if (!record)
    return res.status(404).json({ error: "Replay is not ready yet." });
  res.type("json").send(
    JSON.stringify(
      {
        ...record,
        gitCommit: "DEV",
        info: {
          ...record.info,
          reports: undefined,
          players: record.info.players.map((p) => ({
            ...p,
            persistentID: null,
          })),
        },
      },
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    ),
  );
});
// Give upstream optional account/XP widgets a local, unauthenticated response.
app.use("/api", (_req, res) =>
  res.status(401).json({ error: "Optional account features are unavailable" }),
);
app.get("/source", (_req, res) =>
  res.download(
    path.join(root, "dist-demo/frontpot-source.tar.gz"),
    "frontpot-source.tar.gz",
  ),
);
app.get("/license", (_req, res) => res.sendFile(path.join(root, "LICENSE")));
app.use(
  express.static(path.join(root, "dist-demo"), { index: false, maxAge: "1h" }),
);
app.use(
  express.static(path.join(root, "resources"), { index: false, maxAge: "1d" }),
);
app.get(
  [
    "/",
    "/admin",
    "/terms",
    "/how-to-play",
    "/shop",
    "/lobbies",
    "/matchmaking",
    "/tutorial",
    "/profile",
    "/wallet",
    "/player/:id",
    "/room/:id",
    "/game/:id",
  ],
  (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(path.join(root, "dist-demo/demo.html"));
  },
);
app.use(
  (
    err: Error,
    _req: Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    const parser = err as Error & { type?: string; status?: number };
    const requestFailure =
      parser.type === "entity.too.large" && parser.status === 413
        ? { status: 413, message: "Request body is too large." }
        : parser.type === "encoding.unsupported" && parser.status === 415
          ? {
              status: 415,
              message: "Compressed request bodies are not supported.",
            }
          : parser.type === "entity.parse.failed" && parser.status === 400
            ? { status: 400, message: "Request body must be valid JSON." }
            : null;
    if (
      !requestFailure &&
      !(err instanceof InputError) &&
      !(err instanceof AuthError)
    )
      console.error(err.message);
    res
      .status(
        err instanceof AuthError
          ? err.status
          : err instanceof InputError
            ? 400
            : (requestFailure?.status ?? 500),
      )
      .json({
        error:
          err instanceof InputError || err instanceof AuthError
            ? err.message
            : (requestFailure?.message ??
              "Something went wrong. Please try again."),
      });
  },
);
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
live.start();
server.once("close", () => live.stop());
server.on("upgrade", (req, socket, head) => {
  try {
    const origin = req.headers.origin;
    const expectedHost = process.env.APP_ORIGIN
      ? new URL(process.env.APP_ORIGIN).host
      : req.headers.host;
    if (
      req.url !== "/w0" ||
      (origin && new URL(origin).host !== expectedHost) ||
      wss.clients.size >= 150
    ) {
      live.event("connection_rejected");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req),
    );
  } catch {
    socket.destroy();
  }
});
wss.on("connection", (ws, req) => {
  const timeout = setTimeout(() => ws.close(1008, "Join timeout"), 10_000);
  ws.once("close", () => clearTimeout(timeout));
  ws.on("error", () => {
    live.event("socket_error");
    ws.terminate();
  });
  ws.on("close", (code) => {
    if (![1000, 1001, 1008].includes(code)) live.event("unexpected_disconnect");
  });
  ws.once("message", (data) => {
    clearTimeout(timeout);
    try {
      const message = decodeClientMessage(
        new Uint8Array(data as Buffer),
        undefined,
      );
      if (message.type !== "join" && message.type !== "rejoin")
        throw new Error("Join first");
      const identity = auth.auth(message.token, true, true);
      const room = store.rooms.get(message.gameID);
      if (room) advanceRoom(room);
      const watching =
        (message.type === "join" && message.spectator === true) ||
        (message.type === "rejoin" && canSpectate(room, identity.id));
      if (watching && !canSpectate(room, identity.id))
        throw new Error("Spectating unavailable");
      const connectionID = watching
        ? spectatorIdentity(identity.id)
        : identity.id;
      if (
        !room ||
        (!watching && !room.members.some((m) => m.id === identity.id)) ||
        room.departedIDs?.includes(identity.id) ||
        room.status === "finished"
      )
        throw new Error("Join the room first");
      const game = startGameServer(room);
      if (message.type === "rejoin") {
        if (!game.rejoinClient(ws, connectionID, message.lastTurn)) {
          live.event("rejoin_failed");
          throw new Error("Unable to reconnect");
        }
        return;
      }
      if (room.mode === "2v2") {
        const pins = teamPins.get(room.id)!;
        for (let team = 0; team < 2; team++) {
          pins[team].splice(
            0,
            pins[team].length,
            ...room.members.filter((m) => m.team === team).map((m) => m.id),
          );
        }
      }
      const client = new Client(
        randomBytes(4).toString("hex"),
        connectionID,
        null,
        null,
        undefined,
        req.socket.remoteAddress ?? "127.0.0.1",
        identity.name,
        null,
        ws,
        watching ? undefined : cosmeticShop.cosmetics(identity.id),
        identity.id,
        [],
        watching,
        false,
        "unknown",
        "unknown",
        profiles.badge(identity.id),
      );
      const result = game.joinClient(client);
      if (result !== "joined") throw new Error(result);
    } catch {
      live.event("join_failed");
      ws.close(1008, "Unable to join. Return to the lobby and try again.");
    }
  });
});
setInterval(() => {
  const now = Date.now();
  applyDrain();
  for (const [id, room] of store.rooms) {
    const game = games.get(id);
    game?.pruneStaleClients();
    advanceRoom(room, now);
    const waiting = ["waiting", "countdown"].includes(room.status);
    if (
      (!waiting &&
        now - (room.locked?.at ?? room.created) >
          (room.rules.maxTimerValue + 10) * 60_000) ||
      (waiting && !room.queueKey && now - room.created > 30 * 60_000) ||
      (!room.members.length && !room.queueKey && now - room.created > 60_000) ||
      (room.status === "finished" &&
        now - (room.locked?.at ?? room.created) > 15 * 60_000)
    ) {
      void game?.end();
      const pool = ledger.get(id);
      if (pool?.state === "waiting")
        ledger.refund(id, "Lobby expired. No platform fee.");
      if (waiting && isWager(room)) payments?.cancel(id);
      store.rooms.delete(id);
      games.delete(id);
      teamPins.delete(id);
    }
  }
  queue.replenish();
  for (const [id, game] of games)
    if (!store.rooms.has(id)) {
      void game.end();
      games.delete(id);
    }
}, 500).unref();
let reconciliationRunning = false;
setInterval(async () => {
  if (!reconciliation || reconciliationRunning) return;
  reconciliationRunning = true;
  try {
    await monitoring?.check();
    await reconciliation.tick();
  } catch {
    live.event("reconciliation_failure");
    logger.warn("Reconciliation deferred; persisted jobs will retry.");
  } finally {
    reconciliationRunning = false;
  }
}, 15_000).unref();
let paymentTickRunning = false;
async function tickPayments() {
  if (!payments || paymentTickRunning) return;
  paymentTickRunning = true;
  try {
    let failures = (await playerWallets?.tick()) ?? 0;
    failures += await payments.tick();
    await userOwnedWallets?.tick();
    for (const row of ledger.db.prepare("SELECT id FROM pools").all()) {
      const p = ledger.get(String(row.id))!;
      if (p.network !== payments.network || p.stakeLamports === 0) continue;
      try {
        if (p.state === "review") {
          await payments.advanceRecovery(p.matchID);
          ledger.confirmRecoveredSettlement(p.matchID);
        } else if (p.state === "payout_pending") {
          const job = await payments.settle(p);
          if (job.lastFailureAt) failures++;
          if (job.state === "confirmed")
            ledger.confirmPayment(
              p.matchID,
              "settled",
              job.submission?.signature,
            );
          else if (job.state === "review")
            ledger.review(p.matchID, "Payout needs reconciliation.");
        } else if (p.state === "refund_pending") {
          payments.cancel(p.matchID);
          if (payments.refundsComplete(p.matchID))
            ledger.confirmPayment(p.matchID, "refunded");
        }
      } catch {
        failures++;
      }
    }
    operations.workerResult(failures);
    if (failures) live.event("payment_failure");
  } catch {
    operations.workerResult(1);
    live.event("payment_failure");
    logger.warn("Payment processing deferred; persisted jobs will retry.");
  } finally {
    paymentTickRunning = false;
  }
}
setInterval(() => void tickPayments(), 3_000).unref();
setInterval(() => auth.prune(), 60_000).unref();
server.listen(
  Number(process.env.PORT ?? 3000),
  process.env.HOST ?? "0.0.0.0",
  () =>
    console.log(
      `SolSiege ready on port ${process.env.PORT ?? 3000}; payments: ${payments?.network ?? "simulation"}.`,
    ),
);

let shopReconciling = false;
const shopTimer = setInterval(async () => {
  if (!userOwnedWallets || shopReconciling) return;
  shopReconciling = true;
  try {
    await cosmeticShop.reconcilePending();
  } catch {
    console.error("Cosmetic purchase reconciliation deferred");
  } finally {
    shopReconciling = false;
  }
}, 10_000).unref();
server.once("close", () => clearInterval(shopTimer));
