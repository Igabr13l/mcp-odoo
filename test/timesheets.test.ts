import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExecuteKwImplementation,
  GetAvailableFields,
  GetUid,
  OdooArguments,
  OdooKeywordArguments,
  OdooRecord,
} from "../src/contracts.js";
import { createTimesheetTools } from "../src/tools/timesheets.js";
import {
  array,
  deferred,
  record,
  required,
} from "./helpers.js";

const UID = 16;

interface OdooCall {
  key: string;
  model: string;
  method: string;
  args: OdooArguments;
  kwargs: OdooKeywordArguments;
}

type OdooOverride = (
  args: OdooArguments,
  kwargs: OdooKeywordArguments,
  calls: OdooCall[],
) => unknown | Promise<unknown>;
type OdooOverrides = Record<string, OdooOverride>;
type MockExecuteKw = ExecuteKwImplementation & { calls: OdooCall[] };

function makeExecuteKw(overrides: OdooOverrides = {}): MockExecuteKw {
  const calls: OdooCall[] = [];
  const executeKw: ExecuteKwImplementation = async (
    model,
    method,
    args = [],
    kwargs = {},
  ) => {
    const key = `${model}.${method}`;
    calls.push({ key, model, method, args, kwargs });
    if (Object.hasOwn(overrides, key)) {
      return required(overrides[key])(args, kwargs, calls);
    }
    switch (key) {
      case "hr.employee.search_read":
        return [{ id: 9 }];
      case "account.analytic.line.create":
        return (
          calls.filter((call) => call.key === key).length + 1000
        );
      case "account.analytic.line.write":
      case "account.analytic.line.unlink":
        return true;
      case "account.analytic.line.read":
        return [
          {
            id: 123,
            user_id: [UID, "Current User"],
            name: "test",
            date: "2026-03-01",
            unit_amount: 2,
            project_id: [7, "Project"],
            task_id: [8, "Task"],
          },
        ];
      case "account.analytic.line.search_read":
        return [];
      case "account.analytic.line.search_count":
        return 0;
      case "project.task.search_read": {
        const taskId = array(array(args[0])[0])[2];
        return [{ id: taskId, project_id: [7, "Project"] }];
      }
      default:
        return [];
    }
  };
  return Object.assign(executeKw, { calls });
}

function makeTools(
  executeKw: ExecuteKwImplementation,
  getUid: GetUid = () => UID,
  getAvailableFields?: GetAvailableFields,
) {
  return createTimesheetTools({ executeKw, getUid, getAvailableFields });
}

const validEntry = {
  task_id: 8,
  project_id: 7,
  date: "2026-03-01",
  hours: 2,
  description: "Implement feature",
};

test("defines the five timesheet tools with preserved schemas", () => {
  const { definitions } = makeTools(makeExecuteKw());
  assert.deepEqual(
    definitions.map((definition) => definition.name),
    [
      "odoo_create_timesheet",
      "odoo_get_my_timesheets",
      "odoo_update_timesheet",
      "odoo_delete_timesheet",
      "odoo_create_timesheets_bulk",
    ],
  );

  const create = definitions.find(
    (definition) => definition.name === "odoo_create_timesheet",
  );
  assert.deepEqual(required(create).inputSchema.required, [
    "task_id",
    "project_id",
    "date",
    "hours",
    "description",
  ]);

  const update = definitions.find(
    (definition) => definition.name === "odoo_update_timesheet",
  );
  assert.deepEqual(required(update).inputSchema.required, ["timesheet_id"]);

  const list = definitions.find(
    (definition) => definition.name === "odoo_get_my_timesheets",
  );
  const listProperties = record(required(list).inputSchema.properties);
  assert.equal(record(listProperties.offset).type, "number");

  const deleteTool = definitions.find(
    (definition) => definition.name === "odoo_delete_timesheet",
  );
  assert.deepEqual(required(deleteTool).inputSchema.required, ["timesheet_id"]);

  const bulk = definitions.find(
    (definition) => definition.name === "odoo_create_timesheets_bulk",
  );
  assert.deepEqual(required(bulk).inputSchema.required, ["entries"]);
});

