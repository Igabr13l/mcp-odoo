import { formatList } from "../utils/format.js";
import { normalizeLimit, positiveInt } from "../utils/args.js";

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

const MAX_BRANCH_ATTEMPTS = 8;
const MAX_BRANCH_NAME_LENGTH = 120;

async function readTaskBranches(executeKw, taskId) {
  const taskRows = await executeKw("project.task", "read", [
    [taskId],
    ["id", "name", "gitlab_branch_ids"],
  ]);
  const task = taskRows?.[0];
  if (!task) return null;

  const branchIds = task.gitlab_branch_ids || [];
  const branches = branchIds.length
    ? await executeKw("gitlab.task.branch", "read", [branchIds, BRANCH_FIELDS])
    : [];
  return { task, branches };
}

async function readBranchRow(executeKw, gitlabTaskBranchId) {
  const rows = await executeKw("gitlab.task.branch", "read", [
    [gitlabTaskBranchId],
    BRANCH_FIELDS,
  ]);
  return rows?.[0] || null;
}

function defaultBranchName(taskId, taskName) {
  const fallbackSlug = (taskName || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40);
  return `odoo/${taskId}-${fallbackSlug || "task"}`;
}

function formatBranchRow(branch) {
  const project = branch.gitlab_origin_project_id?.[1] || "N/A";
  const owner = branch.gitlab_user_id?.[1] || "N/A";
  return [
    `[${branch.id}] ${project}`,
    `   branch: ${branch.gitlab_branch_name || "N/A"}`,
    `   from -> target: ${branch.from_branch || "N/A"} -> ${branch.target_branch || "N/A"}`,
    `   author: ${owner}`,
    `   link: ${branch.gitlab_link || "N/A"}`,
    `   mr: ${branch.merge_request_link || "none"}`,
  ].join("\n");
}

function definitions() {
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

export function createGitLabTools({ executeKw, getUid }) {
  const currentUid = getUid || (() => null);

  return {
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
        const rows = await executeKw("gitlab.project", "name_search", [
          query,
          [],
          "ilike",
          limit,
        ]);
        const text = formatList((rows || []).map((r) => `[${r[0]}] ${r[1]}`));
        return { content: [{ type: "text", text }] };
      },

      async odoo_gitlab_list_users(args) {
        const query = (args.query || "").toString();
        const limit = normalizeLimit(args.limit, { fallback: 20 });
        const rows = await executeKw("res.users", "name_search", [
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
            row.gitlab_origin_project_id?.[0] === gitlabProjectId &&
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
          };
        }

        const gitlabTaskBranchId = await executeKw(
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

        const created = await executeKw("gitlab.task.branch", "read", [
          [gitlabTaskBranchId],
          BRANCH_FIELDS,
        ]);
        const c = created?.[0];
        const text = [
          `GitLab task branch row created: ${c?.id || gitlabTaskBranchId}`,
          `project: ${c?.gitlab_origin_project_id?.[1] || gitlabProjectId}`,
          `branch: ${c?.gitlab_branch_name || branchName}`,
          `from -> target: ${c?.from_branch || fromBranch} -> ${c?.target_branch || targetBranch}`,
          `reviewer: ${c?.gitlab_user_id?.[1] || reviewerUserId}`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
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
          };
        }

        let result = false;
        let attempts = 0;
        let renamed = false;

        while (attempts < MAX_BRANCH_ATTEMPTS) {
          const suffix = attempts === 0 ? "" : `-${attempts + 1}`;
          const candidateName = `${baseName.slice(0, MAX_BRANCH_NAME_LENGTH - suffix.length)}${suffix}`;
          if (attempts > 0) {
            renamed = true;
            await executeKw("gitlab.task.branch", "write", [
              [gitlabTaskBranchId],
              { gitlab_branch_name: candidateName },
            ]);
          }
          try {
            result = await executeKw(
              "gitlab.task.branch",
              "create_branch",
              [[gitlabTaskBranchId]],
              {},
            );
            break;
          } catch (err) {
            const msg = (err?.message || "").toLowerCase();
            if (!msg.includes("branch already exists")) {
              if (renamed) {
                await executeKw("gitlab.task.branch", "write", [
                  [gitlabTaskBranchId],
                  { gitlab_branch_name: baseName },
                ]);
              }
              throw err;
            }
            attempts += 1;
          }
        }

        if (!result) {
          if (renamed) {
            await executeKw("gitlab.task.branch", "write", [
              [gitlabTaskBranchId],
              { gitlab_branch_name: baseName },
            ]);
          }
          throw new Error(
            attempts >= MAX_BRANCH_ATTEMPTS
              ? "Could not create branch after multiple retries (name collision)."
              : "Odoo did not create the GitLab branch",
          );
        }

        const row = await readBranchRow(executeKw, gitlabTaskBranchId);
        const r = row || {};
        const text = [
          `create_branch result: ${result}`,
          `branch_id: ${gitlabTaskBranchId}`,
          `renamed_on_conflict: ${renamed}`,
          `retry_count: ${attempts}`,
          `branch_name: ${r.gitlab_branch_name || "N/A"}`,
          `gitlab_link: ${r.gitlab_link || "N/A"}`,
        ].join("\n");
        return { content: [{ type: "text", text }] };
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
        if (current.merge_request_link) {
          return {
            content: [
              {
                type: "text",
                text: `Merge request already recorded:\n${current.merge_request_link}`,
              },
            ],
          };
        }
        if (args.confirm !== true) {
          return {
            content: [
              {
                type: "text",
                text: `Preview only; no merge request created.\nbranch_id: ${gitlabTaskBranchId}\nbranch_name: ${current.gitlab_branch_name}\nRetry with confirm=true to create it.`,
              },
            ],
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
        const r = row || {};
        const text = [
          `create_merge_request result: ${result}`,
          `branch_id: ${gitlabTaskBranchId}`,
          `branch_name: ${r.gitlab_branch_name || "N/A"}`,
          `gitlab_link: ${r.gitlab_link || "N/A"}`,
          `merge_request_link: ${r.merge_request_link || "N/A"}`,
        ].join("\n");
        return { content: [{ type: "text", text }] };
      },
    },
  };
}
