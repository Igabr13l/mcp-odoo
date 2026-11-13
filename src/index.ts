import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolArguments } from "./contracts.js";
import { errorMessage, isRecord } from "./contracts.js";
import { createOdooClient } from "./odoo/client.js";
import { createBoardTools } from "./tools/board.js";
import { createGitLabTools } from "./tools/gitlab.js";
import { createGitLabStatusTools } from "./tools/gitlab-status.js";
import { createKnowledgeTools } from "./tools/knowledge.js";
import { createKnowledgeExtrasTools } from "./tools/knowledge-extras.js";
import { createProjectTools } from "./tools/projects.js";
import { createSessionTools } from "./tools/session.js";
import { createTaskTools } from "./tools/tasks.js";
import { createTicketContentTools } from "./tools/ticket-content.js";
import { createTicketContextTools } from "./tools/ticket-context.js";
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
  createTicketContextTools(dependencies),
  createBoardTools(dependencies),
  createGitLabTools(dependencies),
  createGitLabStatusTools(dependencies),
  createKnowledgeTools(dependencies),
  createKnowledgeExtrasTools(dependencies),
  createTimesheetTools(dependencies),
];

interface ToolGroup {
  definitions: Tool[];
  handlers: Record<string, (args: ToolArguments) => Promise<CallToolResult>>;
}

function createToolRegistry(groups: ToolGroup[]) {
  const definitions: Tool[] = [];
  const handlers = new Map<
    string,
    (args: ToolArguments) => Promise<CallToolResult>
  >();
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
  { name: "odoo-mcp", version: "2.1.0" },
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
    const details = isRecord(error) ? error : {};
    const errorDetails = {
      code: details.code || "UNEXPECTED_ERROR",
      message: errorMessage(error),
      outcome: details.outcome || "failed",
      retryable: details.retryable === true,
      verification_required: details.verificationRequired === true,
    };
    const verificationHint = errorDetails.verification_required
      ? " Outcome is uncertain; verify the remote state before retrying."
      : "";
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Error [${errorDetails.code}]: ${errorDetails.message}.${verificationHint}`,
        },
      ],
      structuredContent: { error: errorDetails },
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