test("odoo_create_timesheet looks up the employee once and creates the line", async () => {
  const executeKw = makeExecuteKw();
  const { handlers } = makeTools(executeKw);
  const result = await handlers.odoo_create_timesheet(validEntry);

  const employeeLookups = executeKw.calls.filter(
    (call) => call.key === "hr.employee.search_read",
  );
  assert.equal(employeeLookups.length, 1);
  assert.deepEqual(employeeLookups[0].args, [[["user_id", "=", UID]]]);

  const createCall = executeKw.calls.find(
    (call) => call.key === "account.analytic.line.create",
  );
  assert.deepEqual(required(createCall).args, [
    {
      date: "2026-03-01",
      employee_id: 9,
      project_id: 7,
      task_id: 8,
      name: "Implement feature",
      unit_amount: 2,
      user_id: UID,
    },
  ]);
  assert.equal(result.content[0].text, "Timesheet created: 1001");
  assert.equal(result.structuredContent.id, 1001);
});

test("odoo_create_timesheet throws when no employee matches the current user", async () => {
  const executeKw = makeExecuteKw({ "hr.employee.search_read": () => [] });
  const { handlers } = makeTools(executeKw);
  await assert.rejects(
    handlers.odoo_create_timesheet(validEntry),
    /No employee found for current user/,
  );
});

test("odoo_create_timesheet rejects invalid dates", async () => {
  const executeKw = makeExecuteKw();
  const { handlers } = makeTools(executeKw);
  for (const date of [
    "2026-02-30",
    "01/03/2026",
    "2026-3-1",
    "not-a-date",
    "",
  ]) {
    await assert.rejects(
      handlers.odoo_create_timesheet({ ...validEntry, date }),
      /date must be a valid YYYY-MM-DD date/,
    );
  }
});

test("odoo_create_timesheet rejects non-positive or non-finite hours", async () => {
  const executeKw = makeExecuteKw();
  const { handlers } = makeTools(executeKw);
  for (const hours of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      handlers.odoo_create_timesheet({ ...validEntry, hours }),
      /hours must be a finite positive number/,
    );
  }
});

test("odoo_create_timesheet rejects hours above 24 and blank descriptions", async () => {
  const { handlers } = makeTools(makeExecuteKw());
  await assert.rejects(
    handlers.odoo_create_timesheet({ ...validEntry, hours: 24.01 }),
    /no greater than 24/,
  );
  for (const description of ["", "   ", null]) {
    await assert.rejects(
      handlers.odoo_create_timesheet({ ...validEntry, description }),
      /description must be a nonblank string/,
    );
  }
});

test("odoo_create_timesheet trims descriptions and rejects normalized duplicates", async () => {
  const executeKw = makeExecuteKw({
    "account.analytic.line.search_read": () => [
      { id: 44, name: " implement   FEATURE ", unit_amount: 2 },
    ],
  });
  const { handlers } = makeTools(executeKw);
  await assert.rejects(
    handlers.odoo_create_timesheet(validEntry),
    /Probable duplicate timesheet already exists: 44/,
  );
  assert.equal(
    executeKw.calls.some((call) => call.key === "account.analytic.line.create"),
    false,
  );

  const cleanExecuteKw = makeExecuteKw();
  const cleanTools = makeTools(cleanExecuteKw);
  await cleanTools.handlers.odoo_create_timesheet({
    ...validEntry,
    description: "  Implement feature  ",
  });
  const createCall = cleanExecuteKw.calls.find(
    (call) => call.key === "account.analytic.line.create",
  );
  assert.equal(record(required(createCall).args[0]).name, "Implement feature");
});

test("odoo_create_timesheet serializes concurrent duplicate checks and creates", async () => {
  const rows: OdooRecord[] = [];
  const createStarted = deferred<void>();
  const createCanFinish = deferred<void>();
  const executeKw = makeExecuteKw({
    "account.analytic.line.search_read": () => rows,
    "account.analytic.line.create": async (args) => {
      createStarted.resolve();
      await createCanFinish.promise;
      const values = record(args[0]);
      const name = values.name;
      const unitAmount = values.unit_amount;
      if (typeof name !== "string" || typeof unitAmount !== "number") {
        throw new TypeError("Unexpected timesheet fixture values");
      }
      const row = { id: 77, name, unit_amount: unitAmount };
      rows.push(row);
      return row.id;
    },
  });
  const { handlers } = makeTools(executeKw);

  const first = handlers.odoo_create_timesheet(validEntry);
  await createStarted.promise;
  const second = handlers.odoo_create_timesheet(validEntry);
  createCanFinish.resolve();
  const results = await Promise.allSettled([first, second]);

  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[0].value.structuredContent.id, 77);
  assert.equal(results[1].status, "rejected");
  assert.match(results[1].reason.message, /Probable duplicate timesheet already exists: 77/);
  assert.equal(
    executeKw.calls.filter((call) => call.key === "account.analytic.line.create").length,
    1,
  );
  assert.equal(
    executeKw.calls.filter((call) => call.key === "account.analytic.line.search_read").length,
    2,
  );
});

