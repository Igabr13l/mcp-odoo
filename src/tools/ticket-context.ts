import { normalizeLimit, positiveInt } from "../utils/args.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { htmlToText, redactSecrets } from "../utils/format.js";
import {
  type AttachmentRecord,
  getAttachmentRows,
  getMessageRows,
  normalizeAttachmentMetadata,
} from "./ticket-content.js";
import type {
  ExecuteKwImplementation,
  GetAvailableFields,
  GetNameMap,
  OdooRecord,
} from "../contracts.js";
import {
  defineToolGroup,
  errorMessage,
  executeKw as execute,
  referenceId,
} from "../contracts.js";

const TASK_FIELDS = [
  "id",
  "name",
  "project_id",
  "stage_id",
  "user_ids",
  "tag_ids",
  "priority",
  "task_priority",
  "date_deadline",
  "allocated_hours",
  "effective_hours",
  "progress",
  "description",
  "gitlab_branch_ids",
];
const BRANCH_FIELDS = [
  "id",
  "gitlab_origin_project_id",
  "gitlab_branch_name",
  "from_branch",
  "target_branch",
  "gitlab_link",
  "merge_request_link",
  "gitlab_user_id",
];
const TIMESHEET_FIELDS = [
  "id",
  "date",
  "unit_amount",
  "name",
  "employee_id",
  "user_id",
  "project_id",
  "task_id",
];

interface Reference {
  id: unknown;
  name: unknown;
}

function reference(value: unknown): Reference | null {
  return Array.isArray(value)
    ? { id: value[0], name: value[1] }
    : null;
}

function safeText(value: unknown): string {
  return redactSecrets(htmlToText(value));
}

function normalizeMessage(message: OdooRecord) {
  return {
    id: message.id,
    date: message.date || null,
    author: reference(message.author_id) || {
      id: null,
      name: message.email_from || "System",
    },
    subject: redactSecrets(message.subject),
    body: safeText(message.body),
    message_type: message.message_type || null,
    subtype: reference(message.subtype_id),
    attachment_ids: message.attachment_ids || [],
  };
}

function normalizeBranch(branch: OdooRecord) {
  return {
    id: branch.id,
    project: reference(branch.gitlab_origin_project_id),
    branch_name: branch.gitlab_branch_name || null,
    from_branch: branch.from_branch || null,
    target_branch: branch.target_branch || null,
    branch_link: branch.gitlab_link || null,
    merge_request_link: branch.merge_request_link || null,
    owner: reference(branch.gitlab_user_id),
  };
}

function normalizeTimesheet(line: OdooRecord) {
  return {
    id: line.id,
    date: line.date || null,
    hours: Number(line.unit_amount || 0),
    description: redactSecrets(line.name),
    employee: reference(line.employee_id),
    user: reference(line.user_id),
    project: reference(line.project_id),
    task: reference(line.task_id),
  };
}

export async function getProjectStages(
  executeKw: ExecuteKwImplementation,
  projectId: number,
) {
  const rows = await execute<OdooRecord[]>(
    executeKw,
    "project.task.type",
    "search_read",
    [
      [
        "|",
        ["project_ids", "=", false],
        ["project_ids", "in", [projectId]],
      ],
    ],
    {
      fields: ["id", "name", "sequence", "fold", "project_ids"],
      limit: 500,
      order: "sequence, id",
    },
  );
  return (rows || []).map((stage) => ({
    id: stage.id,
    name: stage.name,
    sequence: stage.sequence,
    fold: Boolean(stage.fold),
    project_ids: stage.project_ids || [],
    applicability:
      (stage.project_ids?.length ?? 0) > 0 ? "project-specific" : "global",
  }));
}

async function readTask(
  executeKw: ExecuteKwImplementation,
  getAvailableFields: GetAvailableFields | undefined,
  taskId: number,
  requestedFields: string[] = TASK_FIELDS,
): Promise<OdooRecord | null> {
  const fields = getAvailableFields
    ? await getAvailableFields("project.task", requestedFields)
    : requestedFields;
  const rows = await execute<OdooRecord[]>(executeKw, "project.task", "read", [
    [taskId],
    fields,
  ]);
  return rows?.[0] || null;
}

