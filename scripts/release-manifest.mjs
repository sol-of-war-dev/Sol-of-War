import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readdir, readFile, lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const sourceRoots = [
  ".github",
  "src",
  "packages",
  "scripts",
  "tests",
  "docs",
  "__mocks__",
  "resources",
  "map-generator",
];
export const sourceFiles = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.base.json",
  "vite.config.ts",
  "vite.demo.config.ts",
  "demo.html",
  "index.html",
  "client-api.json",
  "Dockerfile",
  "Dockerfile.frontpot",
  "Dockerfile.openfront",
  "Dockerfile.openfront.dockerignore",
  "railway.toml",
  "Dockerfile.frontpot.dockerignore",
  ".dockerignore",
  ".railwayignore",
  ".npmrc",
  ".nvmrc",
  ".gitignore",
  ".editorconfig",
  ".gitattributes",
  ".oxfmtrc.json",
  ".oxlintrc.json",
  ".swcrc",
  "USER_OWNED_WALLETS.md",
  "README.md",
  "PAYOUTS.md",
  "PLAYER_WALLETS.md",
  "PAYMENTS.md",
  "MAINNET.md",
  "DEVNET.md",
  "LAUNCH.md",
  "OPERATIONS.md",
  "RAILWAY.md",
  "REPOSITORY.md",
  "VERIFICATION.md",
  "SECURITY.md",
  "FRONTPOT.md",
  "MATCHMAKING.md",
  "SHARED_MATCHMAKING.md",
  "CONTRIBUTING.md",
  "CREDITS.md",
  "LICENSE",
  "LICENSE-ASSETS",
  "LICENSING.md",
  "example.env",
  "example.sow.env",
  "render.yaml",
  "nginx.conf",
  "supervisord.conf",
  "generate-nginx-upstream.sh",
  "build.sh",
  "build-deploy.sh",
  "deploy.sh",
  "setup.sh",
  "update.sh",
];
const excluded = new Set([
  "node_modules",
  ".git",
  "dist",
  "dist-demo",
  "coverage",
  ".DS_Store",
  "proprietary",
]);
const forbidden = (name) =>
  /^\.env(?:\.|$)/.test(name) ||
  /\.(?:sqlite(?:-.*)?|ssbackup(?:\.partial)?|pem|key|log)$/.test(name) ||
  name === "RESTORE_REQUIRES_RECONCILIATION";
export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function sourceManifest(root) {
  const files = {};
  async function visit(rel) {
    if (rel === "resources/maps" || rel === "map-generator/assets") return; // Separately pinned archive in Dockerfile.frontpot.
    const name = path.basename(rel);
    if (excluded.has(name)) return;
    if (forbidden(name))
      throw new Error(`Sensitive/runtime file in source tree: ${rel}`);
    const absolute = path.join(root, rel);
    const stat = await lstat(absolute).catch((e) =>
      e.code === "ENOENT" ? null : Promise.reject(e),
    );
    if (!stat) return;
    if (stat.isSymbolicLink())
      throw new Error(`Source symlinks require explicit review: ${rel}`);
    if (stat.isDirectory()) {
      for (const entry of (await readdir(absolute)).sort())
        await visit(`${rel}/${entry}`);
    } else if (stat.isFile()) files[rel] = sha(await readFile(absolute));
  }
  for (const rel of [...sourceRoots, ...sourceFiles].sort()) await visit(rel);
  const ordered = Object.fromEntries(
    Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return {
    schema: 1,
    sourceDigest: sha(JSON.stringify(ordered)),
    files: ordered,
    maps: "Pinned separately by Dockerfile.frontpot archive SHA-256; local maps and offline map-generator input assets are not included in this digest.",
  };
}
export async function compareSources(root, other) {
  const [a, b] = await Promise.all([
    sourceManifest(root),
    sourceManifest(other),
  ]);
  const differences = [
    ...new Set([...Object.keys(a.files), ...Object.keys(b.files)]),
  ]
    .sort()
    .filter((file) => a.files[file] !== b.files[file]);
  return {
    match: differences.length === 0,
    sourceDigest: a.sourceDigest,
    otherDigest: b.sourceDigest,
    differences,
  };
}
export function releaseCommit(
  root,
  declared = process.env.RAILWAY_GIT_COMMIT_SHA,
) {
  const normalized = declared?.trim();
  const supplied = normalized?.length ? normalized : null;
  if (supplied && !/^[a-f0-9]{40}$/.test(supplied))
    throw new Error("Invalid deployment commit");
  let commit = null;
  let checkout = false;
  try {
    checkout =
      realpathSync(
        execFileSync("git", ["rev-parse", "--show-toplevel"], {
          cwd: root,
          stdio: ["ignore", "pipe", "ignore"],
        })
          .toString()
          .trim(),
      ) === realpathSync(root);
    if (
      checkout &&
      !execFileSync(
        "git",
        ["status", "--porcelain", "--untracked-files=normal"],
        { cwd: root },
      )
        .toString()
        .trim()
    )
      commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root })
        .toString()
        .trim();
  } catch {
    /* Docker source contexts omit Git metadata. */
  }
  if (checkout && supplied && supplied !== commit)
    throw new Error("Deployment commit does not match the clean checkout");
  return commit ?? (checkout ? null : supplied);
}
export async function writeRelease(root) {
  const source = await sourceManifest(root);
  const sourceCommit = releaseCommit(root);
  const runtimeFiles = Object.fromEntries(
    Object.entries(source.files).filter(
      ([file]) =>
        /^(src|packages|resources)\//.test(file) ||
        [
          "package.json",
          "package-lock.json",
          "tsconfig.json",
          "tsconfig.base.json",
        ].includes(file),
    ),
  );
  const builtFiles = {};
  async function assets(dir) {
    for (const name of (await readdir(path.join(root, dir))).sort()) {
      if (name === "release-manifest.json") continue;
      const rel = `${dir}/${name}`;
      const s = await lstat(path.join(root, rel));
      if (s.isDirectory()) await assets(rel);
      else if (s.isFile())
        builtFiles[rel] = sha(await readFile(path.join(root, rel)));
      else throw new Error(`Unexpected build artifact: ${rel}`);
    }
  }
  await assets("dist-demo");
  const manifest = {
    ...source,
    sourceCommit,
    runtimeFiles,
    builtFiles,
    builtDigest: sha(JSON.stringify(builtFiles)),
  };
  await writeFile(
    path.join(root, "dist-demo/release-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  return manifest;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = process.cwd();
  if (process.argv[2] === "compare" && process.argv[3]) {
    const result = await compareSources(root, path.resolve(process.argv[3]));
    console.log(JSON.stringify(result, null, 2));
    if (!result.match) process.exitCode = 1;
  } else if (process.argv[2] === "build") {
    const result = await writeRelease(root);
    console.log(
      `Release source ${result.sourceDigest}; assets ${result.builtDigest}`,
    );
  } else {
    console.log(JSON.stringify(await sourceManifest(root), null, 2));
  }
}