test("odoo_create_timesheet verifies task association and optional timesheet flags", async () => {
  const available = async () => ["allow_timesheets"];
  const wrongProject = makeExecuteKw({
    "project.task.search_read": () => [{ id: 8, project_id: [99, "Other"], allow_timesheets: true }],
  });
  await assert.rejects(
    makeTools(wrongProject, () => UID, available).handlers.odoo_create_timesheet(validEntry),
    /does not belong to project 7/,
  );

  const disabledTask = makeExecuteKw({
    "project.task.search_read": () => [{ id: 8, project_id: [7, "Project"], allow_timesheets: false }],
  });
  await assert.rejects(
    makeTools(disabledTask, () => UID, available).handlers.odoo_create_timesheet(validEntry),
    /Task 8 does not accept timesheets/,
  );

  const disabledProject = makeExecuteKw({
    "project.task.search_read": () => [{ id: 8, project_id: [7, "Project"], allow_timesheets: true }],
    "project.project.search_read": () => [{ id: 7, allow_timesheets: false }],
  });
  await assert.rejects(
    makeTools(disabledProject, () => UID, available).handlers.odoo_create_timesheet(validEntry),
    /Project 7 does not accept timesheets/,
  );
});

test("odoo_create_timesheet rejects a missing task without requiring field discovery", async () => {
  const executeKw = makeExecuteKw({ "project.task.search_read": () => [] });
  await assert.rejects(
    makeTools(executeKw).handlers.odoo_create_timesheet(validEntry),
    /Task not found: 8/,
  );
});

test("odoo_create_timesheet accepts fractional hours", async () => {
  const executeKw = makeExecuteKw();
  const { handlers } = makeTools(executeKw);
  const result = await handlers.odoo_create_timesheet({
    ...validEntry,
    hours: 2.5,
  });
  const createCall = executeKw.calls.find(
    (call) => call.key === "account.analytic.line.create",
  );
  assert.equal(record(required(createCall).args[0]).unit_amount, 2.5);
  assert.equal(result.content[0].text, "Timesheet created: 1001");
});

test("odoo_create_timesheet rejects invalid task_id or project_id", async () => {
  const executeKw = makeExecuteKw();
  const { handlers } = makeTools(executeKw);
  await assert.rejects(
    handlers.odoo_create_timesheet({ ...validEntry, task_id: 0 }),
    /task_id must be a positive integer/,
  );
  await assert.rejects(
    handlers.odoo_create_timesheet({ ...validEntry, project_id: -3 }),
    /project_id must be a positive integer/,
  );
});

test("odoo_create_timesheet throws when Odoo does not return an id", async () => {
  const executeKw = makeExecuteKw({ "account.analytic.line.create": () => 0 });
  const { handlers } = makeTools(executeKw);
  await assert.rejects(
    handlers.odoo_create_timesheet(validEntry),
    /Odoo did not create the timesheet/,
  );
});

