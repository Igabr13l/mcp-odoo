import { formatList, htmlToText, redactSecrets } from "../utils/format.js";
import { normalizeLimit, positiveInt } from "../utils/args.js";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type {
  ExecuteKwImplementation,
  OdooRecord,
  ToolArguments,
} from "../contracts.js";
import {
  defineToolGroup,
  executeKw as execute,
  referenceId,
  referenceName,
} from "../contracts.js";

const execFileAsync = promisify(execFile);

const ATTACHMENT_FIELDS = [
  "id",
  "name",
  "mimetype",
  "file_size",
  "type",
  "url",
  "description",
  "res_model",
  "res_id",
];
const SUPPORTED_IMAGE_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const SUPPORTED_VIDEO_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);
const SUPPORTED_TEXT_APPLICATION_TYPES = new Set([
  "application/json",
  "application/har+json",
  "application/xml",
  "application/javascript",
  "application/x-javascript",
  "application/csv",
  "application/x-ndjson",
  "application/yaml",
  "application/x-yaml",
]);
const TEXT_EXTENSIONS =
  /\.(har|json|txt|log|csv|xml|md|yaml|yml|html|css|js|ts|sql)$/i;
const SENSITIVE_HEADER_NAME_RE =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|api-key|apikey|token|session|sid|csrf|xsrf)/i;
const SENSITIVE_JSON_KEY_RE =
  /^(authorization|cookie|set-cookie|password|passwd|secret|token|access_token|refresh_token|id_token|api_key|apikey|private_key)$/i;

interface SourceMessage {
  id: number | undefined;
  date: string | null;
  author: { id: number | null; name: string };
}

export interface AttachmentRecord extends OdooRecord {
  provenance?: {
    task_direct: boolean;
    source_messages: SourceMessage[];
  };
}

function taskIdFrom(args: ToolArguments): number {
  return positiveInt(args.task_id, "task_id");
}

function messageLabel(message: OdooRecord): string {
  const subtype = referenceName(message.subtype_id) || "No subtype";
  const normalizedSubtype = subtype.toLowerCase();
  if (normalizedSubtype.includes("note") || normalizedSubtype.includes("nota")) {
    return "Internal note";
  }
  if (message.message_type === "notification") return "System notification";
  return "Message";
}

function formatMessage(message: OdooRecord, redact: boolean): string {
  const author = referenceName(message.author_id) || message.email_from || "System";
  const body = htmlToText(message.body);
  const safeBody = redact ? redactSecrets(body) : body;
  const attachments = message.attachment_ids?.length
    ? `\n   Attachments: ${message.attachment_ids.join(", ")}`
    : "";
  return `[${message.id}] ${message.date || "N/A"} - ${messageLabel(message)} - ${author}\n   ${safeBody || "(empty)"}${attachments}`;
}

