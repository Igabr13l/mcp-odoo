import assert from "node:assert/strict";
import test from "node:test";
import type {
  OdooArguments,
  OdooKeywordArguments,
} from "../src/contracts.js";
import { createTicketContextTools } from "../src/tools/ticket-context.js";
import {
  array,
  required,
  structuredContent,
} from "./helpers.js";

interface OdooCall {
  model: string;
  method: string;
  args: OdooArguments;
  kwargs: OdooKeywordArguments;
}

interface RouteContext {
  args: OdooArguments;
  kwargs: OdooKeywordArguments;
  calls: OdooCall[];
}

type Route = (context: RouteContext) => unknown | Promise<unknown>;
type Routes = Record<string, Route>;

interface TicketContextContent extends Record<string, unknown> {
  ticket: { description: string };
  messages: { body: string }[];
  attachments: {
    name: string;
    description: string;
    url: string;
    provenance: {
      task_direct: boolean;
      source_messages: {
        id?: number;
        date: string | null;
        author: { id: number | null; name: string };
      }[];
    };
  }[];
  gitlab_branches: { branch_name: string | null }[];
  timesheets: {
    line_count: number;
    returned_line_count: number;
    truncated: boolean;
    total_hours: number;
    lines: unknown[];
  };
  project_stages: unknown[];
}

interface NoteContent extends Record<string, unknown> {
  verified: boolean;
  message: { body: string } | null;
}

function makeTools(routes: Routes = {}) {
  const calls: OdooCall[] = [];
  const executeKw: Parameters<typeof createTicketContextTools>[0]["executeKw"] = async (
    model,
    method,
    args = [],
    kwargs = {},
  ) => {
    calls.push({ model, method, args, kwargs });
    const route = routes[`${model}.${method}`];
    if (!route) throw new Error(`Unexpected call ${model}.${method}`);
    return route({ args, kwargs, calls });
  };
  return {
    calls,
    tools: createTicketContextTools({
      executeKw,
      getAvailableFields: async (_model, fields) => fields,
      getNameMap: async (model, ids) =>
        new Map(ids.map((id) => [id, `${model}-${id}`])),
    }),
  };
}

test("odoo_get_project_stages returns exact applicable stages including empty ones", async () => {
  const { tools, calls } = makeTools({
    "project.task.type.search_read": () => [
      { id: 3, name: "To Do", sequence: 1, fold: false, project_ids: [] },
      { id: 8, name: "Review", sequence: 7, fold: true, project_ids: [12] },
    ],
  });

  const result = await tools.handlers.odoo_get_project_stages({ project_id: 12 });

  assert.deepEqual(calls[0].args, [
    [
      "|",
      ["project_ids", "=", false],
      ["project_ids", "in", [12]],
    ],
  ]);
  assert.deepEqual(calls[0].kwargs, {
    fields: ["id", "name", "sequence", "fold", "project_ids"],
    limit: 500,
    order: "sequence, id",
  });
  assert.deepEqual(result.structuredContent.stages, [
    {
      id: 3,
      name: "To Do",
      sequence: 1,
      fold: false,
      project_ids: [],
      applicability: "global",
    },
    {
      id: 8,
      name: "Review",
      sequence: 7,
      fold: true,
      project_ids: [12],
      applicability: "project-specific",
    },
  ]);
});

test("odoo_add_ticket_note previews redacted content without posting", async () => {
  const { tools, calls } = makeTools();
  const result = await tools.handlers.odoo_add_ticket_note({
    task_id: 9,
    body: "<p>token: secret-value</p>",
    confirm: false,
  });

  assert.equal(calls.length, 0);
  assert.deepEqual(result.structuredContent, {
    status: "preview",
    task_id: 9,
    body: "token: [REDACTED]",
  });
  assert.doesNotMatch(result.content[0].text, /secret-value/);
});

test("odoo_add_ticket_note posts an internal note and verifies the message", async () => {
  const { tools, calls } = makeTools({
    "project.task.message_post": () => 77,
    "mail.message.read": () => [
      {
        id: 77,
        date: "2026-08-09 12:00:00",
        author_id: [5, "Ada"],
        body: "<p>password: hidden</p>",
        message_type: "comment",
        subtype_id: [2, "Note"],
        attachment_ids: [],
      },
    ],
  });

  const result = await tools.handlers.odoo_add_ticket_note({
    task_id: 9,
    body: "password: hidden",
    confirm: true,
  });
  const data = structuredContent<NoteContent>(result);

  assert.deepEqual(calls[0], {
    model: "project.task",
    method: "message_post",
    args: [[9]],
    kwargs: {
      body: "password: [REDACTED]",
      subtype_xmlid: "mail.mt_note",
      message_type: "comment",
    },
  });
  assert.equal(data.verified, true);
  assert.equal(required(data.message).body, "password: [REDACTED]");
  assert.doesNotMatch(JSON.stringify(result), /hidden/);
});