test("odoo_get_my_timesheets filters by exact date and defaults limit to 100", async () => {
  const executeKw = makeExecuteKw({
    "account.analytic.line.search_count": () => 2,
    "account.analytic.line.search_read": () => [
      { id: 1, date: "2026-03-01", unit_amount: 2, name: "a", project_id: [7, "P"], task_id: [8, "T"] },
      { id: 2, date: "2026-03-01", unit_amount: 3, name: "b", project_id: [7, "P"], task_id: [8, "T"] },
    ],
  });
  const { handlers } = makeTools(executeKw);
  const result = await handlers.odoo_get_my_timesheets({ date: "2026-03-01" });

  const call = executeKw.calls.find(
    (entry) => entry.key === "account.analytic.line.search_read",
  );
  const searchCall = required(call);
  assert.deepEqual(searchCall.args[0], [
    ["user_id", "=", UID],
    ["date", "=", "2026-03-01"],
  ]);
  assert.equal(searchCall.kwargs.limit, 100);
  assert.equal(searchCall.kwargs.offset, 0);
  assert.equal(searchCall.kwargs.order, "date desc, id desc");
  assert.match(result.content[0].text, /Total hours: 5/);
  assert.match(result.content[0].text, /Entries: 2/);
  assert.equal(result.structuredContent.total_hours, 5);
  assert.equal(result.structuredContent.rows.length, 2);
  assert.equal(result.structuredContent.total_count, 2);
  assert.equal(result.structuredContent.offset, 0);
  assert.equal(result.structuredContent.has_more, false);
});

test("odoo_get_my_timesheets paginates with a matching count domain", async () => {
  const executeKw = makeExecuteKw({
    "account.analytic.line.search_count": () => 12,
    "account.analytic.line.search_read": () => [
      { id: 3, date: "2026-03-01", unit_amount: 1, name: "c" },
      { id: 2, date: "2026-03-01", unit_amount: 1, name: "b" },
    ],
  });
  const result = await makeTools(executeKw).handlers.odoo_get_my_timesheets({
    project_id: 7,
    limit: 2,
    offset: 8,
  });
  const countCall = executeKw.calls.find(
    (call) => call.key === "account.analytic.line.search_count",
  );
  const readCall = executeKw.calls.find(
    (call) => call.key === "account.analytic.line.search_read",
  );
  assert.deepEqual(required(countCall).args, required(readCall).args);
  assert.equal(required(readCall).kwargs.offset, 8);
  assert.match(result.content[0].text, /Total count: 12/);
  assert.match(result.content[0].text, /Offset: 8/);
  assert.match(result.content[0].text, /Has more: true/);
  assert.deepEqual(result.structuredContent, {
    rows: [
      { id: 3, date: "2026-03-01", unit_amount: 1, name: "c" },
      { id: 2, date: "2026-03-01", unit_amount: 1, name: "b" },
    ],
    total_hours: 2,
    total_count: 12,
    offset: 8,
    has_more: true,
  });
});

test("odoo_get_my_timesheets rejects invalid offsets", async () => {
  const { handlers } = makeTools(makeExecuteKw());
  for (const offset of [-1, 1.5, "bad"]) {
    await assert.rejects(
      handlers.odoo_get_my_timesheets({ offset }),
      /offset must be a nonnegative integer/,
    );
  }
});

test("odoo_get_my_timesheets uses a date range and clamps limit to 500", async () => {
  const executeKw = makeExecuteKw();
  const { handlers } = makeTools(executeKw);
  await handlers.odoo_get_my_timesheets({
    date_from: "2026-02-01",
    date_to: "2026-02-28",
    limit: 9999,
  });

  const call = executeKw.calls.find(
    (entry) => entry.key === "account.analytic.line.search_read",
  );
  assert.deepEqual(required(call).args[0], [
    ["user_id", "=", UID],
    ["date", ">=", "2026-02-01"],
    ["date", "<=", "2026-02-28"],
  ]);
  assert.equal(required(call).kwargs.limit, 500);
});

test("odoo_get_my_timesheets falls back to 100 when limit is not a number", async () => {
  const executeKw = makeExecuteKw();
  const { handlers } = makeTools(executeKw);
  await handlers.odoo_get_my_timesheets({ limit: "abc" });

  const call = executeKw.calls.find(
    (entry) => entry.key === "account.analytic.line.search_read",
  );
  assert.equal(required(call).kwargs.limit, 100);
});

test("odoo_get_my_timesheets validates optional project and task filters", async () => {
  const executeKw = makeExecuteKw();
  const { handlers } = makeTools(executeKw);
  await handlers.odoo_get_my_timesheets({ project_id: 7, task_id: 8 });

  const call = executeKw.calls.find(
    (entry) => entry.key === "account.analytic.line.search_read",
  );
  assert.deepEqual(required(call).args[0], [
    ["user_id", "=", UID],
    ["project_id", "=", 7],
    ["task_id", "=", 8],
  ]);
  await assert.rejects(
    handlers.odoo_get_my_timesheets({ project_id: -1 }),
    /project_id must be a positive integer/,
  );
});

