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
  referenceId,
  referenceName,
} from "../contracts.js";
import { normalizeLimit, positiveInt } from "../utils/args.js";
import { formatList, htmlToText, redactSecrets } from "../utils/format.js";

const VALID_CATEGORIES = new Set(["workspace", "private", "shared"]);
const VALID_PERMISSIONS = new Set(["write", "read", "none"]);

const SUMMARY_FIELDS = [
  "id",
  "name",
  "icon",
  "category",
  "parent_id",
  "root_article_id",
  "sequence",
  "active",
  "to_delete",
  "is_locked",
  "is_article_item",
  "has_article_children",
  "user_has_access",
  "user_has_write_access",
  "user_permission",
  "internal_permission",
  "article_url",
  "write_date",
];

const DETAIL_FIELDS = [
  ...SUMMARY_FIELDS,
  "body",
  "parent_path",
  "child_ids",
  "full_width",
  "is_published",
  "is_user_favorite",
  "deletion_date",
  "inherited_permission",
  "inherited_permission_parent_id",
  "create_uid",
  "write_uid",
  "last_edition_uid",
  "last_edition_date",
];

const HTML_BLOCK_PATTERN =
  /<(p|h[1-6]|div|ul|ol|li|pre|blockquote|table|br|hr|section|article)\b/i;

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function normalizeArticleBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  if (HTML_BLOCK_PATTERN.test(trimmed)) return body;
  return trimmed
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll("\n", "<br/>")}</p>`)
    .join("");
}

function nonnegativeInt(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a nonnegative integer`);
  }
  return parsed;
}

function formatReference(value: unknown): { id: number; name: string } | null {
  const id = referenceId(value);
  const name = referenceName(value);
  if (id === undefined) return null;
  return { id, name: name || `#${id}` };
}

function normalizeArticleSummary(article: OdooRecord) {
  return {
    id: article.id,
    name: typeof article.name === "string" && article.name ? article.name : "Untitled",
    icon: typeof article.icon === "string" && article.icon ? article.icon : null,
    category: typeof article.category === "string" ? article.category : null,
    parent: formatReference(article.parent_id),
    root_article: formatReference(article.root_article_id),
    sequence: typeof article.sequence === "number" ? article.sequence : 0,
    active: article.active !== false,
    to_delete: article.to_delete === true,
    is_locked: article.is_locked === true,
    is_article_item: article.is_article_item === true,
    has_article_children: article.has_article_children === true,
    user_has_access: article.user_has_access !== false,
    user_has_write_access: article.user_has_write_access === true,
    user_permission:
      typeof article.user_permission === "string" ? article.user_permission : null,
    internal_permission:
      typeof article.internal_permission === "string"
        ? article.internal_permission
        : null,
    article_url:
      typeof article.article_url === "string" ? article.article_url : null,
    write_date: typeof article.write_date === "string" ? article.write_date : null,
  };
}

function formatArticleSummaryLine(article: ReturnType<typeof normalizeArticleSummary>): string {
  const prefix = article.icon ? `${article.icon} ` : "";
  const parent = article.parent ? `parent:${article.parent.name}` : "root";
  const access = article.user_has_write_access ? "write" : "read";
  const flags = [
    article.category || "unknown",
    parent,
    access,
    article.is_locked ? "locked" : null,
    article.to_delete || !article.active ? "trashed" : null,
  ].filter(Boolean);
  return `[${article.id}] ${prefix}${article.name} | ${flags.join(" | ")}${article.article_url ? `\n   ${article.article_url}` : ""}`;
}

