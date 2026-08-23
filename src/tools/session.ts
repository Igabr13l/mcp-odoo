import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { OdooRecord } from "../contracts.js";
import type { OdooClient } from "../odoo/client.js";
import { defineToolGroup } from "../contracts.js";

function definitions(): Tool[] {
  return [
    {
      name: "odoo_login",
      description: "Login with your own Odoo credentials",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Odoo URL, eg https://odoo.company.com" },
          db: { type: "string", description: "Database name" },
          login: { type: "string", description: "User login/email" },
          password: { type: "string", description: "User password" },
          remember: { type: "boolean", description: "Persist session locally (default true)" },
        },
        required: ["login", "password"],
      },
    },
    {
      name: "odoo_session_status",
      description: "Check if credentials are loaded, stored, and verified in this process",
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
  ];
}

export function createSessionTools(
  client: Pick<
    OdooClient,
    | "authenticate"
    | "ensureAuthenticated"
    | "executeKw"
    | "getSession"
    | "logout"
  >,
) {
  return defineToolGroup({
    definitions: definitions(),
    handlers: {
      async odoo_login(args) {
        const auth = await client.authenticate(args as {
          url?: string;
          db?: string;
          login: string;
          password: string;
          remember?: boolean;
        });
        const session = await client.getSession();
        return {
          content: [{ type: "text", text: `Connected: ${auth.name} (${auth.login}) uid=${auth.uid} db=${session.db}` }],
        };
      },
      async odoo_session_status(_args) {
        const session = await client.getSession();
        const text = `active=${session.active} stored=${session.stored} verified=${session.verified} login=${session.login || "none"} uid=${session.uid ?? "none"} db=${session.db || "none"} url=${session.url || "none"}`;
        return {
          content: [{ type: "text", text }],
          structuredContent: session,
        };
      },
      async odoo_whoami(_args) {
        await client.ensureAuthenticated();
        const currentSession = await client.getSession();
        const users = await client.executeKw<OdooRecord[]>(
          "res.users",
          "read",
          [[currentSession.uid], ["name", "login"]],
        );
        const session = await client.getSession();
        const user = users?.[0] || {};
        return {
          content: [{ type: "text", text: `Connected as ${user.name || session.name || session.login} (${user.login || session.login}) uid=${session.uid} db=${session.db} url=${session.url} verified=${session.verified}` }],
          structuredContent: session,
        };
      },
      async odoo_logout(_args) {
        await client.logout();
        return { content: [{ type: "text", text: "Session cleared" }] };
      },
    },
  });
}