test("odoo_get_my_timesheets validates every supplied optional date", async () => {
  const { handlers } = makeTools(makeExecuteKw());
  for (const [field, value] of [
    ["date", "2026-02-30"],
    ["date_from", "bad"],
    ["date_to", "2026-2-01"],
  ]) {
    await assert.rejects(
      handlers.odoo_get_my_timesheets({ [field]: value }),
      new RegExp(`${field} must be a valid YYYY-MM-DD date`),
    );
  }
  await assert.rejects(
    handlers.odoo_get_my_timesheets({ date: "2026-03-01", date_to: "bad" }),
    /date_to must be a valid YYYY-MM-DD date/,
  );
});

test("odoo_get_my_timesheets returns pagination metadata when empty", async () => {
  const executeKw = makeExecuteKw();
  const { handlers } = makeTools(executeKw);
  const result = await handlers.odoo_get_my_timesheets({});
  assert.match(result.content[0].text, /^No results/);
  assert.deepEqual(result.structuredContent, {
    rows: [],
    total_hours: 0,
    total_count: 0,
    offset: 0,
    has_more: false,
  });
});

test("odoo_update_timesheet maps provided fields and returns a summary", async () => {
  const executeKw = makeExecuteKw();
  const { handlers } = makeTools(executeKw);
  const result = await handlers.odoo_update_timesheet({
    timesheet_id: 5,
    date: "2026-03-02",
    hours: 3.5,
    description: "Fixed bug",
    task_id: 9,
    project_id: 7,
  });

  const writeCall = executeKw.calls.find(
    (call) => call.key === "account.analytic.line.write",
  );
  assert.deepEqual(required(writeCall).args[0], [5]);
  assert.deepEqual(required(writeCall).args[1], {
    date: "2026-03-02",
    unit_amount: 3.5,
    name: "Fixed bug",
    task_id: 9,
    project_id: 7,
  });
  assert.equal(result.content[0].text, "Timesheet updated: [123] 2026-03-01 2h test");
  assert.deepEqual(result.structuredContent, {
    id: 5,
    updated: true,
    verified: true,
    row: {
      id: 123,
      user_id: [UID, "Current User"],
      name: "test",
      date: "2026-03-01",
      unit_amount: 2,
      project_id: [7, "Project"],
      task_id: [8, "Task"],
    },
    verification_error: null,
  });
});

test("odoo_update_timesheet succeeds when the verification read fails", async () => {
  let readCount = 0;
  const executeKw = makeExecuteKw({
    "account.analytic.line.read": () => {
      readCount += 1;
      if (readCount === 2) throw new Error("Verification unavailable");
      return [{
        id: 5,
        user_id: [UID, "Current User"],
        name: "test",
        date: "2026-03-01",
        unit_amount: 2,
        project_id: [7, "Project"],
        task_id: [8, "Task"],
      }];
    },
  });

  const result = await makeTools(executeKw).handlers.odoo_update_timesheet({
    timesheet_id: 5,
    hours: 3,
  });

  assert.equal(result.content[0].text, "Timesheet updated: 5");
  assert.deepEqual(result.structuredContent, {
    id: 5,
    updated: true,
    verified: false,
    row: null,
    verification_error: "Verification unavailable",
  });
  assert.equal(
    executeKw.calls.filter((call) => call.key === "account.analytic.line.write").length,
    1,
  );
});

test("odoo_update_timesheet verifies ownership before writing", async () => {
  const executeKw = makeExecuteKw({
    "account.analytic.line.read": () => [{
      id: 5,
      user_id: [999, "Other"],
      name: "test",
      date: "2026-03-01",
      unit_amount: 2,
      project_id: [7, "Project"],
      task_id: [8, "Task"],
    }],
  });
  await assert.rejects(
    makeTools(executeKw).handlers.odoo_update_timesheet({ timesheet_id: 5, hours: 3 }),
    /does not belong to current user/,
  );
  assert.equal(executeKw.calls.some((call) => call.key === "account.analytic.line.write"), false);
});

