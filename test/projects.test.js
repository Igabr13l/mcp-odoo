import assert from "node:assert/strict";
import test from "node:test";
import { createProjectTools } from "../src/tools/projects.js";

function buildTools({ executeKw, getUid }) {
  return createProjectTools({ executeKw, getUid });
}

test("definitions expose the public project schemas", () => {
  const tools = buildTools({ executeKw: async () => [], getUid: () => 16 });
  assert.deepEqual(
    tools.definitions.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
    [
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
    ],
  );
});

test("odoo_get_projects lists active projects", async () => {
  const calls = [];
  const tools = buildTools({
    getUid: () => 16,
    executeKw: async (model, method, args, kwargs) => {
      calls.push({ model, method, args, kwargs });
      return [
        { id: 1, name: "Platform" },
        { id: 2, name: "Backend" },
      ];
    },
  });

  const result = await tools.handlers.odoo_get_projects({});

  assert.equal(result.content[0].text, "[1] Platform\n[2] Backend");
  assert.deepEqual(calls, [
    {
      model: "project.project",
      method: "search_read",
      args: [[["active", "=", true]]],
      kwargs: { fields: ["id", "name"], limit: 100 },
    },
  ]);
});

test("odoo_get_my_projects dedupes, sorts and uses getUid", async () => {
  const calls = [];
  const tools = buildTools({
    getUid: () => 16,
    executeKw: async (model, method, args, kwargs) => {
      calls.push({ model, method, args, kwargs });
      return [
        { project_id: [1, "Zeta"] },
        { project_id: [2, "Alpha"] },
        { project_id: [2, "Alpha"] },
        { project_id: [null, null] },
        { project_id: [3, null] },
      ];
    },
  });

  const result = await tools.handlers.odoo_get_my_projects({});

  assert.equal(result.content[0].text, "[2] Alpha\n[1] Zeta");
  assert.deepEqual(calls, [
    {
      model: "project.task",
      method: "search_read",
      args: [[["user_ids", "=", 16]]],
      kwargs: { fields: ["project_id"], limit: 1000 },
    },
  ]);
});

test("odoo_get_my_projects returns empty list message", async () => {
  const tools = buildTools({
    getUid: () => 16,
    executeKw: async () => [],
  });

  const result = await tools.handlers.odoo_get_my_projects({});

  assert.equal(result.content[0].text, "No results");
});
