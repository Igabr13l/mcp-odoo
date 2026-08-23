import { formatList } from "../utils/format.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { normalizeLimit, positiveInt } from "../utils/args.js";
import {
  type BranchInspection,
  type GitLabBranchRow,
  type InspectBranch,
  inspectGitLabBranch,
  normalizeMergeRequestLink,
} from "./gitlab-status.js";
import type {
  ExecuteKwImplementation,
  GetUid,
  OdooArguments,
  OdooKeywordArguments,
  OdooRecord,
} from "../contracts.js";
import {
  defineToolGroup,
  errorMessage,
  executeKw as execute,
  referenceId,
  referenceName,
} from "../contracts.js";

const BRANCH_FIELDS = [
  "id",
  "gitlab_origin_project_id",
  "gitlab_branch_name",
  "from_branch",
  "target_branch",
  "gitlab_link",
  "merge_request_link",
  "gitlab_user_id",
];

const MAX_BRANCH_NAME_LENGTH = 120;

type GenericExecuteKw = <T = OdooRecord[]>(
  model: string,
  method: string,
  args?: OdooArguments,
  kwargs?: OdooKeywordArguments,
) => Promise<T>;

async function readTaskBranches(executeKw: GenericExecuteKw, taskId: number) {
  const taskRows = await executeKw<OdooRecord[]>("project.task", "read", [
    [taskId],
    ["id", "name", "gitlab_branch_ids"],
  ]);
  const task = taskRows?.[0];
  if (!task) return null;

  const branchIds = task.gitlab_branch_ids || [];
  const branches = branchIds.length
    ? await executeKw<GitLabBranchRow[]>("gitlab.task.branch", "read", [
        branchIds,
        BRANCH_FIELDS,
      ])
    : [];
  return { task, branches };
}

async function readBranchRow(
  executeKw: GenericExecuteKw,
  gitlabTaskBranchId: number,
): Promise<GitLabBranchRow | null> {
  const rows = await executeKw<GitLabBranchRow[]>("gitlab.task.branch", "read", [
    [gitlabTaskBranchId],
    BRANCH_FIELDS,
  ]);
  return rows?.[0] || null;
}

function defaultBranchName(taskId: number, taskName: unknown): string {
  const fallbackSlug = String(taskName || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40);
  return `odoo/${taskId}-${fallbackSlug || "task"}`;
}

function formatBranchRow(branch: GitLabBranchRow): string {
  const project = referenceName(branch.gitlab_origin_project_id) || "N/A";
  const owner = referenceName(branch.gitlab_user_id) || "N/A";
  return [
    `[${branch.id}] ${project}`,
    `   branch: ${branch.gitlab_branch_name || "N/A"}`,
    `   from -> target: ${branch.from_branch || "N/A"} -> ${branch.target_branch || "N/A"}`,
    `   author: ${owner}`,
    `   link: ${branch.gitlab_link || "N/A"}`,
    `   mr: ${branch.merge_request_link || "none"}`,
  ].join("\n");
}

