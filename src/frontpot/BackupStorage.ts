import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { PaymentMode } from "./payments/Network";

export interface BackupStorage {
  upload(
    file: string,
    network: PaymentMode,
  ): Promise<{ key: string; sha256: string }>;
  prune(network: PaymentMode, now?: number): Promise<void>;
}
const filename =
  /^solsiege-(simulation|devnet|mainnet)-(\d+)-[a-f0-9-]+\.ssbackup$/;
const prefix = (network: PaymentMode) => `solsiege/${network}/`;
function validKey(key: string, network: PaymentMode) {
  const name = key.slice(prefix(network).length);
  const match = filename.exec(name);
  return key.startsWith(prefix(network)) && match?.[1] === network;
}
/** Keep the last hour, hourly snapshots for a day, and daily snapshots for a
 * week. Only our exact filenames in the selected network prefix are eligible. */
export function expiredBackupKeys(
  keys: string[],
  network: PaymentMode,
  now: number,
) {
  const snapshots = keys
    .filter((key) => validKey(key, network))
    .map((key) => ({
      key,
      at: Number(filename.exec(key.slice(prefix(network).length))![2]),
    }))
    .filter((s) => Number.isSafeInteger(s.at) && s.at <= now)
    .sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
  const hours = new Set<number>(),
    days = new Set<number>();
  return snapshots
    .filter((s, index) => {
      const age = now - s.at,
        hour = Math.floor(s.at / 3_600_000),
        day = Math.floor(s.at / 86_400_000);
      const keep =
        index < 12 ||
        age <= 3_600_000 ||
        (age <= 86_400_000 && !hours.has(hour)) ||
        (age <= 7 * 86_400_000 && !days.has(day));
      hours.add(hour);
      days.add(day);
      return !keep;
    })
    .map((s) => s.key);
}
/** S3 stores ciphertext only. Every upload is read back and SHA-256 checked
 * before it counts as an offsite success or any older objects are pruned. */
export class S3BackupStorage implements BackupStorage {
  constructor(
    private client: S3Client,
    private bucket: string,
  ) {}
  private async digest(body: AsyncIterable<Uint8Array>) {
    const hash = createHash("sha256");
    for await (const bytes of body) hash.update(bytes);
    return hash.digest("hex");
  }
  async upload(file: string, network: PaymentMode) {
    const name = path.basename(file),
      match = filename.exec(name);
    if (match?.[1] !== network)
      throw new Error("Backup filename/network mismatch");
    const key = `${prefix(network)}${name}`;
    const sha256 = await this.digest(createReadStream(file));
    const length = (await stat(file)).size;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(file),
        ContentLength: length,
        ContentType: "application/octet-stream",
        Metadata: { sha256, network },
      }),
      { abortSignal: AbortSignal.timeout(120_000) },
    );
    const remote = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { abortSignal: AbortSignal.timeout(120_000) },
    );
    if (
      !remote.Body ||
      remote.ContentLength !== length ||
      (await this.digest(remote.Body as AsyncIterable<Uint8Array>)) !== sha256
    )
      throw new Error("Offsite backup read-back verification failed");
    return { key, sha256 };
  }
  async list(network: PaymentMode) {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix(network),
          ContinuationToken: cursor,
        }),
        { abortSignal: AbortSignal.timeout(30_000) },
      );
      for (const item of page.Contents ?? [])
        if (item.Key && validKey(item.Key, network)) keys.push(item.Key);
      if (
        page.IsTruncated &&
        (!page.NextContinuationToken || page.NextContinuationToken === cursor)
      )
        throw new Error("Invalid backup listing cursor");
      cursor = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (cursor);
    return keys.sort().reverse();
  }
  async prune(network: PaymentMode, now = Date.now()) {
    for (const key of expiredBackupKeys(await this.list(network), network, now))
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal: AbortSignal.timeout(30_000) },
      );
  }
  async download(key: string, file: string, network: PaymentMode) {
    if (!validKey(key, network)) throw new Error("Backup key/network mismatch");
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { abortSignal: AbortSignal.timeout(120_000) },
    );
    if (!result.Body) throw new Error("Backup not found");
    let created = false;
    try {
      const output = createWriteStream(file, { flags: "wx", mode: 0o600 });
      output.once("open", () => {
        created = true;
      });
      await pipeline(result.Body as AsyncIterable<Uint8Array>, output);
      if (
        !result.Metadata?.sha256 ||
        (await this.digest(createReadStream(file))) !== result.Metadata.sha256
      )
        throw new Error("Downloaded backup checksum mismatch");
    } catch (error) {
      if (created) await rm(file, { force: true });
      throw error;
    }
  }
}
export function backupStorage(env: NodeJS.ProcessEnv = process.env) {
  const names = [
    "SOLSIEGE_BACKUP_S3_ENDPOINT",
    "SOLSIEGE_BACKUP_S3_BUCKET",
    "SOLSIEGE_BACKUP_S3_REGION",
    "SOLSIEGE_BACKUP_S3_ACCESS_KEY_ID",
    "SOLSIEGE_BACKUP_S3_SECRET_ACCESS_KEY",
  ] as const;
  if (!names.some((key) => env[key])) return null;
  if (names.some((key) => !env[key]?.trim()))
    throw new Error("Incomplete offsite backup configuration");
  const endpoint = new URL(env.SOLSIEGE_BACKUP_S3_ENDPOINT!);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error(
      "Backup endpoint must use HTTPS without embedded credentials",
    );
  return new S3BackupStorage(
    new S3Client({
      endpoint: endpoint.href,
      region: env.SOLSIEGE_BACKUP_S3_REGION,
      credentials: {
        accessKeyId: env.SOLSIEGE_BACKUP_S3_ACCESS_KEY_ID!,
        secretAccessKey: env.SOLSIEGE_BACKUP_S3_SECRET_ACCESS_KEY!,
      },
      forcePathStyle: env.SOLSIEGE_BACKUP_S3_PATH_STYLE === "true",
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      maxAttempts: 3,
    }),
    env.SOLSIEGE_BACKUP_S3_BUCKET!,
  );
}