export async function getMessageRows(
  executeKw: ExecuteKwImplementation,
  taskId: number,
  { includeSystem, limit }: { includeSystem: boolean; limit: number },
): Promise<OdooRecord[]> {
  const domain = [
    ["model", "=", "project.task"],
    ["res_id", "=", taskId],
  ];
  if (!includeSystem) domain.push(["message_type", "!=", "notification"]);

  return execute<OdooRecord[]>(executeKw, "mail.message", "search_read", [domain], {
    fields: [
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
    limit,
    order: "date desc, id desc",
  });
}

export async function getAttachmentRows(
  executeKw: ExecuteKwImplementation,
  taskId: number,
): Promise<AttachmentRecord[]> {
  const messages = await execute<OdooRecord[]>(executeKw, "mail.message", "search_read", [
    [
      ["model", "=", "project.task"],
      ["res_id", "=", taskId],
    ],
  ], {
    fields: ["id", "date", "author_id", "email_from", "attachment_ids"],
    limit: 500,
  });
  const messageAttachmentIds = [
    ...new Set(messages.flatMap((message) => message.attachment_ids || [])),
  ];
  const taskAttachments = await execute<AttachmentRecord[]>(
    executeKw,
    "ir.attachment",
    "search_read",
    [
      [
        ["res_model", "=", "project.task"],
        ["res_id", "=", taskId],
      ],
    ],
    { fields: ATTACHMENT_FIELDS, limit: 500, order: "id desc" },
  );
  const messageAttachments = messageAttachmentIds.length
    ? await execute<AttachmentRecord[]>(executeKw, "ir.attachment", "read", [
        messageAttachmentIds,
        ATTACHMENT_FIELDS,
      ])
    : [];

  const taskAttachmentIds = new Set(
    taskAttachments.map((attachment) => attachment.id),
  );
  const sourceMessagesByAttachment = new Map<number, SourceMessage[]>();
  for (const message of messages) {
    for (const attachmentId of message.attachment_ids || []) {
      if (!sourceMessagesByAttachment.has(attachmentId)) {
        sourceMessagesByAttachment.set(attachmentId, []);
      }
      sourceMessagesByAttachment.get(attachmentId)!.push({
        id: message.id,
        date: message.date || null,
        author: {
          id: referenceId(message.author_id) || null,
          name: referenceName(message.author_id) || message.email_from || "System",
        },
      });
    }
  }

  return [
    ...new Map(
      [...taskAttachments, ...messageAttachments].map((attachment) => [
        attachment.id,
        {
          ...attachment,
          provenance: {
            task_direct: taskAttachmentIds.has(attachment.id),
            source_messages: sourceMessagesByAttachment.get(attachment.id) || [],
          },
        },
      ]),
    ).values(),
  ];
}

function formatProvenance(attachment: AttachmentRecord): string {
  const sources = attachment.provenance?.source_messages || [];
  const parts = [];
  if (attachment.provenance?.task_direct) parts.push("task-direct");
  parts.push(
    ...sources.map(
      (message) =>
        `message:${message.id} ${message.date || "N/A"} ${message.author.name}`,
    ),
  );
  return parts.join("; ") || "unknown";
}

export function normalizeAttachmentMetadata<T extends AttachmentRecord>(
  attachment: T,
): Omit<T, "datas"> & { name: string; description: string; url: string } {
  const { datas: _datas, ...metadata } = attachment;
  return {
    ...metadata,
    name: redactSecrets(htmlToText(metadata.name)),
    description: redactSecrets(htmlToText(metadata.description)),
    url: redactSecrets(metadata.url),
  };
}

function formatAttachment(attachment: AttachmentRecord): string {
  const metadata = normalizeAttachmentMetadata(attachment);
  const mimetype = typeof attachment.mimetype === "string"
    ? attachment.mimetype
    : "";
  const kind = mimetype.startsWith("image/")
    ? "image"
    : mimetype.startsWith("video/")
      ? "video"
      : "file";
  const size = Number(attachment.file_size || 0);
  const source =
    metadata.type === "url" && metadata.url
      ? ` url=${metadata.url}`
      : "";
  return `[${attachment.id}] ${metadata.name || "unnamed"} - ${kind} - ${attachment.mimetype || "unknown"} - ${size} bytes${source}\n   provenance: ${formatProvenance(attachment)}`;
}

function isTextAttachment(mimetype: unknown, name: unknown): boolean {
  if (typeof mimetype === "string") {
    const normalized = mimetype.split(";")[0].trim().toLowerCase();
    if (
      normalized.startsWith("text/") ||
      SUPPORTED_TEXT_APPLICATION_TYPES.has(normalized)
    ) {
      return true;
    }
  }
  return typeof name === "string" && TEXT_EXTENSIONS.test(name.trim());
}

function redactJsonValue(value: unknown, inCookiesArray = false): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonValue(item, inCookiesArray));
  }
  if (typeof value === "string") {
    return redactSecrets(value);
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const isSensitiveNameValuePair =
      typeof obj.name === "string" &&
      "value" in obj &&
      (inCookiesArray || SENSITIVE_HEADER_NAME_RE.test(obj.name));

    const result: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(obj)) {
      if (isSensitiveNameValuePair && key === "value") {
        result[key] = "[REDACTED]";
      } else if (SENSITIVE_JSON_KEY_RE.test(key)) {
        result[key] = "[REDACTED]";
      } else if (key === "cookies" && Array.isArray(entryValue)) {
        result[key] = redactJsonValue(entryValue, true);
      } else {
        result[key] = redactJsonValue(entryValue, false);
      }
    }
    return result;
  }
  return value;
}

