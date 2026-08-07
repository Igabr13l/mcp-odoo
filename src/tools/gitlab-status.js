import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { formatList } from "../utils/format.js";
import { positiveInt } from "../utils/args.js";

const execFileAsync = promisify(execFile);

export function remoteFromLink(link) {
  const url = new URL(link);
  const allowedHosts = (process.env.ODOO_GITLAB_ALLOWED_HOSTS || "gitlab.solunika.com")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  if (!allowedHosts.includes(url.hostname.toLowerCase())) {
    throw new Error(`GitLab host '${url.hostname}' is not allowed`);
  }
  const projectPath = url.pathname.split("/-/")[0].replace(/^\//, "");
  if (!projectPath) throw new Error("Invalid GitLab project link");
  return `git@${url.hostname}:${projectPath}.git`;
}

async function lsRemote(remote, refs) {
  const { stdout } = await execFileAsync("git", ["ls-remote", remote, ...refs], {
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
    },
  });
  return stdout.trim().split("\n").filter(Boolean);
}

async function branchStatus(row) {
  if (!row.gitlab_link) {
    return { branch_exists: false, mr_ref_exists: false, status: "not_created" };
  }
  const remote = remoteFromLink(row.gitlab_link);
  const refs = [`refs/heads/${row.gitlab_branch_name}`];
  const mrIid = row.merge_request_link?.match(/\/merge_requests\/(\d+)/)?.[1];
  if (mrIid) refs.push(`refs/merge-requests/${mrIid}/head`);
  const lines = await lsRemote(remote, refs);
  const remoteRefs = new Set(lines.map((line) => line.split(/\s+/)[1]).filter(Boolean));
  const branchExists = remoteRefs.has(refs[0]);
  const mrRefExists = mrIid
    ? remoteRefs.has(`refs/merge-requests/${mrIid}/head`)
    : false;
  return {
    branch_exists: branchExists,
    mr_iid: mrIid ? Number(mrIid) : null,
    mr_ref_exists: mrRefExists,
    status: branchExists ? "branch_active" : mrRefExists ? "branch_deleted_mr_exists" : "remote_missing",
  };
}

export function createGitLabStatusTools({ executeKw }) {
  return {
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
          return { content: [{ type: "text", text: "No GitLab branches linked to this task" }] };
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
          try {
            statuses.push({ ...row, ...(await branchStatus(row)) });
          } catch (error) {
            statuses.push({ ...row, status: "verification_error", error: error.message });
          }
        }
        return {
          content: [
            {
              type: "text",
              text: formatList(
                statuses.map(
                  (row) =>
                    `[${row.id}] ${row.gitlab_branch_name} - ${row.status}\n   ${row.gitlab_link || "no branch link"}\n   ${row.merge_request_link || "no merge request"}${row.error ? `\n   error: ${row.error}` : ""}`,
                ),
              ),
            },
          ],
          structuredContent: { task_id: taskId, branches: statuses },
        };
      },
    },
  };
}
