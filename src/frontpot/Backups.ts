import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { createReadStream, createWriteStream, constants } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";
import type { BackupStorage } from "./BackupStorage";
import type { PaymentMode } from "./payments/Network";
const magic = Buffer.from("SOLSIEGE1");
export const RESTORE_HOLD = "RESTORE_REQUIRES_RECONCILIATION";
const keyBytes = (value: string) => {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value))
    throw new Error("Backup key must be a base64-encoded 32-byte key");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("Invalid backup key");
  return key;
};
function integrity(file: string, network: PaymentMode) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (
      db
        .prepare("PRAGMA integrity_check")
        .all()
        .some((r) => r.integrity_check !== "ok")
    )
      throw new Error("Backup integrity check failed");
    const table = db
      .prepare("SELECT 1 FROM sqlite_master WHERE name='payment_network'")
      .get();
    const bound = table
      ? db.prepare("SELECT network FROM payment_network WHERE id=1").get()
          ?.network
      : null;
    if (
      (network !== "simulation" && bound !== network) ||
      (network === "simulation" && bound)
    )
      throw new Error("Backup network does not match database");
  } finally {
    db.close();
  }
}
/** Online SQLite backup includes the ledger, signed transfers and replay blobs.
 * Encrypt before retaining it. Player private keys are envelope-encrypted;
 * wrapping keys are stored separately and must be backed up independently. */
export async function createPaymentBackup(
  db: DatabaseSync,
  directory: string,
  secret: string,
  network: PaymentMode,
) {
  const key = keyBytes(secret);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = await mkdtemp(path.join(tmpdir(), "solsiege-backup-"));
  const file = path.join(
    directory,
    `solsiege-${network}-${Date.now()}-${randomUUID()}.ssbackup`,
  );
  const partial = `${file}.partial`;
  try {
    const snapshot = path.join(temp, "snapshot.sqlite");
    await backup(db, snapshot, { rate: 128 });
    await chmod(snapshot, 0o600);
    integrity(snapshot, network);
    const iv = randomBytes(12);
    const header = Buffer.from(
      JSON.stringify({
        version: 1,
        network,
        createdAt: Date.now(),
        iv: iv.toString("base64"),
      }),
    );
    const size = Buffer.alloc(4);
    size.writeUInt32BE(header.length);
    const aad = Buffer.concat([magic, size, header]);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad);
    await writeFile(partial, aad, { flag: "wx", mode: 0o600 });
    await pipeline(
      createReadStream(snapshot),
      createGzip(),
      cipher,
      createWriteStream(partial, { flags: "a", mode: 0o600 }),
    );
    const handle = await open(partial, "a");
    try {
      await handle.write(cipher.getAuthTag());
      await handle.sync();
    } finally {
      await handle.close();
    }
    // EXCL avoids replacing another retained backup even on a naming collision.
    await copyFile(partial, file, constants.COPYFILE_EXCL);
    await chmod(file, 0o600);
    return { file, createdAt: Date.now(), bytes: (await stat(file)).size };
  } finally {
    await rm(temp, { recursive: true, force: true });
    await rm(partial, { force: true });
  }
}
/** Restore only into a newly created state directory. Startup remains blocked
 * until an operator reconciles the snapshot with chain/provider history. */