function redactAttachmentText(
  text: string,
  mimetype: unknown,
  name: unknown,
): string {
  const normalizedMime =
    typeof mimetype === "string" ? mimetype.toLowerCase() : "";
  const trimmed = text.trim();
  const isJsonLike =
    (typeof name === "string" && /\.(json|har)$/i.test(name.trim())) ||
    normalizedMime.includes("json") ||
    trimmed.startsWith("{") ||
    trimmed.startsWith("[");

  if (isJsonLike) {
    try {
      const parsed: unknown = JSON.parse(text);
      return JSON.stringify(redactJsonValue(parsed), null, 2);
    } catch {
      return redactSecrets(text);
    }
  }
  return redactSecrets(text);
}

function sanitizeAttachmentFilename(
  name: unknown,
  taskId: number,
  attachmentId: number,
): string {
  const raw = typeof name === "string" ? name : "";
  const base = raw.split(/[/\\]/).pop() || "";
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "");
  const safeBase = (cleaned || "attachment.bin").slice(0, 80);
  return `task-${taskId}-att-${attachmentId}-${safeBase}`;
}

async function writeAttachmentTempFile(
  name: unknown,
  taskId: number,
  attachmentId: number,
  payload: string | Buffer,
): Promise<string> {
  const dir = join(tmpdir(), "odoo-mcp-attachments");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const filePath = join(
    dir,
    sanitizeAttachmentFilename(name, taskId, attachmentId),
  );
  if (typeof payload === "string") {
    await writeFile(filePath, payload, { encoding: "utf8", mode: 0o600 });
  } else {
    await writeFile(filePath, payload, { mode: 0o600 });
  }
  return filePath;
}

function videoExtension(mimetype: unknown): string {
  if (mimetype === "video/quicktime") return ".mov";
  if (mimetype === "video/webm") return ".webm";
  return ".mp4";
}

