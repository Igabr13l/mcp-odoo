import { normalizeLimit, positiveInt } from "../utils/args.js";

const MAX_BULK_ENTRIES = 100;

function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function validateDate(value, label = "date") {
  if (!isValidDate(value)) {
    throw new Error(`${label} must be a valid YYYY-MM-DD date`);
  }
  return value;
}

function validateHours(value, label = "hours") {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error(`${label} must be a finite positive number`);
  }
  return hours;
}

function parseCreateEntry(entry, prefix = "") {
  return {
    task_id: positiveInt(entry.task_id, `${prefix}task_id`),
    project_id: positiveInt(entry.project_id, `${prefix}project_id`),
    date: validateDate(entry.date, `${prefix}date`),
    hours: validateHours(entry.hours, `${prefix}hours`),
    description: entry.description,
  };
}

function buildTimesheetValues({ uid, employeeId, entry }) {
  return {
    date: entry.date,
    employee_id: employeeId,
    project_id: entry.project_id,
    task_id: entry.task_id,
    name: entry.description,
    unit_amount: entry.hours,
    user_id: uid,
  };
}

async function findEmployeeId(executeKw, uid) {
  const employees = await executeKw(
    "hr.employee",
    "search_read",
    [[["user_id", "=", uid]]],
    {
      fields: ["id"],
      limit: 1,
    },
  );
  if (!employees?.length) {
    throw new Error("No employee found for current user");
  }
  return employees[0].id;
}

const definitions = [
  {
    name: "odoo_create_timesheet",
    description: "Create a timesheet line for a task",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "number" },
        project_id: { type: "number" },
        date: { type: "string", description: "YYYY-MM-DD" },
        hours: { type: "number" },
        description: { type: "string" },
      },
      required: ["task_id", "project_id", "date", "hours", "description"],
    },
  },
  {
    name: "odoo_get_my_timesheets",
    description: "List my timesheet lines with optional filters",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Exact date YYYY-MM-DD" },
        date_from: { type: "string", description: "From date YYYY-MM-DD" },
        date_to: { type: "string", description: "To date YYYY-MM-DD" },
        project_id: { type: "number", description: "Filter by project ID" },
        task_id: { type: "number", description: "Filter by task ID" },
        limit: {
          type: "number",
          description: "Max results (default 100, max 500)",
        },
      },
    },
  },
  {
    name: "odoo_update_timesheet",
    description: "Update an existing timesheet line",
    inputSchema: {
      type: "object",
      properties: {
        timesheet_id: { type: "number" },
        date: { type: "string", description: "YYYY-MM-DD (optional)" },
        hours: { type: "number", description: "optional" },
        description: { type: "string", description: "optional" },
        task_id: { type: "number", description: "optional" },
        project_id: { type: "number", description: "optional" },
      },
      required: ["timesheet_id"],
    },
  },
  {
    name: "odoo_delete_timesheet",
    description: "Delete a timesheet line by ID",
    inputSchema: {
      type: "object",
      properties: {
        timesheet_id: { type: "number" },
      },
      required: ["timesheet_id"],
    },
  },
  {
    name: "odoo_create_timesheets_bulk",
    description: "Create many timesheet lines in one call",
    inputSchema: {
      type: "object",
      properties: {
        entries: {
          type: "array",
          items: {
            type: "object",
            properties: {
              task_id: { type: "number" },
              project_id: { type: "number" },
              date: { type: "string", description: "YYYY-MM-DD" },
              hours: { type: "number" },
              description: { type: "string" },
            },
            required: [
              "task_id",
              "project_id",
              "date",
              "hours",
              "description",
            ],
          },
        },
      },
      required: ["entries"],
    },
  },
];