async function readBranches(
  executeKw: ExecuteKwImplementation,
  ids: number[] | undefined,
) {
  if (!ids?.length) return [];
  const rows = await execute<OdooRecord[]>(executeKw, "gitlab.task.branch", "read", [
    ids,
    BRANCH_FIELDS,
  ]);
  return (rows || []).map(normalizeBranch);
}

async function readTimesheets(executeKw: ExecuteKwImplementation, taskId: number) {
  const domain = [["task_id", "=", taskId]];
  const lineCount = await execute<number>(
    executeKw,
    "account.analytic.line",
    "search_count",
    [domain],
  );
  const aggregateRows = await execute<OdooRecord[]>(
    executeKw,
    "account.analytic.line",
    "read_group",
    [domain, ["unit_amount:sum"], []],
    { lazy: false },
  );
  const rows = await execute<OdooRecord[]>(
    executeKw,
    "account.analytic.line",
    "search_read",
    [domain],
    { fields: TIMESHEET_FIELDS, limit: 1000, order: "date desc, id desc" },
  );
  const lines = (rows || []).map(normalizeTimesheet);
  const totalLineCount = Number(lineCount || 0);
  return {
    line_count: totalLineCount,
    returned_line_count: lines.length,
    truncated: totalLineCount > lines.length,
    total_hours: Number(aggregateRows?.[0]?.unit_amount || 0),
    lines,
  };
}

async function readNames(
  getNameMap: GetNameMap | undefined,
  model: string,
  ids: number[] | undefined,
) {
  if (!getNameMap || !ids?.length) return [];
  const names = await getNameMap(model, ids);
  return ids.map((id) => ({ id, name: names.get(Number(id)) || `#${id}` }));
}

function definitions(): Tool[] {
  return [
    {
      name: "odoo_get_project_stages",
      description: "List every stage applicable to a project, including empty stages",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "number", description: "Project ID" },
        },
        required: ["project_id"],
      },
    },
    {
      name: "odoo_add_ticket_note",
      description: "Preview or post a redacted internal note on a ticket",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "number", description: "Task ID" },
          body: { type: "string", description: "Internal note body" },
          confirm: {
            type: "boolean",
            description: "Must be true to post the internal note",
          },
        },
        required: ["task_id", "body", "confirm"],
      },
    },
    {
      name: "odoo_get_ticket_context",
      description: "Get aggregate ticket details and linked Odoo evidence",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "number", description: "Task ID" },
          include_system: {
            type: "boolean",
            description: "Include automatic system notifications (default false)",
          },
          message_limit: {
            type: "number",
            description: "Maximum messages (default 50, max 200)",
          },
          expected_project_id: {
            type: "number",
            description: "Reject the ticket unless it belongs to this project ID",
          },
        },
        required: ["task_id"],
      },
    },
  ];
}