test("odoo_update_timesheet validates the effective association and values", async () => {
  const { handlers } = makeTools(makeExecuteKw());
  await assert.rejects(
    handlers.odoo_update_timesheet({ timesheet_id: 5, project_id: 99 }),
    /Task 8 does not belong to project 99/,
  );
  await assert.rejects(
    handlers.odoo_update_timesheet({ timesheet_id: 5, description: "  " }),
    /description must be a nonblank string/,
  );
  await assert.rejects(
    handlers.odoo_update_timesheet({ timesheet_id: 5, hours: 25 }),
    /no greater than 24/,
  );
});

test("odoo_update_timesheet rejects an effective duplicate excluding itself", async () => {
  const executeKw = makeExecuteKw({
    "account.analytic.line.search_read": (args) => {
      const domain = array(args[0]);
      assert.deepEqual(domain, [
        ["user_id", "=", UID],
        ["date", "=", "2026-03-01"],
        ["project_id", "=", 7],
        ["task_id", "=", 8],
        ["unit_amount", "=", 3],
        ["id", "!=", 5],
      ]);
      return [{ id: 44, name: " test ", unit_amount: 3 }];
    },
  });
  await assert.rejects(
    makeTools(executeKw).handlers.odoo_update_timesheet({
      timesheet_id: 5,
      hours: 3,
    }),
    /Probable duplicate timesheet already exists: 44/,
  );
  assert.equal(
    executeKw.calls.some((call) => call.key === "account.analytic.line.write"),
    false,
  );
});

test("odoo_update_timesheet throws on invalid input", async () => {
  const executeKw = makeExecuteKw();
  const { handlers } = makeTools(executeKw);
  await assert.rejects(
    handlers.odoo_update_timesheet({}),
    /timesheet_id must be a positive integer/,
  );
  await assert.rejects(
    handlers.odoo_update_timesheet({ timesheet_id: 5 }),
    /Nothing to update/,
  );
  await assert.rejects(
    handlers.odoo_update_timesheet({ timesheet_id: 5, date: "bad" }),
    /date must be a valid YYYY-MM-DD date/,
  );
  await assert.rejects(
    handlers.odoo_update_timesheet({ timesheet_id: 5, hours: 0 }),
    /hours must be a finite positive number/,
  );
});

test("odoo_update_timesheet throws when Odoo rejects the write", async () => {
  const executeKw = makeExecuteKw({ "account.analytic.line.write": () => false });
  const { handlers } = makeTools(executeKw);
  await assert.rejects(
    handlers.odoo_update_timesheet({ timesheet_id: 5, hours: 2 }),
    /Update failed/,
  );
});

test("odoo_delete_timesheet unlinks the line and returns a summary", async () => {
  const executeKw = makeExecuteKw();
  const { handlers } = makeTools(executeKw);
  const result = await handlers.odoo_delete_timesheet({ timesheet_id: 5 });

  const call = executeKw.calls.find(
    (entry) => entry.key === "account.analytic.line.unlink",
  );
  assert.deepEqual(required(call).args[0], [5]);
  assert.equal(result.content[0].text, "Timesheet deleted: 5");
  assert.deepEqual(result.structuredContent, { id: 5, deleted: true });
});

test("odoo_delete_timesheet verifies ownership before unlinking", async () => {
  const executeKw = makeExecuteKw({
    "account.analytic.line.read": () => [{ id: 5, user_id: [999, "Other"] }],
  });
  await assert.rejects(
    makeTools(executeKw).handlers.odoo_delete_timesheet({ timesheet_id: 5 }),
    /does not belong to current user/,
  );
  assert.equal(executeKw.calls.some((call) => call.key === "account.analytic.line.unlink"), false);
});

test("odoo_delete_timesheet queues ownership verification and unlink together", async () => {
  const createCanFinish = deferred<void>();
  const createDidStart = deferred<void>();
  const executeKw = makeExecuteKw({
    "account.analytic.line.create": async () => {
      createDidStart.resolve();
      await createCanFinish.promise;
      return 77;
    },
  });
  const { handlers } = makeTools(executeKw);

  const create = handlers.odoo_create_timesheet(validEntry);
  await createDidStart.promise;
  const remove = handlers.odoo_delete_timesheet({ timesheet_id: 5 });

  assert.equal(
    executeKw.calls.some((call) => call.key === "account.analytic.line.read"),
    false,
  );
  createCanFinish.resolve();
  await Promise.all([create, remove]);

  const mutationCalls = executeKw.calls
    .filter((call) => [
      "account.analytic.line.create",
      "account.analytic.line.read",
      "account.analytic.line.unlink",
    ].includes(call.key))
    .map((call) => call.key);
  assert.deepEqual(mutationCalls, [
    "account.analytic.line.create",
    "account.analytic.line.read",
    "account.analytic.line.unlink",
  ]);
});

