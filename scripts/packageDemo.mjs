import { execFileSync } from "node:child_process";
import { sourceManifest, writeRelease } from "./release-manifest.mjs";

// Complete served source and build files. Exclude upstream proprietary artwork,
// dependencies, development credentials and Git metadata from the public archive.
const manifest = await sourceManifest(process.cwd());
execFileSync(
  "tar",
  [
    "-czf",
    "dist-demo/frontpot-source.tar.gz",
    "--exclude=.git",
    "--exclude=.frontpot-state",
    "--exclude=*.sqlite",
    "--exclude=*.sqlite-*",
    "--exclude=*.ssbackup",
    "--exclude=*.ssbackup.partial",
    "--exclude=RESTORE_REQUIRES_RECONCILIATION",
    "--exclude=node_modules",
    "--exclude=dist-demo",
    "--exclude=proprietary",
    "--exclude=.env",
    "--exclude=.env.*",
    "--exclude=.DS_Store",
    "--exclude=._*",
    "--exclude=*.log",
    "--exclude=.vercel",
    "--exclude=.private-research",
    "--null",
    "-T",
    "-",
  ],
  {
    input: Object.keys(manifest.files).join("\0") + "\0",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  },
);
// Include the exact served source archive in the built-asset digest too.
await writeRelease(process.cwd());
console.log("Demo source archive ready.");
