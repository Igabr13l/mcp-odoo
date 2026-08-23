import assert from "node:assert/strict";
import test from "node:test";
import {
  createGitLabStatusTools,
  inspectGitLabBranch,
  inspectGitLabMergeRequest,
  normalizeMergeRequestLink,
  remoteFromLink,
} from "../src/tools/gitlab-status.js";

const LINK = "https://gitlab.solunika.com/group/project/-/tree/feature";

function row(overrides = {}) {
  return {
    id: 7,
    gitlab_branch_name: "feature",
    target_branch: "uat",
    gitlab_link: LINK,
    merge_request_link: null,
    ...overrides,
  };
}

function fakeGit({
  refs,
  divergence = "0\t1\n",
  mergeBaseSha = "merge-base-commit\n",
  treeShas = "merge-base-tree\ntarget-tree\nbranch-tree\n",
  failOn,
} = {}) {
  const calls = [];
  const git = async (args) => {
    calls.push(args);
    if (failOn && args.includes(failOn)) throw new Error("git failed");
    if (args[0] === "ls-remote") return { stdout: refs || "" };
    if (args.includes("rev-list")) return { stdout: divergence };
    if (args.includes("merge-base")) return { stdout: mergeBaseSha };
    if (args.includes("rev-parse")) return { stdout: treeShas };
    return { stdout: "" };
  };
  return { git, calls };
}

test("remoteFromLink accepts configured GitLab hosts", () => {
  assert.equal(
    remoteFromLink("https://gitlab.solunika.com/group/project/-/tree/main"),
    "git@gitlab.solunika.com:group/project.git",
  );
});

test("remoteFromLink rejects untrusted hosts", () => {
  assert.throws(
    () => remoteFromLink("https://evil.example/group/project/-/tree/main"),
    /is not allowed/,
  );
});

test("normalizeMergeRequestLink safely handles malformed Odoo values", () => {
  assert.equal(normalizeMergeRequestLink(false), null);
  assert.equal(normalizeMergeRequestLink(true), null);
  assert.equal(normalizeMergeRequestLink(""), null);
  assert.equal(normalizeMergeRequestLink("   "), null);
  assert.equal(normalizeMergeRequestLink(" malformed "), "malformed");
});

test("inspectGitLabBranch classifies active and empty branches from divergence", async () => {
  const refs = [
    "aaaaaaaa\trefs/heads/feature",
    "bbbbbbbb\trefs/heads/uat",
  ].join("\n");
  const activeGit = fakeGit({ refs, divergence: "2\t3\n" });
  const removed = [];
  const active = await inspectGitLabBranch(row(), {
    git: activeGit.git,
    makeTempDir: async () => "/tmp/status-active",
    removeTempDir: async (path) => removed.push(path),
  });
  assert.deepEqual(
    {
      status: active.status,
      branch_sha: active.branch_sha,
      target_sha: active.target_sha,
      merge_base_sha: active.merge_base_sha,
      branch_tree_sha: active.branch_tree_sha,
      target_tree_sha: active.target_tree_sha,
      merge_base_tree_sha: active.merge_base_tree_sha,
      tree_has_changes: active.tree_has_changes,
      ahead: active.ahead,
      behind: active.behind,
      branch_has_changes: active.branch_has_changes,
      branch_empty: active.branch_empty,
    },
    {
      status: "branch_active",
      branch_sha: "aaaaaaaa",
      target_sha: "bbbbbbbb",
      merge_base_sha: "merge-base-commit",
      branch_tree_sha: "branch-tree",
      target_tree_sha: "target-tree",
      merge_base_tree_sha: "merge-base-tree",
      tree_has_changes: true,
      ahead: 3,
      behind: 2,
      branch_has_changes: true,
      branch_empty: false,
    },
  );
  assert.ok(activeGit.calls.some((args) => args.includes("--no-tags")));
  assert.ok(activeGit.calls.some((args) => args.includes("--filter=blob:none")));
  assert.ok(activeGit.calls.some((args) => args.includes("rev-parse")));
  assert.deepEqual(removed, ["/tmp/status-active"]);

  const emptyGit = fakeGit({ refs, divergence: "1\t0\n" });
  const empty = await inspectGitLabBranch(row(), {
    git: emptyGit.git,
    makeTempDir: async () => "/tmp/status-empty",
    removeTempDir: async () => {},
  });
  assert.equal(empty.status, "branch_empty");
  assert.equal(empty.branch_empty, true);
  assert.equal(empty.branch_has_changes, false);
  assert.equal(empty.tree_has_changes, true);
});

