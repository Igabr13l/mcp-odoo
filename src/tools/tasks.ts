import {
  formatList,
  hasValue,
  htmlToText,
  redactSecrets,
} from "../utils/format.js";
import { normalizeLimit, positiveInt } from "../utils/args.js";
import type {
  ExecuteKwImplementation,
  GetAvailableFields,
  GetNameMap,
  GetSelectionLabelMap,
  GetUid,
  OdooArguments,
  OdooKeywordArguments,
  OdooRecord,
} from "../contracts.js";
import {
  defineToolGroup,
  executeKw as execute,
  referenceId,
  referenceName,
} from "../contracts.js";

const STATE_CANONICAL_NAMES = {
  in_progress: "In Progress",
  to_do: "To Do",
  done: "Done",
};

function getNamesFromMap(
  ids: number[] | undefined,
  nameMap: Map<number, string>,
): string[] {
  return (ids || []).map((id) => nameMap.get(Number(id)) || `#${id}`);
}

function formatSelectionValue(
  selectionMap: Map<unknown, string>,
  value: unknown,
  fallback: unknown = "N/A",
): unknown {
  if (!hasValue(value)) return fallback;
  return selectionMap.get(value) || value;
}

function formatTaskPriority(
  task: OdooRecord,
  taskPriorityMap: Map<unknown, string>,
  priorityMap: Map<unknown, string>,
): unknown {
  if (hasValue(task?.task_priority)) {
    return formatSelectionValue(
      taskPriorityMap,
      task.task_priority,
      task.task_priority,
    );
  }

  return formatSelectionValue(priorityMap, task?.priority, "N/A");
}

function canonicalStageName({
  state,
  stageName,
}: {
  state?: unknown;
  stageName?: unknown;
}): string | null {
  if (stageName) return String(stageName);
  if (!state) return null;
  const canonical = typeof state === "string"
    ? STATE_CANONICAL_NAMES[state as keyof typeof STATE_CANONICAL_NAMES]
    : undefined;
  if (!canonical) {
    throw new Error(
      `Unknown state shortcut: "${state}" (expected in_progress | to_do | done)`,
    );
  }
  return canonical;
}

async function resolveTaskStageId(
  executeKw: <T = OdooRecord[]>(
    model: string,
    method: string,
    args?: OdooArguments,
    kwargs?: OdooKeywordArguments,
  ) => Promise<T>,
  {
    projectId,
    state,
    stageName,
  }: { projectId?: number; state?: unknown; stageName?: unknown },
): Promise<number | null> {
  const targetName = canonicalStageName({ state, stageName });
  if (!targetName) return null;

  const normalized = targetName.trim().toLowerCase();
  const rows = await executeKw(
    "project.task.type",
    "search_read",
    [[["name", "=ilike", targetName]]],
    {
    fields: ["id", "name", "project_ids"],
      limit: 100,
    },
  );
  const matches = (rows || []).filter(
    (stage) => String(stage.name || "").trim().toLowerCase() === normalized,
  );

  if (matches.length === 0) {
    throw new Error(`Stage not found: "${targetName}"`);
  }

  if (projectId) {
    const projectIdNumber = Number(projectId);
    const projectMatches = matches.filter(
      (stage) =>
        Array.isArray(stage.project_ids) &&
        stage.project_ids.includes(projectIdNumber),
    );
    if (projectMatches.length > 1) {
      throw new Error(
        `Ambiguous stage "${targetName}": multiple stages match project ${projectId}`,
      );
    }
    if (projectMatches.length === 1) return projectMatches[0].id;

    const globalMatches = matches.filter(
      (stage) => !stage.project_ids || stage.project_ids.length === 0,
    );
    if (globalMatches.length > 1) {
      throw new Error(
        `Ambiguous stage "${targetName}": multiple global stages match`,
      );
    }
    if (globalMatches.length === 1) return globalMatches[0].id;

    throw new Error(`Stage "${targetName}" not found for project ${projectId}`);
  }

  if (matches.length === 1) return matches[0].id;

  throw new Error(
    `Ambiguous stage "${targetName}": multiple stages match, pass project_id or stage_id`,
  );
}

function buildTaskDomain({
  uid,
  projectId,
  stageName,
  mine = true,
  search,
}: {
  uid: number | null;
  projectId: number | null;
  stageName: string | null;
  mine?: boolean;
  search?: unknown;
}): unknown[][] {
  const domain: unknown[][] = [];
  if (mine) domain.push(["user_ids", "=", uid]);
  if (projectId) domain.push(["project_id", "=", Number(projectId)]);
  if (stageName) domain.push(["stage_id.name", "=ilike", stageName]);
  if (search) domain.push(["name", "ilike", search.toString()]);
  return domain;
}