function definitions(): Tool[] {
  return [
    {
      name: "odoo_get_task_gitlab_branches",
      description: "Get GitLab branches linked to a task",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "number", description: "Task ID" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "odoo_gitlab_list_projects",
      description: "Search GitLab repositories available in Odoo",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional search text" },
          limit: { type: "number", description: "Optional limit (default 20)" },
        },
      },
    },
    {
      name: "odoo_gitlab_list_users",
      description: "Search Odoo users to assign as GitLab reviewer/owner",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional search text" },
          limit: { type: "number", description: "Optional limit (default 20)" },
        },
      },
    },
    {
      name: "odoo_gitlab_add_task_branch",
      description:
        "Add a GitLab branch row to a task (same as tab GitLab -> add line)",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "number", description: "Task ID" },
          gitlab_project_id: {
            type: "number",
            description: "GitLab project/repo ID from gitlab.project",
          },
          reviewer_user_id: {
            type: "number",
            description:
              "Odoo user ID for gitlab_user_id (optional, default current user)",
          },
          branch_name: {
            type: "string",
            description:
              "Branch name (optional, default odoo/<task_id>-<slug>)",
          },
          from_branch: {
            type: "string",
            description: "Source branch (default uat)",
          },
          target_branch: {
            type: "string",
            description: "Target branch (default uat)",
          },
          confirm: {
            type: "boolean",
            description: "Must be true to create the Odoo GitLab row",
          },
        },
        required: ["task_id", "gitlab_project_id", "confirm"],
      },
    },
    {
      name: "odoo_gitlab_create_branch",
      description: 'Click "Create Branch" for a gitlab.task.branch row',
      inputSchema: {
        type: "object",
        properties: {
          gitlab_task_branch_id: {
            type: "number",
            description: "ID from gitlab.task.branch",
          },
          confirm: {
            type: "boolean",
            description: "Must be true to create the remote branch",
          },
        },
        required: ["gitlab_task_branch_id", "confirm"],
      },
    },
    {
      name: "odoo_gitlab_create_merge_request",
      description: 'Click "Create Merge Request" for a gitlab.task.branch row',
      inputSchema: {
        type: "object",
        properties: {
          gitlab_task_branch_id: {
            type: "number",
            description: "ID from gitlab.task.branch",
          },
          confirm: {
            type: "boolean",
            description: "Must be true to create the merge request",
          },
        },
        required: ["gitlab_task_branch_id", "confirm"],
      },
    },
  ];
}

