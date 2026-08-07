import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createOdooClient } from "./odoo/client.js";
import { createBoardTools } from "./tools/board.js";
import { createGitLabTools } from "./tools/gitlab.js";
import { createGitLabStatusTools } from "./tools/gitlab-status.js";
import { createProjectTools } from "./tools/projects.js";
import { createSessionTools } from "./tools/session.js";
import { createTaskTools } from "./tools/tasks.js";
import { createTicketContentTools } from "./tools/ticket-content.js";
import { createTimesheetTools } from "./tools/timesheets.js";

const client = createOdooClient();
const dependencies = {
  executeKw: client.executeKw,
  getAvailableFields: client.getAvailableFields,
  getNameMap: client.getNameMap,
  getSelectionLabelMap: client.getSelectionLabelMap,
  getUid: client.getUid,
};
const toolGroups = [
  createSessionTools(client),
  createProjectTools(dependencies),
  createTaskTools(dependencies),
  createTicketContentTools(dependencies),
  createBoardTools(dependencies),
  createGitLabTools(dependencies),
  createGitLabStatusTools(dependencies),
  createTimesheetTools(dependencies),
];

function createToolRegistry(groups) {
  const definitions = [];
  const handlers = new Map();
  for (const group of groups) {
    for (const definition of group.definitions) {
      if (handlers.has(definition.name)) {
        throw new Error(`Duplicate tool definition: ${definition.name}`);
      }
      const handler = group.handlers[definition.name];
      if (!handler) throw new Error(`Missing handler for tool: ${definition.name}`);
      definitions.push(definition);
      handlers.set(definition.name, handler);
    }
  }
  return { definitions, handlers };
}

const registry = createToolRegistry(toolGroups);
const server = new Server(
  { name: "odoo-mcp", version: "2.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: registry.definitions,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const handler = registry.handlers.get(name);
  if (!handler) {
    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
    };
  }
  try {
    if (
      name !== "odoo_login" &&
      name !== "odoo_session_status" &&
      name !== "odoo_logout"
    ) {
      await client.ensureAuthenticated();
    }
    return await handler(args);
  } catch (error) {
    return {
      isError: true,
      content: [
        { type: "text", text: `Error: ${error?.message || String(error)}` },
      ],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
