import { appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repository = "sol-of-war-dev/Sol-of-War";
export const site = "https://solofwar.fun";
const api = `https://api.github.com/repos/${repository}`;
const task = "verify:live";

export function validateRelease(release, health) {
  if (
    health?.ok !== true ||
    release?.available !== true ||
    release.sourceRepository !== `https://github.com/${repository}` ||
    !/^[a-f0-9]{40}$/.test(release.sourceCommit ?? "") ||
    !/^[a-f0-9]{64}$/.test(release.sourceDigest ?? "") ||
    !/^[a-f0-9]{64}$/.test(release.builtDigest ?? "")
  )
    throw new Error(
      "The live service did not report a healthy, identified release.",
    );
  return {
    sourceCommit: release.sourceCommit,
    sourceDigest: release.sourceDigest,
    builtDigest: release.builtDigest,
  };
}

const same = (a, b) =>
  a?.sourceCommit === b?.sourceCommit &&
  a?.sourceDigest === b?.sourceDigest &&
  a?.builtDigest === b?.builtDigest;

/** Record observed releases. This never calls Railway or deploys application code. */
export async function reportProduction({ request, logUrl, write = false }) {
  const snapshot = async () => {
    const [release, health] = await Promise.all([
      request("GET", `${site}/frontpot/api/release`),
      request("GET", `${site}/healthz`),
    ]);
    return validateRelease(release, health);
  };
  const release = await snapshot();
  const deployments = await request(
    "GET",
    `${api}/deployments?environment=Production&per_page=100`,
  );
  const owned = deployments.filter(
    (d) =>
      d.task === task && d.payload?.reporter === "sol-of-war-live-release-v1",
  );
  let deployment = owned[0];
  const matching =
    deployment?.sha === release.sourceCommit &&
    same(deployment?.payload, release);
  let status = matching
    ? (
        await request(
          "GET",
          `${api}/deployments/${deployment.id}/statuses?per_page=1`,
        )
      )[0]
    : null;
  if (!matching || status?.state !== "success") {
    const runs = await request(
      "GET",
      `${api}/actions/workflows/verify.yml/runs?head_sha=${release.sourceCommit}&event=push&branch=main&status=success&per_page=100`,
    );
    const verified = runs.workflow_runs?.some(
      (run) =>
        run.head_sha === release.sourceCommit &&
        run.head_branch === "main" &&
        run.event === "push" &&
        run.conclusion === "success",
    );
    if (!verified)
      throw new Error(
        "The live commit has no successful main-branch verification run.",
      );
    if (!same(release, await snapshot()))
      throw new Error(
        "The live release changed during verification; retry later.",
      );
    if (!write) return { action: "would-record", ...release };
    if (!matching) {
      deployment = await request("POST", `${api}/deployments`, {
        ref: release.sourceCommit,
        task,
        auto_merge: false,
        // The exact live SHA's Actions verification was checked above.
        required_contexts: [],
        environment: "Production",
        production_environment: true,
        transient_environment: false,
        description: "Verified running release on solofwar.fun",
        payload: { reporter: "sol-of-war-live-release-v1", ...release },
      });
      if (
        !Number.isSafeInteger(deployment.id) ||
        deployment.sha !== release.sourceCommit
      )
        throw new Error(
          "GitHub did not create a record for the verified live commit.",
        );
    }
    // Re-check after record creation to detect a rollout between observations.
    if (!same(release, await snapshot()))
      throw new Error(
        "The live release changed before success could be recorded.",
      );
    await request("POST", `${api}/deployments/${deployment.id}/statuses`, {
      state: "success",
      environment: "Production",
      environment_url: site,
      log_url: logUrl,
      auto_inactive: false,
      description:
        "Live health and release identity verified; main-branch CI passed.",
    });
    status = { state: "success" };
  }
  if (write && status?.state === "success") {
    // GitHub does not auto-inactivate production environments. Recover interrupted
    // cleanup on the next run, touching only records created by this reporter.
    for (const old of owned.filter((d) => d.id !== deployment.id)) {
      const previous = (
        await request("GET", `${api}/deployments/${old.id}/statuses?per_page=1`)
      )[0];
      if (previous?.state === "inactive") break;
      await request("POST", `${api}/deployments/${old.id}/statuses`, {
        state: "inactive",
        environment: "Production",
        auto_inactive: false,
        description: "Superseded by a newer verified live release.",
      });
    }
  }
  return {
    action: matching ? "already-recorded" : "recorded",
    deploymentId: deployment.id,
    ...release,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const write = process.argv.includes("--write");
  if (
    write &&
    (!process.env.GH_TOKEN ||
      process.env.GITHUB_REPOSITORY !== repository ||
      process.env.GITHUB_REF !== "refs/heads/main")
  )
    throw new Error(
      "Recording requires the scoped GitHub Actions token on this repository's main branch.",
    );
  const request = async (method, url, body) => {
    const github = url.startsWith(`${api}/`);
    if (
      !github &&
      !(
        method === "GET" &&
        ["/healthz", "/frontpot/api/release"].some((p) => url === site + p)
      )
    )
      throw new Error(
        "Request is outside the deployment reporter's fixed destinations.",
      );
    const response = await fetch(url, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(20000),
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache",
        ...(github ? { "X-GitHub-Api-Version": "2026-03-10" } : {}),
        ...(github && process.env.GH_TOKEN
          ? { Authorization: `Bearer ${process.env.GH_TOKEN}` }
          : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok)
      throw new Error(
        `${method} ${new URL(url).pathname}: HTTP ${response.status}`,
      );
    return response.json();
  };
  const logUrl = `https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const result = await reportProduction({ request, logUrl, write });
  console.log(JSON.stringify(result, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `Production: ${result.action}\n\nLive site: ${site}\n\nObserved commit: ${result.sourceCommit}\n\nSource digest: ${result.sourceDigest}\n\nBuilt digest: ${result.builtDigest}\n\nThis records the observed running release. It does not restart Railway, move funds, or independently attest the hosting operator.\n`,
    );
}
