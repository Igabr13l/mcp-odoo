import { formatList } from "../utils/format.js";
import { normalizeLimit, positiveInt } from "../utils/args.js";

function progressPercentage(value) {
  return Math.round(Number(value) || 0);
}

export function createBoardTools({
  executeKw,
  getAvailableFields,
  getNameMap,
  getUid,
}) {
  return {
    definitions: [
      {
        name: "odoo_get_my_board",
        description: "Show my Odoo Kanban board grouped and ordered by real stages",
        inputSchema: {
          type: "object",
          properties: {
            project_id: { type: "number", description: "Project ID" },
            include_closed: {
              type: "boolean",
              description: "Include closed tasks (default false)",
            },
            limit: {
              type: "number",
              description: "Maximum tasks (default 100, max 500)",
            },
          },
          required: ["project_id"],
        },
      },
    ],
    handlers: {
      async odoo_get_my_board(args) {
        const projectId = positiveInt(args.project_id, "project_id");
        const requestedFields = [
          "id",
          "name",
          "stage_id",
          "is_closed",
          "sequence",
          "priority",
          "task_priority",
          "tag_ids",
          "allocated_hours",
          "effective_hours",
          "remaining_hours",
          "progress",
          "date_deadline",
          "subtask_count",
          "closed_subtask_count",
          "depend_on_ids",
          "dependent_ids",
          "milestone_id",
          "partner_id",
          "rejected_count",
          "rejection_date",
          "gitlab_branch_ids",
        ];
        const fields = await getAvailableFields("project.task", requestedFields);
        const domain = [
          ["user_ids", "=", getUid()],
          ["project_id", "=", projectId],
        ];
        if (args.include_closed !== true && fields.includes("is_closed")) {
          domain.push(["is_closed", "=", false]);
        }
        const rows = await executeKw("project.task", "search_read", [domain], {
          fields,
          limit: normalizeLimit(args.limit, { fallback: 100, maximum: 500 }),
          order: "sequence, priority desc, id desc",
        });
        const stageIds = [
          ...new Set(rows.map((row) => row.stage_id?.[0]).filter(Boolean)),
        ];
        const stageRows = stageIds.length
          ? await executeKw("project.task.type", "read", [
              stageIds,
              ["id", "name", "sequence", "fold"],
            ])
          : [];
        const stageMap = new Map(stageRows.map((stage) => [stage.id, stage]));
        const tagMap = await getNameMap(
          "project.tags",
          rows.flatMap((row) => row.tag_ids || []),
        );
        const groups = new Map();

        for (const row of rows) {
          const stageId = row.stage_id?.[0];
          const stageMetadata = stageMap.get(stageId);
          const stage = row.stage_id?.[1] || "No stage";
          const task = {
            id: row.id,
            name: row.name,
            sequence: row.sequence,
            priority: row.task_priority || row.priority || "0",
            tags: (row.tag_ids || []).map((id) => tagMap.get(id) || `#${id}`),
            hours: {
              allocated: Number(row.allocated_hours || 0),
              spent: Number(row.effective_hours || 0),
              remaining: Number(row.remaining_hours || 0),
            },
            progress_percent: progressPercentage(row.progress),
            deadline: row.date_deadline || null,
            subtasks: {
              closed: Number(row.closed_subtask_count || 0),
              total: Number(row.subtask_count || 0),
            },
            blocked_by_ids: row.depend_on_ids || [],
            blocking_ids: row.dependent_ids || [],
            milestone: row.milestone_id?.[1] || null,
            customer: row.partner_id?.[1] || null,
            rejected_count: Number(row.rejected_count || 0),
            rejection_date: row.rejection_date || null,
            gitlab_branch_ids: row.gitlab_branch_ids || [],
          };
          const groupKey = stageId || `none:${stage}`;
          if (!groups.has(groupKey)) {
            groups.set(groupKey, {
              stage_id: stageId || null,
              stage,
              sequence: stageMetadata?.sequence ?? 9999,
              folded: Boolean(stageMetadata?.fold),
              tasks: [],
            });
          }
          groups.get(groupKey).tasks.push(task);
        }

        const board = [...groups.values()]
          .map((group) => ({ ...group, count: group.tasks.length }))
          .sort((left, right) => left.sequence - right.sequence);
        const text = formatList(
          board.map(({ stage, count, tasks }) =>
            [
              `## ${stage} (${count})`,
              ...tasks.map((task) => {
                const flags = [
                  task.tags.join(", ") || "no tags",
                  `${task.hours.spent}/${task.hours.allocated}h`,
                  `${task.progress_percent}%`,
                  task.blocked_by_ids.length ? `blocked by ${task.blocked_by_ids.join(",")}` : null,
                  task.gitlab_branch_ids.length ? `gitlab:${task.gitlab_branch_ids.join(",")}` : null,
                ].filter(Boolean);
                return `- [${task.id}] ${task.name} | ${flags.join(" | ")}`;
              }),
            ].join("\n"),
          ),
        );

        return {
          content: [{ type: "text", text }],
          structuredContent: { project_id: projectId, stages: board },
        };
      },
    },
  };
}
