import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExecuteKwImplementation,
  OdooArguments,
  OdooKeywordArguments,
} from "../src/contracts.js";
import { createKnowledgeExtrasTools } from "../src/tools/knowledge-extras.js";
import { array, record, required, structuredContent, textContent } from "./helpers.js";

interface OdooCall {
  key: string;
  model: string;
  method: string;
  args: OdooArguments;
  kwargs: OdooKeywordArguments;
}

function makeExecuteKw(
  overrides: Record<
    string,
    (args: OdooArguments, kwargs: OdooKeywordArguments, calls: OdooCall[]) => unknown
  > = {},
) {
  const calls: OdooCall[] = [];
  const executeKw: ExecuteKwImplementation = async (
    model,
    method,
    args = [],
    kwargs = {},
  ) => {
    const key = `${model}.${method}`;
    calls.push({ key, model, method, args, kwargs });
    if (Object.hasOwn(overrides, key)) {
      return required(overrides[key])(args, kwargs, calls);
    }
    switch (key) {
      case "knowledge.article.read":
        return [
          {
            id: 497,
            name: "mcp-mysql",
            user_has_access: true,
            user_has_write_access: true,
            is_locked: false,
            article_properties_definition: [
              { name: "deadline", type: "date", string: "Deadline" },
            ],
          },
        ];
      case "knowledge.article.stage.search_read":
        return [
          { id: 10, name: "Nuevo", sequence: 0, fold: false, parent_id: [497, "mcp-mysql"] },
          { id: 11, name: "Listo", sequence: 1, fold: true, parent_id: [497, "mcp-mysql"] },
        ];
      case "knowledge.article.thread.search_read":
        return [
          {
            id: 14,
            article_id: [497, "mcp-mysql"],
            article_anchor_text: "token=anchor-secret",
            is_resolved: false,
            message_ids: [901],
          },
        ];
      case "knowledge.article.thread.read":
        return [
          {
            id: 14,
            article_id: [497, "mcp-mysql"],
            article_anchor_text: "anchor",
            is_resolved: false,
          },
        ];
      case "knowledge.article.thread.create":
        return 25;
      case "knowledge.article.thread.write":
        return true;
      case "knowledge.article.thread.message_post":
      case "knowledge.article.message_post":
        return 999;
      case "mail.message.search_read": {
        const domain = JSON.stringify(args[0]);
        if (domain.includes("knowledge.article.thread")) {
          return [
            {
              id: 901,
              res_id: 14,
              date: "2026-11-10 10:00:00",
              author_id: [16, "Ivan"],
              body: "<p>password=thread-secret</p>",
              message_type: "comment",
              attachment_ids: [501],
            },
          ];
        }
        return [
          {
            id: 902,
            res_id: 497,
            date: "2026-11-11 10:00:00",
            author_id: [16, "Ivan"],
            body: "<p>Chatter note</p>",
            message_type: "comment",
            attachment_ids: [],
          },
        ];
      }
      case "mail.message.read":
        return [{ id: 999, date: "2026-11-13", body: "ok" }];
      case "ir.attachment.search_read":
        return [
          {
            id: 500,
            name: "token=doc-secret.pdf",
            mimetype: "application/pdf",
            file_size: 100,
            type: "binary",
            url: false,
            description: "<p>api_key: direct-secret</p>",
            res_model: "knowledge.article",
            res_id: 497,
          },
        ];
      case "ir.attachment.read":
        if (array(args[1]).includes("datas")) {
          return [
            {
              id: 501,
              name: "screen.png",
              mimetype: "image/png",
              file_size: 4,
              datas: "aW1hZ2U=",
            },
          ];
        }
        return [
          {
            id: 501,
            name: "screen.png",
            mimetype: "image/png",
            file_size: 4,
            type: "binary",
            url: false,
            description: false,
            res_model: "mail.message",
            res_id: 901,
          },
        ];
      case "ir.attachment.create":
        return 800;
      default:
        return [];
    }
  };
  return Object.assign(executeKw, { calls });
}

test("defines the six Knowledge extras tools", () => {
  const { definitions } = createKnowledgeExtrasTools({ executeKw: makeExecuteKw() });
  assert.deepEqual(
    definitions.map((d) => d.name),
    [
      "odoo_get_knowledge_stages",
      "odoo_get_knowledge_article_attachments",
      "odoo_get_knowledge_article_images",
      "odoo_add_knowledge_attachment",
      "odoo_get_knowledge_article_comments",
      "odoo_add_knowledge_comment",
    ],
  );
});