function definitions(): Tool[] {
  return [
    {
      name: "odoo_get_knowledge_articles",
      description: "List or search Odoo Knowledge documentation articles",
      inputSchema: {
        type: "object",
        properties: {
          search: { type: "string", description: "Search text in article title" },
          category: {
            type: "string",
            description: "Filter by section: workspace | private | shared",
          },
          parent_id: { type: "number", description: "Filter by parent article ID" },
          roots_only: {
            type: "boolean",
            description: "Only return root articles without a parent",
          },
          include_trashed: {
            type: "boolean",
            description: "Include trashed/archived articles (default false)",
          },
          include_items: {
            type: "boolean",
            description: "Include article database items (default true)",
          },
          limit: {
            type: "number",
            description: "Max results (default 50, max 200)",
          },
          offset: {
            type: "number",
            description: "Number of results to skip (default 0)",
          },
        },
      },
    },
    {
      name: "odoo_get_knowledge_article",
      description: "Get full content and metadata of an Odoo Knowledge article",
      inputSchema: {
        type: "object",
        properties: {
          article_id: { type: "number", description: "Knowledge article ID" },
          include_children: {
            type: "boolean",
            description: "Include immediate child articles (default true)",
          },
          redact_secrets: {
            type: "boolean",
            description: "Mask API keys, tokens and passwords (default true)",
          },
        },
        required: ["article_id"],
      },
    },
    {
      name: "odoo_create_knowledge_article",
      description: "Create a new Odoo Knowledge documentation article",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Article title" },
          body: {
            type: "string",
            description: "Article body (HTML or plain text; optional)",
          },
          parent_id: {
            type: "number",
            description: "Optional parent article ID",
          },
          category: {
            type: "string",
            description:
              "For root articles without parent_id: workspace (default) | private",
          },
          internal_permission: {
            type: "string",
            description: "Optional internal permission override: write | read | none",
          },
          icon: { type: "string", description: "Optional emoji icon" },
          full_width: { type: "boolean", description: "Full width layout (optional)" },
          is_locked: { type: "boolean", description: "Lock article content (optional)" },
          sequence: { type: "number", description: "Ordering sequence (optional)" },
        },
        required: ["name"],
      },
    },
    {
      name: "odoo_update_knowledge_article",
      description: "Edit or restore an existing Odoo Knowledge documentation article",
      inputSchema: {
        type: "object",
        properties: {
          article_id: { type: "number", description: "Knowledge article ID" },
          name: { type: "string", description: "New article title" },
          body: { type: "string", description: "New article body (HTML or plain text)" },
          icon: {
            type: ["string", "null"],
            description: "Emoji icon (pass empty string or null to clear)",
          },
          parent_id: {
            type: ["number", "null"],
            description: "New parent article ID (pass null or 0 to move to root)",
          },
          is_locked: { type: "boolean", description: "Lock or unlock article" },
          full_width: { type: "boolean", description: "Full width layout" },
          internal_permission: {
            type: "string",
            description: "Internal permission: write | read | none",
          },
          sequence: { type: "number", description: "Ordering sequence" },
          restore: {
            type: "boolean",
            description: "Set true to restore a trashed article",
          },
        },
        required: ["article_id"],
      },
    },
    {
      name: "odoo_delete_knowledge_article",
      description: "Preview or send an Odoo Knowledge article to Trash",
      inputSchema: {
        type: "object",
        properties: {
          article_id: { type: "number", description: "Knowledge article ID" },
          confirm: {
            type: "boolean",
            description: "Must be true to send the article to Trash",
          },
        },
        required: ["article_id", "confirm"],
      },
    },
  ];
}

