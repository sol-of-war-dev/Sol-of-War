import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vitest";
import {
  createPaymentBackup,
  restorePaymentBackup,
  RESTORE_HOLD,
} from "../../src/frontpot/Backups";
import { bindPaymentDatabase } from "../../src/frontpot/payments/PaymentDatabase";
describe("encrypted payment backups", () => {
  it("restores mainnet ledger, replay blobs and signed payments while holding startup", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ss-backup-test-")),
      db = new DatabaseSync(":memory:"),
      key = randomBytes(32).toString("base64");
    try {
      bindPaymentDatabase(db, "mainnet");
      db.exec(
        "CREATE TABLE chain_jobs(id TEXT,body TEXT); INSERT INTO chain_jobs VALUES('payout','sensitive-signed-transaction'); CREATE TABLE recordings(id TEXT,body BLOB); INSERT INTO recordings VALUES('game',x'0123456789');",
      );
      const result = await createPaymentBackup(
        db,
        path.join(dir, "backups"),
        key,
        "mainnet",
      );
      expect(
        (await readFile(result.file)).includes(
          Buffer.from("sensitive-signed-transaction"),
        ),
      ).toBe(false);
      expect((await stat(result.file)).mode & 0o777).toBe(0o600);
      const restored = path.join(dir, "restored");
      await restorePaymentBackup(result.file, restored, key, "mainnet");
      expect(
        JSON.parse(await readFile(path.join(restored, RESTORE_HOLD), "utf8"))
          .network,
      ).toBe("mainnet");
      const check = new DatabaseSync(path.join(restored, "matches.sqlite"), {
        readOnly: true,
      });
      try {
        expect(check.prepare("SELECT body FROM chain_jobs").get()!.body).toBe(
          "sensitive-signed-transaction",
        );
        expect(
          Buffer.from(
            check.prepare("SELECT body FROM recordings").get()!
              .body as Uint8Array,
          ).toString("hex"),
        ).toBe("0123456789");
      } finally {
        check.close();
      }
      await expect(
        restorePaymentBackup(result.file, restored, key, "mainnet"),
      ).rejects.toThrow();
      await expect(
        restorePaymentBackup(
          result.file,
          path.join(dir, "wrong-chain"),
          key,
          "devnet",
        ),
      ).rejects.toThrow("network");
      await expect(
        restorePaymentBackup(
          result.file,
          path.join(dir, "wrong-key"),
          randomBytes(32).toString("base64"),
          "mainnet",
        ),
      ).rejects.toThrow();
      const bytes = await readFile(result.file);
      bytes[bytes.length - 20] ^= 1;
      const tampered = path.join(dir, "tampered.ssbackup");
      await writeFile(tampered, bytes);
      await expect(
        restorePaymentBackup(
          tampered,
          path.join(dir, "corrupt"),
          key,
          "mainnet",
        ),
      ).rejects.toThrow();
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