export function createTimesheetTools({ executeKw, getUid }) {
  return {
    definitions,
    handlers: {
      async odoo_create_timesheet(args) {
        const uid = getUid();
        const employeeId = await findEmployeeId(executeKw, uid);
        const entry = parseCreateEntry(args);
        const timesheetId = await executeKw("account.analytic.line", "create", [
          buildTimesheetValues({ uid, employeeId, entry }),
        ]);
        if (!timesheetId) {
          throw new Error("Odoo did not create the timesheet");
        }
        return {
          content: [{ type: "text", text: `Timesheet created: ${timesheetId}` }],
        };
      },

      async odoo_get_my_timesheets(args) {
        const limit = normalizeLimit(args.limit);
        const domain = [["user_id", "=", getUid()]];
        if (args.date) {
          domain.push(["date", "=", args.date]);
        } else {
          if (args.date_from) domain.push(["date", ">=", args.date_from]);
          if (args.date_to) domain.push(["date", "<=", args.date_to]);
        }
        if (args.project_id !== undefined) {
          domain.push(["project_id", "=", positiveInt(args.project_id, "project_id")]);
        }
        if (args.task_id !== undefined) {
          domain.push(["task_id", "=", positiveInt(args.task_id, "task_id")]);
        }

        const rows = await executeKw(
          "account.analytic.line",
          "search_read",
          [domain],
          {
            fields: [
              "id",
              "date",
              "unit_amount",
              "name",
              "project_id",
              "task_id",
            ],
            limit,
            order: "date desc, id desc",
          },
        );

        const totalHours = (rows || []).reduce(
          (acc, row) => acc + (Number(row.unit_amount) || 0),
          0,
        );
        const lines = (rows || []).map((r) => {
          const project = r.project_id?.[1] || "N/A";
          const task = r.task_id?.[1] || "N/A";
          return `[${r.id}] ${r.date} - ${r.unit_amount || 0}h\n   ${project} / ${task}\n   ${r.name || ""}`;
        });

        const text = rows?.length
          ? [
              `Total hours: ${totalHours}`,
              `Entries: ${rows.length}`,
              "",
              ...lines,
            ].join("\n")
          : "No results";

        return { content: [{ type: "text", text }] };
      },

      async odoo_update_timesheet(args) {
        const timesheetId = positiveInt(args.timesheet_id, "timesheet_id");
        const values = {};

        if (args.date !== undefined) values.date = validateDate(args.date, "date");
        if (args.hours !== undefined) {
          values.unit_amount = validateHours(args.hours, "hours");
        }
        if (args.description !== undefined) values.name = args.description;
        if (args.task_id !== undefined) {
          values.task_id = positiveInt(args.task_id, "task_id");
        }
        if (args.project_id !== undefined) {
          values.project_id = positiveInt(args.project_id, "project_id");
        }

        if (Object.keys(values).length === 0) {
          throw new Error("Nothing to update");
        }

        const ok = await executeKw("account.analytic.line", "write", [
          [timesheetId],
          values,
        ]);
        if (!ok) {
          throw new Error("Update failed");
        }

        const updated = await executeKw("account.analytic.line", "read", [
          [timesheetId],
          ["id", "name", "date", "unit_amount", "project_id", "task_id"],
        ]);
        const row = updated?.[0];
        return {
          content: [
            {
              type: "text",
              text: row
                ? `Timesheet updated: [${row.id}] ${row.date} ${row.unit_amount}h ${row.name}`
                : `Timesheet updated: ${timesheetId}`,
            },
          ],
        };
      },

      async odoo_delete_timesheet(args) {
        const timesheetId = positiveInt(args.timesheet_id, "timesheet_id");
        const ok = await executeKw("account.analytic.line", "unlink", [
          [timesheetId],
        ]);
        if (!ok) {
          throw new Error("Delete failed");
        }
        return {
          content: [{ type: "text", text: `Timesheet deleted: ${timesheetId}` }],
        };
      },

      async odoo_create_timesheets_bulk(args) {
        const entries = Array.isArray(args.entries) ? args.entries : [];
        if (entries.length === 0) {
          throw new Error("No entries provided");
        }
        if (entries.length > MAX_BULK_ENTRIES) {
          throw new Error(
            `Too many entries: ${entries.length} (max ${MAX_BULK_ENTRIES})`,
          );
        }

        const uid = getUid();
        const employeeId = await findEmployeeId(executeKw, uid);
        const createdIds = [];
        const failed = [];

        for (let i = 0; i < entries.length; i += 1) {
          const e = entries[i];
          try {
            const entry = parseCreateEntry(e, `entries[${i}].`);
            const id = await executeKw("account.analytic.line", "create", [
              buildTimesheetValues({ uid, employeeId, entry }),
            ]);
            if (!id) throw new Error("Odoo did not create the timesheet");
            createdIds.push(id);
          } catch (err) {
            failed.push({ index: i, message: err.message });
          }
        }

        return {
          content: [
            {
              type: "text",
              text: [
                "Bulk create finished",
                `Created: ${createdIds.length}`,
                `IDs: ${createdIds.join(", ") || "none"}`,
                `Failed: ${failed.length}`,
                ...failed.map((f) => `- entry ${f.index}: ${f.message}`),
              ].join("\n"),
            },
          ],
        };
      },
    },
  };
}
