import { execFileSync } from "node:child_process";

// Complete served source and build files. Exclude upstream proprietary artwork,
// dependencies, development credentials and Git metadata from the public archive.
execFileSync("tar", [
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
  "--exclude=*.log",
  "--exclude=.vercel",
  "--exclude=.private-research",
  ".",
]);
console.log("Demo source archive ready.");
