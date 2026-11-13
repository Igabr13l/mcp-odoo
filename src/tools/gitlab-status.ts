import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  ExecuteKwImplementation,
  OdooArguments,
  OdooKeywordArguments,
  OdooRecord,
} from "../contracts.js";
import {
  defineToolGroup,
  errorMessage,
  executeKw as execute,
  isRecord,
} from "../contracts.js";
import type { FetchImplementation, FetchResponse } from "../odoo/client.js";
import { formatList } from "../utils/format.js";
import { positiveInt } from "../utils/args.js";

const execFileAsync = promisify(execFile);
const DEFAULT_GIT_TIMEOUT_MS = 15000;
const DEFAULT_GITLAB_API_TIMEOUT_MS = 15000;
const MIN_GITLAB_API_TIMEOUT_MS = 1000;
const MAX_GITLAB_API_TIMEOUT_MS = 120000;

type Environment = Record<string, string | undefined>;

export interface GitLabBranchRow extends OdooRecord {
  gitlab_branch_name?: string | false | null;
  target_branch?: string | false | null;
  gitlab_link?: string | false | null;
  merge_request_link?: string | boolean | null;
}

export interface BranchInspection {
  status: string;
  branch_exists?: boolean;
  branch_sha?: string | null;
  target_sha?: string | null;
  merge_base_sha?: string;
  branch_tree_sha?: string;
  target_tree_sha?: string;
  merge_base_tree_sha?: string;
  tree_has_changes?: boolean;
  ahead?: number;
  behind?: number;
  branch_has_changes?: boolean;
  branch_empty?: boolean;
  mr_iid?: number | null;
  mr_ref_exists?: boolean;
  error?: string;
}

export interface MergeRequestInspection {
  api_status: string;
  reason?: string;
  http_status?: number;
  iid?: number;
  state?: string | null;
  draft?: boolean;
  merge_status?: string | null;
  detailed_merge_status?: string | null;
  has_conflicts?: boolean;
  blocking_discussions_resolved?: unknown;
  pipeline?: { status: string | null; url: string | null } | null;
  head_pipeline?: { status: string | null; url: string | null } | null;
  approvals?: Record<string, unknown>;
}

export type GitRunner = (args: string[]) => Promise<{ stdout: string }>;
export type InspectBranch = (row: GitLabBranchRow) => Promise<BranchInspection>;
export type InspectMergeRequest = (
  link: unknown,
  options?: { fetchImpl?: FetchImplementation; env?: Environment },
) => Promise<MergeRequestInspection>;

function allowedGitLabHosts(env: Environment = process.env): string[] {
  return (env.ODOO_GITLAB_ALLOWED_HOSTS || "gitlab.solunika.com")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

function gitTimeoutMs() {
  const configured = Number(process.env.ODOO_GIT_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_GIT_TIMEOUT_MS;
}

async function runGit(args: string[]): Promise<{ stdout: string }> {
  return execFileAsync("git", args, {
    timeout: gitTimeoutMs(),
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o LogLevel=ERROR",
    },
    encoding: "utf8",
  });
}

export function normalizeMergeRequestLink(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function remoteFromLink(link: string): string {
  const url = new URL(link);
  if (!allowedGitLabHosts().includes(url.hostname.toLowerCase())) {
    throw new Error(`GitLab host '${url.hostname}' is not allowed`);
  }
  const projectPath = url.pathname.split("/-/")[0].replace(/^\//, "");
  if (!projectPath) throw new Error("Invalid GitLab project link");
  return `git@${url.hostname}:${projectPath}.git`;
}

function gitLabApiTimeoutMs(env: Environment): number {
  const configured = Number(env.ODOO_GITLAB_API_TIMEOUT_MS);
  if (!Number.isFinite(configured)) return DEFAULT_GITLAB_API_TIMEOUT_MS;
  return Math.min(
    MAX_GITLAB_API_TIMEOUT_MS,
    Math.max(MIN_GITLAB_API_TIMEOUT_MS, configured),
  );
}

function mergeRequestApiDetails(link: string, env: Environment) {
  const url = new URL(link);
  if (url.protocol !== "https:") throw new Error("invalid_protocol");
  if (!allowedGitLabHosts(env).includes(url.hostname.toLowerCase())) {
    throw new Error("host_not_allowed");
  }
  const match = url.pathname.match(/^\/(.+)\/-\/merge_requests\/(\d+)\/?$/);
  if (!match) throw new Error("invalid_merge_request_link");
  const projectPath = decodeURIComponent(match[1]);
  const iid = Number(match[2]);
  const base = `${url.origin}/api/v4/projects/${encodeURIComponent(projectPath)}/merge_requests/${iid}`;
  return { base, iid };
}

function pipelineDetails(
  pipeline: unknown,
): { status: string | null; url: string | null } | null {
  if (!isRecord(pipeline)) return null;
  return {
    status: typeof pipeline.status === "string" ? pipeline.status : null,
    url: typeof pipeline.web_url === "string" ? pipeline.web_url : null,
  };
}

type GitLabFetchResult =
  | { ok: true; data: unknown }
  | { ok: false; redirected?: boolean; status?: number };

async function fetchGitLabJson(
  url: string,
  {
    fetchImpl,
    token,
    timeoutMs,
  }: { fetchImpl: FetchImplementation; token: string; timeoutMs: number },
): Promise<GitLabFetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { "PRIVATE-TOKEN": token },
      redirect: "manual",
      signal: controller.signal,
    });
    if (
      response.type === "opaqueredirect" ||
      (response.status !== undefined &&
        response.status >= 300 &&
        response.status < 400)
    ) {
      return { ok: false, redirected: true };
    }
    if (!response.ok) return { ok: false, status: response.status };
    if (!response.json) return { ok: false, status: response.status };
    return { ok: true, data: await response.json() };
  } finally {
    clearTimeout(timeout);
  }
}

