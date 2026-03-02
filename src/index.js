import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const DEFAULT_URL = process.env.ODOO_URL || 'https://odoo.solunika.com';
const DEFAULT_DB = process.env.ODOO_DB || 'solunika';

const state = {
  url: DEFAULT_URL,
  db: DEFAULT_DB,
  uid: null,
  login: null,
  password: null,
  name: null,
};

async function callJsonRpc(payload) {
  const response = await fetch(`${state.url}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (data.error) {
    throw new Error(data.error.data?.message || data.error.message || 'Odoo Server Error');
  }
  return data.result;
}

async function authenticate({ url, db, login, password }) {
  if (url) state.url = url.replace(/\/$/, '');
  if (db) state.db = db;
  state.login = login;
  state.password = password;

  const uid = await callJsonRpc({
    jsonrpc: '2.0',
    method: 'call',
    params: {
      service: 'common',
      method: 'authenticate',
      args: [state.db, login, password, {}],
    },
    id: Date.now(),
  });

  if (!uid) {
    throw new Error('Authentication failed');
  }

  state.uid = uid;

  const user = await executeKw('res.users', 'read', [[uid], ['name', 'login']]);
  state.name = user?.[0]?.name || login;
  return { uid, name: state.name, login: user?.[0]?.login || login };
}

function assertAuthenticated() {
  if (!state.uid || !state.login || !state.password) {
    throw new Error('Not authenticated. Run odoo_login first.');
  }
}

async function executeKw(model, method, args = [], kwargs = {}) {
  assertAuthenticated();
  return callJsonRpc({
    jsonrpc: '2.0',
    method: 'call',
    params: {
      service: 'object',
      method: 'execute_kw',
      args: [state.db, state.uid, state.password, model, method, args, kwargs],
    },
    id: Date.now(),
  });
}

function formatList(rows) {
  if (!rows || rows.length === 0) return 'No results';
  return rows.join('\n');
}

const server = new Server(
  { name: 'odoo-mcp', version: '2.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'odoo_login',
      description: 'Login with your own Odoo credentials',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Odoo URL, eg https://odoo.company.com' },
          db: { type: 'string', description: 'Database name' },
          login: { type: 'string', description: 'User login/email' },
          password: { type: 'string', description: 'User password' },
        },
        required: ['login', 'password'],
      },
    },
    {
      name: 'odoo_whoami',
      description: 'Show current authenticated user/session',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'odoo_get_projects',
      description: 'List active projects',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'odoo_get_my_tasks',
      description: 'List my tasks (optional filters: project_id, state)',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'number', description: 'Project ID (optional)' },
          state: { type: 'string', description: 'in_progress | to_do | done' },
        },
      },
    },
    {
      name: 'odoo_get_task_detail',
      description: 'Get task details with assignees and metrics',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'number', description: 'Task ID' },
        },
        required: ['task_id'],
      },
    },
    {
      name: 'odoo_get_task_gitlab_branches',
      description: 'Get GitLab branches linked to a task',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'number', description: 'Task ID' },
        },
        required: ['task_id'],
      },
    },
    {
      name: 'odoo_create_timesheet',
      description: 'Create a timesheet line for a task',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'number' },
          project_id: { type: 'number' },
          date: { type: 'string', description: 'YYYY-MM-DD' },
          hours: { type: 'number' },
          description: { type: 'string' },
        },
        required: ['task_id', 'project_id', 'date', 'hours', 'description'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case 'odoo_login': {
        const auth = await authenticate({
          url: args.url,
          db: args.db,
          login: args.login,
          password: args.password,
        });
        return {
          content: [
            {
              type: 'text',
              text: `Connected: ${auth.name} (${auth.login}) uid=${auth.uid} db=${state.db}`,
            },
          ],
        };
      }

      case 'odoo_whoami': {
        assertAuthenticated();
        return {
          content: [
            {
              type: 'text',
              text: `Connected as ${state.name || state.login} (${state.login}) uid=${state.uid} db=${state.db} url=${state.url}`,
            },
          ],
        };
      }

      case 'odoo_get_projects': {
        const projects = await executeKw('project.project', 'search_read', [[['active', '=', true]]], {
          fields: ['id', 'name'],
          limit: 100,
        });
        return {
          content: [{ type: 'text', text: formatList(projects.map((p) => `[${p.id}] ${p.name}`)) }],
        };
      }

      case 'odoo_get_my_tasks': {
        const domain = [['user_ids', '=', state.uid]];
        if (args.project_id) domain.push(['project_id', '=', args.project_id]);
        if (args.state === 'in_progress') domain.push(['stage_id.name', 'ilike', 'In Progress']);
        if (args.state === 'to_do') domain.push(['stage_id.name', 'ilike', 'To Do']);
        if (args.state === 'done') domain.push(['stage_id.name', 'ilike', 'Done']);

        const tasks = await executeKw('project.task', 'search_read', [domain], {
          fields: ['id', 'name', 'project_id', 'stage_id'],
          limit: 100,
        });

        return {
          content: [
            {
              type: 'text',
              text: formatList(
                tasks.map(
                  (t) =>
                    `[${t.id}] ${t.name}\n   ${t.project_id?.[1] || 'N/A'} - ${t.stage_id?.[1] || 'N/A'}`
                )
              ),
            },
          ],
        };
      }

      case 'odoo_get_task_detail': {
        const taskId = Number(args.task_id);
        const rows = await executeKw('project.task', 'read', [[taskId], [
          'id',
          'name',
          'project_id',
          'stage_id',
          'user_ids',
          'priority',
          'date_deadline',
          'task_category',
          'allocated_hours',
          'effective_hours',
          'progress',
          'gitlab_branch_ids',
        ]]);

        if (!rows || rows.length === 0) {
          return { content: [{ type: 'text', text: 'Task not found' }] };
        }

        const t = rows[0];
        let assignees = 'N/A';
        if (t.user_ids?.length) {
          const users = await executeKw('res.users', 'read', [t.user_ids, ['name']]);
          assignees = users.map((u) => u.name).join(', ');
        }

        const text = [
          `Task #${t.id}: ${t.name}`,
          `Project: ${t.project_id?.[1] || 'N/A'}`,
          `Stage: ${t.stage_id?.[1] || 'N/A'}`,
          `Assignees: ${assignees}`,
          `Priority: ${t.priority}`,
          `Deadline: ${t.date_deadline || 'N/A'}`,
          `Hours: ${t.effective_hours || 0}/${t.allocated_hours || 0}`,
          `Progress: ${t.progress || 0}%`,
          `Category: ${t.task_category || 'N/A'}`,
          `GitLab branch ids: ${t.gitlab_branch_ids?.join(', ') || 'none'}`,
        ].join('\n');

        return { content: [{ type: 'text', text }] };
      }

      case 'odoo_get_task_gitlab_branches': {
        const taskId = Number(args.task_id);
        const rows = await executeKw('project.task', 'read', [[taskId], ['gitlab_branch_ids', 'name']]);
        if (!rows || rows.length === 0) {
          return { content: [{ type: 'text', text: 'Task not found' }] };
        }

        const branchIds = rows[0].gitlab_branch_ids || [];
        if (branchIds.length === 0) {
          return { content: [{ type: 'text', text: 'No GitLab branches linked to this task' }] };
        }

        const branches = await executeKw('gitlab.task.branch', 'read', [branchIds, [
          'id',
          'gitlab_branch_name',
          'gitlab_origin_project_id',
          'target_branch',
          'from_branch',
          'gitlab_link',
          'merge_request_link',
          'gitlab_user_id',
        ]]);

        const text = formatList(
          branches.map((b) => {
            const project = b.gitlab_origin_project_id?.[1] || 'N/A';
            const owner = b.gitlab_user_id?.[1] || 'N/A';
            return [
              `[${b.id}] ${project}`,
              `   branch: ${b.gitlab_branch_name || 'N/A'}`,
              `   from -> target: ${b.from_branch || 'N/A'} -> ${b.target_branch || 'N/A'}`,
              `   author: ${owner}`,
              `   link: ${b.gitlab_link || 'N/A'}`,
              `   mr: ${b.merge_request_link || 'none'}`,
            ].join('\n');
          })
        );

        return { content: [{ type: 'text', text }] };
      }

      case 'odoo_create_timesheet': {
        const employees = await executeKw('hr.employee', 'search_read', [[['user_id', '=', state.uid]]], {
          fields: ['id'],
          limit: 1,
        });

        if (!employees?.length) {
          return { content: [{ type: 'text', text: 'No employee found for current user' }] };
        }

        const timesheetId = await executeKw('account.analytic.line', 'create', [
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

        return { content: [{ type: 'text', text: `Timesheet created: ${timesheetId}` }] };
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error.message}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