test("odoo_delete_timesheet throws when unlink fails", async () => {
  const executeKw = makeExecuteKw({ "account.analytic.line.unlink": () => false });
  const { handlers } = makeTools(executeKw);
  await assert.rejects(
    handlers.odoo_delete_timesheet({ timesheet_id: 5 }),
    /Delete failed/,
  );
});

test("odoo_delete_timesheet rejects invalid ids", async () => {
  const executeKw = makeExecuteKw();
  const { handlers } = makeTools(executeKw);
  await assert.rejects(
    handlers.odoo_delete_timesheet({ timesheet_id: 0 }),
    /timesheet_id must be a positive integer/,
  );
});

test("odoo_create_timesheets_bulk creates every entry with a single employee lookup", async () => {
  const executeKw = makeExecuteKw();
  const { handlers } = makeTools(executeKw);
  const result = await handlers.odoo_create_timesheets_bulk({
    entries: [
      { task_id: 8, project_id: 7, date: "2026-03-01", hours: 2, description: "a" },
      { task_id: 9, project_id: 7, date: "2026-03-02", hours: 1.5, description: "b" },
    ],
  });

  const employeeLookups = executeKw.calls.filter(
    (call) => call.key === "hr.employee.search_read",
  );
  assert.equal(employeeLookups.length, 1);

  const createCalls = executeKw.calls.filter(
    (call) => call.key === "account.analytic.line.create",
  );
  assert.equal(createCalls.length, 2);
  assert.equal(record(createCalls[0].args[0]).date, "2026-03-01");
  assert.equal(record(createCalls[0].args[0]).employee_id, 9);
  assert.equal(record(createCalls[0].args[0]).user_id, UID);
  assert.equal(record(createCalls[1].args[0]).date, "2026-03-02");

  assert.match(result.content[0].text, /Bulk create finished/);
  assert.match(result.content[0].text, /Created: 2/);
  assert.match(result.content[0].text, /IDs: 1001, 1002/);
  assert.match(result.content[0].text, /Failed: 0/);
  assert.deepEqual(result.structuredContent, {
    created_ids: [1001, 1002],
    failures: [],
  });
});

test("odoo_create_timesheets_bulk caches repeated task validation", async () => {
  const executeKw = makeExecuteKw();
  const { handlers } = makeTools(executeKw);
  await handlers.odoo_create_timesheets_bulk({
    entries: [
      { ...validEntry, date: "2026-03-01", description: "one" },
      { ...validEntry, date: "2026-03-02", description: "two" },
    ],
  });
  assert.equal(
    executeKw.calls.filter((call) => call.key === "project.task.search_read").length,
    1,
  );
});

test("odoo_create_timesheets_bulk rejects empty or oversized entry lists", async () => {
  const executeKw = makeExecuteKw();
  const { handlers } = makeTools(executeKw);
  await assert.rejects(
    handlers.odoo_create_timesheets_bulk({ entries: [] }),
    /No entries provided/,
  );

  const tooMany = Array.from({ length: 101 }, (_, i) => ({
    task_id: i + 1,
    project_id: 7,
    date: "2026-03-01",
    hours: 1,
    description: "x",
  }));
  await assert.rejects(
    handlers.odoo_create_timesheets_bulk({ entries: tooMany }),
    /Too many entries: 101 \(max 100\)/,
  );
});