export async function inspectGitLabMergeRequest(
  link: unknown,
  {
    fetchImpl = globalThis.fetch,
    env = process.env,
  }: { fetchImpl?: FetchImplementation; env?: Environment } = {},
): Promise<MergeRequestInspection> {
  const normalizedLink = normalizeMergeRequestLink(link);
  if (!normalizedLink) return { api_status: "no_merge_request" };
  const token = env.ODOO_GITLAB_TOKEN?.trim();
  if (!token) return { api_status: "not_configured" };

  let details;
  try {
    details = mergeRequestApiDetails(normalizedLink, env);
  } catch (error) {
    return { api_status: "unavailable", reason: errorMessage(error) };
  }

  const options = {
    fetchImpl,
    token,
    timeoutMs: gitLabApiTimeoutMs(env),
  };
  let mergeRequestResponse;
  try {
    mergeRequestResponse = await fetchGitLabJson(details.base, options);
  } catch {
    return { api_status: "unavailable", reason: "request_failed" };
  }
  if (!mergeRequestResponse.ok) {
    return {
      api_status: "unavailable",
      reason: mergeRequestResponse.redirected
        ? "redirect_not_allowed"
        : "request_failed",
      ...(mergeRequestResponse.status
        ? { http_status: mergeRequestResponse.status }
        : {}),
    };
  }

  const mr = isRecord(mergeRequestResponse.data)
    ? mergeRequestResponse.data
    : {};
  const result: MergeRequestInspection = {
    api_status: "available",
    iid: typeof mr.iid === "number" ? mr.iid : details.iid,
    state: typeof mr.state === "string" ? mr.state : null,
    draft: Boolean(mr.draft ?? mr.work_in_progress),
    merge_status: typeof mr.merge_status === "string" ? mr.merge_status : null,
    detailed_merge_status:
      typeof mr.detailed_merge_status === "string"
        ? mr.detailed_merge_status
        : null,
    has_conflicts: Boolean(mr.has_conflicts),
    blocking_discussions_resolved: mr.blocking_discussions_resolved ?? null,
    pipeline: pipelineDetails(mr.pipeline),
    head_pipeline: pipelineDetails(mr.head_pipeline),
  };

  try {
    const approvalsResponse = await fetchGitLabJson(
      `${details.base}/approvals`,
      options,
    );
    if (!approvalsResponse.ok) {
      result.approvals = {
        api_status: "unavailable",
        ...(approvalsResponse.status
          ? { http_status: approvalsResponse.status }
          : {}),
      };
    } else {
      const approvals = isRecord(approvalsResponse.data)
        ? approvalsResponse.data
        : {};
      const approvedBy = Array.isArray(approvals.approved_by)
        ? approvals.approved_by
        : [];
      result.approvals = {
        api_status: "available",
        approved: Boolean(approvals.approved),
        approvals_left: approvals.approvals_left ?? null,
        approver_names: approvedBy
          .map((entry) =>
            isRecord(entry) && isRecord(entry.user) &&
              typeof entry.user.name === "string"
              ? entry.user.name
              : null,
          )
          .filter((name): name is string => Boolean(name)),
      };
    }
  } catch {
    result.approvals = { api_status: "unavailable" };
  }
  return result;
}

