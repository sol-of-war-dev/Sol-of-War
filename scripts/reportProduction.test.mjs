import assert from "node:assert/strict";
import test from "node:test";
import { reportProduction, repository, site } from "./reportProduction.mjs";

const release = {
  available: true,
  sourceRepository: `https://github.com/${repository}`,
  sourceCommit: "a".repeat(40),
  sourceDigest: "b".repeat(64),
  builtDigest: "c".repeat(64),
};
function fixture(options = {}) {
  const writes = [];
  let reads = 0;
  const request = async (method, url, body) => {
    if (method === "POST") {
      writes.push({ url, body });
      return url.endsWith("/deployments")
        ? { id: 99, sha: release.sourceCommit }
        : {};
    }
    if (url === `${site}/frontpot/api/release`) {
      reads++;
      return {
        ...release,
        ...options.release,
        ...(options.changeAt && reads >= options.changeAt
          ? { sourceCommit: "d".repeat(40) }
          : {}),
      };
    }
    if (url === `${site}/healthz`) return { ok: !options.unhealthy };
    if (url.includes("/actions/workflows/"))
      return {
        workflow_runs: options.noCI
          ? []
          : [
              {
                head_sha: release.sourceCommit,
                head_branch: "main",
                event: "push",
                conclusion: "success",
                ...options.ci,
              },
            ],
      };
    if (url.includes("/statuses"))
      return options.statuses?.[url.match(/deployments\/(\d+)/)[1]] ?? [];
    if (url.includes("/deployments?")) return options.deployments ?? [];
    throw new Error(`Unexpected test request ${url}`);
  };
  return {
    writes,
    run: (write = true) =>
      reportProduction({
        request,
        write,
        logUrl: "https://github.com/test/run",
      }),
  };
}
test("records the live SHA and canonical URL, with auto-merge disabled", async () => {
  const f = fixture();
  await f.run();
  assert.equal(f.writes[0].body.ref, release.sourceCommit);
  assert.equal(f.writes[0].body.auto_merge, false);
  assert.equal(f.writes[0].body.environment, "Production");
  assert.equal(f.writes[1].body.environment_url, site);
  assert.equal(f.writes[1].body.state, "success");
});
test("read-only check creates no deployment record", async () => {
  const f = fixture();
  assert.equal((await f.run(false)).action, "would-record");
  assert.equal(f.writes.length, 0);
});
for (const [name, options] of Object.entries({
  "unhealthy site": { unhealthy: true },
  "unknown repository": {
    release: { sourceRepository: "https://github.com/other/repo" },
  },
  "missing commit": { release: { sourceCommit: null } },
  "missing digest": { release: { builtDigest: null } },
  "unverified commit": { noCI: true },
  "different CI commit": { ci: { head_sha: "d".repeat(40) } },
  "pull-request CI": { ci: { event: "pull_request" } },
  "feature-branch CI": { ci: { head_branch: "codex/test" } },
  "rollout during verification": { changeAt: 2 },
}))
  test(`does not publish for ${name}`, async () => {
    const f = fixture(options);
    await assert.rejects(f.run());
    assert.equal(f.writes.length, 0);
  });
test("a rollout after record creation never gets a success status", async () => {
  const f = fixture({ changeAt: 3 });
  await assert.rejects(f.run());
  assert.equal(f.writes.length, 1);
  assert.ok(f.writes[0].url.endsWith("/deployments"));
});
const recorded = {
  id: 99,
  sha: release.sourceCommit,
  task: "verify:live",
  payload: { reporter: "sol-of-war-live-release-v1", ...release },
};
test("unchanged successful release does not generate duplicate history", async () => {
  const f = fixture({
    deployments: [recorded],
    statuses: { 99: [{ state: "success" }] },
  });
  assert.equal((await f.run()).action, "already-recorded");
  assert.equal(f.writes.length, 0);
});
test("an interrupted status write reuses the existing deployment", async () => {
  const f = fixture({ deployments: [recorded] });
  await f.run();
  assert.equal(f.writes.length, 1);
  assert.ok(f.writes[0].url.endsWith("/99/statuses"));
});
test("a rollback gets a new record and only reporter-owned predecessors become inactive", async () => {
  const old = { ...recorded, id: 90, sha: "d".repeat(40) };
  const unrelated = { ...old, id: 89, task: "deploy" };
  const f = fixture({
    deployments: [old, unrelated],
    statuses: { 90: [{ state: "success" }] },
  });
  await f.run();
  assert.equal(f.writes.length, 3);
  assert.equal(f.writes[2].body.state, "inactive");
  assert.ok(f.writes[2].url.endsWith("/90/statuses"));
});
