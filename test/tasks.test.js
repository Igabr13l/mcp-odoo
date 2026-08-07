import assert from "node:assert/strict";
import test from "node:test";
const { createTaskTools } = await import("../src/tools/tasks.js");

function makeTools({ routes = {}, deps = {} } = {}) {
  const calls = [];
  const executeKw = async (model, method, args, kwargs) => {
    calls.push({ model, method, args, kwargs });
    const handler = routes[`${model}:${method}`];
    if (handler) return handler(args, kwargs);
    throw new Error(`Unexpected executeKw call: ${model}.${method}`);
  };
  const tools = createTaskTools({
    executeKw,
    getUid: () => 16,
    getAvailableFields: async (_model, fields) => fields,
    getSelectionLabelMap: async () => new Map(),
    getNameMap: async () => new Map(),
    ...deps,
  });
  return { tools, calls };
}

test("definitions expose the public task schemas", () => {
  const { tools } = makeTools();
  assert.deepEqual(
    tools.definitions.map(({ name, inputSchema }) => ({ name, inputSchema })),
    [
      {
        name: "odoo_get_my_tasks",
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
  );
});

test("odoo_get_my_tasks builds an exact stage-name domain", async () => {
  const { tools, calls } = makeTools({
    routes: {
      "project.task:search_read": (args, kwargs) => {
        assert.deepEqual(kwargs, {
          fields: ["id", "name", "project_id", "stage_id"],
          limit: 100,
        });
        return [
          { id: 10, name: "Task A", project_id: [7, "Project X"], stage_id: [5, "To Do"] },
        ];
      },
    },
  });

  const result = await tools.handlers.odoo_get_my_tasks({
    project_id: 7,
    state: "to_do",
  });

  assert.equal(
    result.content[0].text,
    "[10] Task A\n   Project X - To Do",
  );
  const taskCall = calls.find(
    (c) => c.model === "project.task" && c.method === "search_read",
  );
  assert.deepEqual(taskCall.args[0], [
    ["user_ids", "=", 16],
    ["project_id", "=", 7],
    ["stage_id.name", "=ilike", "To Do"],
  ]);
});

test("odoo_get_my_tasks without state does not resolve stages", async () => {
  const { tools, calls } = makeTools({
    routes: {
      "project.task:search_read": () => [],
    },
  });

  await tools.handlers.odoo_get_my_tasks({});

  assert.equal(
    calls.some((c) => c.model === "project.task.type"),
    false,
  );
  assert.deepEqual(
    calls.find((c) => c.model === "project.task").args[0],
    [["user_ids", "=", 16]],
  );
});

test("odoo_get_my_tasks validates project_id as a positive integer", async () => {
  const { tools } = makeTools();
  await assert.rejects(
    tools.handlers.odoo_get_my_tasks({ project_id: "abc" }),
    /project_id must be a positive integer/,
  );
});

test("odoo_get_my_tasks rejects unknown state shortcut", async () => {
  const { tools } = makeTools();
  await assert.rejects(
    tools.handlers.odoo_get_my_tasks({ state: "inprogress" }),
    /Unknown state shortcut: "inprogress"/,
  );
});

test("odoo_get_tickets renders priority, tags and deadline", async () => {
  const { tools, calls } = makeTools({
    deps: {
      getSelectionLabelMap: async (model, field) =>
        model === "project.task" && field === "priority"
          ? new Map([["1", "High"], ["2", "Low"]])
          : new Map([["3", "Urgent"]]),
      getNameMap: async (model) =>
        model === "project.tags" ? new Map([[10, "bug"], [11, "ui"]]) : new Map(),
    },
    routes: {
      "project.task:search_read": (args, kwargs) => {
        assert.equal(kwargs.limit, 100);
        assert.equal(kwargs.order, "id desc");
        assert.deepEqual(args[0], [
          ["user_ids", "=", 16],
        ]);
        return [
          {
            id: 1,
            name: "T",
            project_id: [7, "P"],
            stage_id: [5, "To Do"],
            priority: "1",
            tag_ids: [10, 11],
            date_deadline: "2026-01-01",
          },
          {
            id: 2,
            name: "U",
            project_id: [7, "P"],
            stage_id: [5, "To Do"],
            task_priority: "3",
            tag_ids: [],
            date_deadline: null,
          },
        ];
      },
    },
  });

  const result = await tools.handlers.odoo_get_tickets({});

  assert.equal(
    result.content[0].text,
    [
      "[1] T",
      "   P - To Do - priority:High - tags:bug, ui - deadline:2026-01-01",
      "[2] U",
      "   P - To Do - priority:Urgent - tags:none - deadline:N/A",
    ].join("\n"),
  );
  assert.equal(calls[0].model, "project.task");
});

test("odoo_get_tickets clamps limit and supports mine=false", async () => {
  const { tools, calls } = makeTools({
    routes: {
      "project.task:search_read": (args, kwargs) => {
        assert.equal(kwargs.limit, 500);
        assert.deepEqual(args[0], []);
        return [];
      },
    },
  });

  await tools.handlers.odoo_get_tickets({ mine: false, limit: 1000 });

  const taskCall = calls.find(
    (c) => c.model === "project.task" && c.method === "search_read",
  );
  assert.deepEqual(taskCall.args[0], []);
});

test("odoo_get_tickets applies search filter and state resolution", async () => {
  const { tools, calls } = makeTools({
    routes: {
      "project.task:search_read": () => [],
    },
  });

  await tools.handlers.odoo_get_tickets({
    state: "in_progress",
    search: "whatsapp",
  });

  const taskCall = calls.find(
    (c) => c.model === "project.task" && c.method === "search_read",
  );
  assert.deepEqual(taskCall.args[0], [
    ["user_ids", "=", 16],
    ["stage_id.name", "=ilike", "In Progress"],
    ["name", "ilike", "whatsapp"],
  ]);
});

test("odoo_get_tickets rejects invalid project_id", async () => {
  const { tools } = makeTools();
  await assert.rejects(
    tools.handlers.odoo_get_tickets({ project_id: -1 }),
    /project_id must be a positive integer/,
  );
});

test("odoo_get_task_detail renders progress as percent without scaling", async () => {
  const { tools } = makeTools({
    routes: {
      "project.task:read": () => [
        {
          id: 42,
          name: "Task",
          project_id: [7, "P"],
          stage_id: [5, "To Do"],
          user_ids: [],
          tag_ids: [],
          progress: 42,
          effective_hours: 2,
          allocated_hours: 8,
          description: "<p>api key: abc-123</p>",
          gitlab_branch_ids: [],
        },
      ],
    },
  });

  const result = await tools.handlers.odoo_get_task_detail({ task_id: 42 });

  const text = result.content[0].text;
  assert.match(text, /Progress: 42%/);
  assert.doesNotMatch(text, /4200%/);
  assert.match(text, /api key: \[REDACTED\]/);
  assert.match(text, /Hours: 2\/8/);
});

test("odoo_get_task_detail defaults progress to 0", async () => {
  const { tools } = makeTools({
    routes: {
      "project.task:read": () => [
        { id: 1, name: "T", progress: null },
      ],
    },
  });

  const result = await tools.handlers.odoo_get_task_detail({ task_id: 1 });
  assert.match(result.content[0].text, /Progress: 0%/);
});

test("odoo_get_task_detail returns Task not found", async () => {
  const { tools } = makeTools({
    routes: { "project.task:read": () => [] },
  });
  const result = await tools.handlers.odoo_get_task_detail({ task_id: 99 });
  assert.equal(result.content[0].text, "Task not found");
});

test("odoo_get_task_detail validates task_id", async () => {
  const { tools } = makeTools();
  await assert.rejects(
    tools.handlers.odoo_get_task_detail({ task_id: 0 }),
    /task_id must be a positive integer/,
  );
});

function updateTools({ current, updated = current, stages = [] }) {
  let readCount = 0;
  return makeTools({
    routes: {
      "project.task.type:search_read": () => stages,
      "project.task:read": () => {
        readCount += 1;
        return readCount === 1 ? [current] : [updated];
      },
      "project.task:write": () => true,
      "res.users:read": () => [{ id: 16, name: "Gabriel" }],
    },
  });
}

test("odoo_update_task prefers project-specific stage over global", async () => {
  const current = {
    id: 10,
    name: "Task A",
    project_id: [7, "P"],
    stage_id: [5, "To Do"],
    user_ids: [16],
    description: "old",
  };
  const { tools, calls } = updateTools({
    current,
    updated: {
      ...current,
      stage_id: [8, "To Do"],
      description: "new",
    },
    stages: [
      { id: 5, name: "To Do", project_ids: [] },
      { id: 8, name: "To Do", project_ids: [7] },
    ],
  });

  const result = await tools.handlers.odoo_update_task({
    task_id: 10,
    state: "to_do",
    description: "new",
  });

  const writeCall = calls.find(
    (c) => c.model === "project.task" && c.method === "write",
  );
  assert.deepEqual(writeCall.args[1], { stage_id: 8, description: "new" });
  assert.equal(
    result.content[0].text,
    [
      "Task updated: #10 Task A",
      "Project: P",
      "Stage: To Do",
      "Assignees: Gabriel",
      "Description: updated",
    ].join("\n"),
  );
});

test("odoo_update_task falls back to a single global stage", async () => {
  const current = {
    id: 10,
    name: "Task A",
    project_id: [7, "P"],
    stage_id: [5, "To Do"],
    user_ids: [],
    description: "",
  };
  const { tools, calls } = updateTools({
    current,
    stages: [
      { id: 5, name: "To Do", project_ids: [] },
      { id: 9, name: "In Progress", project_ids: [3] },
    ],
  });

  await tools.handlers.odoo_update_task({ task_id: 10, state: "to_do" });

  const writeCall = calls.find(
    (c) => c.model === "project.task" && c.method === "write",
  );
  assert.deepEqual(writeCall.args[1], { stage_id: 5 });
});

test("odoo_update_task throws on ambiguous global stages", async () => {
  const current = {
    id: 10,
    name: "Task A",
    project_id: [7, "P"],
    user_ids: [],
    description: "",
  };
  const { tools } = updateTools({
    current,
    stages: [
      { id: 1, name: "Done", project_ids: [] },
      { id: 2, name: "Done", project_ids: [] },
    ],
  });

  await assert.rejects(
    tools.handlers.odoo_update_task({ task_id: 10, state: "done" }),
    /Ambiguous stage "Done"/,
  );
});

test("odoo_update_task throws when stage is not found", async () => {
  const current = {
    id: 10,
    name: "Task A",
    project_id: [7, "P"],
    user_ids: [],
    description: "",
  };
  const { tools } = updateTools({ current, stages: [] });

  await assert.rejects(
    tools.handlers.odoo_update_task({ task_id: 10, stage_name: "Review" }),
    /Stage not found: "Review"/,
  );
});

test("odoo_update_task uses stage_id directly without stage lookup", async () => {
  const current = {
    id: 10,
    name: "Task A",
    project_id: [7, "P"],
    user_ids: [],
    description: "",
  };
  const { tools, calls } = updateTools({ current });

  await tools.handlers.odoo_update_task({ task_id: 10, stage_id: 9 });

  assert.equal(
    calls.some((c) => c.model === "project.task.type"),
    false,
  );
  const writeCall = calls.find(
    (c) => c.model === "project.task" && c.method === "write",
  );
  assert.deepEqual(writeCall.args[1], { stage_id: 9 });
});

test("odoo_update_task filters assignees to positive integers", async () => {
  const current = {
    id: 10,
    name: "Task A",
    project_id: [7, "P"],
    user_ids: [16],
    description: "",
  };
  const { tools, calls } = updateTools({ current });

  await tools.handlers.odoo_update_task({
    task_id: 10,
    assignee_user_ids: [16, "abc", 0, -5, 17],
  });

  const writeCall = calls.find(
    (c) => c.model === "project.task" && c.method === "write",
  );
  assert.deepEqual(writeCall.args[1], { user_ids: [[6, 0, [16, 17]]] });
});

test("odoo_update_task returns Task not found", async () => {
  const { tools } = makeTools({
    routes: { "project.task:read": () => [] },
  });
  const result = await tools.handlers.odoo_update_task({ task_id: 404 });
  assert.equal(result.content[0].text, "Task not found");
});

test("odoo_update_task returns Nothing to update", async () => {
  const current = {
    id: 10,
    name: "Task A",
    project_id: [7, "P"],
    user_ids: [],
    description: "",
  };
  const { tools } = updateTools({ current });
  const result = await tools.handlers.odoo_update_task({ task_id: 10 });
  assert.equal(result.content[0].text, "Nothing to update");
});

test("odoo_update_task validates task_id", async () => {
  const { tools } = makeTools();
  await assert.rejects(
    tools.handlers.odoo_update_task({ task_id: -3 }),
    /task_id must be a positive integer/,
  );
});