function parseRemoteRefs(stdout: string): Map<string, string> {
  return new Map(
    stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(/\s+/))
      .filter((parts) => parts.length >= 2)
      .map(([sha, ref]) => [ref, sha]),
  );
}

export async function inspectGitLabBranch(
  row: GitLabBranchRow,
  {
    git = runGit,
    makeTempDir = () => mkdtemp(join(tmpdir(), "mcp-odoo-git-")),
    removeTempDir = (path: string) =>
      rm(path, { recursive: true, force: true }),
  }: {
    git?: GitRunner;
    makeTempDir?: () => Promise<string>;
    removeTempDir?: (path: string) => Promise<unknown>;
  } = {},
): Promise<BranchInspection> {
  if (!row.gitlab_link) {
    return { branch_exists: false, mr_ref_exists: false, status: "not_created" };
  }

  const remote = remoteFromLink(String(row.gitlab_link));
  const branchRef = `refs/heads/${row.gitlab_branch_name}`;
  const targetRef = `refs/heads/${row.target_branch}`;
  const mergeRequestLink = normalizeMergeRequestLink(row.merge_request_link);
  const mrIid = mergeRequestLink?.match(/\/merge_requests\/(\d+)(?:\/|$)/)?.[1];
  const mrRef = mrIid ? `refs/merge-requests/${mrIid}/head` : null;
  const refs = [
    ...new Set(
      [branchRef, targetRef, mrRef].filter(
        (ref): ref is string => Boolean(ref),
      ),
    ),
  ];
  const { stdout } = await git(["ls-remote", remote, ...refs]);
  const remoteRefs = parseRemoteRefs(stdout);
  const branchSha = remoteRefs.get(branchRef) || null;
  const targetSha = remoteRefs.get(targetRef) || null;
  const mrRefExists = mrRef ? remoteRefs.has(mrRef) : false;

  if (!branchSha) {
    return {
      branch_exists: false,
      branch_sha: null,
      target_sha: targetSha,
      mr_iid: mrIid ? Number(mrIid) : null,
      mr_ref_exists: mrRefExists,
      status: mrRefExists ? "branch_deleted_mr_exists" : "remote_missing",
    };
  }
  if (!targetSha) {
    throw new Error(`Target branch '${row.target_branch}' was not found`);
  }

  const directory = await makeTempDir();
  try {
    await git(["init", "--bare", directory]);
    await git([
      "-C",
      directory,
      "fetch",
      "--quiet",
      "--no-tags",
      "--filter=blob:none",
      remote,
      `+${branchRef}:refs/remotes/origin/branch`,
      `+${targetRef}:refs/remotes/origin/target`,
    ]);
    const divergence = await git([
      "-C",
      directory,
      "rev-list",
      "--left-right",
      "--count",
      "refs/remotes/origin/target...refs/remotes/origin/branch",
    ]);
    const [behind, ahead] = divergence.stdout.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(ahead) || !Number.isInteger(behind)) {
      throw new Error("Git returned an invalid branch divergence result");
    }
    const mergeBase = await git([
      "-C",
      directory,
      "merge-base",
      "refs/remotes/origin/target",
      "refs/remotes/origin/branch",
    ]);
    const mergeBaseSha = mergeBase.stdout.trim();
    if (!mergeBaseSha) {
      throw new Error("Git returned an invalid merge base result");
    }
    const trees = await git([
      "-C",
      directory,
      "rev-parse",
      `${mergeBaseSha}^{tree}`,
      "refs/remotes/origin/target^{tree}",
      "refs/remotes/origin/branch^{tree}",
    ]);
    const [mergeBaseTreeSha, targetTreeSha, branchTreeSha] = trees.stdout
      .trim()
      .split(/\s+/);
    if (!mergeBaseTreeSha || !targetTreeSha || !branchTreeSha) {
      throw new Error("Git returned an invalid branch tree result");
    }
    const treeHasChanges = branchTreeSha !== mergeBaseTreeSha;
    const branchHasChanges = ahead > 0 && treeHasChanges;
    const branchEmpty = !branchHasChanges;
    return {
      branch_exists: true,
      branch_sha: branchSha,
      target_sha: targetSha,
      merge_base_sha: mergeBaseSha,
      branch_tree_sha: branchTreeSha,
      target_tree_sha: targetTreeSha,
      merge_base_tree_sha: mergeBaseTreeSha,
      tree_has_changes: treeHasChanges,
      ahead,
      behind,
      branch_has_changes: branchHasChanges,
      branch_empty: branchEmpty,
      mr_iid: mrIid ? Number(mrIid) : null,
      mr_ref_exists: mrRefExists,
      status: branchEmpty ? "branch_empty" : "branch_active",
    };
  } finally {
    await removeTempDir(directory);
  }
}

