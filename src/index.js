import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const DEFAULT_URL = process.env.ODOO_URL || "https://odoo.solunika.com";
const DEFAULT_DB = process.env.ODOO_DB || "solunika";
const SESSION_FILE =
  process.env.ODOO_SESSION_FILE ||
  `${process.env.HOME || ""}/.config/mcp-odoo/session.json`;

const state = {
  url: DEFAULT_URL,
  db: DEFAULT_DB,
  uid: null,
  login: null,
  password: null,
  name: null,
  sessionLoaded: false,
  sessionValidatedAt: 0,
};

async function callJsonRpc(payload) {
  const response = await fetch(`${state.url}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (data.error) {
    throw new Error(
      data.error.data?.message || data.error.message || "Odoo Server Error",
    );
  }
  return data.result;
}

async function savePersistedSession() {
  await mkdir(dirname(SESSION_FILE), { recursive: true });
  const payload = {
    url: state.url,
    db: state.db,
    uid: state.uid,
    login: state.login,
    password: state.password,
    name: state.name,
    saved_at: Date.now(),
  };
  await writeFile(SESSION_FILE, JSON.stringify(payload, null, 2), {
    mode: 0o600,
  });
}

async function loadPersistedSession() {
  if (state.sessionLoaded) return;
  state.sessionLoaded = true;

  try {
    const raw = await readFile(SESSION_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed?.login || !parsed?.password) return;

    state.url = parsed.url || state.url;
    state.db = parsed.db || state.db;
    state.uid = parsed.uid || null;
    state.login = parsed.login;
    state.password = parsed.password;
    state.name = parsed.name || null;
  } catch {
    // Ignore when no session file exists.
  }
}

function clearInMemorySession() {
  state.uid = null;
  state.login = null;
  state.password = null;
  state.name = null;
  state.sessionValidatedAt = 0;
}

async function clearPersistedSession() {
  clearInMemorySession();
  try {
    await rm(SESSION_FILE, { force: true });
  } catch {
    // Ignore cleanup failures.
  }
}

async function commonAuthenticate(url, db, login, password) {
  const response = await fetch(`${url}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "call",
      params: {
        service: "common",
        method: "authenticate",
        args: [db, login, password, {}],
      },
      id: Date.now(),
    }),
  });

  const data = await response.json();
  if (data.error) {
    throw new Error(
      data.error.data?.message || data.error.message || "Odoo auth error",
    );
  }
  return data.result || null;
}

async function ensureAuthenticated() {
  if (state.login && state.password) {
    const isFresh = Date.now() - state.sessionValidatedAt < 5 * 60 * 1000;
    if (state.uid && isFresh) return;

    const uid = await commonAuthenticate(
      state.url,
      state.db,
      state.login,
      state.password,
    );
    if (uid) {
      state.uid = uid;
      state.sessionValidatedAt = Date.now();
      return;
    }
  }

  await loadPersistedSession();
  if (state.login && state.password) {
    const uid = await commonAuthenticate(
      state.url,
      state.db,
      state.login,
      state.password,
    );
    if (!uid) {
      await clearPersistedSession();
      throw new Error("Stored session is no longer valid. Run odoo_login.");
    }
    state.uid = uid;
    state.sessionValidatedAt = Date.now();
    return;
  }

  throw new Error("Not authenticated. Run odoo_login first.");
}

async function authenticate({ url, db, login, password, remember = true }) {
  if (url) state.url = url.replace(/\/$/, "");
  if (db) state.db = db;
  state.login = login;
  state.password = password;

  const uid = await commonAuthenticate(state.url, state.db, login, password);

  if (!uid) {
    throw new Error("Authentication failed");
  }

  state.uid = uid;
  state.sessionValidatedAt = Date.now();

  const user = await executeKw("res.users", "read", [[uid], ["name", "login"]]);
  state.name = user?.[0]?.name || login;

  if (remember !== false) {
    await savePersistedSession();
  }

  return { uid, name: state.name, login: user?.[0]?.login || login };
}

