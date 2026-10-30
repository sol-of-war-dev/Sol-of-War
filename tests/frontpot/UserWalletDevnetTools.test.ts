import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import {
  privateJSON,
  rehearsalDirectory,
} from "../../scripts/userWalletDevnetFiles.mjs";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "wallet-rehearsal-boundary-"));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
test("private fixture files are usable outside the source checkout", async () => {
  const root = await fixture(),
    file = path.join(root, "private.json");
  await writeFile(file, JSON.stringify({ marker: "test-only" }), {
    mode: 0o600,
  });
  expect(await rehearsalDirectory(root)).toBeTruthy();
  expect(await privateJSON(file)).toEqual({ marker: "test-only" });
});
test("a symlink cannot redirect private state into the checkout", async () => {
  const root = await fixture(),
    link = path.join(root, "redirect");
  await symlink(fileURLToPath(new URL("../../", import.meta.url)), link);
  await expect(rehearsalDirectory(link)).rejects.toThrow(
    "outside the source checkout",
  );
  await expect(privateJSON(path.join(link, "package.json"))).rejects.toThrow(
    "outside the source checkout",
  );
});
test("shared directory and file permissions are rejected", async () => {
  const root = await fixture(),
    shared = path.join(root, "shared"),
    file = path.join(root, "shared.json");
  await mkdir(shared, { mode: 0o755 });
  await chmod(shared, 0o755);
  await writeFile(file, "{}", { mode: 0o644 });
  await chmod(file, 0o644);
  await expect(rehearsalDirectory(shared)).rejects.toThrow("0700");
  await expect(privateJSON(file)).rejects.toThrow("0600");
});
test("invalid secret JSON is not included in diagnostics", async () => {
  const root = await fixture(),
    file = path.join(root, "malformed.json");
  await writeFile(file, "PRIVATE_TEST_MARKER_not_json", { mode: 0o600 });
  await expect(privateJSON(file)).rejects.toThrow("contents omitted");
  try {
    await privateJSON(file);
  } catch (error) {
    expect(String(error)).not.toContain("PRIVATE_TEST_MARKER");
  }
});