test("odoo_add_ticket_note rejects blank content", async () => {
  const { tools } = makeTools();
  await assert.rejects(
    tools.handlers.odoo_add_ticket_note({ task_id: 9, body: "  ", confirm: true }),
    /body must be a nonblank string/,
  );
});

test("odoo_add_ticket_note rejects content blank after HTML normalization", async () => {
  const { tools, calls } = makeTools();

  for (const body of ["<p></p>", "<script>alert('ignored')</script>"]) {
    await assert.rejects(
      tools.handlers.odoo_add_ticket_note({ task_id: 9, body, confirm: true }),
      /body must be a nonblank string/,
    );
  }

  assert.equal(calls.length, 0);
});

test("odoo_get_ticket_context aggregates redacted ticket evidence", async () => {
  let messageReadCount = 0;
  const { tools, calls } = makeTools({
    "project.task.read": () => [
      {
        id: 9,
        name: "Ticket",
        project_id: [12, "Support"],
        stage_id: [3, "To Do"],
        user_ids: [5],
        tag_ids: [6],
        priority: "1",
        allocated_hours: 8,
        effective_hours: 2,
        progress: 25,
        description: "<p>api key: value</p>",
        gitlab_branch_ids: [40],
      },
    ],
    "mail.message.search_read": ({ kwargs }) => {
      messageReadCount += 1;
      assert.equal(messageReadCount === 1 ? kwargs.limit : 500, kwargs.limit);
      return [
        {
          id: 70,
          date: "2026-08-08 10:00:00",
          author_id: [5, "Ada"],
          subject: false,
          body: false,
          message_type: "comment",
          subtype_id: [2, "Note"],
          attachment_ids: [80],
        },
      ];
    },
    "ir.attachment.search_read": () => [
      {
        id: 81,
        name: "token=context-direct-filename-secret.txt",
        mimetype: "text/plain",
        file_size: 2,
        type: "binary",
        url: "https://files.example/direct?password=direct-secret",
        description: "<p>token: direct-secret</p>",
        res_model: "project.task",
        res_id: 9,
      },
    ],
    "ir.attachment.read": () => [
      {
        id: 80,
        name: "password=context-image-filename-secret.png",
        mimetype: "image/png",
        file_size: 3,
        type: "binary",
        url: "https://files.example/chat?token=image-secret",
        description: "<p>password: image-secret</p>",
        res_model: "mail.message",
        res_id: 70,
      },
    ],
    "gitlab.task.branch.read": () => [
      {
        id: 40,
        gitlab_origin_project_id: [20, "Repo"],
        gitlab_branch_name: "odoo/9-ticket",
        from_branch: "uat",
        target_branch: "uat",
        gitlab_link: "https://gitlab/branch",
        merge_request_link: false,
        gitlab_user_id: [5, "Ada"],
      },
    ],
    "account.analytic.line.search_count": () => 1,
    "account.analytic.line.read_group": () => [{ unit_amount: 1.5 }],
    "account.analytic.line.search_read": () => [
      {
        id: 90,
        date: "2026-08-09",
        unit_amount: 1.5,
        name: "investigation",
        employee_id: [4, "Ada Employee"],
        user_id: [5, "Ada"],
        project_id: [12, "Support"],
        task_id: [9, "Ticket"],
      },
    ],
    "project.task.type.search_read": () => [
      { id: 3, name: "To Do", sequence: 1, fold: false, project_ids: [12] },
      { id: 4, name: "Done", sequence: 2, fold: true, project_ids: [12] },
    ],
  });

  const result = await tools.handlers.odoo_get_ticket_context({
    task_id: 9,
    include_system: true,
    message_limit: 4,
  });
  const data = structuredContent<TicketContextContent>(result);

  assert.equal(data.ticket.description, "api key: [REDACTED]");
  assert.equal(data.messages[0].body, "");
  assert.deepEqual(data.attachments[0].provenance, {
    task_direct: true,
    source_messages: [],
  });
  assert.deepEqual(data.attachments[1].provenance.source_messages[0], {
    id: 70,
    date: "2026-08-08 10:00:00",
    author: { id: 5, name: "Ada" },
  });
  assert.equal(data.attachments[0].description, "token: [REDACTED]");
  assert.equal(data.attachments[0].name, "token=[REDACTED]");
  assert.equal(data.attachments[1].name, "password=[REDACTED]");
  assert.equal(
    data.attachments[1].url,
    "https://files.example/chat?token=[REDACTED]",
  );
  assert.doesNotMatch(
    JSON.stringify(result),
    /direct-secret|image-secret|context-direct-filename-secret|context-image-filename-secret/,
  );
  assert.equal(data.gitlab_branches[0].branch_name, "odoo/9-ticket");
  assert.equal(data.timesheets.line_count, 1);
  assert.equal(data.timesheets.returned_line_count, 1);
  assert.equal(data.timesheets.truncated, false);
  assert.equal(data.timesheets.total_hours, 1.5);
  assert.equal(data.project_stages.length, 2);
  assert.equal(
    calls.some((call) => call.model === "gitlab.task.branch"),
    true,
  );
});