async function renderVideoFrames(
  row: AttachmentRecord & { datas: string },
  frameCount: number,
): Promise<{ duration: number; frames: { timestamp: number; data: string }[] }> {
  const directory = await mkdtemp(join(tmpdir(), "mcp-odoo-video-"));
  const inputPath = join(directory, `input${videoExtension(row.mimetype)}`);
  try {
    await writeFile(inputPath, Buffer.from(row.datas, "base64"), { mode: 0o600 });
    const { stdout } = await execFileAsync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        inputPath,
      ],
      { timeout: 15000 },
    );
    const duration = Number.parseFloat(stdout.trim());
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("Could not determine video duration");
    }
    const frames: { timestamp: number; data: string }[] = [];
    for (let index = 0; index < frameCount; index += 1) {
      const timestamp = ((index + 1) * duration) / (frameCount + 1);
      const outputPath = join(directory, `frame-${index + 1}.jpg`);
      await execFileAsync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-ss",
          timestamp.toFixed(3),
          "-i",
          inputPath,
          "-frames:v",
          "1",
          "-vf",
          "scale=1280:-2:force_original_aspect_ratio=decrease",
          "-q:v",
          "4",
          "-y",
          outputPath,
        ],
        { timeout: 30000 },
      );
      frames.push({
        timestamp,
        data: (await readFile(outputPath)).toString("base64"),
      });
    }
    return { duration, frames };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function definitions(): Tool[] {
  return [
    {
      name: "odoo_get_ticket_messages",
      description: "Read messages and internal notes from a ticket chatter",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "number", description: "Task ID" },
          include_system: {
            type: "boolean",
            description: "Include automatic system notifications (default false)",
          },
          redact_secrets: {
            type: "boolean",
            description: "Mask API keys, tokens and passwords (default true)",
          },
          limit: {
            type: "number",
            description: "Maximum messages (default 50, max 200)",
          },
        },
        required: ["task_id"],
      },
    },
    {
      name: "odoo_get_ticket_attachments",
      description: "List ticket and chatter attachments, including image and video metadata",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "number", description: "Task ID" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "odoo_get_ticket_images",
      description: "Read ticket images as native MCP image content",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "number", description: "Task ID" },
          limit: {
            type: "number",
            description: "Maximum images (default 5, max 10)",
          },
          max_bytes: {
            type: "number",
            description: "Maximum bytes per image (default 5242880, max 10485760)",
          },
        },
        required: ["task_id"],
      },
    },
    {
      name: "odoo_get_ticket_video_frames",
      description: "Extract representative image frames from a ticket video attachment",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "number", description: "Task ID" },
          attachment_id: {
            type: "number",
            description: "Specific video attachment ID (optional; defaults to first video)",
          },
          frames: {
            type: "number",
            description: "Number of frames (default 4, max 8)",
          },
          max_bytes: {
            type: "number",
            description: "Maximum video size (default 52428800, max 104857600)",
          },
        },
        required: ["task_id"],
      },
    },
    {
      name: "odoo_get_ticket_attachment",
      description:
        "Read or download a ticket attachment (text/JSON/HAR/logs inline or saved to a local temp file with secret redaction)",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "number", description: "Task ID" },
          attachment_id: {
            type: "number",
            description: "Attachment ID from odoo_get_ticket_attachments",
          },
          max_bytes: {
            type: "number",
            description:
              "Maximum attachment size in bytes (default 10485760, max 26214400)",
          },
          max_chars: {
            type: "number",
            description:
              "Maximum inline text characters when save_to_temp is false (default 20000, max 100000)",
          },
          save_to_temp: {
            type: "boolean",
            description:
              "Save decoded attachment to a local temp file and return its path (default false)",
          },
          redact_secrets: {
            type: "boolean",
            description:
              "Mask API keys, tokens, passwords, cookies and auth headers in text/JSON/HAR attachments (default true)",
          },
        },
        required: ["task_id", "attachment_id"],
      },
    },
  ];
}

