import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  sourceManifest,
  compareSources,
  writeRelease,
  releaseCommit,
} from "../../scripts/release-manifest.mjs";
import { releaseIntegrity } from "../../src/frontpot/ReleaseIntegrity";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "sow-release-test-"));
  roots.push(root);
  for (const d of ["src", "packages", "resources", "dist-demo"])
    await mkdir(path.join(root, d));
  await writeFile(
    path.join(root, "src/server.ts"),
    "export const safe = true;\n",
  );
  await writeFile(path.join(root, "package.json"), "{}\n");
  await writeFile(
    path.join(root, "dist-demo/app.js"),
    "console.log('test');\n",
  );
  return root;
}
it("compares contents, detects drift and excludes dependencies and runtime secrets from root", async () => {
  const a = await fixture(),
    b = await fixture();
  await writeFile(path.join(a, ".env"), "PRIVATE=not-for-release");
  const m = await sourceManifest(a);
  expect(m.files).not.toHaveProperty(".env");
  expect((await compareSources(a, b)).match).toBe(true);
  await writeFile(path.join(b, "src/server.ts"), "changed");
  expect((await compareSources(a, b)).differences).toEqual(["src/server.ts"]);
});
it("requires a manifest in production and detects changed or extra source and assets", async () => {
  const root = await fixture();
  expect(() => releaseIntegrity(root, true)).toThrow("Missing release");
  await writeRelease(root);
  expect(releaseIntegrity(root, true).available).toBe(true);
  await writeFile(path.join(root, "src/extra.ts"), "extra");
  expect(() => releaseIntegrity(root, true)).toThrow("Unrecorded release");
  await rm(path.join(root, "src/extra.ts"));
  await writeFile(path.join(root, "dist-demo/app.js"), "tampered");
  expect(() => releaseIntegrity(root, true)).toThrow(
    "differs from tested build",
  );
});
it("refuses sensitive files inside a packaged directory", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "src/operator.key"), "private");
  await expect(sourceManifest(root)).rejects.toThrow("Sensitive/runtime file");
});
it("checks the exact served source archive as a build artifact", async () => {
  const root = await fixture();
  await writeFile(
    path.join(root, "dist-demo/frontpot-source.tar.gz"),
    "source-fixture",
  );
  const m = await writeRelease(root);
  expect(m.builtFiles).toHaveProperty("dist-demo/frontpot-source.tar.gz");
  expect(releaseIntegrity(root, true).available).toBe(true);
  await writeFile(
    path.join(root, "dist-demo/frontpot-source.tar.gz"),
    "wrong-source",
  );
  expect(() => releaseIntegrity(root, true)).toThrow(
    "differs from tested build",
  );
});
it("accepts a valid Railway revision in a Docker context without inventing one", async () => {
  const root = await fixture();
  const sha = "a".repeat(40);
  expect(releaseCommit(root, sha)).toBe(sha);
  expect(releaseCommit(root, "")).toBeNull();
  expect(() => releaseCommit(root, "main")).toThrow(
    "Invalid deployment commit",
  );
});
it("rejects a claimed revision that differs from the checkout or hides local changes", async () => {
  const root = await fixture();
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  git("init");
  git("add", ".");
  git(
    "-c",
    "user.name=Test fixture",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "Fixture",
  );
  const sha = git("rev-parse", "HEAD");
  expect(releaseCommit(root, sha)).toBe(sha);
  expect(() => releaseCommit(root, "b".repeat(40))).toThrow("does not match");
  await writeFile(path.join(root, "src/server.ts"), "uncommitted");
  expect(releaseCommit(root, "")).toBeNull();
  expect(() => releaseCommit(root, sha)).toThrow("does not match");
});