export function createTicketContextTools({
  executeKw,
  getAvailableFields,
  getNameMap,
}: {
  executeKw: ExecuteKwImplementation;
  getAvailableFields?: GetAvailableFields;
  getNameMap?: GetNameMap;
}) {
  return defineToolGroup({
    definitions: definitions(),
    handlers: {
      async odoo_get_project_stages(args) {
        const projectId = positiveInt(args.project_id, "project_id");
        const stages = await getProjectStages(executeKw, projectId);
        const text = stages.length
          ? stages
              .map(
                (stage) =>
                  `[${stage.id}] ${stage.name} - sequence:${stage.sequence} - fold:${stage.fold} - ${stage.applicability}`,
              )
              .join("\n")
          : "No stages found";
        return {
          content: [{ type: "text", text }],
          structuredContent: { project_id: projectId, stages },
        };
      },

      async odoo_add_ticket_note(args) {
        const taskId = positiveInt(args.task_id, "task_id");
        if (typeof args.body !== "string" || !args.body.trim()) {
          throw new Error("body must be a nonblank string");
        }
        const redactedBody = safeText(args.body);
        if (!redactedBody.trim()) {
          throw new Error("body must be a nonblank string");
        }
        if (args.confirm !== true) {
          return {
            content: [
              {
                type: "text",
                text: `Preview internal note for task ${taskId}:\n${redactedBody}`,
              },
            ],
            structuredContent: {
              status: "preview",
              task_id: taskId,
              body: redactedBody,
            },
          };
        }

        const messageId = await execute<unknown>(
          executeKw,
          "project.task",
          "message_post",
          [[taskId]],
          {
            body: redactedBody,
            subtype_xmlid: "mail.mt_note",
            message_type: "comment",
          },
        );
        if (!messageId) throw new Error("Odoo did not post the internal note");

        let verifiedMessage = null;
        let verificationError = null;
        if (Number.isInteger(Number(messageId)) && Number(messageId) > 0) {
          try {
            const rows = await execute<OdooRecord[]>(executeKw, "mail.message", "read", [
              [Number(messageId)],
              [
                "id",
                "date",
                "author_id",
                "email_from",
                "subject",
                "body",
                "message_type",
                "subtype_id",
                "attachment_ids",
              ],
            ]);
            if (rows?.[0]) verifiedMessage = normalizeMessage(rows[0]);
          } catch (error) {
            verificationError = errorMessage(error);
          }
        }

        return {
          content: [
            {
              type: "text",
              text: `Internal note posted on task ${taskId} as message ${messageId}:\n${redactedBody}`,
            },
          ],
          structuredContent: {
            status: "posted",
            task_id: taskId,
            body: redactedBody,
            message_id: Number(messageId) || messageId,
            verified: Boolean(verifiedMessage),
            message: verifiedMessage,
            verification_error: verificationError
              ? "Message verification was unavailable"
              : null,
          },
        };
      },

      async odoo_get_ticket_context(args) {
        const taskId = positiveInt(args.task_id, "task_id");
        const expectedProjectId =
          args.expected_project_id === undefined
            ? null
            : positiveInt(args.expected_project_id, "expected_project_id");
        let task;

        if (expectedProjectId !== null) {
          const scopedTask = await readTask(executeKw, getAvailableFields, taskId, [
            "id",
            "project_id",
          ]);
          if (!scopedTask) {
            return {
              content: [{ type: "text", text: "Task not found" }],
              structuredContent: { task_id: taskId, found: false },
            };
          }
          const scopedProjectId = referenceId(scopedTask.project_id) || null;
          if (scopedProjectId !== expectedProjectId) {
            throw new Error(
              `Task ${taskId} belongs to project ${scopedProjectId || "none"}, expected project ${expectedProjectId}`,
            );
          }
          task = await readTask(executeKw, getAvailableFields, taskId);
        } else {
          task = await readTask(executeKw, getAvailableFields, taskId);
        }
        if (!task) {
          return {
            content: [{ type: "text", text: "Task not found" }],
            structuredContent: { task_id: taskId, found: false },
          };
        }

        const projectId = referenceId(task.project_id) || null;
        const messages = await getMessageRows(executeKw, taskId, {
          includeSystem: args.include_system === true,
          limit: normalizeLimit(args.message_limit, 50, 200),
        });
        const attachments = await getAttachmentRows(executeKw, taskId);
        const branches = await readBranches(
          executeKw,
          task.gitlab_branch_ids || [],
        );
        const timesheets = await readTimesheets(executeKw, taskId);
        const stages = projectId
          ? await getProjectStages(executeKw, projectId)
          : [];
        const assignees = await readNames(
          getNameMap,
          "res.users",
          task.user_ids || [],
        );
        const tags = await readNames(
          getNameMap,
          "project.tags",
          task.tag_ids || [],
        );
        const ticket = {
          id: task.id,
          name: task.name,
          project: reference(task.project_id),
          stage: reference(task.stage_id),
          assignees,
          tags,
          priority: task.task_priority || task.priority || null,
          deadline: task.date_deadline || null,
          hours: {
            allocated: Number(task.allocated_hours || 0),
            effective: Number(task.effective_hours || 0),
          },
          progress_percent: Math.round(Number(task.progress) || 0),
          description: safeText(task.description),
        };

        return {
          content: [
            {
              type: "text",
              text: `Task #${task.id}: ${task.name}\n${messages.length} message(s), ${attachments.length} attachment(s), ${branches.length} GitLab row(s), ${timesheets.total_hours} timesheet hour(s), ${stages.length} project stage(s)`,
            },
          ],
          structuredContent: {
            task_id: taskId,
            found: true,
            ticket,
            messages: messages.map(normalizeMessage),
            attachments: attachments.map(normalizeAttachmentMetadata),
            gitlab_branches: branches,
            timesheets,
            project_stages: stages,
          },
        };
      },
    },
  });
}
