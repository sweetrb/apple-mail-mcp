import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { verifyPublishCI } from "./verify-publish-ci.mjs";

const workflow = readFileSync(new URL("../workflows/publish.yml", import.meta.url), "utf8");

test("every publication route checks successful full CI for the pinned commit", () => {
  const start = workflow.indexOf("      - name: Verify full CI for the pinned commit");
  assert.ok(start >= 0, "manual, scheduled and release events need the same CI evidence");
  const end = workflow.indexOf("      - name:", start + 1);
  const step = workflow.slice(start, end);
  assert.doesNotMatch(step, /\n\s+if:/, "CI validation must apply to every admitted event");
  assert.match(step, /node \.github\/scripts\/verify-publish-ci\.mjs/);
  assert.ok(start < workflow.indexOf("      - name: Publish to npm"));
});

test("the exact plugin archive is validated before npm publication", () => {
  const validation = workflow.indexOf(
    "      - name: Verify and package the standalone Codex plugin"
  );
  const publication = workflow.indexOf("      - name: Publish to npm");
  assert.ok(validation >= 0 && publication >= 0 && validation < publication);
});

const sha = "a".repeat(40);
const repository = "example/mail";
const valid = {
  id: 12,
  head_sha: sha,
  status: "completed",
  conclusion: "success",
  head_branch: "main",
  head_repository: { full_name: repository },
  event: "push",
};
const verify = (
  runs,
  fetchImpl = async () => ({ ok: true, json: async () => ({ workflow_runs: runs }) })
) => verifyPublishCI({ repository, sha, token: "fixture-token", fetchImpl });

test("accepts successful push and manual CI on the exact main revision", async () => {
  for (const event of ["push", "workflow_dispatch"])
    assert.equal(await verify([{ ...valid, event }]), 12);
});

for (const [name, change] of [
  ["another revision", { head_sha: "b".repeat(40) }],
  ["unfinished CI", { status: "in_progress" }],
  ["failed CI", { conclusion: "failure" }],
  ["another branch", { head_branch: "candidate" }],
  ["a fork", { head_repository: { full_name: "someone/mail" } }],
  ["pull-request-only evidence", { event: "pull_request" }],
]) {
  test(`rejects ${name}`, async () => {
    await assert.rejects(verify([{ ...valid, ...change }]), /No successful full CI/);
  });
}

test("missing evidence and API errors fail closed", async () => {
  await assert.rejects(verify([]), /No successful full CI/);
  await assert.rejects(
    verify([], async () => ({ ok: false, status: 403 })),
    /HTTP 403/
  );
  await assert.rejects(
    verify([], async () => ({ ok: true, json: async () => ({}) })),
    /malformed/
  );
});

test("queries the named CI workflow with exact SHA and follows bounded pagination", async () => {
  const requests = [];
  const id = await verify([], async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      json: async () => ({
        workflow_runs:
          requests.length === 1
            ? Array.from({ length: 100 }, () => ({ ...valid, event: "pull_request" }))
            : [valid],
      }),
    };
  });
  assert.equal(id, 12);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url.pathname, "/repos/example/mail/actions/workflows/ci.yml/runs");
  assert.equal(requests[0].url.searchParams.get("head_sha"), sha);
  assert.equal(requests[1].url.searchParams.get("page"), "2");
  assert.equal(requests[0].options.headers.Authorization, "Bearer fixture-token");
});
