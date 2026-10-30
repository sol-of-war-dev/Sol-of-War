import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, lstatSync } from "node:fs";
import path from "node:path";

/** Detect release drift, not a cryptographic attestation of a hostile host. */
export function releaseIntegrity(root: string, required: boolean) {
  const file = path.join(root, "dist-demo/release-manifest.json");
  if (!existsSync(file)) {
    if (required)
      throw new Error(
        "Missing release manifest. Rebuild this release before starting production.",
      );
    return { available: false as const };
  }
  const m = JSON.parse(readFileSync(file, "utf8"));
  if (
    m.schema !== 1 ||
    !/^[a-f0-9]{64}$/.test(m.sourceDigest) ||
    !/^[a-f0-9]{64}$/.test(m.builtDigest) ||
    (m.sourceCommit !== null && !/^[a-f0-9]{40}$/.test(m.sourceCommit))
  )
    throw new Error("Invalid release manifest");
  const hash = (bytes: string | Buffer) =>
    createHash("sha256").update(bytes).digest("hex");
  if (
    hash(JSON.stringify(m.files)) !== m.sourceDigest ||
    hash(JSON.stringify(m.builtFiles)) !== m.builtDigest
  )
    throw new Error("Release manifest digest mismatch");
  const expectedRuntime = Object.fromEntries(
    Object.entries(m.files).filter(
      ([rel]) =>
        /^(src|packages|resources)\//.test(rel) ||
        [
          "package.json",
          "package-lock.json",
          "tsconfig.json",
          "tsconfig.base.json",
        ].includes(rel),
    ),
  );
  if (JSON.stringify(expectedRuntime) !== JSON.stringify(m.runtimeFiles))
    throw new Error("Incomplete runtime manifest");
  if (required) {
    const expected = { ...m.runtimeFiles, ...m.builtFiles } as Record<
      string,
      string
    >;
    for (const [rel, digest] of Object.entries(expected)) {
      if (
        rel.startsWith("/") ||
        rel.split("/").some((p) => p === ".." || p === ".") ||
        !/^[a-f0-9]{64}$/.test(digest)
      )
        throw new Error("Invalid release path or digest");
      const abs = path.join(root, rel);
      if (
        !existsSync(abs) ||
        !lstatSync(abs).isFile() ||
        hash(readFileSync(abs)) !== digest
      )
        throw new Error(`Release file differs from tested build: ${rel}`);
    }
    const walk = (rel: string) => {
      if (rel === "resources/maps") return;
      for (const entry of readdirSync(path.join(root, rel))) {
        if (["node_modules", ".DS_Store"].includes(entry)) continue;
        const next = `${rel}/${entry}`;
        const stat = lstatSync(path.join(root, next));
        if (stat.isDirectory()) walk(next);
        else if (
          !(next in expected) &&
          ![
            "dist-demo/release-manifest.json",
            "dist-demo/frontpot-source.tar.gz",
          ].includes(next)
        )
          throw new Error(`Unrecorded release file: ${next}`);
      }
    };
    for (const dir of ["src", "packages", "resources", "dist-demo"]) walk(dir);
  }
  return {
    available: true as const,
    sourceDigest: m.sourceDigest as string,
    builtDigest: m.builtDigest as string,
    sourceCommit: typeof m.sourceCommit === "string" ? m.sourceCommit : null,
    sourceRepository: "https://github.com/sol-of-war-dev/Sol-of-War",
  };
}
