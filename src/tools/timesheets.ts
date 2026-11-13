import { normalizeLimit, positiveInt } from "../utils/args.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type {
  ExecuteKwImplementation,
  GetAvailableFields,
  GetUid,
  OdooArguments,
  OdooKeywordArguments,
  OdooRecord,
} from "../contracts.js";
import {
  defineToolGroup,
  errorMessage,
  executeKw as execute,
  isRecord,
  referenceName,
} from "../contracts.js";

const MAX_BULK_ENTRIES = 100;

interface TimesheetEntry {
  task_id: number;
  project_id: number;
  date: string;
  hours: number;
  description: string;
}

interface TimesheetValues {
  date?: string;
  unit_amount?: number;
  name?: string;
  task_id?: number;
  project_id?: number;
}

interface BulkFailure {
  index: number;
  message: string;
  code?: unknown;
  outcome?: unknown;
  retryable?: unknown;
  verification_required?: unknown;
}

type GenericExecuteKw = <T = OdooRecord[]>(
  model: string,
  method: string,
  args?: OdooArguments,
  kwargs?: OdooKeywordArguments,
) => Promise<T>;

function isValidDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function validateDate(value: unknown, label = "date"): string {
  if (!isValidDate(value)) {
    throw new Error(`${label} must be a valid YYYY-MM-DD date`);
  }
  return value;
}

function validateHours(value: unknown, label = "hours"): number {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
    throw new Error(`${label} must be a finite positive number no greater than 24`);
  }
  return hours;
}

function validateDescription(value: unknown, label = "description"): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a nonblank string`);
  }
  return value.trim();
}

function normalizeDescription(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function relationId(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function nonnegativeInt(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a nonnegative integer`);
  }
  return parsed;
}

function parseCreateEntry(entry: unknown, prefix = ""): TimesheetEntry {
  const value = isRecord(entry) ? entry : {};
  return {
    task_id: positiveInt(value.task_id, `${prefix}task_id`),
    project_id: positiveInt(value.project_id, `${prefix}project_id`),
    date: validateDate(value.date, `${prefix}date`),
    hours: validateHours(value.hours, `${prefix}hours`),
    description: validateDescription(value.description, `${prefix}description`),
  };
}

