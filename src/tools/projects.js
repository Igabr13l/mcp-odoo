import { formatList } from "../utils/format.js";

export function createProjectTools({ executeKw, getUid }) {
  return {
    definitions: [
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
    handlers: {
      async odoo_get_projects() {
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
      },

      async odoo_get_my_projects() {
        const tasks = await executeKw(
          "project.task",
          "search_read",
          [[["user_ids", "=", getUid()]]],
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
      },
    },
  };
}
