import assert from "node:assert/strict";
import test from "node:test";
import { createTimesheetTools } from "../src/tools/timesheets.js";

const UID = 16;

function makeExecuteKw(overrides = {}) {
  const calls = [];
  const executeKw = async (model, method, args = [], kwargs = {}) => {
    const key = `${model}.${method}`;
    calls.push({ key, model, method, args, kwargs });
    if (Object.hasOwn(overrides, key)) {
      return overrides[key](args, kwargs, calls);
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
            name: "test",
            date: "2026-03-01",
            unit_amount: 2,
            project_id: [7, "Project"],
            task_id: [8, "Task"],
          },
        ];
      case "account.analytic.line.search_read":
        return [];
      default:
        return [];
    }
  };
  executeKw.calls = calls;
  return executeKw;
}

function makeTools(executeKw, getUid = () => UID) {
  return createTimesheetTools({ executeKw, getUid });
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
  assert.deepEqual(create.inputSchema.required, [
    "task_id",
    "project_id",
    "date",
    "hours",
    "description",
  ]);

  const update = definitions.find(
    (definition) => definition.name === "odoo_update_timesheet",
  );
  assert.deepEqual(update.inputSchema.required, ["timesheet_id"]);

  const deleteTool = definitions.find(
    (definition) => definition.name === "odoo_delete_timesheet",
  );
  assert.deepEqual(deleteTool.inputSchema.required, ["timesheet_id"]);

  const bulk = definitions.find(
    (definition) => definition.name === "odoo_create_timesheets_bulk",
  );
  assert.deepEqual(bulk.inputSchema.required, ["entries"]);
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
  assert.deepEqual(createCall.args, [
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
  assert.equal(createCall.args[0].unit_amount, 2.5);
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
  assert.deepEqual(call.args[0], [
    ["user_id", "=", UID],
    ["date", "=", "2026-03-01"],
  ]);
  assert.equal(call.kwargs.limit, 100);
  assert.equal(call.kwargs.order, "date desc, id desc");
  assert.match(result.content[0].text, /Total hours: 5/);
  assert.match(result.content[0].text, /Entries: 2/);
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
  assert.deepEqual(call.args[0], [
    ["user_id", "=", UID],
    ["date", ">=", "2026-02-01"],
    ["date", "<=", "2026-02-28"],
  ]);
  assert.equal(call.kwargs.limit, 500);
});

test("odoo_get_my_timesheets falls back to 100 when limit is not a number", async () => {
  const executeKw = makeExecuteKw();
  const { handlers } = makeTools(executeKw);
  await handlers.odoo_get_my_timesheets({ limit: "abc" });

  const call = executeKw.calls.find(
    (entry) => entry.key === "account.analytic.line.search_read",
  );
  assert.equal(call.kwargs.limit, 100);
});

test("odoo_get_my_timesheets validates optional project and task filters", async () => {
  const executeKw = makeExecuteKw();
  const { handlers } = makeTools(executeKw);
  await handlers.odoo_get_my_timesheets({ project_id: 7, task_id: 8 });

  const call = executeKw.calls.find(
    (entry) => entry.key === "account.analytic.line.search_read",
  );
  assert.deepEqual(call.args[0], [
    ["user_id", "=", UID],
    ["project_id", "=", 7],
    ["task_id", "=", 8],
  ]);
  await assert.rejects(
    handlers.odoo_get_my_timesheets({ project_id: -1 }),
    /project_id must be a positive integer/,
  );
});

test("odoo_get_my_timesheets returns No results when empty", async () => {
  const executeKw = makeExecuteKw();
  const { handlers } = makeTools(executeKw);
  const result = await handlers.odoo_get_my_timesheets({});
  assert.equal(result.content[0].text, "No results");
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
    project_id: 10,
  });

  const writeCall = executeKw.calls.find(
    (call) => call.key === "account.analytic.line.write",
  );
  assert.deepEqual(writeCall.args[0], [5]);
  assert.deepEqual(writeCall.args[1], {
    date: "2026-03-02",
    unit_amount: 3.5,
    name: "Fixed bug",
    task_id: 9,
    project_id: 10,
  });
  assert.equal(result.content[0].text, "Timesheet updated: [123] 2026-03-01 2h test");
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
  assert.deepEqual(call.args[0], [5]);
  assert.equal(result.content[0].text, "Timesheet deleted: 5");
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
  assert.equal(createCalls[0].args[0].date, "2026-03-01");
  assert.equal(createCalls[0].args[0].employee_id, 9);
  assert.equal(createCalls[0].args[0].user_id, UID);
  assert.equal(createCalls[1].args[0].date, "2026-03-02");

  assert.match(result.content[0].text, /Bulk create finished/);
  assert.match(result.content[0].text, /Created: 2/);
  assert.match(result.content[0].text, /IDs: 1001, 1002/);
  assert.match(result.content[0].text, /Failed: 0/);
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
      if (args[0].task_id === 99) throw new Error("Access denied");
      return 1000 + args[0].task_id;
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