test("inspectGitLabBranch treats a branch matching merge base as empty when target differs", async () => {
  const refs = [
    "aaaaaaaa\trefs/heads/feature",
    "bbbbbbbb\trefs/heads/uat",
  ].join("\n");
  const identicalTreeGit = fakeGit({
    refs,
    divergence: "0\t2\n",
    treeShas: "same-tree\ntarget-tree\nsame-tree\n",
  });
  const result = await inspectGitLabBranch(row(), {
    git: identicalTreeGit.git,
    makeTempDir: async () => "/tmp/status-identical-tree",
    removeTempDir: async () => {},
  });

  assert.equal(result.ahead, 2);
  assert.equal(result.merge_base_tree_sha, "same-tree");
  assert.equal(result.target_tree_sha, "target-tree");
  assert.equal(result.branch_tree_sha, "same-tree");
  assert.equal(result.tree_has_changes, false);
  assert.equal(result.branch_has_changes, false);
  assert.equal(result.branch_empty, true);
  assert.equal(result.status, "branch_empty");
});

test("inspectGitLabBranch preserves missing branch and deleted-with-MR classifications", async () => {
  const missing = await inspectGitLabBranch(row({ merge_request_link: true }), {
    git: fakeGit({ refs: "bbbbbbbb\trefs/heads/uat\n" }).git,
  });
  assert.equal(missing.status, "remote_missing");
  assert.equal(missing.mr_iid, null);

  const deleted = await inspectGitLabBranch(
    row({
      merge_request_link:
        "https://gitlab.solunika.com/group/project/-/merge_requests/42",
    }),
    {
      git: fakeGit({
        refs: [
          "bbbbbbbb\trefs/heads/uat",
          "cccccccc\trefs/merge-requests/42/head",
        ].join("\n"),
      }).git,
    },
  );
  assert.equal(deleted.status, "branch_deleted_mr_exists");
  assert.equal(deleted.mr_iid, 42);
  assert.equal(deleted.mr_ref_exists, true);
});

test("inspectGitLabBranch cleans the temporary repository after Git failure", async () => {
  const refs = [
    "aaaaaaaa\trefs/heads/feature",
    "bbbbbbbb\trefs/heads/uat",
  ].join("\n");
  const failing = fakeGit({ refs, failOn: "rev-list" });
  let removed = false;
  await assert.rejects(
    () =>
      inspectGitLabBranch(row(), {
        git: failing.git,
        makeTempDir: async () => "/tmp/status-failure",
        removeTempDir: async () => {
          removed = true;
        },
      }),
    /git failed/,
  );
  assert.equal(removed, true);
});

test("inspectGitLabMergeRequest reports missing configuration without fetching", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error("network must not be used");
  };
  assert.deepEqual(
    await inspectGitLabMergeRequest(null, { fetchImpl, env: {} }),
    { api_status: "no_merge_request" },
  );
  assert.deepEqual(
    await inspectGitLabMergeRequest(
      "https://gitlab.solunika.com/group/project/-/merge_requests/42",
      { fetchImpl, env: {} },
    ),
    { api_status: "not_configured" },
  );
  assert.equal(calls, 0);
});

test("inspectGitLabMergeRequest returns MR, pipeline, and approval details", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/approvals")) {
      return {
        ok: true,
        json: async () => ({
          approved: false,
          approvals_left: 1,
          approved_by: [{ user: { name: "Ada Lovelace" } }],
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        iid: 42,
        state: "opened",
        draft: true,
        merge_status: "can_be_merged",
        detailed_merge_status: "not_approved",
        has_conflicts: false,
        blocking_discussions_resolved: true,
        pipeline: { status: "success", web_url: "https://gitlab/p/1" },
        head_pipeline: { status: "running", web_url: "https://gitlab/p/2" },
      }),
    };
  };
  const result = await inspectGitLabMergeRequest(
    "https://gitlab.solunika.com/group/project/-/merge_requests/42",
    {
      fetchImpl,
      env: {
        ODOO_GITLAB_TOKEN: "secret-token",
        ODOO_GITLAB_API_TIMEOUT_MS: "2000",
      },
    },
  );

  assert.deepEqual(result, {
    api_status: "available",
    iid: 42,
    state: "opened",
    draft: true,
    merge_status: "can_be_merged",
    detailed_merge_status: "not_approved",
    has_conflicts: false,
    blocking_discussions_resolved: true,
    pipeline: { status: "success", url: "https://gitlab/p/1" },
    head_pipeline: { status: "running", url: "https://gitlab/p/2" },
    approvals: {
      api_status: "available",
      approved: false,
      approvals_left: 1,
      approver_names: ["Ada Lovelace"],
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(
    calls[0].url,
    "https://gitlab.solunika.com/api/v4/projects/group%2Fproject/merge_requests/42",
  );
  assert.equal(calls[0].options.headers["PRIVATE-TOKEN"], "secret-token");
  assert.equal(calls[0].options.redirect, "manual");
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.doesNotMatch(JSON.stringify(result), /secret-token/);
});

test("inspectGitLabMergeRequest does not follow cross-origin redirects", async () => {
  const token = "redirect-secret-token";
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: false,
      status: 302,
      headers: new Headers({
        location: `https://evil.example/collect?token=${token}`,
      }),
    };
  };
  const result = await inspectGitLabMergeRequest(
    "https://gitlab.solunika.com/group/project/-/merge_requests/42",
    { fetchImpl, env: { ODOO_GITLAB_TOKEN: token } },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.redirect, "manual");
  assert.deepEqual(result, {
    api_status: "unavailable",
    reason: "redirect_not_allowed",
  });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(token));
});