function buildTimesheetValues({
  uid,
  employeeId,
  entry,
}: {
  uid: number | null;
  employeeId: number;
  entry: TimesheetEntry;
}) {
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

async function findEmployeeId(
  executeKw: GenericExecuteKw,
  uid: number | null,
): Promise<number> {
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
  return employees[0].id!;
}

async function readOwnedTimesheet(
  executeKw: GenericExecuteKw,
  uid: number | null,
  timesheetId: number,
): Promise<OdooRecord> {
  const rows = await executeKw("account.analytic.line", "read", [
    [timesheetId],
    ["id", "user_id", "name", "date", "unit_amount", "project_id", "task_id"],
  ]);
  const row = rows?.[0];
  if (!row) throw new Error(`Timesheet not found: ${timesheetId}`);
  if (relationId(row.user_id) !== uid) {
    throw new Error(`Timesheet ${timesheetId} does not belong to current user`);
  }
  return row;
}

async function findDuplicate(
  executeKw: GenericExecuteKw,
  uid: number | null,
  entry: TimesheetEntry,
  excludeId?: number,
): Promise<OdooRecord | undefined> {
  const domain: unknown[][] = [
    ["user_id", "=", uid],
    ["date", "=", entry.date],
    ["project_id", "=", entry.project_id],
    ["task_id", "=", entry.task_id],
    ["unit_amount", "=", entry.hours],
  ];
  if (excludeId !== undefined) domain.push(["id", "!=", excludeId]);
  const rows = await executeKw(
    "account.analytic.line",
    "search_read",
    [domain],
    { fields: ["id", "name", "unit_amount"] },
  );
  const normalized = normalizeDescription(entry.description);
  return (rows || []).find(
    (row) =>
      Number(row.unit_amount) === entry.hours &&
      typeof row.name === "string" &&
      normalizeDescription(row.name) === normalized,
  );
}

const definitions: Tool[] = [
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
        offset: {
          type: "number",
          description: "Number of results to skip (default 0)",
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

export function createTimesheetTools({
  executeKw: executeKwImplementation,
  getUid,
  getAvailableFields,
}: {
  executeKw: ExecuteKwImplementation;
  getUid: GetUid;
  getAvailableFields?: GetAvailableFields;
}) {
  const executeKw: GenericExecuteKw = <T = OdooRecord[]>(
    model: string,
    method: string,
    args: OdooArguments = [],
    kwargs: OdooKeywordArguments = {},
  ) => execute<T>(executeKwImplementation, model, method, args, kwargs);
  let mutationQueue: Promise<unknown> = Promise.resolve();

  function serializeTimesheetMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutationQueue.then(operation);
    mutationQueue = result.catch(() => undefined);
    return result;
  }

  async function validateTaskProject(
    taskId: number,
    projectId: number,
    cache?: Map<string, Promise<void>>,
  ): Promise<void> {
    const cacheKey = `${taskId}:${projectId}`;
    if (cache?.has(cacheKey)) return cache.get(cacheKey)!;

    const validation = (async () => {
      const taskOptionalFields = getAvailableFields
        ? await getAvailableFields("project.task", ["allow_timesheets"])
        : [];
      const taskFields = ["id", "project_id", ...taskOptionalFields];
      const tasks = await executeKw(
        "project.task",
        "search_read",
        [[["id", "=", taskId]]],
        { fields: taskFields, limit: 1 },
      );
      const task = tasks?.[0];
      if (!task) throw new Error(`Task not found: ${taskId}`);
      if (relationId(task.project_id) !== projectId) {
        throw new Error(`Task ${taskId} does not belong to project ${projectId}`);
      }
      if (taskOptionalFields.includes("allow_timesheets") && !task.allow_timesheets) {
        throw new Error(`Task ${taskId} does not accept timesheets`);
      }

      const projectOptionalFields = getAvailableFields
        ? await getAvailableFields("project.project", ["allow_timesheets"])
        : [];
      if (projectOptionalFields.includes("allow_timesheets")) {
        const projects = await executeKw("project.project", "search_read", [
          [["id", "=", projectId]],
        ], { fields: ["id", "allow_timesheets"], limit: 1 });
        const project = projects?.[0];
        if (!project) throw new Error(`Project not found: ${projectId}`);
        if (!project.allow_timesheets) {
          throw new Error(`Project ${projectId} does not accept timesheets`);
        }
      }
    })();

    if (cache) cache.set(cacheKey, validation);
    return validation;
  }

  async function validateCreateEntry(
    entry: TimesheetEntry,
    cache?: Map<string, Promise<void>>,
  ): Promise<void> {
    await validateTaskProject(entry.task_id, entry.project_id, cache);
    const duplicate = await findDuplicate(executeKw, getUid(), entry);
    if (duplicate) {
      throw new Error(`Probable duplicate timesheet already exists: ${duplicate.id}`);
    }
  }

  return defineToolGroup({
    definitions,
    handlers: {
      async odoo_create_timesheet(args) {
        const uid = getUid();
        const entry = parseCreateEntry(args);
        return serializeTimesheetMutation(async () => {
          await validateCreateEntry(entry);
          const employeeId = await findEmployeeId(executeKw, uid);
          const timesheetId = await executeKw<number>(
            "account.analytic.line",
            "create",
            [buildTimesheetValues({ uid, employeeId, entry })],
          );
          if (!timesheetId) {
            throw new Error("Odoo did not create the timesheet");
          }
          return {
            content: [{ type: "text", text: `Timesheet created: ${timesheetId}` }],
            structuredContent: { id: timesheetId, ...entry },
          };
        });
      },

      async odoo_get_my_timesheets(args) {
        const limit = normalizeLimit(args.limit);
        const offset = args.offset === undefined
          ? 0
          : nonnegativeInt(args.offset, "offset");
        const domain: unknown[][] = [["user_id", "=", getUid()]];
        const date = args.date === undefined ? undefined : validateDate(args.date, "date");
        const dateFrom = args.date_from === undefined
          ? undefined
          : validateDate(args.date_from, "date_from");
        const dateTo = args.date_to === undefined
          ? undefined
          : validateDate(args.date_to, "date_to");
        if (date) {
          domain.push(["date", "=", date]);
        } else {
          if (dateFrom) domain.push(["date", ">=", dateFrom]);
          if (dateTo) domain.push(["date", "<=", dateTo]);
        }
        if (args.project_id !== undefined) {
          domain.push(["project_id", "=", positiveInt(args.project_id, "project_id")]);
        }
        if (args.task_id !== undefined) {
          domain.push(["task_id", "=", positiveInt(args.task_id, "task_id")]);
        }

        const [totalCount, aggregateRows, rows] = await Promise.all([
          executeKw<number>("account.analytic.line", "search_count", [domain]),
          executeKw<OdooRecord[]>(
            "account.analytic.line",
            "read_group",
            [domain, ["unit_amount:sum"], []],
            { lazy: false },
          ),
          executeKw<OdooRecord[]>("account.analytic.line", "search_read", [domain], {
            fields: [
              "id",
              "date",
              "unit_amount",
              "name",
              "project_id",
              "task_id",
            ],
            limit,
            offset,
            order: "date desc, id desc",
          }),
        ]);

        const pageHours = (rows || []).reduce(
          (acc, row) => acc + (Number(row.unit_amount) || 0),
          0,
        );
        const aggregatedHours = aggregateRows?.[0]?.unit_amount;
        const totalHours =
          typeof aggregatedHours === "number" && Number.isFinite(aggregatedHours)
            ? aggregatedHours
            : pageHours;
        const lines = (rows || []).map((r) => {
          const project = referenceName(r.project_id) || "N/A";
          const task = referenceName(r.task_id) || "N/A";
          return `[${r.id}] ${r.date} - ${r.unit_amount || 0}h\n   ${project} / ${task}\n   ${r.name || ""}`;
        });

        const text = rows?.length
          ? [
              `Total hours: ${totalHours}`,
              `Entries: ${rows.length}`,
              `Total count: ${totalCount}`,
              `Offset: ${offset}`,
              `Has more: ${offset + rows.length < totalCount}`,
              "",
              ...lines,
            ].join("\n")
          : [
              "No results",
              `Total count: ${totalCount}`,
              `Offset: ${offset}`,
              "Has more: false",
            ].join("\n");

        return {
          content: [{ type: "text", text }],
          structuredContent: {
            rows: rows || [],
            total_hours: totalHours,
            total_count: totalCount,
            offset,
            has_more: offset + (rows?.length || 0) < totalCount,
          },
        };
      },

      async odoo_update_timesheet(args) {
        const timesheetId = positiveInt(args.timesheet_id, "timesheet_id");
        return serializeTimesheetMutation(async () => {
          const current = await readOwnedTimesheet(executeKw, getUid(), timesheetId);
          const values: TimesheetValues = {};

          if (args.date !== undefined) values.date = validateDate(args.date, "date");
          if (args.hours !== undefined) {
            values.unit_amount = validateHours(args.hours, "hours");
          }
          if (args.description !== undefined) {
            values.name = validateDescription(args.description, "description");
          }
          if (args.task_id !== undefined) {
            values.task_id = positiveInt(args.task_id, "task_id");
          }
          if (args.project_id !== undefined) {
            values.project_id = positiveInt(args.project_id, "project_id");
          }

          if (Object.keys(values).length === 0) {
            throw new Error("Nothing to update");
          }

          const effective: TimesheetEntry = {
            task_id: positiveInt(
              values.task_id ?? relationId(current.task_id),
              "task_id",
            ),
            project_id: positiveInt(
              values.project_id ?? relationId(current.project_id),
              "project_id",
            ),
            date: validateDate(values.date ?? current.date, "date"),
            hours: validateHours(
              values.unit_amount ?? current.unit_amount,
              "hours",
            ),
            description: validateDescription(
              values.name ?? current.name,
              "description",
            ),
          };
          await validateTaskProject(effective.task_id, effective.project_id);
          const duplicate = await findDuplicate(
            executeKw,
            getUid(),
            effective,
            timesheetId,
          );
          if (duplicate) {
            throw new Error(
              `Probable duplicate timesheet already exists: ${duplicate.id}`,
            );
          }

          const ok = await executeKw<boolean>("account.analytic.line", "write", [
            [timesheetId],
            values,
          ]);
          if (!ok) {
            throw new Error("Update failed");
          }

          let row: OdooRecord | null = null;
          let verificationError: string | null = null;
          try {
            const updated = await executeKw("account.analytic.line", "read", [
              [timesheetId],
              ["id", "name", "date", "unit_amount", "project_id", "task_id"],
            ]);
            row = updated?.[0] || null;
          } catch (error) {
            verificationError = errorMessage(error);
          }
          return {
            content: [
              {
                type: "text",
                text: row
                  ? `Timesheet updated: [${row.id}] ${row.date} ${row.unit_amount}h ${row.name}`
                  : `Timesheet updated: ${timesheetId}`,
              },
            ],
            structuredContent: {
              id: timesheetId,
              updated: true,
              verified: verificationError === null,
              row,
              verification_error: verificationError,
            },
          };
        });
      },

      async odoo_delete_timesheet(args) {
        const timesheetId = positiveInt(args.timesheet_id, "timesheet_id");
        return serializeTimesheetMutation(async () => {
          await readOwnedTimesheet(executeKw, getUid(), timesheetId);
          const ok = await executeKw<boolean>("account.analytic.line", "unlink", [
            [timesheetId],
          ]);
          if (!ok) {
            throw new Error("Delete failed");
          }
          return {
            content: [{ type: "text", text: `Timesheet deleted: ${timesheetId}` }],
            structuredContent: { id: timesheetId, deleted: true },
          };
        });
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

        return serializeTimesheetMutation(async () => {
          const uid = getUid();
          const employeeId = await findEmployeeId(executeKw, uid);
          const createdIds: number[] = [];
          const failed: BulkFailure[] = [];
          const taskValidationCache = new Map<string, Promise<void>>();

          for (let i = 0; i < entries.length; i += 1) {
            const e = entries[i];
            try {
              const entry = parseCreateEntry(e, `entries[${i}].`);
              await validateCreateEntry(entry, taskValidationCache);
              const id = await executeKw<number>("account.analytic.line", "create", [
                buildTimesheetValues({ uid, employeeId, entry }),
              ]);
              if (!id) throw new Error("Odoo did not create the timesheet");
              createdIds.push(id);
            } catch (err) {
              const details = isRecord(err) ? err : {};
              const failure: BulkFailure = {
                index: i,
                message: errorMessage(err),
              };
              if (details.code !== undefined) failure.code = details.code;
              if (details.outcome !== undefined) failure.outcome = details.outcome;
              if (details.retryable !== undefined) failure.retryable = details.retryable;
              if (details.verificationRequired !== undefined) {
                failure.verification_required = details.verificationRequired;
              }
              failed.push(failure);
              if (
                details.outcome === "uncertain" ||
                details.verificationRequired === true
              ) {
                for (let skippedIndex = i + 1; skippedIndex < entries.length; skippedIndex += 1) {
                  failed.push({
                    index: skippedIndex,
                    message: `Skipped after uncertain outcome for entry ${i}`,
                    outcome: "skipped",
                    retryable: false,
                    verification_required: false,
                  });
                }
                return {
                  isError: true,
                  content: [
                    {
                      type: "text",
                      text: [
                        "Bulk create stopped: an entry has an uncertain outcome",
                        `Created: ${createdIds.length}`,
                        `IDs: ${createdIds.join(", ") || "none"}`,
                        `Uncertain entry: ${i} - ${errorMessage(err)}`,
                        `Skipped: ${entries.length - i - 1}`,
                      ].join("\n"),
                    },
                  ],
                  structuredContent: {
                    created_ids: createdIds,
                    uncertain_entry: failure,
                    failures: failed,
                  },
                };
              }
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
            structuredContent: { created_ids: createdIds, failures: failed },
          };
        });
      },
    },
  });
}