async function executeKw(model, method, args = [], kwargs = {}) {
  await ensureAuthenticated();
  return callJsonRpc({
    jsonrpc: "2.0",
    method: "call",
    params: {
      service: "object",
      method: "execute_kw",
      args: [state.db, state.uid, state.password, model, method, args, kwargs],
    },
    id: Date.now(),
  });
}

function formatList(rows) {
  if (!rows || rows.length === 0) return "No results";
  return rows.join("\n");
}

function buildTaskDomain({ uid, projectId, state, mine = true, search }) {
  const domain = [];
  if (mine) domain.push(["user_ids", "=", uid]);
  if (projectId) domain.push(["project_id", "=", Number(projectId)]);
  if (state === "in_progress")
    domain.push(["stage_id.name", "ilike", "In Progress"]);
  if (state === "to_do") domain.push(["stage_id.name", "ilike", "To Do"]);
  if (state === "done") domain.push(["stage_id.name", "ilike", "Done"]);
  if (search) domain.push(["name", "ilike", search.toString()]);
  return domain;
}

async function resolveTaskStageId({ taskId, projectId, state, stageName }) {
  const targetName =
    stageName ||
    (state === "in_progress"
      ? "In Progress"
      : state === "to_do"
        ? "To Do"
        : state === "done"
          ? "Done"
          : null);
  if (!targetName) return null;

  const stages = await executeKw(
    "project.task.type",
    "search_read",
    [[["name", "ilike", targetName]]],
    {
      fields: ["id", "name", "project_ids"],
      limit: 50,
    },
  );

  if (!stages?.length) return null;

  const projectStage = stages.find(
    (s) => Array.isArray(s.project_ids) && s.project_ids.includes(projectId),
  );
  if (projectStage) return projectStage.id;

  const globalStage = stages.find(
    (s) => !s.project_ids || s.project_ids.length === 0,
  );
  if (globalStage) return globalStage.id;

  return stages[0].id;
}

