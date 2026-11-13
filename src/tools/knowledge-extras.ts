import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type {
  ExecuteKwImplementation,
  OdooArguments,
  OdooKeywordArguments,
  OdooRecord,
} from "../contracts.js";
import {
  defineToolGroup,
  errorMessage,
  executeKw as execute,
  referenceId,
  referenceName,
} from "../contracts.js";
import { normalizeLimit, positiveInt } from "../utils/args.js";
import { formatList, htmlToText, redactSecrets } from "../utils/format.js";
import {
  type AttachmentRecord,
  normalizeAttachmentMetadata,
} from "./ticket-content.js";

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

const MESSAGE_FIELDS = [
  "id",
  "res_id",
  "date",
  "author_id",
  "email_from",
  "subject",
  "body",
  "message_type",
  "subtype_id",
  "attachment_ids",
];

const SUPPORTED_IMAGE_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function formatReference(value: unknown): { id: number | null; name: string } {
  const id = referenceId(value) ?? null;
  const name = referenceName(value) || "System";
  return { id, name };
}

function normalizeMessage(message: OdooRecord, redact: boolean) {
  const body = htmlToText(message.body);
  return {
    id: message.id,
    res_id: typeof message.res_id === "number" ? message.res_id : null,
    date: typeof message.date === "string" ? message.date : null,
    author: Array.isArray(message.author_id)
      ? formatReference(message.author_id)
      : { id: null, name: String(message.email_from || "System") },
    subject: redact
      ? redactSecrets(message.subject)
      : String(message.subject || ""),
    body: redact ? redactSecrets(body) : body,
    message_type:
      typeof message.message_type === "string" ? message.message_type : null,
    subtype: Array.isArray(message.subtype_id)
      ? formatReference(message.subtype_id)
      : null,
    attachment_ids: Array.isArray(message.attachment_ids)
      ? message.attachment_ids
      : [],
  };
}

function definitions(): Tool[] {
  return [
    {
      name: "odoo_get_knowledge_stages",
      description:
        "List Kanban stages and item property definitions for a parent Knowledge article",
      inputSchema: {
        type: "object",
        properties: {
          parent_id: {
            type: "number",
            description: "Parent Knowledge article ID",
          },
        },
        required: ["parent_id"],
      },
    },
    {
      name: "odoo_get_knowledge_article_attachments",
      description:
        "List attachments linked to a Knowledge article, threads, or chatter",
      inputSchema: {
        type: "object",
        properties: {
          article_id: { type: "number", description: "Knowledge article ID" },
        },
        required: ["article_id"],
      },
    },
    {
      name: "odoo_get_knowledge_article_images",
      description: "Read Knowledge article images as native MCP image content",
      inputSchema: {
        type: "object",
        properties: {
          article_id: { type: "number", description: "Knowledge article ID" },
          limit: {
            type: "number",
            description: "Maximum images (default 5, max 10)",
          },
          max_bytes: {
            type: "number",
            description: "Maximum bytes per image (default 5242880, max 10485760)",
          },
        },
        required: ["article_id"],
      },
    },
    {
      name: "odoo_add_knowledge_attachment",
      description:
        "Attach a file (base64) or external URL to an Odoo Knowledge article",
      inputSchema: {
        type: "object",
        properties: {
          article_id: { type: "number", description: "Knowledge article ID" },
          name: { type: "string", description: "Attachment display/file name" },
          data_base64: {
            type: "string",
            description: "Base64-encoded file content (mutually exclusive with url)",
          },
          url: {
            type: "string",
            description: "External URL attachment (mutually exclusive with data_base64)",
          },
          mimetype: { type: "string", description: "Optional MIME type" },
          description: { type: "string", description: "Optional description" },
        },
        required: ["article_id", "name"],
      },
    },
    {
      name: "odoo_get_knowledge_article_comments",
      description:
        "Read anchored comment threads and chatter messages on a Knowledge article",
      inputSchema: {
        type: "object",
        properties: {
          article_id: { type: "number", description: "Knowledge article ID" },
          include_resolved: {
            type: "boolean",
            description: "Include resolved comment threads (default true)",
          },
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
            description: "Maximum messages per scope (default 50, max 200)",
          },
        },
        required: ["article_id"],
      },
    },
    {
      name: "odoo_add_knowledge_comment",
      description:
        "Preview, post, or resolve a comment/note on a Knowledge article or thread",
      inputSchema: {
        type: "object",
        properties: {
          article_id: { type: "number", description: "Knowledge article ID" },
          body: {
            type: "string",
            description:
              "Comment text (required unless only resolving/reopening an existing thread_id)",
          },
          thread_id: {
            type: "number",
            description: "Optional existing knowledge.article.thread ID to reply to",
          },
          anchor_text: {
            type: "string",
            description:
              "Optional article anchor text to create a new anchored comment thread",
          },
          resolve: {
            type: "boolean",
            description:
              "Set true to mark thread_id resolved, false to reopen it",
          },
          confirm: {
            type: "boolean",
            description: "Must be true to post the comment or update the thread",
          },
        },
        required: ["article_id", "confirm"],
      },
    },
  ];
}