test("odoo_get_ticket_context rejects another project before reading evidence", async () => {
  const { tools, calls } = makeTools({
    "project.task.read": () => [
      {
        id: 9,
        name: "Other project ticket",
        project_id: [47, "prj_manijacasas"],
      },
    ],
  });

  await assert.rejects(
    tools.handlers.odoo_get_ticket_context({
      task_id: 9,
      expected_project_id: 7,
    }),
    /belongs to project 47, expected project 7/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "project.task");
  assert.deepEqual(calls[0].args, [[9], ["id", "project_id"]]);
  assert.equal(array(calls[0].args[1]).includes("description"), false);
});

test("odoo_get_ticket_context validates scope before requesting full task fields", async () => {
  let taskReadCount = 0;
  const { tools, calls } = makeTools({
    "project.task.read": ({ args }) => {
      taskReadCount += 1;
      if (taskReadCount === 1) {
        assert.deepEqual(args, [[9], ["id", "project_id"]]);
        return [{ id: 9, project_id: [12, "Support"] }];
      }
      assert.equal(array(args[1]).includes("description"), true);
      return [
        {
          id: 9,
          name: "Ticket",
          project_id: [12, "Support"],
          user_ids: [],
          tag_ids: [],
          gitlab_branch_ids: [],
        },
      ];
    },
    "mail.message.search_read": () => [],
    "ir.attachment.search_read": () => [],
    "account.analytic.line.search_count": () => 0,
    "account.analytic.line.read_group": () => [],
    "account.analytic.line.search_read": () => [],
    "project.task.type.search_read": () => [],
  });

  const result = await tools.handlers.odoo_get_ticket_context({
    task_id: 9,
    expected_project_id: 12,
  });

  assert.equal(result.structuredContent.found, true);
  assert.equal(taskReadCount, 2);
  assert.deepEqual(calls[0].args[1], ["id", "project_id"]);
  assert.equal(array(calls[1].args[1]).includes("description"), true);
});

test("odoo_get_ticket_context preserves scoped not-found behavior after minimal read", async () => {
  const { tools, calls } = makeTools({
    "project.task.read": () => [],
  });

  const result = await tools.handlers.odoo_get_ticket_context({
    task_id: 404,
    expected_project_id: 12,
  });

  assert.deepEqual(result, {
    content: [{ type: "text", text: "Task not found" }],
    structuredContent: { task_id: 404, found: false },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [[404], ["id", "project_id"]]);
});

test("odoo_get_ticket_context reports complete timesheet totals with capped rows", async () => {
  const { tools, calls } = makeTools({
    "project.task.read": () => [
      {
        id: 9,
        name: "Ticket",
        project_id: false,
        stage_id: false,
        user_ids: [],
        tag_ids: [],
        gitlab_branch_ids: [],
      },
    ],
    "mail.message.search_read": () => [],
    "ir.attachment.search_read": () => [],
    "account.analytic.line.search_count": () => 1250,
    "account.analytic.line.read_group": () => [{ unit_amount: 321.5 }],
    "account.analytic.line.search_read": () => [
      { id: 1250, date: "2026-08-09", unit_amount: 1, name: "Recent" },
      { id: 1249, date: "2026-08-08", unit_amount: 2, name: "Previous" },
    ],
  });

  const result = await tools.handlers.odoo_get_ticket_context({ task_id: 9 });
  const { timesheets } = structuredContent<TicketContextContent>(result);

  assert.equal(timesheets.line_count, 1250);
  assert.equal(timesheets.returned_line_count, 2);
  assert.equal(timesheets.truncated, true);
  assert.equal(timesheets.total_hours, 321.5);
  assert.equal(timesheets.lines.length, 2);

  const countCall = calls.find(
    (call) =>
      call.model === "account.analytic.line" && call.method === "search_count",
  );
  const aggregateCall = calls.find(
    (call) =>
      call.model === "account.analytic.line" && call.method === "read_group",
  );
  const rowsCall = calls.find(
    (call) =>
      call.model === "account.analytic.line" && call.method === "search_read",
  );
  assert.deepEqual(required(countCall).args, [[["task_id", "=", 9]]]);
  assert.deepEqual(required(aggregateCall).args, [
    [["task_id", "=", 9]],
    ["unit_amount:sum"],
    [],
  ]);
  assert.deepEqual(required(aggregateCall).kwargs, { lazy: false });
  assert.equal(required(rowsCall).kwargs.limit, 1000);
  assert.equal(required(rowsCall).kwargs.order, "date desc, id desc");
});