test("inspectGitLabMergeRequest preserves MR data when approvals are unavailable", async () => {
  const fetchImpl = async (url) =>
    url.endsWith("/approvals")
      ? { ok: false, status: 403 }
      : {
          ok: true,
          json: async () => ({ iid: 42, state: "opened" }),
        };
  const result = await inspectGitLabMergeRequest(
    "https://gitlab.solunika.com/group/project/-/merge_requests/42",
    { fetchImpl, env: { ODOO_GITLAB_TOKEN: "token" } },
  );
  assert.equal(result.api_status, "available");
  assert.equal(result.state, "opened");
  assert.deepEqual(result.approvals, {
    api_status: "unavailable",
    http_status: 403,
  });
});

test("inspectGitLabMergeRequest enforces allowed hosts before fetching", async () => {
  let called = false;
  const result = await inspectGitLabMergeRequest(
    "https://evil.example/group/project/-/merge_requests/42",
    {
      fetchImpl: async () => {
        called = true;
      },
      env: { ODOO_GITLAB_TOKEN: "token" },
    },
  );
  assert.deepEqual(result, {
    api_status: "unavailable",
    reason: "host_not_allowed",
  });
  assert.equal(called, false);
});

test("status tool returns structured classifications and verification errors", async () => {
  const rows = [row(), row({ id: 8, gitlab_branch_name: "broken" })];
  const executeKw = async (model) =>
    model === "project.task"
      ? [{ id: 1, name: "Task", gitlab_branch_ids: [7, 8] }]
      : rows;
  const { handlers } = createGitLabStatusTools({
    executeKw,
    env: {},
    inspectBranch: async (branch) => {
      if (branch.id === 8) throw new Error("unavailable");
      return {
        status: "branch_empty",
        ahead: 0,
        behind: 1,
        branch_empty: true,
      };
    },
  });
  const result = await handlers.odoo_get_gitlab_status({ task_id: 1 });
  assert.equal(result.structuredContent.branches[0].status, "branch_empty");
  assert.deepEqual(result.structuredContent.branches[0].merge_request, {
    api_status: "no_merge_request",
  });
  assert.equal(result.structuredContent.branches[1].status, "verification_error");
  assert.match(result.content[0].text, /ahead: 0, behind: 1/);
});

test("status tool integrates MR inspection independently from branch verification", async () => {
  const executeKw = async (model) =>
    model === "project.task"
      ? [{ id: 1, gitlab_branch_ids: [7] }]
      : [
          row({
            merge_request_link:
              "https://gitlab.solunika.com/group/project/-/merge_requests/42",
          }),
        ];
  const { handlers } = createGitLabStatusTools({
    executeKw,
    inspectBranch: async () => {
      throw new Error("git unavailable");
    },
    inspectMergeRequest: async () => ({
      api_status: "available",
      state: "opened",
    }),
  });
  const result = await handlers.odoo_get_gitlab_status({ task_id: 1 });
  const branch = result.structuredContent.branches[0];
  assert.equal(branch.status, "verification_error");
  assert.deepEqual(branch.merge_request, {
    api_status: "available",
    state: "opened",
  });
});

test("status tool returns an empty structured branch list", async () => {
  const { handlers } = createGitLabStatusTools({
    executeKw: async () => [{ id: 1, gitlab_branch_ids: [] }],
  });
  const result = await handlers.odoo_get_gitlab_status({ task_id: 1 });
  assert.deepEqual(result.structuredContent, { task_id: 1, branches: [] });
});
