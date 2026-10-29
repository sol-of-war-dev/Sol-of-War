import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  PaymentBackups,
  restorePaymentBackup,
} from "../../src/frontpot/Backups";
import {
  backupStorage,
  expiredBackupKeys,
  S3BackupStorage,
} from "../../src/frontpot/BackupStorage";

describe("offsite payment backups", () => {
  it("uploads ciphertext, verifies the downloaded bytes and restores the database", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ss-offsite-"));
    const db = new DatabaseSync(":memory:"),
      secret = randomBytes(32).toString("base64");
    const client = new S3Client({ region: "auto" });
    let stored = Buffer.alloc(0),
      objectKey = "",
      sha256 = "",
      corrupt = false;
    vi.spyOn(client, "send").mockImplementation(async (command: unknown) => {
      if (command instanceof PutObjectCommand) {
        const parts: Buffer[] = [];
        for await (const part of command.input.Body as AsyncIterable<Buffer>)
          parts.push(part);
        stored = Buffer.concat(parts);
        objectKey = command.input.Key!;
        sha256 = command.input.Metadata!.sha256;
        return {};
      }
      if (command instanceof GetObjectCommand)
        return {
          Body: Readable.from([corrupt ? Buffer.from("corrupt") : stored]),
          ContentLength: stored.length,
          Metadata: { sha256 },
        };
      if (command instanceof ListObjectsV2Command)
        return { Contents: [{ Key: objectKey }] };
      throw new Error("Unexpected storage operation");
    });
    try {
      db.exec(
        "CREATE TABLE ledger(value TEXT); INSERT INTO ledger VALUES('private-ledger-data');",
      );
      const storage = new S3BackupStorage(client, "private-bucket");
      const backups = new PaymentBackups(
        db,
        dir,
        secret,
        "simulation",
        storage,
      );
      await backups.run();
      expect(backups.status().offsite).toMatchObject({
        failed: false,
        key: objectKey,
      });
      expect(backups.status().offsite!.lastSuccess).toBeGreaterThan(0);
      expect(stored.subarray(0, 9).toString()).toBe("SOLSIEGE1");
      expect(stored.includes(Buffer.from("private-ledger-data"))).toBe(false);
      expect(createHash("sha256").update(stored).digest("hex")).toBe(sha256);
      const download = path.join(dir, "download.ssbackup");
      await storage.download(objectKey, download, "simulation");
      const restored = path.join(dir, "restored");
      await restorePaymentBackup(download, restored, secret, "simulation");
      const copy = new DatabaseSync(path.join(restored, "matches.sqlite"), {
        readOnly: true,
      });
      try {
        expect(copy.prepare("SELECT value FROM ledger").get()!.value).toBe(
          "private-ledger-data",
        );
      } finally {
        copy.close();
      }
      await expect(
        storage.download(objectKey, download, "simulation"),
      ).rejects.toThrow();
      expect(await readFile(download)).toEqual(stored);
      corrupt = true;
      await backups.run();
      expect(backups.status().failed).toBe(false);
      expect(backups.status().offsite!.failed).toBe(true);
      await expect(
        storage.download(
          objectKey,
          path.join(dir, "bad.ssbackup"),
          "simulation",
        ),
      ).rejects.toThrow("checksum");
      await expect(readFile(path.join(dir, "bad.ssbackup"))).rejects.toThrow();
      await expect(
        storage.download(
          objectKey,
          path.join(dir, "other.ssbackup"),
          "mainnet",
        ),
      ).rejects.toThrow("network");
    } finally {
      db.close();
      client.destroy();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("keeps recent, hourly and daily recovery points and never touches unrelated objects", () => {
    const now = Date.UTC(2026, 9, 27, 12);
    const key = (at: number, mode = "mainnet") =>
      `solsiege/${mode}/solsiege-${mode}-${at}-abcdef.ssbackup`;
    const keys = Array.from({ length: 10 * 24 * 12 }, (_, i) =>
      key(now - i * 300_000),
    );
    const unrelated = [
      key(now - 20 * 86_400_000, "devnet"),
      "other/file",
      "solsiege/mainnet/important",
      key(now + 86_400_000),
    ];
    const expired = new Set(
      expiredBackupKeys([...keys, ...unrelated], "mainnet", now),
    );
    for (const safe of [...keys.slice(0, 13), ...unrelated])
      expect(expired.has(safe)).toBe(false);
    expect(expired.has(keys[keys.length - 1])).toBe(true);
    const kept = keys.filter((k) => !expired.has(k));
    expect(kept.length).toBeLessThan(50);
    for (let day = 1; day < 7; day++) {
      const dayNumber = Math.floor((now - day * 86_400_000) / 86_400_000);
      expect(
        kept.some(
          (k) => Math.floor(Number(k.split("-")[2]) / 86_400_000) === dayNumber,
        ),
      ).toBe(true);
    }
  });
  it("rejects incomplete and insecure storage configuration", () => {
    expect(backupStorage({})).toBeNull();
    expect(() => backupStorage({ SOLSIEGE_BACKUP_S3_BUCKET: "test" })).toThrow(
      "Incomplete",
    );
    expect(() =>
      backupStorage({
        SOLSIEGE_BACKUP_S3_ENDPOINT: "http://storage.test",
        SOLSIEGE_BACKUP_S3_BUCKET: "test",
        SOLSIEGE_BACKUP_S3_REGION: "auto",
        SOLSIEGE_BACKUP_S3_ACCESS_KEY_ID: "test",
        SOLSIEGE_BACKUP_S3_SECRET_ACCESS_KEY: "test",
      }),
    ).toThrow("HTTPS");
  });
});