export function createGitLabTools({
  executeKw: executeKwImplementation,
  getUid,
  inspectBranch = inspectGitLabBranch,
}: {
  executeKw: ExecuteKwImplementation;
  getUid?: GetUid;
  inspectBranch?: InspectBranch;
}) {
  const executeKw: GenericExecuteKw = <T = OdooRecord[]>(
    model: string,
    method: string,
    args: OdooArguments = [],
    kwargs: OdooKeywordArguments = {},
  ) => execute<T>(executeKwImplementation, model, method, args, kwargs);
  const currentUid = getUid || (() => null);

  return defineToolGroup({
    definitions: definitions(),
    handlers: {
      async odoo_get_task_gitlab_branches(args) {
        const taskId = positiveInt(args.task_id, { label: "task_id" });
        const linked = await readTaskBranches(executeKw, taskId);
        if (!linked) {
          return { content: [{ type: "text", text: "Task not found" }] };
        }
        if (linked.branches.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No GitLab branches linked to this task",
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: formatList(linked.branches.map(formatBranchRow)),
            },
          ],
        };
      },

      async odoo_gitlab_list_projects(args) {
        const query = (args.query || "").toString();
        const limit = normalizeLimit(args.limit, { fallback: 20 });
        const rows = await executeKw<[number, string][]>(
          "gitlab.project",
          "name_search",
          [
          query,
          [],
          "ilike",
          limit,
          ],
        );
        const text = formatList((rows || []).map((r) => `[${r[0]}] ${r[1]}`));
        return { content: [{ type: "text", text }] };
      },

      async odoo_gitlab_list_users(args) {
        const query = (args.query || "").toString();
        const limit = normalizeLimit(args.limit, { fallback: 20 });
        const rows = await executeKw<[number, string][]>("res.users", "name_search", [
          query,
          [],
          "ilike",
          limit,
        ]);
        const text = formatList((rows || []).map((r) => `[${r[0]}] ${r[1]}`));
        return { content: [{ type: "text", text }] };
      },

      async odoo_gitlab_add_task_branch(args) {
        const taskId = positiveInt(args.task_id, { label: "task_id" });
        const gitlabProjectId = positiveInt(args.gitlab_project_id, {
          label: "gitlab_project_id",
        });
        const reviewerUserId = positiveInt(
          args.reviewer_user_id || currentUid(),
          { label: "reviewer_user_id" },
        );
        const fromBranch = (args.from_branch || "uat").toString();
        const targetBranch = (args.target_branch || "uat").toString();

        const linked = await readTaskBranches(executeKw, taskId);
        if (!linked) {
          return { content: [{ type: "text", text: "Task not found" }] };
        }

        const branchName = (
          args.branch_name || defaultBranchName(taskId, linked.task.name)
        ).toString();

        const existing = linked.branches.find(
          (row) =>
            referenceId(row.gitlab_origin_project_id) === gitlabProjectId &&
            row.gitlab_branch_name === branchName &&
            row.from_branch === fromBranch &&
            row.target_branch === targetBranch,
        );
        if (existing) {
          return {
            content: [
              {
                type: "text",
                text: `GitLab task branch row already exists: ${existing.id}\nbranch: ${existing.gitlab_branch_name}\nlink: ${existing.gitlab_link || "not created"}\nmr: ${existing.merge_request_link || "not created"}`,
              },
            ],
            structuredContent: {
              result: "already_exists",
              branch_id: existing.id,
              branch: existing,
            },
          };
        }

        if (args.confirm !== true) {
          return {
            content: [
              {
                type: "text",
                text: `Preview only; no row created.\nproject_id: ${gitlabProjectId}\nbranch: ${branchName}\nfrom -> target: ${fromBranch} -> ${targetBranch}\nassignee: ${reviewerUserId}\nRetry with confirm=true to create it.`,
              },
            ],
            structuredContent: {
              result: "preview",
              task_id: taskId,
              gitlab_project_id: gitlabProjectId,
              branch_name: branchName,
              from_branch: fromBranch,
              target_branch: targetBranch,
              reviewer_user_id: reviewerUserId,
            },
          };
        }

        const gitlabTaskBranchId = await executeKw<number>(
          "gitlab.task.branch",
          "create",
          [
            {
              task_id: taskId,
              gitlab_origin_project_id: gitlabProjectId,
              from_branch: fromBranch,
              gitlab_branch_name: branchName,
              target_branch: targetBranch,
              gitlab_user_id: reviewerUserId,
            },
          ],
        );

        const created = await executeKw<GitLabBranchRow[]>(
          "gitlab.task.branch",
          "read",
          [
          [gitlabTaskBranchId],
          BRANCH_FIELDS,
          ],
        );
        const c = created?.[0];
        const text = [
          `GitLab task branch row created: ${c?.id || gitlabTaskBranchId}`,
          `project: ${referenceName(c?.gitlab_origin_project_id) || gitlabProjectId}`,
          `branch: ${c?.gitlab_branch_name || branchName}`,
          `from -> target: ${c?.from_branch || fromBranch} -> ${c?.target_branch || targetBranch}`,
          `reviewer: ${referenceName(c?.gitlab_user_id) || reviewerUserId}`,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: {
            result: "created",
            branch_id: c?.id || gitlabTaskBranchId,
            branch: c || null,
          },
        };
      },

      async odoo_gitlab_create_branch(args) {
        const gitlabTaskBranchId = positiveInt(args.gitlab_task_branch_id, {
          label: "gitlab_task_branch_id",
        });
        const currentRow = await readBranchRow(executeKw, gitlabTaskBranchId);
        if (!currentRow) throw new Error("GitLab task branch row not found");
        if (currentRow.gitlab_link) {
          return {
            content: [
              {
                type: "text",
                text: `Branch already recorded: ${currentRow.gitlab_branch_name}\n${currentRow.gitlab_link}`,
              },
            ],
            structuredContent: {
              result: "already_exists",
              branch_id: gitlabTaskBranchId,
              branch: currentRow,
            },
          };
        }
        const baseName =
          currentRow.gitlab_branch_name || `odoo/branch-${gitlabTaskBranchId}`;

        if (args.confirm !== true) {
          return {
            content: [
              {
                type: "text",
                text: `Preview only; no branch created.\nbranch_id: ${gitlabTaskBranchId}\nbranch_name: ${baseName}\nRetry with confirm=true to create it.`,
              },
            ],
            structuredContent: {
              result: "preview",
              branch_id: gitlabTaskBranchId,
              branch_name: baseName,
            },
          };
        }

        let result: unknown;
        try {
          result = await executeKw(
            "gitlab.task.branch",
            "create_branch",
            [[gitlabTaskBranchId]],
            {},
          );
        } catch (err) {
          if (!errorMessage(err).toLowerCase().includes("branch already exists")) {
            throw err;
          }
          await executeKw<boolean>("gitlab.task.branch", "write", [
            [gitlabTaskBranchId],
            { gitlab_branch_name: baseName },
          ]);
          const suffix = "-2";
          const proposedName = `${baseName.slice(0, MAX_BRANCH_NAME_LENGTH - suffix.length)}${suffix}`;
          throw new Error(
            `Branch '${baseName}' already exists. The Odoo row was preserved. Proposed alternate: '${proposedName}'. Update the row and confirm separately.`,
          );
        }

        if (!result) {
          throw new Error("Odoo did not create the GitLab branch");
        }

        const row = await readBranchRow(executeKw, gitlabTaskBranchId);
        const r: Partial<GitLabBranchRow> = row || {};
        const text = [
          `create_branch result: ${result}`,
          `branch_id: ${gitlabTaskBranchId}`,
          `branch_name: ${r.gitlab_branch_name || "N/A"}`,
          `gitlab_link: ${r.gitlab_link || "N/A"}`,
        ].join("\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: {
            result,
            branch_id: gitlabTaskBranchId,
            branch: r,
          },
        };
      },

      async odoo_gitlab_create_merge_request(args) {
        const gitlabTaskBranchId = positiveInt(args.gitlab_task_branch_id, {
          label: "gitlab_task_branch_id",
        });
        const current = await readBranchRow(executeKw, gitlabTaskBranchId);
        if (!current) throw new Error("GitLab task branch row not found");
        if (!current.gitlab_link) {
          throw new Error(
            "Create the GitLab branch before creating a merge request",
          );
        }
        const existingMergeRequest = normalizeMergeRequestLink(
          current.merge_request_link,
        );
        if (existingMergeRequest) {
          return {
            content: [
              {
                type: "text",
                text: `Merge request already recorded:\n${existingMergeRequest}`,
              },
            ],
            structuredContent: {
              result: "already_exists",
              branch_id: gitlabTaskBranchId,
              merge_request_link: existingMergeRequest,
            },
          };
        }
        let divergence: BranchInspection;
        try {
          divergence = await inspectBranch(current);
        } catch (error) {
          throw new Error(`Unable to verify branch divergence: ${errorMessage(error)}`);
        }
        if (divergence.status === "branch_empty" || divergence.branch_empty) {
          throw new Error(
            `Cannot create a merge request for an empty branch (ahead: ${divergence.ahead}, behind: ${divergence.behind})`,
          );
        }
        if (
          divergence.status !== "branch_active" ||
          divergence.branch_has_changes !== true
        ) {
          throw new Error(
            `Unable to verify a non-empty branch (status: ${divergence.status})`,
          );
        }
        if (args.confirm !== true) {
          return {
            content: [
              {
                type: "text",
                text: `Preview only; no merge request created.\nbranch_id: ${gitlabTaskBranchId}\nbranch_name: ${current.gitlab_branch_name}\nahead: ${divergence.ahead}\nbehind: ${divergence.behind}\nRetry with confirm=true to create it.`,
              },
            ],
            structuredContent: {
              result: "preview",
              branch_id: gitlabTaskBranchId,
              divergence,
            },
          };
        }
        const result = await executeKw(
          "gitlab.task.branch",
          "create_merge_request",
          [[gitlabTaskBranchId]],
          {},
        );
        if (!result) throw new Error("Odoo did not create the merge request");

        const row = await readBranchRow(executeKw, gitlabTaskBranchId);
        const r: Partial<GitLabBranchRow> = row || {};
        const text = [
          `create_merge_request result: ${result}`,
          `branch_id: ${gitlabTaskBranchId}`,
          `branch_name: ${r.gitlab_branch_name || "N/A"}`,
          `gitlab_link: ${r.gitlab_link || "N/A"}`,
          `merge_request_link: ${r.merge_request_link || "N/A"}`,
        ].join("\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: {
            result,
            branch_id: gitlabTaskBranchId,
            divergence,
            branch: r,
          },
        };
      },
    },
  });
}
