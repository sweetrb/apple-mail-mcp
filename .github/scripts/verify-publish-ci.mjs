import { pathToFileURL } from "node:url";

/** Require the complete CI workflow for the exact main-branch revision. */
export async function verifyPublishCI({ repository, sha, token, fetchImpl = fetch }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) {
    throw new Error("A valid GITHUB_REPOSITORY is required.");
  }
  if (!/^[a-f0-9]{40}$/i.test(sha ?? ""))
    throw new Error("A full candidate commit SHA is required.");
  if (!token) throw new Error("A read-only GitHub Actions token is required to verify CI.");
  for (let page = 1; page <= 10; page++) {
    const url = new URL(`https://api.github.com/repos/${repository}/actions/workflows/ci.yml/runs`);
    url.search = new URLSearchParams({
      head_sha: sha,
      status: "success",
      per_page: "100",
      page: String(page),
    });
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new Error(`Cannot verify full CI: GitHub returned HTTP ${response.status}.`);
    const data = await response.json();
    if (!Array.isArray(data.workflow_runs))
      throw new Error("Cannot verify full CI: malformed workflow response.");
    const approved = data.workflow_runs.find(
      (run) =>
        run.head_sha === sha &&
        run.status === "completed" &&
        run.conclusion === "success" &&
        run.head_branch === "main" &&
        run.head_repository?.full_name === repository &&
        (run.event === "push" || run.event === "workflow_dispatch")
    );
    if (approved) return approved.id;
    if (data.workflow_runs.length < 100) break;
  }
  throw new Error(
    `No successful full CI run on main validates ${sha}. Publish is blocked until CI passes for this exact revision.`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const run = await verifyPublishCI({
      repository: process.env.GITHUB_REPOSITORY,
      sha: process.env.CANDIDATE_SHA,
      token: process.env.GH_TOKEN,
    });
    console.log(`Full CI run ${run} validated the pinned publication revision.`);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