export function createGitLabStatusTools({
  executeKw: executeKwImplementation,
  inspectBranch = inspectGitLabBranch,
  inspectMergeRequest = inspectGitLabMergeRequest,
  fetchImpl = globalThis.fetch,
  env = process.env,
}: {
  executeKw: ExecuteKwImplementation;
  inspectBranch?: InspectBranch;
  inspectMergeRequest?: InspectMergeRequest;
  fetchImpl?: FetchImplementation;
  env?: Environment;
}) {
  const executeKw = <T = OdooRecord[]>(
    model: string,
    method: string,
    args: OdooArguments = [],
    kwargs: OdooKeywordArguments = {},
  ) => execute<T>(executeKwImplementation, model, method, args, kwargs);

  return defineToolGroup({
    definitions: [
      {
        name: "odoo_get_gitlab_status",
        description: "Verify linked ticket branches and merge request refs against GitLab",
        inputSchema: {
          type: "object",
          properties: {
            task_id: { type: "number", description: "Task ID" },
          },
          required: ["task_id"],
        },
      },
    ],
    handlers: {
      async odoo_get_gitlab_status(args) {
        const taskId = positiveInt(args.task_id, "task_id");
        const tasks = await executeKw("project.task", "read", [
          [taskId],
          ["id", "name", "gitlab_branch_ids"],
        ]);
        if (!tasks?.length) throw new Error("Task not found");
        const branchIds = tasks[0].gitlab_branch_ids || [];
        if (!branchIds.length) {
          return {
            content: [{ type: "text", text: "No GitLab branches linked to this task" }],
            structuredContent: { task_id: taskId, branches: [] },
          };
        }
        const rows = await executeKw("gitlab.task.branch", "read", [
          branchIds,
          [
            "id",
            "gitlab_origin_project_id",
            "gitlab_branch_name",
            "from_branch",
            "target_branch",
            "gitlab_link",
            "merge_request_link",
          ],
        ]);
        const statuses = [];
        for (const row of rows) {
          let branchStatus;
          try {
            branchStatus = await inspectBranch(row);
          } catch (error) {
            branchStatus = {
              status: "verification_error",
              error: errorMessage(error),
            };
          }
          let mergeRequest;
          try {
            mergeRequest = await inspectMergeRequest(row.merge_request_link, {
              fetchImpl,
              env,
            });
          } catch {
            mergeRequest = { api_status: "unavailable" };
          }
          statuses.push({ ...row, ...branchStatus, merge_request: mergeRequest });
        }
        return {
          content: [
            {
              type: "text",
              text: formatList(
                statuses.map(
                  (row) =>
                    `[${row.id}] ${row.gitlab_branch_name} - ${row.status}\n   ${row.gitlab_link || "no branch link"}\n   ${normalizeMergeRequestLink(row.merge_request_link) || "no merge request"}${row.ahead !== undefined ? `\n   ahead: ${row.ahead}, behind: ${row.behind}` : ""}${row.error ? `\n   error: ${row.error}` : ""}`,
                ),
              ),
            },
          ],
          structuredContent: { task_id: taskId, branches: statuses },
        };
      },
    },
  });
}