test("odoo_create_timesheets_bulk reports per-entry failures with indexes and keeps successes", async () => {
  const executeKw = makeExecuteKw({
    "account.analytic.line.create": (args) => {
      const values = record(args[0]);
      if (values.task_id === 99) throw new Error("Access denied");
      return 1000 + Number(values.task_id);
    },
  });
  const { handlers } = makeTools(executeKw);
  const result = await handlers.odoo_create_timesheets_bulk({
    entries: [
      { task_id: 1, project_id: 7, date: "2026-03-01", hours: 2, description: "ok" },
      { task_id: 99, project_id: 7, date: "2026-03-02", hours: 1, description: "bad" },
      { task_id: 3, project_id: 7, date: "2026-03-03", hours: 0.5, description: "ok2" },
    ],
  });

  assert.match(result.content[0].text, /Created: 2/);
  assert.match(result.content[0].text, /IDs: 1001, 1003/);
  assert.match(result.content[0].text, /Failed: 1/);
  assert.match(result.content[0].text, /- entry 1: Access denied/);
  assert.deepEqual(result.structuredContent, {
    created_ids: [1001, 1003],
    failures: [{ index: 1, message: "Access denied" }],
  });
});

test("odoo_create_timesheets_bulk preserves classified failure details", async () => {
  const executeKw = makeExecuteKw({
    "account.analytic.line.create": () => {
      const error = new Error("Validation failed");
      Object.assign(error, {
        code: "ODOO_VALIDATION_ERROR",
        outcome: "failed",
        retryable: false,
        verificationRequired: false,
      });
      throw error;
    },
  });
  const result = await makeTools(executeKw).handlers.odoo_create_timesheets_bulk({
    entries: [validEntry],
  });
  assert.deepEqual(result.structuredContent.failures, [{
    index: 0,
    message: "Validation failed",
    code: "ODOO_VALIDATION_ERROR",
    outcome: "failed",
    retryable: false,
    verification_required: false,
  }]);
});

test("odoo_create_timesheets_bulk stops writes and reconciles an uncertain create", async () => {
  let createCalls = 0;
  const executeKw = makeExecuteKw({
    "account.analytic.line.create": () => {
      createCalls += 1;
      if (createCalls === 1) return 2001;
      const error = new Error("Response could not be decoded");
      Object.assign(error, {
        code: "INVALID_JSON",
        outcome: "uncertain",
        retryable: false,
        verificationRequired: true,
      });
      throw error;
    },
  });
  const entries = [
    { ...validEntry, task_id: 1, description: "created" },
    { ...validEntry, task_id: 2, description: "uncertain" },
    { ...validEntry, task_id: 3, description: "skip one" },
    { ...validEntry, task_id: 4, description: "skip two" },
  ];
  const result = await makeTools(executeKw).handlers.odoo_create_timesheets_bulk({ entries });
  assert.equal(result.isError, true);
  assert.equal(createCalls, 2);
  assert.deepEqual(result.structuredContent.created_ids, [2001]);
  assert.deepEqual(result.structuredContent.uncertain_entry, {
    index: 1,
    message: "Response could not be decoded",
    code: "INVALID_JSON",
    outcome: "uncertain",
    retryable: false,
    verification_required: true,
  });
  assert.deepEqual(
    result.structuredContent.failures.map((failure) => failure.outcome),
    ["uncertain", "skipped", "skipped"],
  );
  assert.deepEqual(
    result.structuredContent.failures.map((failure) => failure.index),
    [1, 2, 3],
  );
});

test("odoo_create_timesheets_bulk validates each entry and records invalid ones by index", async () => {
  const executeKw = makeExecuteKw();
  const { handlers } = makeTools(executeKw);
  const result = await handlers.odoo_create_timesheets_bulk({
    entries: [
      { task_id: 1, project_id: 7, date: "2026-02-30", hours: 2, description: "bad date" },
      { task_id: 2, project_id: 7, date: "2026-03-01", hours: 0, description: "bad hours" },
      { task_id: 3, project_id: 7, date: "2026-03-02", hours: 1, description: "ok" },
    ],
  });

  assert.match(result.content[0].text, /Created: 1/);
  assert.match(result.content[0].text, /Failed: 2/);
  assert.match(result.content[0].text, /- entry 0: .*date must be a valid YYYY-MM-DD date/);
  assert.match(result.content[0].text, /- entry 1: .*hours must be a finite positive number/);
});

test("odoo_create_timesheets_bulk throws when no employee is found", async () => {
  const executeKw = makeExecuteKw({ "hr.employee.search_read": () => [] });
  const { handlers } = makeTools(executeKw);
  await assert.rejects(
    handlers.odoo_create_timesheets_bulk({
      entries: [validEntry],
    }),
    /No employee found for current user/,
  );
});