test("odoo_get_knowledge_stages lists stages and property definitions", async () => {
  const result = await createKnowledgeExtrasTools({
    executeKw: makeExecuteKw(),
  }).handlers.odoo_get_knowledge_stages({ parent_id: 497 });
  assert.match(textContent(result), /\[10\] Nuevo/);
  assert.match(textContent(result), /deadline: Deadline \(date\)/);
  const data = structuredContent<{ stages: unknown[]; properties_definition: unknown[] }>(result);
  assert.equal(data.stages.length, 2);
  assert.equal(data.properties_definition.length, 1);
});

test("odoo_get_knowledge_article_attachments and images redact secrets and return image blocks", async () => {
  const tools = createKnowledgeExtrasTools({ executeKw: makeExecuteKw() });
  const attRes = await tools.handlers.odoo_get_knowledge_article_attachments({
    article_id: 497,
  });
  assert.doesNotMatch(
    JSON.stringify(attRes),
    /doc-secret|direct-secret/,
  );
  assert.match(textContent(attRes), /token=\[REDACTED\]/);

  const imgRes = await tools.handlers.odoo_get_knowledge_article_images({
    article_id: 497,
  });
  assert.equal(imgRes.content[1].type, "image");
  assert.equal(record(imgRes.content[1]).mimeType, "image/png");
});

test("odoo_add_knowledge_attachment validates payload and lock state", async () => {
  const tools = createKnowledgeExtrasTools({ executeKw: makeExecuteKw() });
  await assert.rejects(
    tools.handlers.odoo_add_knowledge_attachment({
      article_id: 497,
      name: "bad",
    }),
    /exactly one of data_base64 or url/,
  );

  const lockedTools = createKnowledgeExtrasTools({
    executeKw: makeExecuteKw({
      "knowledge.article.read": () => [
        { id: 497, user_has_access: true, user_has_write_access: true, is_locked: true },
      ],
    }),
  });
  await assert.rejects(
    lockedTools.handlers.odoo_add_knowledge_attachment({
      article_id: 497,
      name: "doc.txt",
      url: "https://example.com/doc",
    }),
    /is locked/,
  );

  const created = await tools.handlers.odoo_add_knowledge_attachment({
    article_id: 497,
    name: "notes.txt",
    data_base64: "aGVsbG8=",
    mimetype: "text/plain",
  });
  assert.equal(structuredContent(created).id, 800);
});

test("odoo_get_knowledge_article_comments reads threads and chatter with secret redaction", async () => {
  const result = await createKnowledgeExtrasTools({
    executeKw: makeExecuteKw(),
  }).handlers.odoo_get_knowledge_article_comments({ article_id: 497 });
  const text = textContent(result);
  assert.match(text, /Comment threads \(1\)/);
  assert.match(text, /Chatter messages \(1\)/);
  assert.match(text, /password=\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(result), /thread-secret|anchor-secret/);
});

test("odoo_add_knowledge_comment previews, creates anchored thread, replies, and resolves", async () => {
  const executeKw = makeExecuteKw();
  const { handlers } = createKnowledgeExtrasTools({ executeKw });

  const preview = await handlers.odoo_add_knowledge_comment({
    article_id: 497,
    anchor_text: "target section",
    body: "Review token=secret-123",
    confirm: false,
  });
  assert.equal(structuredContent(preview).status, "preview");
  assert.doesNotMatch(JSON.stringify(preview), /secret-123/);
  assert.equal(
    executeKw.calls.some((c) => c.key === "knowledge.article.thread.create"),
    false,
  );

  const createdThread = await handlers.odoo_add_knowledge_comment({
    article_id: 497,
    anchor_text: "target section",
    body: "Review token=secret-123",
    confirm: true,
  });
  assert.equal(structuredContent(createdThread).thread_id, 25);
  assert.equal(structuredContent(createdThread).status, "posted");

  const resolved = await handlers.odoo_add_knowledge_comment({
    article_id: 497,
    thread_id: 14,
    resolve: true,
    confirm: true,
  });
  assert.equal(structuredContent(resolved).resolved, true);
  assert.ok(
    executeKw.calls.some((c) => c.key === "knowledge.article.thread.write"),
  );
});
