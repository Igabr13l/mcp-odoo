import { formatList, htmlToText, redactSecrets } from "../utils/format.js";
import { normalizeLimit, positiveInt } from "../utils/args.js";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

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

function taskIdFrom(args) {
  return positiveInt(args.task_id, "task_id");
}

function messageLabel(message) {
  const subtype = message.subtype_id?.[1] || "No subtype";
  const normalizedSubtype = subtype.toLowerCase();
  if (normalizedSubtype.includes("note") || normalizedSubtype.includes("nota")) {
    return "Internal note";
  }
  if (message.message_type === "notification") return "System notification";
  return "Message";
}

function formatMessage(message, redact) {
  const author = message.author_id?.[1] || message.email_from || "System";
  const body = htmlToText(message.body);
  const safeBody = redact ? redactSecrets(body) : body;
  const attachments = message.attachment_ids?.length
    ? `\n   Attachments: ${message.attachment_ids.join(", ")}`
    : "";
  return `[${message.id}] ${message.date || "N/A"} - ${messageLabel(message)} - ${author}\n   ${safeBody || "(empty)"}${attachments}`;
}

async function getMessageRows(executeKw, taskId, { includeSystem, limit }) {
  const domain = [
    ["model", "=", "project.task"],
    ["res_id", "=", taskId],
  ];
  if (!includeSystem) domain.push(["message_type", "!=", "notification"]);

  return executeKw("mail.message", "search_read", [domain], {
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

async function getAttachmentRows(executeKw, taskId) {
  const messages = await executeKw("mail.message", "search_read", [
    [
      ["model", "=", "project.task"],
      ["res_id", "=", taskId],
    ],
  ], {
    fields: ["attachment_ids"],
    limit: 500,
  });
  const messageAttachmentIds = [
    ...new Set(messages.flatMap((message) => message.attachment_ids || [])),
  ];
  const taskAttachments = await executeKw(
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
    ? await executeKw("ir.attachment", "read", [
        messageAttachmentIds,
        ATTACHMENT_FIELDS,
      ])
    : [];

  return [
    ...new Map(
      [...taskAttachments, ...messageAttachments].map((attachment) => [
        attachment.id,
        attachment,
      ]),
    ).values(),
  ];
}

function formatAttachment(attachment) {
  const kind = attachment.mimetype?.startsWith("image/")
    ? "image"
    : attachment.mimetype?.startsWith("video/")
      ? "video"
      : "file";
  const size = Number(attachment.file_size || 0);
  const source =
    attachment.type === "url" && attachment.url
      ? ` url=${attachment.url}`
      : "";
  return `[${attachment.id}] ${attachment.name || "unnamed"} - ${kind} - ${attachment.mimetype || "unknown"} - ${size} bytes${source}`;
}

function videoExtension(mimetype) {
  if (mimetype === "video/quicktime") return ".mov";
  if (mimetype === "video/webm") return ".webm";
  return ".mp4";
}

async function renderVideoFrames(row, frameCount) {
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
    const frames = [];
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

function definitions() {
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
  ];
}

export function createTicketContentTools({ executeKw }) {
  return {
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
          .filter((attachment) => SUPPORTED_IMAGE_TYPES.has(attachment.mimetype))
          .slice(0, limit);
        const eligible = candidates.filter(
          (attachment) => Number(attachment.file_size || 0) <= maxBytes,
        );
        const rows = eligible.length
          ? await executeKw("ir.attachment", "read", [
              eligible.map((attachment) => attachment.id),
              ["id", "name", "mimetype", "file_size", "datas"],
            ])
          : [];
        const content = [];

        for (const row of rows) {
          if (!row.datas) continue;
          content.push({
            type: "text",
            text: `Image [${row.id}] ${row.name || "unnamed"} (${row.file_size || 0} bytes)`,
          });
          content.push({
            type: "image",
            data: row.datas,
            mimeType: row.mimetype,
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

        return { content };
      },

      async odoo_get_ticket_video_frames(args) {
        const attachments = await getAttachmentRows(
          executeKw,
          taskIdFrom(args),
        );
        const attachmentId = args.attachment_id
          ? Number(args.attachment_id)
          : null;
        const video = attachments.find(
          (attachment) =>
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
        const rows = await executeKw("ir.attachment", "read", [
          [video.id],
          ["id", "name", "mimetype", "file_size", "datas"],
        ]);
        const row = rows?.[0];
        if (!row?.datas) throw new Error("Video content is not readable");
        const rendered = await renderVideoFrames(
          row,
          normalizeLimit(args.frames, 4, 8),
        );
        const content = [
          {
            type: "text",
            text: `Video [${row.id}] ${row.name || "unnamed"} - ${rendered.duration.toFixed(2)}s. Frames are visual samples; audio is not transcribed.`,
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
        return { content };
      },
    },
  };
}
