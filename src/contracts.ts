import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

export type ToolArguments = Record<string, unknown>;
export type OdooArguments = unknown[];
export type OdooKeywordArguments = Record<string, unknown>;
export type OdooReference = [number, string];

export interface OdooRecord {
  [field: string]: unknown;
  id: number;
  name?: string | false | null;
  login?: string | false | null;
  date?: string | false | null;
  body?: string | false | null;
  subject?: string | false | null;
  description?: string | false | null;
  email_from?: string | false | null;
  message_type?: string | false | null;
  mimetype?: string | false | null;
  type?: string | false | null;
  url?: string | false | null;
  datas?: string | false | null;
  file_size?: number | false | null;
  unit_amount?: number | false | null;
  progress?: number | false | null;
  sequence?: number | false | null;
  fold?: boolean;
  is_closed?: boolean;
  allow_timesheets?: boolean;
  priority?: string | false | null;
  task_priority?: string | false | null;
  date_deadline?: string | false | null;
  allocated_hours?: number | false | null;
  effective_hours?: number | false | null;
  remaining_hours?: number | false | null;
  subtask_count?: number | false | null;
  closed_subtask_count?: number | false | null;
  rejected_count?: number | false | null;
  rejection_date?: string | false | null;
  project_id?: OdooReference | false | null;
  stage_id?: OdooReference | false | null;
  author_id?: OdooReference | false | null;
  subtype_id?: OdooReference | false | null;
  employee_id?: OdooReference | false | null;
  user_id?: OdooReference | number | false | null;
  task_id?: OdooReference | number | false | null;
  partner_id?: OdooReference | false | null;
  milestone_id?: OdooReference | false | null;
  gitlab_origin_project_id?: OdooReference | false | null;
  gitlab_user_id?: OdooReference | false | null;
  user_ids?: number[];
  tag_ids?: number[];
  project_ids?: number[];
  attachment_ids?: number[];
  gitlab_branch_ids?: number[];
  depend_on_ids?: number[];
  dependent_ids?: number[];
  gitlab_branch_name?: string | false | null;
  from_branch?: string | false | null;
  target_branch?: string | false | null;
  gitlab_link?: string | false | null;
  merge_request_link?: string | boolean | null;
  task_category?: string | false | null;
}

export type ExecuteKwImplementation = (
  model: string,
  method: string,
  args?: OdooArguments,
  kwargs?: OdooKeywordArguments,
) => Promise<unknown>;

export async function executeKw<T = OdooRecord[]>(
  implementation: ExecuteKwImplementation,
  model: string,
  method: string,
  args: OdooArguments = [],
  kwargs: OdooKeywordArguments = {},
): Promise<T> {
  // Odoo's dynamic model API cannot validate a model-specific result at this boundary.
  return (await implementation(model, method, args, kwargs)) as T;
}

export type GetAvailableFields = (
  model: string,
  fieldNames: string[],
) => Promise<string[]>;
export type GetNameMap = (
  model: string,
  ids: number[],
) => Promise<Map<number, string>>;
export type GetSelectionLabelMap = (
  model: string,
  fieldName: string,
) => Promise<Map<unknown, string>>;
export type GetUid = () => number | null;

export interface ToolDependencies {
  executeKw: ExecuteKwImplementation;
  getAvailableFields: GetAvailableFields;
  getNameMap: GetNameMap;
  getSelectionLabelMap: GetSelectionLabelMap;
  getUid: GetUid;
}

export type ToolHandler = (args: ToolArguments) => Promise<CallToolResult>;

export function defineToolGroup<
  const Handlers extends Record<string, ToolHandler>,
>(group: {
  definitions: Tool[];
  handlers: Handlers;
}): {
  definitions: Tool[];
  handlers: Handlers;
} {
  return group;
}

export function referenceId(value: unknown): number | undefined {
  return Array.isArray(value) && typeof value[0] === "number"
    ? value[0]
    : undefined;
}

export function referenceName(value: unknown): string | undefined {
  return Array.isArray(value) && typeof value[1] === "string"
    ? value[1]
    : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
