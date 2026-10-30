// No production environment variables or secret files are inherited by this server.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { privateJSON, rehearsalDirectory } from "./userWalletDevnetFiles.mjs";

const [directory] = process.argv.slice(2);
if (!directory)
  throw new Error(
    "Usage: node scripts/runUserWalletDevnet.mjs <isolated-state-directory>",
  );
const root = await rehearsalDirectory(directory);
const settings = await privateJSON(path.join(root, "environment-private.json"));
const setup = await privateJSON(path.join(root, "setup-private.json"));
const checkout = fileURLToPath(new URL("../", import.meta.url));
if (existsSync(path.join(checkout, ".env")))
  throw new Error("Use a clean checkout without a .env file for the rehearsal");
if (
  settings.PAYMENTS_MODE !== "devnet" ||
  settings.PRIVY_APP_ID === "cmvpxnxk801020gjsjwl9vf1u" ||
  !settings.PRIVY_APP_ID ||
  settings.PRIVY_APP_ID !== setup.appId ||
  settings.HOST !== "127.0.0.1" ||
  ![
    `http://127.0.0.1:${settings.PORT}`,
    `http://localhost:${settings.PORT}`,
  ].includes(settings.APP_ORIGIN) ||
  settings.SOLANA_DEVNET_RPC_URL !== "https://api.devnet.solana.com" ||
  settings.FRONTPOT_STATE_DIR !== path.join(root, "state") ||
  settings.NODE_ENV !== "development"
)
  throw new Error("Unsafe rehearsal configuration");
const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  LANG: process.env.LANG,
  ...settings,
};
const child = spawn(
  process.execPath,
  [
    "--import",
    "./scripts/observeUserWalletDevnet.mjs",
    "--import",
    "tsx",
    "src/frontpot/Server.ts",
  ],
  { cwd: checkout, env, stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.on("error", () => {
  console.error("Could not start the isolated rehearsal server");
  process.exitCode = 1;
});
child.on("exit", (code) => process.exit(code ?? 1));
