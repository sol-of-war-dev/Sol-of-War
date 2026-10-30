import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const checkout = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const outsideCheckout = (target) => {
  if (target === checkout || target.startsWith(checkout + path.sep))
    throw new Error(
      "Private rehearsal files must be outside the source checkout",
    );
};
export async function rehearsalDirectory(directory, create = false) {
  const target = path.resolve(directory);
  outsideCheckout(target);
  if (create) await mkdir(target, { recursive: true, mode: 0o700 });
  const resolved = await realpath(target);
  outsideCheckout(resolved);
  const info = await stat(resolved);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0)
    throw new Error(
      "Use a dedicated private rehearsal directory with permissions 0700",
    );
  return resolved;
}
export async function privateJSON(file) {
  const resolved = await realpath(file);
  outsideCheckout(resolved);
  const info = await stat(resolved);
  if (!info.isFile() || (info.mode & 0o077) !== 0)
    throw new Error("Private rehearsal JSON must have permissions 0600");
  try {
    return JSON.parse(await readFile(resolved, "utf8"));
  } catch {
    throw new Error("Cannot parse private rehearsal JSON; contents omitted");
  }
}