const server = new Server(
  { name: "odoo-mcp", version: "2.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "odoo_login",
      description: "Login with your own Odoo credentials",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Odoo URL, eg https://odoo.company.com",
          },
          db: { type: "string", description: "Database name" },
          login: { type: "string", description: "User login/email" },
          password: { type: "string", description: "User password" },
          remember: {
            type: "boolean",
            description: "Persist session locally (default true)",
          },
        },
        required: ["login", "password"],
      },
    },
    {
      name: "odoo_session_status",
      description: "Check if there is an active or stored session",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "odoo_whoami",
      description: "Show current authenticated user/session",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "odoo_logout",
      description: "Clear in-memory and persisted session",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "odoo_get_projects",
      description: "List active projects",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "odoo_get_my_projects",
      description: "List projects where I have assigned tasks",
      inputSchema: { type: "object", properties: {} },
    },
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
      description: "List tickets/tasks with optional filters",
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
      description: "Get task details with assignees and metrics",
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
        },
        required: ["task_id", "gitlab_project_id"],
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
        },
        required: ["gitlab_task_branch_id"],
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
        },
        required: ["gitlab_task_branch_id"],
      },
    },
    {
      name: "odoo_create_timesheet",
      description: "Create a timesheet line for a task",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "number" },
          project_id: { type: "number" },
          date: { type: "string", description: "YYYY-MM-DD" },
          hours: { type: "number" },
          description: { type: "string" },
        },
        required: ["task_id", "project_id", "date", "hours", "description"],
      },
    },
    {
      name: "odoo_get_my_timesheets",
      description: "List my timesheet lines with optional filters",
      inputSchema: {
        type: "object",
        properties: {
          date: { type: "string", description: "Exact date YYYY-MM-DD" },
          date_from: { type: "string", description: "From date YYYY-MM-DD" },
          date_to: { type: "string", description: "To date YYYY-MM-DD" },
          project_id: { type: "number", description: "Filter by project ID" },
          task_id: { type: "number", description: "Filter by task ID" },
          limit: {
            type: "number",
            description: "Max results (default 100, max 500)",
          },
        },
      },
    },
    {
      name: "odoo_update_timesheet",
      description: "Update an existing timesheet line",
      inputSchema: {
        type: "object",
        properties: {
          timesheet_id: { type: "number" },
          date: { type: "string", description: "YYYY-MM-DD (optional)" },
          hours: { type: "number", description: "optional" },
          description: { type: "string", description: "optional" },
          task_id: { type: "number", description: "optional" },
          project_id: { type: "number", description: "optional" },
        },
        required: ["timesheet_id"],
      },
    },
    {
      name: "odoo_delete_timesheet",
      description: "Delete a timesheet line by ID",
      inputSchema: {
        type: "object",
        properties: {
          timesheet_id: { type: "number" },
        },
        required: ["timesheet_id"],
      },
    },
    {
      name: "odoo_create_timesheets_bulk",
      description: "Create many timesheet lines in one call",
      inputSchema: {
        type: "object",
        properties: {
          entries: {
            type: "array",
            items: {
              type: "object",
              properties: {
                task_id: { type: "number" },
                project_id: { type: "number" },
                date: { type: "string", description: "YYYY-MM-DD" },
                hours: { type: "number" },
                description: { type: "string" },
              },
              required: [
                "task_id",
                "project_id",
                "date",
                "hours",
                "description",
              ],
            },
          },
        },
        required: ["entries"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    if (
      name !== "odoo_login" &&
      name !== "odoo_session_status" &&
      name !== "odoo_logout"
    ) {
      await ensureAuthenticated();
    }

    switch (name) {
      case "odoo_login": {
        const auth = await authenticate({
          url: args.url,
          db: args.db,
          login: args.login,
          password: args.password,
          remember: args.remember,
        });
        return {
          content: [
            {
              type: "text",
              text: `Connected: ${auth.name} (${auth.login}) uid=${auth.uid} db=${state.db}`,
            },
          ],
        };
      }

      case "odoo_session_status": {
        try {
          await ensureAuthenticated();
          return {
            content: [
              {
                type: "text",
                text: `active=true login=${state.login} uid=${state.uid} db=${state.db} url=${state.url}`,
              },
            ],
          };
        } catch {
          await loadPersistedSession();
          const hasStored = Boolean(state.login && state.password);
          return {
            content: [
              {
                type: "text",
                text: `active=false stored=${hasStored}`,
              },
            ],
          };
        }
      }

      case "odoo_whoami": {
        return {
          content: [
            {
              type: "text",
              text: `Connected as ${state.name || state.login} (${state.login}) uid=${state.uid} db=${state.db} url=${state.url}`,
            },
          ],
        };
      }

      case "odoo_logout": {
        await clearPersistedSession();
        return { content: [{ type: "text", text: "Session cleared" }] };
      }

      case "odoo_get_projects": {
        const projects = await executeKw(
          "project.project",
          "search_read",
          [[["active", "=", true]]],
          {
            fields: ["id", "name"],
            limit: 100,
          },
        );
        return {
          content: [
            {
              type: "text",
              text: formatList(projects.map((p) => `[${p.id}] ${p.name}`)),
            },
          ],
        };
      }

      case "odoo_get_my_projects": {
        const tasks = await executeKw(
          "project.task",
          "search_read",
          [[["user_ids", "=", state.uid]]],
          {
            fields: ["project_id"],
            limit: 1000,
          },
        );

        const seen = new Map();
        for (const task of tasks || []) {
          const projectId = task?.project_id?.[0];
          const projectName = task?.project_id?.[1];
          if (!projectId || !projectName || seen.has(projectId)) continue;
          seen.set(projectId, projectName);
        }

        const list = [...seen.entries()]
          .sort((a, b) => a[1].localeCompare(b[1]))
          .map(([id, name]) => `[${id}] ${name}`);

        return { content: [{ type: "text", text: formatList(list) }] };
      }

      case "odoo_get_my_tasks": {
        const domain = buildTaskDomain({
          uid: state.uid,
          projectId: args.project_id,
          state: args.state,
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
                    `[${t.id}] ${t.name}\n   ${t.project_id?.[1] || "N/A"} - ${t.stage_id?.[1] || "N/A"}`,
                ),
              ),
            },
          ],
        };
      }

      case "odoo_get_tickets": {
        const mine = args.mine !== false;
        const parsedLimit = Number(args.limit || 100);
        const limit = Number.isNaN(parsedLimit)
          ? 100
          : Math.max(1, Math.min(500, parsedLimit));
        const domain = buildTaskDomain({
          uid: state.uid,
          projectId: args.project_id,
          state: args.state,
          mine,
          search: args.search,
        });

        const tasks = await executeKw("project.task", "search_read", [domain], {
          fields: [
            "id",
            "name",
            "project_id",
            "stage_id",
            "priority",
            "date_deadline",
          ],
          limit,
          order: "id desc",
        });

        const text = formatList(
          tasks.map(
            (t) =>
              `[${t.id}] ${t.name}\n   ${t.project_id?.[1] || "N/A"} - ${t.stage_id?.[1] || "N/A"} - priority:${t.priority || "0"} - deadline:${t.date_deadline || "N/A"}`,
          ),
        );

        return { content: [{ type: "text", text }] };
      }

      case "odoo_get_task_detail": {
        const taskId = Number(args.task_id);
        const rows = await executeKw("project.task", "read", [
          [taskId],
          [
            "id",
            "name",
            "project_id",
            "stage_id",
            "user_ids",
            "priority",
            "date_deadline",
            "task_category",
            "allocated_hours",
            "effective_hours",
            "progress",
            "gitlab_branch_ids",
          ],
        ]);

        if (!rows || rows.length === 0) {
          return { content: [{ type: "text", text: "Task not found" }] };
        }

        const t = rows[0];
        let assignees = "N/A";
        if (t.user_ids?.length) {
          const users = await executeKw("res.users", "read", [
            t.user_ids,
            ["name"],
          ]);
          assignees = users.map((u) => u.name).join(", ");
        }

        const text = [
          `Task #${t.id}: ${t.name}`,
          `Project: ${t.project_id?.[1] || "N/A"}`,
          `Stage: ${t.stage_id?.[1] || "N/A"}`,
          `Assignees: ${assignees}`,
          `Priority: ${t.priority}`,
          `Deadline: ${t.date_deadline || "N/A"}`,
          `Hours: ${t.effective_hours || 0}/${t.allocated_hours || 0}`,
          `Progress: ${t.progress || 0}%`,
          `Category: ${t.task_category || "N/A"}`,
          `GitLab branch ids: ${t.gitlab_branch_ids?.join(", ") || "none"}`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      }

      case "odoo_update_task": {
        const taskId = Number(args.task_id);
        const values = {};

        const currentRows = await executeKw("project.task", "read", [
          [taskId],
          ["id", "name", "project_id", "stage_id", "user_ids", "description"],
        ]);
        if (!currentRows || currentRows.length === 0) {
          return { content: [{ type: "text", text: "Task not found" }] };
        }
        const current = currentRows[0];
        const projectId = current.project_id?.[0];

        if (args.assignee_user_ids !== undefined) {
          const assigneeIds = Array.isArray(args.assignee_user_ids)
            ? args.assignee_user_ids
                .map((id) => Number(id))
                .filter((id) => !Number.isNaN(id))
            : [];
          values.user_ids = [[6, 0, assigneeIds]];
        }

        if (args.description !== undefined) {
          values.description = args.description;
        }

        if (args.stage_id !== undefined) {
          const stageId = Number(args.stage_id);
          if (!Number.isNaN(stageId)) values.stage_id = stageId;
        } else if (args.stage_name || args.state) {
          const resolvedStageId = await resolveTaskStageId({
            taskId,
            projectId,
            state: args.state,
            stageName: args.stage_name,
          });

          if (!resolvedStageId) {
            return {
              content: [
                {
                  type: "text",
                  text: `Could not resolve stage for state=${args.state || "N/A"} stage_name=${args.stage_name || "N/A"}`,
                },
              ],
            };
          }

          values.stage_id = resolvedStageId;
        }

        if (Object.keys(values).length === 0) {
          return { content: [{ type: "text", text: "Nothing to update" }] };
        }

        const ok = await executeKw("project.task", "write", [[taskId], values]);
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
          `Project: ${updated?.project_id?.[1] || "N/A"}`,
          `Stage: ${updated?.stage_id?.[1] || "N/A"}`,
          `Assignees: ${assignees}`,
          `Description: ${updated?.description ? "updated" : "empty"}`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      }

      case "odoo_get_task_gitlab_branches": {
        const taskId = Number(args.task_id);
        const rows = await executeKw("project.task", "read", [
          [taskId],
          ["gitlab_branch_ids", "name"],
        ]);
        if (!rows || rows.length === 0) {
          return { content: [{ type: "text", text: "Task not found" }] };
        }

        const branchIds = rows[0].gitlab_branch_ids || [];
        if (branchIds.length === 0) {
          return {
            content: [
              { type: "text", text: "No GitLab branches linked to this task" },
            ],
          };
        }

        const branches = await executeKw("gitlab.task.branch", "read", [
          branchIds,
          [
            "id",
            "gitlab_branch_name",
            "gitlab_origin_project_id",
            "target_branch",
            "from_branch",
            "gitlab_link",
            "merge_request_link",
            "gitlab_user_id",
          ],
        ]);

        const text = formatList(
          branches.map((b) => {
            const project = b.gitlab_origin_project_id?.[1] || "N/A";
            const owner = b.gitlab_user_id?.[1] || "N/A";
            return [
              `[${b.id}] ${project}`,
              `   branch: ${b.gitlab_branch_name || "N/A"}`,
              `   from -> target: ${b.from_branch || "N/A"} -> ${b.target_branch || "N/A"}`,
              `   author: ${owner}`,
              `   link: ${b.gitlab_link || "N/A"}`,
              `   mr: ${b.merge_request_link || "none"}`,
            ].join("\n");
          }),
        );

        return { content: [{ type: "text", text }] };
      }

      case "odoo_gitlab_list_projects": {
        const query = (args.query || "").toString();
        const limit = Number(args.limit || 20);
        const rows = await executeKw("gitlab.project", "name_search", [
          query,
          [],
          "ilike",
          limit,
        ]);
        const text = formatList((rows || []).map((r) => `[${r[0]}] ${r[1]}`));
        return { content: [{ type: "text", text }] };
      }

      case "odoo_gitlab_list_users": {
        const query = (args.query || "").toString();
        const limit = Number(args.limit || 20);
        const rows = await executeKw("res.users", "name_search", [
          query,
          [],
          "ilike",
          limit,
        ]);
        const text = formatList((rows || []).map((r) => `[${r[0]}] ${r[1]}`));
        return { content: [{ type: "text", text }] };
      }

      case "odoo_gitlab_add_task_branch": {
        const taskId = Number(args.task_id);
        const gitlabProjectId = Number(args.gitlab_project_id);
        const reviewerUserId = Number(args.reviewer_user_id || state.uid);
        const fromBranch = (args.from_branch || "uat").toString();
        const targetBranch = (args.target_branch || "uat").toString();

        const task = await executeKw("project.task", "read", [
          [taskId],
          ["id", "name"],
        ]);
        if (!task || task.length === 0) {
          return { content: [{ type: "text", text: "Task not found" }] };
        }

        const fallbackSlug = task[0].name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/(^-|-$)/g, "")
          .slice(0, 40);
        const defaultBranchName = `odoo/${taskId}-${fallbackSlug || "task"}`;
        const branchName = (args.branch_name || defaultBranchName).toString();

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
          [
            "id",
            "gitlab_origin_project_id",
            "gitlab_branch_name",
            "from_branch",
            "target_branch",
            "gitlab_user_id",
            "gitlab_link",
            "merge_request_link",
          ],
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
      }

      case "odoo_gitlab_create_branch": {
        const gitlabTaskBranchId = Number(args.gitlab_task_branch_id);
        const currentRow = await executeKw("gitlab.task.branch", "read", [
          [gitlabTaskBranchId],
          ["id", "gitlab_branch_name"],
        ]);
        const baseName =
          currentRow?.[0]?.gitlab_branch_name ||
          `odoo/branch-${gitlabTaskBranchId}`;

        let result = false;
        let attempts = 0;
        let renamed = false;
        const maxAttempts = 8;

        while (attempts < maxAttempts) {
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
              throw err;
            }

            attempts += 1;
            renamed = true;
            const suffix = attempts + 1;
            let nextName = `${baseName}-${suffix}`;
            if (nextName.length > 120) {
              nextName = `${baseName.slice(0, 110)}-${suffix}`;
            }

            await executeKw("gitlab.task.branch", "write", [
              [gitlabTaskBranchId],
              { gitlab_branch_name: nextName },
            ]);
          }
        }

        if (attempts >= maxAttempts && !result) {
          throw new Error(
            "Could not create branch after multiple retries (name collision).",
          );
        }

        const row = await executeKw("gitlab.task.branch", "read", [
          [gitlabTaskBranchId],
          ["id", "gitlab_link", "merge_request_link", "gitlab_branch_name"],
        ]);
        const r = row?.[0];
        const text = [
          `create_branch result: ${result}`,
          `branch_id: ${gitlabTaskBranchId}`,
          `renamed_on_conflict: ${renamed}`,
          `retry_count: ${attempts}`,
          `branch_name: ${r?.gitlab_branch_name || "N/A"}`,
          `gitlab_link: ${r?.gitlab_link || "N/A"}`,
        ].join("\n");
        return { content: [{ type: "text", text }] };
      }

      case "odoo_gitlab_create_merge_request": {
        const gitlabTaskBranchId = Number(args.gitlab_task_branch_id);
        const result = await executeKw(
          "gitlab.task.branch",
          "create_merge_request",
          [[gitlabTaskBranchId]],
          {},
        );
        const row = await executeKw("gitlab.task.branch", "read", [
          [gitlabTaskBranchId],
          ["id", "gitlab_link", "merge_request_link", "gitlab_branch_name"],
        ]);
        const r = row?.[0];
        const text = [
          `create_merge_request result: ${result}`,
          `branch_id: ${gitlabTaskBranchId}`,
          `branch_name: ${r?.gitlab_branch_name || "N/A"}`,
          `gitlab_link: ${r?.gitlab_link || "N/A"}`,
          `merge_request_link: ${r?.merge_request_link || "N/A"}`,
        ].join("\n");
        return { content: [{ type: "text", text }] };
      }

      case "odoo_create_timesheet": {
        const employees = await executeKw(
          "hr.employee",
          "search_read",
          [[["user_id", "=", state.uid]]],
          {
            fields: ["id"],
            limit: 1,
          },
        );

        if (!employees?.length) {
          return {
            content: [
              { type: "text", text: "No employee found for current user" },
            ],
          };
        }

        const timesheetId = await executeKw("account.analytic.line", "create", [
          {
            date: args.date,
            employee_id: employees[0].id,
            project_id: args.project_id,
            task_id: args.task_id,
            name: args.description,
            unit_amount: args.hours,
            user_id: state.uid,
          },
        ]);

        return {
          content: [
            { type: "text", text: `Timesheet created: ${timesheetId}` },
          ],
        };
      }

      case "odoo_get_my_timesheets": {
        const parsedLimit = Number(args.limit || 100);
        const limit = Number.isNaN(parsedLimit)
          ? 100
          : Math.max(1, Math.min(500, parsedLimit));

        const domain = [["user_id", "=", state.uid]];
        if (args.date) {
          domain.push(["date", "=", args.date]);
        } else {
          if (args.date_from) domain.push(["date", ">=", args.date_from]);
          if (args.date_to) domain.push(["date", "<=", args.date_to]);
        }
        if (args.project_id)
          domain.push(["project_id", "=", Number(args.project_id)]);
        if (args.task_id) domain.push(["task_id", "=", Number(args.task_id)]);

        const rows = await executeKw(
          "account.analytic.line",
          "search_read",
          [domain],
          {
            fields: [
              "id",
              "date",
              "unit_amount",
              "name",
              "project_id",
              "task_id",
            ],
            limit,
            order: "date desc, id desc",
          },
        );

        const totalHours = (rows || []).reduce(
          (acc, row) => acc + (Number(row.unit_amount) || 0),
          0,
        );
        const lines = (rows || []).map((r) => {
          const project = r.project_id?.[1] || "N/A";
          const task = r.task_id?.[1] || "N/A";
          return `[${r.id}] ${r.date} - ${r.unit_amount || 0}h\n   ${project} / ${task}\n   ${r.name || ""}`;
        });

        const text = rows?.length
          ? [
              `Total hours: ${totalHours}`,
              `Entries: ${rows.length}`,
              "",
              ...lines,
            ].join("\n")
          : "No results";

        return { content: [{ type: "text", text }] };
      }

      case "odoo_update_timesheet": {
        const timesheetId = Number(args.timesheet_id);
        const values = {};

        if (args.date !== undefined) values.date = args.date;
        if (args.hours !== undefined) values.unit_amount = args.hours;
        if (args.description !== undefined) values.name = args.description;
        if (args.task_id !== undefined) values.task_id = args.task_id;
        if (args.project_id !== undefined) values.project_id = args.project_id;

        if (Object.keys(values).length === 0) {
          return { content: [{ type: "text", text: "Nothing to update" }] };
        }

        const ok = await executeKw("account.analytic.line", "write", [
          [timesheetId],
          values,
        ]);
        if (!ok) {
          return { content: [{ type: "text", text: "Update failed" }] };
        }

        const updated = await executeKw("account.analytic.line", "read", [
          [timesheetId],
          ["id", "name", "date", "unit_amount", "project_id", "task_id"],
        ]);
        const row = updated?.[0];
        return {
          content: [
            {
              type: "text",
              text: row
                ? `Timesheet updated: [${row.id}] ${row.date} ${row.unit_amount}h ${row.name}`
                : `Timesheet updated: ${timesheetId}`,
            },
          ],
        };
      }

      case "odoo_delete_timesheet": {
        const timesheetId = Number(args.timesheet_id);
        const ok = await executeKw("account.analytic.line", "unlink", [
          [timesheetId],
        ]);
        return {
          content: [
            {
              type: "text",
              text: ok ? `Timesheet deleted: ${timesheetId}` : "Delete failed",
            },
          ],
        };
      }

      case "odoo_create_timesheets_bulk": {
        const entries = Array.isArray(args.entries) ? args.entries : [];
        if (entries.length === 0) {
          return { content: [{ type: "text", text: "No entries provided" }] };
        }

        const employees = await executeKw(
          "hr.employee",
          "search_read",
          [[["user_id", "=", state.uid]]],
          {
            fields: ["id"],
            limit: 1,
          },
        );

        if (!employees?.length) {
          return {
            content: [
              { type: "text", text: "No employee found for current user" },
            ],
          };
        }

        const employeeId = employees[0].id;
        const createdIds = [];
        const failed = [];

        for (let i = 0; i < entries.length; i += 1) {
          const e = entries[i];
          try {
            const id = await executeKw("account.analytic.line", "create", [
              {
                date: e.date,
                employee_id: employeeId,
                project_id: e.project_id,
                task_id: e.task_id,
                name: e.description,
                unit_amount: e.hours,
                user_id: state.uid,
              },
            ]);
            createdIds.push(id);
          } catch (err) {
            failed.push({ index: i, message: err.message });
          }
        }

        return {
          content: [
            {
              type: "text",
              text: [
                `Bulk create finished`,
                `Created: ${createdIds.length}`,
                `IDs: ${createdIds.join(", ") || "none"}`,
                `Failed: ${failed.length}`,
                ...failed.map((f) => `- entry ${f.index}: ${f.message}`),
              ].join("\n"),
            },
          ],
        };
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
    }
  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
