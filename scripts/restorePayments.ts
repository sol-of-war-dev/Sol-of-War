import { restorePaymentBackup } from "../src/frontpot/Backups";
const [file, directory, network] = process.argv.slice(2);
if (
  !file ||
  !directory ||
  !["simulation", "devnet", "mainnet"].includes(network) ||
  !process.env.SOLSIEGE_BACKUP_KEY
) {
  console.error(
    "Usage: SOLSIEGE_BACKUP_KEY=<private key> node --import tsx scripts/restorePayments.ts <backup.ssbackup> <new-state-directory> <simulation|devnet|mainnet>",
  );
  process.exitCode = 1;
} else {
  try {
    console.log(
      JSON.stringify(
        await restorePaymentBackup(
          file,
          directory,
          process.env.SOLSIEGE_BACKUP_KEY,
          network as "simulation" | "devnet" | "mainnet",
        ),
      ),
    );
  } catch {
    console.error(
      "Restore failed. Check the backup key, network, file integrity and that the destination does not already exist.",
    );
    process.exitCode = 1;
  }
}