export function createTaskTools({
  executeKw: executeKwImplementation,
  getUid,
  getAvailableFields,
  getSelectionLabelMap,
  getNameMap,
}: {
  executeKw: ExecuteKwImplementation;
  getUid: GetUid;
  getAvailableFields: GetAvailableFields;
  getSelectionLabelMap: GetSelectionLabelMap;
  getNameMap: GetNameMap;
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
        name: "odoo_get_my_tasks",
        description: "List my tasks (optional filters: project_id, state)",
        inputSchema: {
          type: "object",
          properties: {
            project_id: { type: "number", description: "Project ID (optional)" },
            state: { type: "string", description: "in_progress | to_do | done" },
          },
        },
      },
      {
        name: "odoo_get_tickets",
        description: "List tickets/tasks with optional filters, priority and tags",
        inputSchema: {
          type: "object",
          properties: {
            mine: {
              type: "boolean",
              description: "Only my assigned tickets (default true)",
            },
            project_id: { type: "number", description: "Project ID (optional)" },
            state: { type: "string", description: "in_progress | to_do | done" },
            search: { type: "string", description: "Search text in ticket name" },
            limit: {
              type: "number",
              description: "Max results (default 100, max 500)",
            },
          },
        },
      },
      {
        name: "odoo_get_task_detail",
        description:
          "Get task details with assignees, tags, priority, description and metrics",
        inputSchema: {
          type: "object",
          properties: {
            task_id: { type: "number", description: "Task ID" },
          },
          required: ["task_id"],
        },
      },
      {
        name: "odoo_update_task",
        description: "Update task assignees, description, and status/stage",
        inputSchema: {
          type: "object",
          properties: {
            task_id: { type: "number", description: "Task ID" },
            assignee_user_ids: {
              type: "array",
              description: "Replace assignees with this list of user IDs",
              items: { type: "number" },
            },
            description: { type: "string", description: "Task description/body" },
            stage_id: { type: "number", description: "Exact stage ID to set" },
            stage_name: {
              type: "string",
              description: "Stage name (searched with ilike)",
            },
            state: {
              type: "string",
              description: "Shortcut: in_progress | to_do | done",
            },
          },
          required: ["task_id"],
        },
      },
    ],
    handlers: {
      async odoo_get_my_tasks(args) {
        const projectId =
          args.project_id !== undefined
            ? positiveInt(args.project_id, "project_id")
            : null;
        const stageName = canonicalStageName({ state: args.state });
        const domain = buildTaskDomain({
          uid: getUid(),
          projectId,
          stageName,
          mine: true,
        });

        const tasks = await executeKw("project.task", "search_read", [domain], {
          fields: ["id", "name", "project_id", "stage_id"],
          limit: 100,
        });

        return {
          content: [
            {
              type: "text",
              text: formatList(
                tasks.map(
                  (t) =>
                    `[${t.id}] ${t.name}\n   ${referenceName(t.project_id) || "N/A"} - ${referenceName(t.stage_id) || "N/A"}`,
                ),
              ),
            },
          ],
        };
      },

      async odoo_get_tickets(args) {
        const mine = args.mine !== false;
        const projectId =
          args.project_id !== undefined
            ? positiveInt(args.project_id, "project_id")
            : null;
        const stageName = canonicalStageName({ state: args.state });
        const domain = buildTaskDomain({
          uid: getUid(),
          projectId,
          stageName,
          mine,
          search: args.search,
        });

        const ticketFields = await getAvailableFields("project.task", [
          "id",
          "name",
          "project_id",
          "stage_id",
          "priority",
          "task_priority",
          "tag_ids",
          "date_deadline",
        ]);

        const tasks = await executeKw("project.task", "search_read", [domain], {
          fields: ticketFields,
          limit: normalizeLimit(args.limit, 100, 500),
          order: "id desc",
        });

        const priorityMap = ticketFields.includes("priority")
          ? await getSelectionLabelMap("project.task", "priority")
          : new Map();
        const taskPriorityMap = ticketFields.includes("task_priority")
          ? await getSelectionLabelMap("project.task", "task_priority")
          : new Map();
        const tagNameMap = ticketFields.includes("tag_ids")
          ? await getNameMap(
              "project.tags",
              tasks.flatMap((task) => task.tag_ids || []),
            )
          : new Map();

        const text = formatList(
          tasks.map(
            (t) => {
              const tagNames = getNamesFromMap(t.tag_ids, tagNameMap);
              const priority = formatTaskPriority(
                t,
                taskPriorityMap,
                priorityMap,
              );

               return `[${t.id}] ${t.name}\n   ${referenceName(t.project_id) || "N/A"} - ${referenceName(t.stage_id) || "N/A"} - priority:${priority} - tags:${tagNames.join(", ") || "none"} - deadline:${t.date_deadline || "N/A"}`;
            },
          ),
        );

        return { content: [{ type: "text", text }] };
      },

      async odoo_get_task_detail(args) {
        const taskId = positiveInt(args.task_id, "task_id");
        const taskFields = await getAvailableFields("project.task", [
          "id",
          "name",
          "project_id",
          "stage_id",
          "user_ids",
          "priority",
          "task_priority",
          "date_deadline",
          "task_category",
          "allocated_hours",
          "effective_hours",
          "progress",
          "gitlab_branch_ids",
          "tag_ids",
          "description",
        ]);
        const rows = await executeKw("project.task", "read", [
          [taskId],
          taskFields,
        ]);

        if (!rows || rows.length === 0) {
          return { content: [{ type: "text", text: "Task not found" }] };
        }

        const t = rows[0];
        const userNameMap = await getNameMap("res.users", t.user_ids || []);
        const assignees = getNamesFromMap(t.user_ids, userNameMap).join(", ") || "N/A";
        const tagNameMap = await getNameMap("project.tags", t.tag_ids || []);
        const tags = getNamesFromMap(t.tag_ids, tagNameMap).join(", ") || "none";
        const priorityMap = taskFields.includes("priority")
          ? await getSelectionLabelMap("project.task", "priority")
          : new Map();
        const taskPriorityMap = taskFields.includes("task_priority")
          ? await getSelectionLabelMap("project.task", "task_priority")
          : new Map();
        const categoryMap = taskFields.includes("task_category")
          ? await getSelectionLabelMap("project.task", "task_category")
          : new Map();
        const description = redactSecrets(htmlToText(t.description));

        const text = [
          `Task #${t.id}: ${t.name}`,
          `Project: ${referenceName(t.project_id) || "N/A"}`,
          `Stage: ${referenceName(t.stage_id) || "N/A"}`,
          `Assignees: ${assignees}`,
          `Tags: ${tags}`,
          `Priority: ${formatTaskPriority(t, taskPriorityMap, priorityMap)}`,
          `Deadline: ${t.date_deadline || "N/A"}`,
          `Hours: ${t.effective_hours || 0}/${t.allocated_hours || 0}`,
          `Progress: ${Math.round(Number(t.progress) || 0)}%`,
          `Category: ${formatSelectionValue(categoryMap, t.task_category)}`,
          `GitLab branch ids: ${t.gitlab_branch_ids?.join(", ") || "none"}`,
          "",
          "Description:",
          description || "N/A",
        ].join("\n");

        return { content: [{ type: "text", text }] };
      },

      async odoo_update_task(args) {
        const taskId = positiveInt(args.task_id, "task_id");
        const values: Record<string, unknown> = {};

        const currentRows = await executeKw("project.task", "read", [
          [taskId],
          ["id", "name", "project_id", "stage_id", "user_ids", "description"],
        ]);
        if (!currentRows || currentRows.length === 0) {
          return { content: [{ type: "text", text: "Task not found" }] };
        }
        const current = currentRows[0];
        const projectId = referenceId(current.project_id);

        if (args.assignee_user_ids !== undefined) {
          const assigneeIds = Array.isArray(args.assignee_user_ids)
            ? args.assignee_user_ids
                .map((id) => Number(id))
                .filter((id) => Number.isInteger(id) && id > 0)
            : [];
          values.user_ids = [[6, 0, assigneeIds]];
        }

        if (args.description !== undefined) {
          values.description = args.description;
        }

        if (args.stage_id !== undefined) {
          values.stage_id = positiveInt(args.stage_id, "stage_id");
        } else if (args.stage_name || args.state) {
          const resolvedStageId = await resolveTaskStageId(executeKw, {
            projectId,
            state: args.state,
            stageName: args.stage_name,
          });
          values.stage_id = resolvedStageId;
        }

        if (Object.keys(values).length === 0) {
          return { content: [{ type: "text", text: "Nothing to update" }] };
        }

        const ok = await executeKw<boolean>("project.task", "write", [
          [taskId],
          values,
        ]);
        if (!ok) {
          return { content: [{ type: "text", text: "Update failed" }] };
        }

        const updatedRows = await executeKw("project.task", "read", [
          [taskId],
          ["id", "name", "project_id", "stage_id", "user_ids", "description"],
        ]);
        const updated = updatedRows?.[0];

        let assignees = "N/A";
        if (updated?.user_ids?.length) {
          const users = await executeKw("res.users", "read", [
            updated.user_ids,
            ["name"],
          ]);
          assignees = users.map((u) => u.name).join(", ");
        }

        const text = [
          `Task updated: #${updated?.id || taskId} ${updated?.name || ""}`,
          `Project: ${referenceName(updated?.project_id) || "N/A"}`,
          `Stage: ${referenceName(updated?.stage_id) || "N/A"}`,
          `Assignees: ${assignees}`,
          `Description: ${updated?.description ? "updated" : "empty"}`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      },

    },
  });
}