export function createKnowledgeTools({
  executeKw: executeKwImplementation,
  getAvailableFields,
  getUid,
}: {
  executeKw: ExecuteKwImplementation;
  getAvailableFields?: GetAvailableFields;
  getUid?: GetUid;
}) {
  const executeKw = <T = OdooRecord[]>(
    model: string,
    method: string,
    args: OdooArguments = [],
    kwargs: OdooKeywordArguments = {},
  ) => execute<T>(executeKwImplementation, model, method, args, kwargs);
  const currentUid = getUid || (() => null);

  async function resolveFields(requested: string[]): Promise<string[]> {
    return getAvailableFields
      ? getAvailableFields("knowledge.article", requested)
      : requested;
  }

  async function readArticleById(
    articleId: number,
    requestedFields: string[],
  ): Promise<OdooRecord | null> {
    const fields = await resolveFields(requestedFields);
    const rows = await executeKw<OdooRecord[]>(
      "knowledge.article",
      "read",
      [[articleId], fields],
      { context: { active_test: false } },
    );
    return rows?.[0] || null;
  }

  return defineToolGroup({
    definitions: definitions(),
    handlers: {
      async odoo_get_knowledge_articles(args) {
        const limit = normalizeLimit(args.limit, { fallback: 50, maximum: 200 });
        const offset = args.offset === undefined
          ? 0
          : nonnegativeInt(args.offset, "offset");
        const includeTrashed = args.include_trashed === true;
        const fields = await resolveFields(SUMMARY_FIELDS);
        const filterFields = getAvailableFields
          ? await getAvailableFields("knowledge.article", [
              "is_template",
              "user_has_access",
              "is_article_item",
            ])
          : ["is_template", "user_has_access", "is_article_item"];

        const domain: unknown[][] = [];
        if (filterFields.includes("is_template")) {
          domain.push(["is_template", "=", false]);
        }
        if (filterFields.includes("user_has_access")) {
          domain.push(["user_has_access", "=", true]);
        }
        if (!includeTrashed) {
          domain.push(["active", "=", true]);
        }
        if (args.include_items === false && filterFields.includes("is_article_item")) {
          domain.push(["is_article_item", "=", false]);
        }
        if (args.category !== undefined) {
          const category = String(args.category);
          if (!VALID_CATEGORIES.has(category)) {
            throw new Error(
              `Invalid category "${category}" (expected workspace | private | shared)`,
            );
          }
          domain.push(["category", "=", category]);
        }
        if (args.roots_only === true) {
          domain.push(["parent_id", "=", false]);
        } else if (args.parent_id !== undefined) {
          domain.push(["parent_id", "=", positiveInt(args.parent_id, "parent_id")]);
        }
        if (typeof args.search === "string" && args.search.trim()) {
          domain.push(["name", "ilike", args.search.trim()]);
        }

        const kwargs = includeTrashed
          ? { context: { active_test: false } }
          : {};
        const [totalCount, rows] = await Promise.all([
          executeKw<number>("knowledge.article", "search_count", [domain], kwargs),
          executeKw<OdooRecord[]>("knowledge.article", "search_read", [domain], {
            ...kwargs,
            fields,
            limit,
            offset,
            order: "sequence, id desc",
          }),
        ]);

        const articles = (rows || []).map(normalizeArticleSummary);
        const hasMore = offset + articles.length < totalCount;
        const text = articles.length
          ? [
              `Articles: ${articles.length} (total: ${totalCount}, offset: ${offset}, has_more: ${hasMore})`,
              "",
              ...articles.map(formatArticleSummaryLine),
            ].join("\n")
          : formatList([]);

        return {
          content: [{ type: "text", text }],
          structuredContent: {
            articles,
            total_count: totalCount,
            offset,
            has_more: hasMore,
          },
        };
      },

      async odoo_get_knowledge_article(args) {
        const articleId = positiveInt(args.article_id, "article_id");
        const redact = args.redact_secrets !== false;
        const row = await readArticleById(articleId, DETAIL_FIELDS);
        if (!row) {
          return {
            content: [{ type: "text", text: "Article not found" }],
            structuredContent: { article_id: articleId, found: false },
          };
        }
        if (row.user_has_access === false) {
          throw new Error(`Access denied to Knowledge article ${articleId}`);
        }

        const summary = normalizeArticleSummary(row);
        const rawHtml = typeof row.body === "string" ? row.body : "";
        const safeHtml = redact ? redactSecrets(rawHtml) : rawHtml;
        const bodyText = redact ? redactSecrets(htmlToText(rawHtml)) : htmlToText(rawHtml);

        let children: ReturnType<typeof normalizeArticleSummary>[] = [];
        const childIds = Array.isArray(row.child_ids)
          ? row.child_ids.filter((id): id is number => typeof id === "number")
          : [];
        if (args.include_children !== false && childIds.length > 0) {
          const childFields = await resolveFields(SUMMARY_FIELDS);
          const childDomain: unknown[][] = [["id", "in", childIds]];
          if (childFields.includes("user_has_access")) {
            childDomain.push(["user_has_access", "=", true]);
          }
          const childRows = await executeKw<OdooRecord[]>(
            "knowledge.article",
            "search_read",
            [childDomain],
            { fields: childFields, limit: 200, order: "sequence, id" },
          );
          children = (childRows || []).map(normalizeArticleSummary);
        }

        const article = {
          ...summary,
          body_text: bodyText,
          body_html: safeHtml,
          parent_path: typeof row.parent_path === "string" ? row.parent_path : null,
          full_width: row.full_width === true,
          is_published: row.is_published === true,
          is_user_favorite: row.is_user_favorite === true,
          deletion_date:
            typeof row.deletion_date === "string" ? row.deletion_date : null,
          inherited_permission:
            typeof row.inherited_permission === "string"
              ? row.inherited_permission
              : null,
          inherited_permission_parent: formatReference(
            row.inherited_permission_parent_id,
          ),
          created_by: formatReference(row.create_uid),
          last_edited_by: formatReference(row.last_edition_uid || row.write_uid),
          last_edition_date:
            typeof row.last_edition_date === "string" ? row.last_edition_date : null,
          children,
        };

        const header = [
          `Article #${article.id}: ${article.icon ? `${article.icon} ` : ""}${article.name}`,
          `Category: ${article.category || "N/A"} | Access: ${article.user_has_write_access ? "write" : "read"} | Locked: ${article.is_locked}`,
          `Parent: ${article.parent ? `[${article.parent.id}] ${article.parent.name}` : "root"}`,
          `URL: ${article.article_url || "N/A"}`,
          children.length
            ? `Children (${children.length}): ${children.map((c) => `[${c.id}] ${c.name}`).join(", ")}`
            : "Children: none",
          "",
          "Content:",
          bodyText || "(empty)",
        ].join("\n");

        return {
          content: [{ type: "text", text: header }],
          structuredContent: {
            article_id: articleId,
            found: true,
            article,
          },
        };
      },

      async odoo_create_knowledge_article(args) {
        if (typeof args.name !== "string" || !args.name.trim()) {
          throw new Error("name must be a nonblank string");
        }
        const name = args.name.trim();
        const values: Record<string, unknown> = { name };

        if (args.body !== undefined) {
          if (typeof args.body !== "string") {
            throw new Error("body must be a string");
          }
          values.body = normalizeArticleBody(args.body);
        }

        const parentId = args.parent_id === undefined
          ? null
          : positiveInt(args.parent_id, "parent_id");

        if (parentId !== null) {
          if (args.category === "private") {
            throw new Error(
              "category 'private' cannot be combined with parent_id; child articles inherit section from parent",
            );
          }
          const parent = await readArticleById(parentId, [
            "id",
            "name",
            "active",
            "to_delete",
            "user_has_write_access",
          ]);
          if (!parent) {
            throw new Error(`Parent article not found: ${parentId}`);
          }
          if (parent.active === false || parent.to_delete === true) {
            throw new Error(`Parent article ${parentId} is in Trash`);
          }
          if (parent.user_has_write_access === false) {
            throw new Error(
              `You do not have write access to parent article ${parentId}`,
            );
          }
          values.parent_id = parentId;
        }

        if (args.internal_permission !== undefined) {
          const perm = String(args.internal_permission);
          if (!VALID_PERMISSIONS.has(perm)) {
            throw new Error(
              `Invalid internal_permission "${perm}" (expected write | read | none)`,
            );
          }
          values.internal_permission = perm;
        } else if (parentId === null) {
          const category = args.category === undefined
            ? "workspace"
            : String(args.category);
          if (category !== "workspace" && category !== "private") {
            throw new Error(
              `Invalid category "${category}" (expected workspace | private)`,
            );
          }
          if (category === "private") {
            const uid = currentUid();
            if (!uid) {
              throw new Error("Unable to determine current user for private article");
            }
            const users = await executeKw<OdooRecord[]>("res.users", "read", [
              [uid],
              ["partner_id"],
            ]);
            const partnerId = referenceId(users?.[0]?.partner_id);
            if (!partnerId) {
              throw new Error("Current user has no partner_id for private article");
            }
            values.internal_permission = "none";
            values.article_member_ids = [
              [0, 0, { partner_id: partnerId, permission: "write" }],
            ];
          } else {
            values.internal_permission = "write";
          }
        }

        if (args.icon !== undefined) {
          values.icon = typeof args.icon === "string" && args.icon.trim()
            ? args.icon.trim()
            : false;
        }
        if (args.full_width !== undefined) {
          values.full_width = Boolean(args.full_width);
        }
        if (args.is_locked !== undefined) {
          values.is_locked = Boolean(args.is_locked);
        }
        if (args.sequence !== undefined) {
          values.sequence = nonnegativeInt(args.sequence, "sequence");
        }

        const articleId = await executeKw<number>(
          "knowledge.article",
          "create",
          [values],
        );
        if (!articleId) {
          throw new Error("Odoo did not create the Knowledge article");
        }

        let created: ReturnType<typeof normalizeArticleSummary> | null = null;
        let verificationError: string | null = null;
        try {
          const row = await readArticleById(articleId, SUMMARY_FIELDS);
          if (row) created = normalizeArticleSummary(row);
        } catch (error) {
          verificationError = errorMessage(error);
        }

        return {
          content: [
            {
              type: "text",
              text: created
                ? `Knowledge article created: [${created.id}] ${created.name}\nCategory: ${created.category || "N/A"}\nURL: ${created.article_url || "N/A"}`
                : `Knowledge article created: ${articleId}`,
            },
          ],
          structuredContent: {
            id: articleId,
            created: true,
            verified: verificationError === null,
            article: created,
            verification_error: verificationError,
          },
        };
      },

      async odoo_update_knowledge_article(args) {
        const articleId = positiveInt(args.article_id, "article_id");
        const current = await readArticleById(articleId, SUMMARY_FIELDS);
        if (!current) {
          throw new Error(`Article not found: ${articleId}`);
        }
        if (current.user_has_write_access === false) {
          throw new Error(
            `You do not have write access to Knowledge article ${articleId}`,
          );
        }

        const values: Record<string, unknown> = {};
        if (args.name !== undefined) {
          if (typeof args.name !== "string" || !args.name.trim()) {
            throw new Error("name must be a nonblank string");
          }
          values.name = args.name.trim();
        }
        if (args.body !== undefined) {
          if (typeof args.body !== "string") {
            throw new Error("body must be a string");
          }
          values.body = normalizeArticleBody(args.body);
        }
        if (args.icon !== undefined) {
          values.icon = typeof args.icon === "string" && args.icon.trim()
            ? args.icon.trim()
            : false;
        }
        if (args.parent_id !== undefined) {
          if (args.parent_id === null || args.parent_id === 0) {
            values.parent_id = false;
          } else {
            const parentId = positiveInt(args.parent_id, "parent_id");
            if (parentId === articleId) {
              throw new Error("An article cannot be its own parent");
            }
            const parent = await readArticleById(parentId, [
              "id",
              "active",
              "to_delete",
              "user_has_write_access",
            ]);
            if (!parent) {
              throw new Error(`Parent article not found: ${parentId}`);
            }
            if (parent.active === false || parent.to_delete === true) {
              throw new Error(`Parent article ${parentId} is in Trash`);
            }
            if (parent.user_has_write_access === false) {
              throw new Error(
                `You do not have write access to parent article ${parentId}`,
              );
            }
            values.parent_id = parentId;
          }
        }
        if (args.is_locked !== undefined) {
          values.is_locked = Boolean(args.is_locked);
        }
        if (args.full_width !== undefined) {
          values.full_width = Boolean(args.full_width);
        }
        if (args.internal_permission !== undefined) {
          const perm = String(args.internal_permission);
          if (!VALID_PERMISSIONS.has(perm)) {
            throw new Error(
              `Invalid internal_permission "${perm}" (expected write | read | none)`,
            );
          }
          values.internal_permission = perm;
        }
        if (args.sequence !== undefined) {
          values.sequence = nonnegativeInt(args.sequence, "sequence");
        }

        const shouldRestore = args.restore === true &&
          (current.active === false || current.to_delete === true);

        if (Object.keys(values).length === 0 && !shouldRestore) {
          return {
            content: [{ type: "text", text: "Nothing to update" }],
            structuredContent: { id: articleId, updated: false },
          };
        }

        const editsContent =
          values.name !== undefined ||
          values.body !== undefined ||
          values.icon !== undefined;
        if (current.is_locked === true && editsContent && args.is_locked !== false) {
          throw new Error(
            `Knowledge article ${articleId} is locked. Pass is_locked=false to unlock before editing.`,
          );
        }

        if (shouldRestore) {
          await executeKw("knowledge.article", "action_unarchive", [[articleId]]);
        }

        if (Object.keys(values).length > 0) {
          if (current.is_locked === true && args.is_locked === false && editsContent) {
            await executeKw<boolean>("knowledge.article", "write", [
              [articleId],
              { is_locked: false },
            ]);
            const rest = { ...values };
            delete rest.is_locked;
            if (Object.keys(rest).length > 0) {
              const ok = await executeKw<boolean>("knowledge.article", "write", [
                [articleId],
                rest,
              ]);
              if (!ok) throw new Error("Update failed");
            }
          } else {
            const ok = await executeKw<boolean>("knowledge.article", "write", [
              [articleId],
              values,
            ]);
            if (!ok) throw new Error("Update failed");
          }
        }

        let updated: ReturnType<typeof normalizeArticleSummary> | null = null;
        let verificationError: string | null = null;
        try {
          const row = await readArticleById(articleId, SUMMARY_FIELDS);
          if (row) updated = normalizeArticleSummary(row);
        } catch (error) {
          verificationError = errorMessage(error);
        }

        return {
          content: [
            {
              type: "text",
              text: updated
                ? `Knowledge article updated: [${updated.id}] ${updated.name}\nURL: ${updated.article_url || "N/A"}`
                : `Knowledge article updated: ${articleId}`,
            },
          ],
          structuredContent: {
            id: articleId,
            updated: true,
            restored: shouldRestore,
            verified: verificationError === null,
            article: updated,
            verification_error: verificationError,
          },
        };
      },

      async odoo_delete_knowledge_article(args) {
        const articleId = positiveInt(args.article_id, "article_id");
        const current = await readArticleById(articleId, [
          ...SUMMARY_FIELDS,
          "child_ids",
          "deletion_date",
        ]);
        if (!current) {
          throw new Error(`Article not found: ${articleId}`);
        }
        if (current.active === false || current.to_delete === true) {
          return {
            content: [
              {
                type: "text",
                text: `Knowledge article ${articleId} is already in Trash`,
              },
            ],
            structuredContent: {
              id: articleId,
              status: "already_trashed",
              article: normalizeArticleSummary(current),
            },
          };
        }
        if (current.user_has_write_access === false) {
          throw new Error(
            `You do not have write access to Knowledge article ${articleId}`,
          );
        }
        if (current.is_locked === true) {
          throw new Error(
            `Knowledge article ${articleId} is locked. Unlock it before sending to Trash.`,
          );
        }

        const childCount = Array.isArray(current.child_ids)
          ? current.child_ids.length
          : 0;
        const summary = normalizeArticleSummary(current);

        if (args.confirm !== true) {
          return {
            content: [
              {
                type: "text",
                text: [
                  `Preview only; article ${articleId} was NOT sent to Trash.`,
                  `Title: ${summary.name}`,
                  `Category: ${summary.category || "N/A"}`,
                  `Child articles: ${childCount}`,
                  `URL: ${summary.article_url || "N/A"}`,
                  "Retry with confirm=true to send it to Trash.",
                ].join("\n"),
              },
            ],
            structuredContent: {
              id: articleId,
              status: "preview",
              child_count: childCount,
              article: summary,
            },
          };
        }

        await executeKw("knowledge.article", "action_send_to_trash", [[articleId]]);

        let verifiedArticle: ReturnType<typeof normalizeArticleSummary> | null = null;
        let deletionDate: string | null = null;
        let verificationError: string | null = null;
        try {
          const row = await readArticleById(articleId, [
            ...SUMMARY_FIELDS,
            "deletion_date",
          ]);
          if (row) {
            verifiedArticle = normalizeArticleSummary(row);
            deletionDate =
              typeof row.deletion_date === "string" ? row.deletion_date : null;
          }
        } catch (error) {
          verificationError = errorMessage(error);
        }

        return {
          content: [
            {
              type: "text",
              text: `Knowledge article sent to Trash: [${articleId}] ${summary.name}${deletionDate ? ` (scheduled deletion: ${deletionDate})` : ""}`,
            },
          ],
          structuredContent: {
            id: articleId,
            status: "trashed",
            deletion_date: deletionDate,
            verified: verificationError === null,
            article: verifiedArticle,
            verification_error: verificationError,
          },
        };
      },
    },
  });
}
