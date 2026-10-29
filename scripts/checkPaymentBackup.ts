import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { restorePaymentBackup } from "../src/frontpot/Backups";
import { backupStorage } from "../src/frontpot/BackupStorage";
import type { PaymentMode } from "../src/frontpot/payments/Network";

const [network, selectedKey] = process.argv.slice(2);
if (!network || !["simulation", "devnet", "mainnet"].includes(network)) {
  console.error(
    "Usage: node --import tsx scripts/checkPaymentBackup.ts <simulation|devnet|mainnet> [object-key]",
  );
  process.exitCode = 1;
} else {
  let temp: string | undefined;
  try {
    const storage = backupStorage();
    const secret = process.env.SOLSIEGE_BACKUP_KEY;
    if (!storage || !secret) throw new Error("Backup configuration required");
    const mode = network as PaymentMode;
    const key = selectedKey ?? (await storage.list(mode))[0];
    if (!key) throw new Error("No retained backup");
    temp = await mkdtemp(path.join(tmpdir(), "solsiege-offsite-drill-"));
    const file = path.join(temp, "download.ssbackup");
    await storage.download(key, file, mode);
    const result = await restorePaymentBackup(
      file,
      path.join(temp, "restored"),
      secret,
      mode,
    );
    console.log(
      JSON.stringify({
        network,
        key,
        decrypted: true,
        integrity: "ok",
        requiresChainReconciliation: result.requiresReconciliation,
      }),
    );
  } catch {
    console.error(
      "Offsite restore check failed. Verify private configuration, storage availability, backup key and selected network. No live database was changed.",
    );
    process.exitCode = 1;
  } finally {
    if (temp) await rm(temp, { recursive: true, force: true });
  }
}