export function createKnowledgeExtrasTools({
  executeKw: executeKwImplementation,
}: {
  executeKw: ExecuteKwImplementation;
}) {
  const executeKw = <T = OdooRecord[]>(
    model: string,
    method: string,
    args: OdooArguments = [],
    kwargs: OdooKeywordArguments = {},
  ) => execute<T>(executeKwImplementation, model, method, args, kwargs);

  async function assertReadableArticle(
    articleId: number,
    extraFields: string[] = [],
  ): Promise<OdooRecord> {
    const rows = await executeKw("knowledge.article", "read", [
      [articleId],
      [
        "id",
        "name",
        "user_has_access",
        "user_has_write_access",
        "is_locked",
        ...extraFields,
      ],
    ], { context: { active_test: false } });
    const article = rows?.[0];
    if (!article) throw new Error(`Article not found: ${articleId}`);
    if (article.user_has_access === false) {
      throw new Error(`Access denied to Knowledge article ${articleId}`);
    }
    return article;
  }

  async function fetchArticleAttachments(
    articleId: number,
  ): Promise<AttachmentRecord[]> {
    const threads = await executeKw("knowledge.article.thread", "search_read", [
      [["article_id", "=", articleId]],
    ], { fields: ["id", "message_ids"], limit: 200 });
    const threadIds = threads
      .map((t) => t.id)
      .filter((id): id is number => typeof id === "number");

    const articleMessages = await executeKw("mail.message", "search_read", [
      [
        ["model", "=", "knowledge.article"],
        ["res_id", "=", articleId],
      ],
    ], { fields: ["id", "date", "author_id", "email_from", "attachment_ids"], limit: 500 });

    const threadMessages = threadIds.length
      ? await executeKw("mail.message", "search_read", [
          [
            ["model", "=", "knowledge.article.thread"],
            ["res_id", "in", threadIds],
          ],
        ], { fields: ["id", "date", "author_id", "email_from", "attachment_ids"], limit: 500 })
      : [];

    const allMessages = [...articleMessages, ...threadMessages];
    const messageAttachmentIds = [
      ...new Set(
        allMessages.flatMap((m) =>
          Array.isArray(m.attachment_ids) ? m.attachment_ids : [],
        ),
      ),
    ];

    const directAttachments = await executeKw<AttachmentRecord[]>(
      "ir.attachment",
      "search_read",
      [
        [
          ["res_model", "=", "knowledge.article"],
          ["res_id", "=", articleId],
        ],
      ],
      { fields: ATTACHMENT_FIELDS, limit: 500, order: "id desc" },
    );

    const messageAttachments = messageAttachmentIds.length
      ? await executeKw<AttachmentRecord[]>("ir.attachment", "read", [
          messageAttachmentIds,
          ATTACHMENT_FIELDS,
        ])
      : [];

    const directIds = new Set(directAttachments.map((a) => a.id));
    const sourceByAttachment = new Map<
      number,
      { id: number | undefined; date: string | null; author: { id: number | null; name: string } }[]
    >();
    for (const msg of allMessages) {
      for (const attId of Array.isArray(msg.attachment_ids) ? msg.attachment_ids : []) {
        if (!sourceByAttachment.has(attId)) sourceByAttachment.set(attId, []);
        sourceByAttachment.get(attId)!.push({
          id: msg.id,
          date: typeof msg.date === "string" ? msg.date : null,
          author: Array.isArray(msg.author_id)
            ? formatReference(msg.author_id)
            : { id: null, name: String(msg.email_from || "System") },
        });
      }
    }

    return [
      ...new Map(
        [...directAttachments, ...messageAttachments].map((att) => [
          att.id,
          {
            ...att,
            provenance: {
              task_direct: directIds.has(att.id),
              source_messages: sourceByAttachment.get(att.id) || [],
            },
          },
        ]),
      ).values(),
    ];
  }

  return defineToolGroup({
    definitions: definitions(),
    handlers: {
      async odoo_get_knowledge_stages(args) {
        const parentId = positiveInt(args.parent_id, "parent_id");
        const parent = await assertReadableArticle(parentId, [
          "article_properties_definition",
        ]);
        const stages = await executeKw(
          "knowledge.article.stage",
          "search_read",
          [[["parent_id", "=", parentId]]],
          {
            fields: ["id", "name", "sequence", "fold", "parent_id"],
            limit: 200,
            order: "sequence, id",
          },
        );
        const propertiesDefinition = Array.isArray(
          parent.article_properties_definition,
        )
          ? parent.article_properties_definition
          : [];
        const stageList = (stages || []).map((s) => ({
          id: s.id,
          name: s.name,
          sequence: typeof s.sequence === "number" ? s.sequence : 0,
          fold: Boolean(s.fold),
        }));
        const lines = [
          `Parent [${parentId}] ${parent.name || "Untitled"}`,
          stageList.length
            ? `Stages (${stageList.length}):\n${stageList.map((s) => `- [${s.id}] ${s.name} (seq=${s.sequence}, fold=${s.fold})`).join("\n")}`
            : "Stages: none",
          propertiesDefinition.length
            ? `Properties (${propertiesDefinition.length}):\n${propertiesDefinition.map((p: Record<string, unknown>) => `- ${String(p.name)}: ${String(p.string || p.name)} (${String(p.type)})`).join("\n")}`
            : "Properties: none",
        ].join("\n\n");

        return {
          content: [{ type: "text", text: lines }],
          structuredContent: {
            parent_id: parentId,
            stages: stageList,
            properties_definition: propertiesDefinition,
          },
        };
      },

      async odoo_get_knowledge_article_attachments(args) {
        const articleId = positiveInt(args.article_id, "article_id");
        await assertReadableArticle(articleId);
        const rows = await fetchArticleAttachments(articleId);
        const attachments = rows.map(normalizeAttachmentMetadata);
        const text = formatList(
          attachments.map(
            (a) =>
              `[${a.id}] ${a.name || "unnamed"} - ${a.mimetype || "unknown"} - ${Number(a.file_size || 0)} bytes${a.type === "url" && a.url ? ` url=${a.url}` : ""}`,
          ),
        );
        return {
          content: [{ type: "text", text }],
          structuredContent: { article_id: articleId, attachments },
        };
      },

      async odoo_get_knowledge_article_images(args) {
        const articleId = positiveInt(args.article_id, "article_id");
        await assertReadableArticle(articleId);
        const attachments = await fetchArticleAttachments(articleId);
        const limit = normalizeLimit(args.limit, 5, 10);
        const maxBytes = normalizeLimit(
          args.max_bytes,
          5 * 1024 * 1024,
          10 * 1024 * 1024,
        );
        const candidates = attachments
          .filter(
            (att) =>
              typeof att.mimetype === "string" &&
              SUPPORTED_IMAGE_TYPES.has(att.mimetype),
          )
          .slice(0, limit);
        const eligible = candidates.filter(
          (att) => Number(att.file_size || 0) <= maxBytes,
        );
        const rows = eligible.length
          ? await executeKw<AttachmentRecord[]>("ir.attachment", "read", [
              eligible.map((att) => att.id),
              ["id", "name", "mimetype", "file_size", "datas"],
            ])
          : [];
        const byId = new Map(eligible.map((att) => [att.id, att]));
        const content: CallToolResult["content"] = [];
        const images: ReturnType<typeof normalizeAttachmentMetadata>[] = [];

        for (const row of rows) {
          if (typeof row.datas !== "string" || !row.datas) continue;
          const meta = byId.get(row.id) || row;
          const normalized = normalizeAttachmentMetadata(meta);
          images.push(normalized);
          content.push({
            type: "text",
            text: `Image [${row.id}] ${normalized.name || "unnamed"} (${row.file_size || 0} bytes)`,
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
          structuredContent: { article_id: articleId, images },
        };
      },

      async odoo_add_knowledge_attachment(args) {
        const articleId = positiveInt(args.article_id, "article_id");
        if (typeof args.name !== "string" || !args.name.trim()) {
          throw new Error("name must be a nonblank string");
        }
        const hasData =
          typeof args.data_base64 === "string" && args.data_base64.trim().length > 0;
        const hasUrl = typeof args.url === "string" && args.url.trim().length > 0;
        if (hasData === hasUrl) {
          throw new Error("Provide exactly one of data_base64 or url");
        }

        const article = await assertReadableArticle(articleId);
        if (article.user_has_write_access === false) {
          throw new Error(
            `You do not have write access to Knowledge article ${articleId}`,
          );
        }
        if (article.is_locked === true) {
          throw new Error(
            `Knowledge article ${articleId} is locked. Unlock it before adding attachments.`,
          );
        }

        const values: Record<string, unknown> = {
          name: args.name.trim(),
          res_model: "knowledge.article",
          res_id: articleId,
          type: hasData ? "binary" : "url",
        };
        if (hasData) values.datas = String(args.data_base64).trim();
        if (hasUrl) values.url = String(args.url).trim();
        if (typeof args.mimetype === "string" && args.mimetype.trim()) {
          values.mimetype = args.mimetype.trim();
        }
        if (typeof args.description === "string" && args.description.trim()) {
          values.description = args.description.trim();
        }

        const attachmentId = await executeKw<number>(
          "ir.attachment",
          "create",
          [values],
        );
        if (!attachmentId) {
          throw new Error("Odoo did not create the attachment");
        }
        let attachment: ReturnType<typeof normalizeAttachmentMetadata> | null = null;
        try {
          const rows = await executeKw<AttachmentRecord[]>(
            "ir.attachment",
            "read",
            [[attachmentId], ATTACHMENT_FIELDS],
          );
          if (rows?.[0]) attachment = normalizeAttachmentMetadata(rows[0]);
        } catch {
          attachment = null;
        }
        return {
          content: [
            {
              type: "text",
              text: `Attachment created: [${attachmentId}] ${values.name} on article ${articleId}`,
            },
          ],
          structuredContent: {
            id: attachmentId,
            article_id: articleId,
            attachment,
          },
        };
      },

      async odoo_get_knowledge_article_comments(args) {
        const articleId = positiveInt(args.article_id, "article_id");
        await assertReadableArticle(articleId);
        const includeResolved = args.include_resolved !== false;
        const includeSystem = args.include_system === true;
        const redact = args.redact_secrets !== false;
        const limit = normalizeLimit(args.limit, 50, 200);

        const threadDomain: unknown[][] = [["article_id", "=", articleId]];
        if (!includeResolved) threadDomain.push(["is_resolved", "=", false]);

        const threads = await executeKw(
          "knowledge.article.thread",
          "search_read",
          [threadDomain],
          {
            fields: ["id", "article_id", "article_anchor_text", "is_resolved"],
            limit: 200,
            order: "id desc",
          },
        );
        const threadIds = threads
          .map((t) => t.id)
          .filter((id): id is number => typeof id === "number");

        const threadMsgDomain: unknown[][] = [
          ["model", "=", "knowledge.article.thread"],
          ["res_id", "in", threadIds],
        ];
        const chatterDomain: unknown[][] = [
          ["model", "=", "knowledge.article"],
          ["res_id", "=", articleId],
        ];
        if (!includeSystem) {
          threadMsgDomain.push(["message_type", "!=", "notification"]);
          chatterDomain.push(["message_type", "!=", "notification"]);
        }

        const [threadMessages, chatterMessages] = await Promise.all([
          threadIds.length
            ? executeKw("mail.message", "search_read", [threadMsgDomain], {
                fields: MESSAGE_FIELDS,
                limit,
                order: "date asc, id asc",
              })
            : Promise.resolve([] as OdooRecord[]),
          executeKw("mail.message", "search_read", [chatterDomain], {
            fields: MESSAGE_FIELDS,
            limit,
            order: "date desc, id desc",
          }),
        ]);

        const messagesByThread = new Map<
          number,
          ReturnType<typeof normalizeMessage>[]
        >();
        for (const msg of threadMessages) {
          if (typeof msg.res_id !== "number") continue;
          if (!messagesByThread.has(msg.res_id)) {
            messagesByThread.set(msg.res_id, []);
          }
          messagesByThread.get(msg.res_id)!.push(normalizeMessage(msg, redact));
        }

        const normalizedThreads = threads.map((t) => ({
          id: t.id,
          anchor_text: redact
            ? redactSecrets(t.article_anchor_text)
            : String(t.article_anchor_text || ""),
          is_resolved: t.is_resolved === true,
          messages: messagesByThread.get(t.id) || [],
        }));
        const normalizedChatter = chatterMessages.map((m) =>
          normalizeMessage(m, redact),
        );

        const sections: string[] = [];
        if (normalizedThreads.length) {
          sections.push(
            `Comment threads (${normalizedThreads.length}):\n` +
              normalizedThreads
                .map((t) => {
                  const header = `[Thread ${t.id}] resolved=${t.is_resolved}${t.anchor_text ? ` | anchor="${t.anchor_text}"` : ""}`;
                  const msgs = t.messages
                    .map(
                      (m) =>
                        `   - [${m.id}] ${m.date || "N/A"} ${m.author.name}: ${m.body || "(empty)"}`,
                    )
                    .join("\n");
                  return msgs ? `${header}\n${msgs}` : header;
                })
                .join("\n"),
          );
        }
        if (normalizedChatter.length) {
          sections.push(
            `Chatter messages (${normalizedChatter.length}):\n` +
              normalizedChatter
                .map(
                  (m) =>
                    `- [${m.id}] ${m.date || "N/A"} ${m.author.name}: ${m.body || "(empty)"}`,
                )
                .join("\n"),
          );
        }

        return {
          content: [
            {
              type: "text",
              text: sections.length ? sections.join("\n\n") : "No comments found",
            },
          ],
          structuredContent: {
            article_id: articleId,
            threads: normalizedThreads,
            chatter_messages: normalizedChatter,
          },
        };
      },

      async odoo_add_knowledge_comment(args) {
        const articleId = positiveInt(args.article_id, "article_id");
        await assertReadableArticle(articleId);

        const threadId = args.thread_id === undefined
          ? null
          : positiveInt(args.thread_id, "thread_id");
        const hasResolve = args.resolve !== undefined;
        const bodyText =
          typeof args.body === "string"
            ? redactSecrets(htmlToText(args.body))
            : "";

        if (!bodyText.trim() && !(threadId !== null && hasResolve)) {
          throw new Error(
            "body must be a nonblank string (unless resolving/reopening an existing thread_id)",
          );
        }
        if (threadId !== null && args.anchor_text !== undefined) {
          throw new Error("anchor_text cannot be combined with thread_id");
        }

        let targetThread: OdooRecord | null = null;
        if (threadId !== null) {
          const threads = await executeKw("knowledge.article.thread", "read", [
            [threadId],
            ["id", "article_id", "is_resolved", "article_anchor_text"],
          ]);
          targetThread = threads?.[0] || null;
          if (!targetThread) {
            throw new Error(`Comment thread not found: ${threadId}`);
          }
          if (referenceId(targetThread.article_id) !== articleId) {
            throw new Error(
              `Thread ${threadId} does not belong to Knowledge article ${articleId}`,
            );
          }
        }

        const anchorText =
          typeof args.anchor_text === "string" && args.anchor_text.trim()
            ? redactSecrets(args.anchor_text.trim())
            : null;

        if (args.confirm !== true) {
          return {
            content: [
              {
                type: "text",
                text: `Preview Knowledge comment on article ${articleId}${threadId ? ` (thread ${threadId})` : anchorText ? ` (new thread "${anchorText}")` : ""}:\n${bodyText || `(set is_resolved=${Boolean(args.resolve)})`}`,
              },
            ],
            structuredContent: {
              status: "preview",
              article_id: articleId,
              thread_id: threadId,
              anchor_text: anchorText,
              resolve: hasResolve ? Boolean(args.resolve) : null,
              body: bodyText || null,
            },
          };
        }

        let finalThreadId = threadId;
        if (finalThreadId === null && anchorText !== null) {
          finalThreadId = await executeKw<number>(
            "knowledge.article.thread",
            "create",
            [
              {
                article_id: articleId,
                article_anchor_text: anchorText,
              },
            ],
          );
          if (!finalThreadId) {
            throw new Error("Odoo did not create the Knowledge comment thread");
          }
        }

        let messageId: unknown = null;
        if (bodyText.trim()) {
          const targetModel = finalThreadId !== null
            ? "knowledge.article.thread"
            : "knowledge.article";
          const targetId = finalThreadId !== null ? finalThreadId : articleId;
          messageId = await executeKw<unknown>(
            targetModel,
            "message_post",
            [[targetId]],
            {
              body: bodyText,
              subtype_xmlid: "mail.mt_note",
              message_type: "comment",
            },
          );
          if (!messageId) {
            throw new Error("Odoo did not post the Knowledge comment");
          }
        }

        if (finalThreadId !== null && hasResolve) {
          const ok = await executeKw<boolean>(
            "knowledge.article.thread",
            "write",
            [[finalThreadId], { is_resolved: Boolean(args.resolve) }],
          );
          if (!ok) {
            throw new Error("Failed to update thread resolution status");
          }
        }

        let verificationError: string | null = null;
        if (Number.isInteger(Number(messageId)) && Number(messageId) > 0) {
          try {
            await executeKw("mail.message", "read", [
              [Number(messageId)],
              ["id", "date", "body"],
            ]);
          } catch (error) {
            verificationError = errorMessage(error);
          }
        }

        return {
          content: [
            {
              type: "text",
              text: `Knowledge comment saved on article ${articleId}${finalThreadId ? ` (thread ${finalThreadId})` : ""}${messageId ? ` as message ${messageId}` : ""}`,
            },
          ],
          structuredContent: {
            status: "posted",
            article_id: articleId,
            thread_id: finalThreadId,
            message_id: messageId ? Number(messageId) || messageId : null,
            resolved: hasResolve ? Boolean(args.resolve) : null,
            verified: verificationError === null,
            verification_error: verificationError,
          },
        };
      },
    },
  });
}
