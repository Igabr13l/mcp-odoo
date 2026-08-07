function definitions() {
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
  ];
}

export function createSessionTools(client) {
  return {
    definitions: definitions(),
    handlers: {
      async odoo_login(args) {
        const auth = await client.authenticate(args);
        const session = await client.getSession();
        return {
          content: [{ type: "text", text: `Connected: ${auth.name} (${auth.login}) uid=${auth.uid} db=${session.db}` }],
        };
      },
      async odoo_session_status() {
        const session = await client.getSession();
        const text = session.active
          ? `active=true login=${session.login} uid=${session.uid} db=${session.db} url=${session.url}`
          : `active=false stored=${session.stored}`;
        return { content: [{ type: "text", text }] };
      },
      async odoo_whoami() {
        await client.ensureAuthenticated();
        const session = await client.getSession();
        return {
          content: [{ type: "text", text: `Connected as ${session.name || session.login} (${session.login}) uid=${session.uid} db=${session.db} url=${session.url}` }],
        };
      },
      async odoo_logout() {
        await client.logout();
        return { content: [{ type: "text", text: "Session cleared" }] };
      },
    },
  };
}