export function createTicketContentTools({
  executeKw,
}: {
  executeKw: ExecuteKwImplementation;
}) {
  return defineToolGroup({
    definitions: definitions(),
    handlers: {
      async odoo_get_ticket_messages(args) {
        const taskId = taskIdFrom(args);
        const rows = await getMessageRows(executeKw, taskId, {
          includeSystem: args.include_system === true,
          limit: normalizeLimit(args.limit, 50, 200),
        });
        const redact = args.redact_secrets !== false;
        return {
          content: [
            {
              type: "text",
              text: formatList(rows.map((row) => formatMessage(row, redact))),
            },
          ],
        };
      },

      async odoo_get_ticket_attachments(args) {
        const rows = await getAttachmentRows(executeKw, taskIdFrom(args));
        return {
          content: [
            {
              type: "text",
              text: formatList(rows.map(formatAttachment)),
            },
          ],
          structuredContent: {
            task_id: taskIdFrom(args),
            attachments: rows.map(normalizeAttachmentMetadata),
          },
        };
      },

      async odoo_get_ticket_images(args) {
        const attachments = await getAttachmentRows(
          executeKw,
          taskIdFrom(args),
        );
        const limit = normalizeLimit(args.limit, 5, 10);
        const maxBytes = normalizeLimit(args.max_bytes, 5 * 1024 * 1024, 10 * 1024 * 1024);
        const candidates = attachments
          .filter(
            (attachment) =>
              typeof attachment.mimetype === "string" &&
              SUPPORTED_IMAGE_TYPES.has(attachment.mimetype),
          )
          .slice(0, limit);
        const eligible = candidates.filter(
          (attachment) => Number(attachment.file_size || 0) <= maxBytes,
        );
        const rows = eligible.length
          ? await execute<AttachmentRecord[]>(executeKw, "ir.attachment", "read", [
              eligible.map((attachment) => attachment.id),
              ["id", "name", "mimetype", "file_size", "datas"],
            ])
          : [];
        const metadataById = new Map(
          eligible.map((attachment) => [attachment.id, attachment]),
        );
        const content: CallToolResult["content"] = [];
        const images: ReturnType<typeof normalizeAttachmentMetadata>[] = [];

        for (const row of rows) {
          if (typeof row.datas !== "string" || !row.datas) continue;
          const metadata = metadataById.get(row.id);
          const rowMetadata = normalizeAttachmentMetadata(row);
          images.push(normalizeAttachmentMetadata(metadata || row));
          content.push({
            type: "text",
            text: `Image [${row.id}] ${rowMetadata.name || "unnamed"} (${row.file_size || 0} bytes)\n   provenance: ${formatProvenance(metadata || row)}`,
          });
          content.push({
            type: "image",
            data: row.datas,
            mimeType:
              typeof row.mimetype === "string"
                ? row.mimetype
                : "application/octet-stream",
          });
        }

        const skipped = candidates.length - eligible.length;
        if (skipped > 0) {
          content.push({
            type: "text",
            text: `Skipped ${skipped} image(s) larger than ${maxBytes} bytes`,
          });
        }
        if (content.length === 0) {
          content.push({ type: "text", text: "No readable images found" });
        }

        return {
          content,
          structuredContent: { task_id: taskIdFrom(args), images },
        };
      },

      async odoo_get_ticket_video_frames(args) {
        const attachments = await getAttachmentRows(
          executeKw,
          taskIdFrom(args),
        );
        const attachmentId =
          args.attachment_id === undefined
            ? null
            : positiveInt(args.attachment_id, "attachment_id");
        const video = attachments.find(
          (attachment) =>
            typeof attachment.mimetype === "string" &&
            SUPPORTED_VIDEO_TYPES.has(attachment.mimetype) &&
            (!attachmentId || attachment.id === attachmentId),
        );
        if (!video) {
          throw new Error(
            attachmentId
              ? `Video attachment ${attachmentId} not found on this ticket`
              : "No supported video attachment found",
          );
        }
        const maxBytes = normalizeLimit(
          args.max_bytes,
          50 * 1024 * 1024,
          100 * 1024 * 1024,
        );
        if (Number(video.file_size || 0) > maxBytes) {
          throw new Error(`Video exceeds the ${maxBytes} byte limit`);
        }
        const rows = await execute<AttachmentRecord[]>(executeKw, "ir.attachment", "read", [
          [video.id],
          ["id", "name", "mimetype", "file_size", "datas"],
        ]);
        const row = rows?.[0];
        if (typeof row?.datas !== "string" || !row.datas) {
          throw new Error("Video content is not readable");
        }
        const rendered = await renderVideoFrames(
          { ...row, datas: row.datas },
          normalizeLimit(args.frames, 4, 8),
        );
        const rowMetadata = normalizeAttachmentMetadata(row);
        const content: CallToolResult["content"] = [
          {
            type: "text",
            text: `Video [${row.id}] ${rowMetadata.name || "unnamed"} - ${rendered.duration.toFixed(2)}s. Frames are visual samples; audio is not transcribed.\n   provenance: ${formatProvenance(video)}`,
          },
        ];
        for (const frame of rendered.frames) {
          content.push({
            type: "text",
            text: `Frame at ${frame.timestamp.toFixed(2)}s`,
          });
          content.push({
            type: "image",
            data: frame.data,
            mimeType: "image/jpeg",
          });
        }
        return {
          content,
          structuredContent: {
            task_id: taskIdFrom(args),
            video: normalizeAttachmentMetadata(video),
            duration_seconds: rendered.duration,
            frame_timestamps: rendered.frames.map((frame) => frame.timestamp),
          },
        };
      },

      async odoo_get_ticket_attachment(args) {
        const taskId = taskIdFrom(args);
        const attachmentId = positiveInt(args.attachment_id, "attachment_id");
        const maxBytes = normalizeLimit(
          args.max_bytes,
          10 * 1024 * 1024,
          25 * 1024 * 1024,
        );
        const maxChars = normalizeLimit(args.max_chars, 20000, 100000);
        const saveToTemp = args.save_to_temp === true;
        const redact = args.redact_secrets !== false;

        const attachments = await getAttachmentRows(executeKw, taskId);
        const attachment = attachments.find((item) => item.id === attachmentId);
        if (!attachment) {
          throw new Error(`Attachment ${attachmentId} not found on this ticket`);
        }

        if (Number(attachment.file_size || 0) > maxBytes) {
          throw new Error(`Attachment exceeds the ${maxBytes} byte limit`);
        }

        const rows = await execute<AttachmentRecord[]>(
          executeKw,
          "ir.attachment",
          "read",
          [[attachment.id], ["id", "name", "mimetype", "file_size", "datas"]],
        );
        const row = rows?.[0];
        if (typeof row?.datas !== "string" || !row.datas) {
          throw new Error("Attachment content is not readable");
        }

        const buffer = Buffer.from(row.datas, "base64");
        const effectiveMime = row.mimetype ?? attachment.mimetype;
        const effectiveName = row.name ?? attachment.name;
        const textReadable = isTextAttachment(effectiveMime, effectiveName);
        const metadata = normalizeAttachmentMetadata(attachment);
        const provenance = formatProvenance(attachment);

        if (!textReadable) {
          if (!saveToTemp) {
            throw new Error(
              `Attachment ${attachmentId} is binary (${String(effectiveMime || "application/octet-stream")}); pass save_to_temp: true to save it locally, or use odoo_get_ticket_images / odoo_get_ticket_video_frames for media`,
            );
          }
          const filePath = await writeAttachmentTempFile(
            effectiveName,
            taskId,
            attachmentId,
            buffer,
          );

          return {
            content: [
              {
                type: "text",
                text: `Attachment [${row.id}] ${metadata.name || "unnamed"} (${buffer.length} bytes, binary)\n   provenance: ${provenance}\n   file_path: ${filePath}\n   redacted: false`,
              },
            ],
            structuredContent: {
              task_id: taskId,
              attachment: metadata,
              file_path: filePath,
              bytes: buffer.length,
              redacted: false,
              is_text: false,
            },
          };
        }

        const rawText = buffer.toString("utf8");
        const outputText = redact
          ? redactAttachmentText(rawText, effectiveMime, effectiveName)
          : rawText;

        if (saveToTemp) {
          const filePath = await writeAttachmentTempFile(
            effectiveName,
            taskId,
            attachmentId,
            outputText,
          );
          const bytes = Buffer.byteLength(outputText, "utf8");

          return {
            content: [
              {
                type: "text",
                text: `Attachment [${row.id}] ${metadata.name || "unnamed"} (${bytes} bytes, ${outputText.length} chars)\n   provenance: ${provenance}\n   file_path: ${filePath}\n   redacted: ${String(redact)}`,
              },
            ],
            structuredContent: {
              task_id: taskId,
              attachment: metadata,
              file_path: filePath,
              bytes,
              chars: outputText.length,
              redacted: redact,
              is_text: true,
            },
          };
        }

        const snippet = outputText.slice(0, maxChars);
        const truncated = outputText.length > maxChars;
        const truncationNotice = truncated
          ? `\n\n[Truncated: showing ${snippet.length} of ${outputText.length} chars. Pass save_to_temp: true to save the full attachment locally.]`
          : "";

        return {
          content: [
            {
              type: "text",
              text: `Attachment [${row.id}] ${metadata.name || "unnamed"} (${Number(row.file_size || buffer.length)} bytes)\n   provenance: ${provenance}\n\n${snippet}${truncationNotice}`,
            },
          ],
          structuredContent: {
            task_id: taskId,
            attachment: metadata,
            text: snippet,
            total_chars: outputText.length,
            truncated,
            redacted: redact,
            is_text: true,
          },
        };
      },
    },
  });
}