export async function restorePaymentBackup(
  file: string,
  directory: string,
  secret: string,
  expectedNetwork: PaymentMode,
) {
  const key = keyBytes(secret);
  const handle = await open(file, "r");
  const temp = await mkdtemp(path.join(tmpdir(), "solsiege-restore-"));
  try {
    const prefix = Buffer.alloc(magic.length + 4);
    await handle.read(prefix, 0, prefix.length, 0);
    if (!prefix.subarray(0, magic.length).equals(magic))
      throw new Error("Not a SolSiege backup");
    const length = prefix.readUInt32BE(magic.length);
    if (length < 2 || length > 4096) throw new Error("Invalid backup header");
    const header = Buffer.alloc(length);
    await handle.read(header, 0, length, prefix.length);
    const metadata = JSON.parse(header.toString());
    if (metadata.version !== 1 || metadata.network !== expectedNetwork)
      throw new Error("Backup network mismatch");
    const total = (await handle.stat()).size,
      offset = prefix.length + length;
    if (total <= offset + 16) throw new Error("Truncated backup");
    const tag = Buffer.alloc(16);
    await handle.read(tag, 0, 16, total - 16);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(metadata.iv, "base64"),
    );
    decipher.setAAD(Buffer.concat([prefix, header]));
    decipher.setAuthTag(tag);
    const snapshot = path.join(temp, "snapshot.sqlite");
    await pipeline(
      createReadStream(file, { start: offset, end: total - 17 }),
      decipher,
      createGunzip(),
      createWriteStream(snapshot, { flags: "wx", mode: 0o600 }),
    );
    integrity(snapshot, expectedNetwork);
    // Do not overwrite a live database, WAL, or an earlier restoration.
    await mkdir(directory, { mode: 0o700 });
    await writeFile(
      path.join(directory, RESTORE_HOLD),
      JSON.stringify({
        restoredAt: Date.now(),
        backupCreatedAt: metadata.createdAt,
        network: expectedNetwork,
      }),
      { flag: "wx", mode: 0o600 },
    );
    await copyFile(
      snapshot,
      path.join(directory, "matches.sqlite"),
      constants.COPYFILE_EXCL,
    );
    await chmod(path.join(directory, "matches.sqlite"), 0o600);
    return {
      directory,
      network: expectedNetwork,
      requiresReconciliation: true,
    };
  } finally {
    await handle.close();
    await rm(temp, { recursive: true, force: true });
  }
}
export class PaymentBackups {
  private running: Promise<void> | null = null;
  private backedUpThrough = 0;
  private offsite: {
    lastAttempt: number | null;
    lastSuccess: number | null;
    key: string | null;
    sha256: string | null;
    failed: boolean;
  } = {
    lastAttempt: null,
    lastSuccess: null,
    key: null,
    sha256: null,
    failed: false,
  };
  private health: {
    lastAttempt: number | null;
    lastSuccess: number | null;
    bytes: number | null;
    failed: boolean;
  } = { lastAttempt: null, lastSuccess: null, bytes: null, failed: false };
  constructor(
    private db: DatabaseSync,
    private directory: string,
    private secret: string,
    private network: PaymentMode,
    private storage: BackupStorage | null = null,
  ) {
    keyBytes(secret);
  }
  status() {
    return {
      ...this.health,
      offsite: this.storage ? { ...this.offsite } : null,
    };
  }
  async ensureContains(createdAt: number) {
    if (!this.storage)
      throw new Error(
        "Offsite wallet backup is required before showing a deposit address",
      );
    if (this.running) await this.running;
    if (this.backedUpThrough <= createdAt) await this.run();
    if (this.backedUpThrough <= createdAt)
      throw new Error(
        "Your wallet backup is not ready. Please try again shortly.",
      );
  }
  run(): Promise<void> {
    if (this.running) return this.running;
    const task = this.perform();
    this.running = task;
    void task.finally(() => {
      if (this.running === task) this.running = null;
    });
    return task;
  }
  private async perform() {
    const started = Date.now();
    this.health.lastAttempt = started;
    try {
      const result = await createPaymentBackup(
        this.db,
        this.directory,
        this.secret,
        this.network,
      );
      this.health.lastSuccess = result.createdAt;
      this.health.bytes = result.bytes;
      this.health.failed = false;
      if (this.storage) {
        this.offsite.lastAttempt = Date.now();
        try {
          const remote = await this.storage.upload(result.file, this.network);
          this.offsite = {
            ...this.offsite,
            ...remote,
            lastSuccess: Date.now(),
            failed: false,
          };
          this.backedUpThrough = started;
          await this.storage.prune(this.network);
        } catch {
          this.offsite.failed = true;
        }
      }
      const files = (await readdir(this.directory))
        .filter((f) =>
          new RegExp(
            `^solsiege-${this.network}-[0-9]+-[a-f0-9-]+\\.ssbackup$`,
          ).test(f),
        )
        .sort()
        .reverse();
      for (const file of files.slice(24))
        await rm(path.join(this.directory, file));
    } catch {
      this.health.failed = true;
    }
  }
}
