import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExecuteKwImplementation,
  GetAvailableFields,
  GetUid,
  OdooArguments,
  OdooKeywordArguments,
} from "../src/contracts.js";
import {
  createKnowledgeTools,
  normalizeArticleBody,
} from "../src/tools/knowledge.js";
import { array, record, required, structuredContent, textContent } from "./helpers.js";

const UID = 16;

interface OdooCall {
  key: string;
  model: string;
  method: string;
  args: OdooArguments;
  kwargs: OdooKeywordArguments;
}

type OdooOverride = (
  args: OdooArguments,
  kwargs: OdooKeywordArguments,
  calls: OdooCall[],
) => unknown | Promise<unknown>;

function makeExecuteKw(overrides: Record<string, OdooOverride> = {}) {
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
      case "knowledge.article.search_count":
        return 1;
      case "knowledge.article.search_read":
        return [
          {
            id: 497,
            name: "mcp-mysql",
            icon: false,
            category: "workspace",
            parent_id: [479, "Nuestros MCPs"],
            root_article_id: [127, "Proyectos"],
            sequence: 1,
            active: true,
            to_delete: false,
            is_locked: false,
            is_article_item: false,
            has_article_children: false,
            user_has_access: true,
            user_has_write_access: true,
            user_permission: "write",
            internal_permission: false,
            article_url: "https://odoo.solunika.com/knowledge/article/497",
            write_date: "2026-11-12 10:00:00",
          },
        ];
      case "knowledge.article.read":
        return [
          {
            id: 497,
            name: "mcp-mysql",
            icon: false,
            category: "workspace",
            parent_id: [479, "Nuestros MCPs"],
            root_article_id: [127, "Proyectos"],
            parent_path: "127/140/479/497/",
            child_ids: [],
            sequence: 1,
            active: true,
            to_delete: false,
            is_locked: false,
            is_article_item: false,
            has_article_children: false,
            user_has_access: true,
            user_has_write_access: true,
            user_permission: "write",
            internal_permission: false,
            inherited_permission: "write",
            inherited_permission_parent_id: [127, "Proyectos"],
            article_url: "https://odoo.solunika.com/knowledge/article/497",
            body: "<h1>@hubeet/mcp-mysql</h1><p>token=super-secret</p>",
            write_date: "2026-11-12 10:00:00",
          },
        ];
      case "knowledge.article.create":
        return 1200;
      case "knowledge.article.write":
      case "knowledge.article.action_send_to_trash":
      case "knowledge.article.action_unarchive":
        return true;
      case "res.users.read":
        return [{ id: UID, partner_id: [99, "Ivan"] }];
      default:
        return [];
    }
  };
  return Object.assign(executeKw, { calls });
}

function makeTools(
  executeKw: ExecuteKwImplementation,
  {
    getAvailableFields,
    getUid = () => UID,
  }: { getAvailableFields?: GetAvailableFields; getUid?: GetUid } = {},
) {
  return createKnowledgeTools({ executeKw, getAvailableFields, getUid });
}

test("defines the five Knowledge tools with expected schemas", () => {
  const { definitions } = makeTools(makeExecuteKw());
  assert.deepEqual(
    definitions.map((d) => d.name),
    [
      "odoo_get_knowledge_articles",
      "odoo_get_knowledge_article",
      "odoo_create_knowledge_article",
      "odoo_update_knowledge_article",
      "odoo_delete_knowledge_article",
    ],
  );
  const create = required(
    definitions.find((d) => d.name === "odoo_create_knowledge_article"),
  );
  assert.deepEqual(create.inputSchema.required, ["name"]);
  const del = required(
    definitions.find((d) => d.name === "odoo_delete_knowledge_article"),
  );
  assert.deepEqual(del.inputSchema.required, ["article_id", "confirm"]);
});

test("normalizeArticleBody preserves HTML and wraps plain text paragraphs", () => {
  assert.equal(normalizeArticleBody("  "), "");
  assert.equal(
    normalizeArticleBody("<h1>Title</h1><p>Text</p>"),
    "<h1>Title</h1><p>Text</p>",
  );
  assert.equal(
    normalizeArticleBody("Line 1\nLine 2\n\nSecond <para> & more"),
    "<p>Line 1<br/>Line 2</p><p>Second &lt;para&gt; &amp; more</p>",
  );
});

test("odoo_get_knowledge_articles builds accessible domain and pagination", async () => {
  const executeKw = makeExecuteKw();
  const result = await makeTools(executeKw).handlers.odoo_get_knowledge_articles({
    search: "mysql",
    category: "workspace",
    parent_id: 479,
    include_items: false,
    limit: 20,
    offset: 0,
  });

  const searchRead = required(
    executeKw.calls.find((c) => c.key === "knowledge.article.search_read"),
  );
  assert.deepEqual(searchRead.args[0], [
    ["is_template", "=", false],
    ["user_has_access", "=", true],
    ["active", "=", true],
    ["is_article_item", "=", false],
    ["category", "=", "workspace"],
    ["parent_id", "=", 479],
    ["name", "ilike", "mysql"],
  ]);
  assert.equal(searchRead.kwargs.limit, 20);
  assert.match(textContent(result), /\[497\] mcp-mysql/);
  const data = structuredContent<{ articles: { id: number }[]; total_count: number }>(result);
  assert.equal(data.total_count, 1);
  assert.equal(data.articles[0].id, 497);
});

test("odoo_get_knowledge_articles passes active_test=false when include_trashed is true", async () => {
  const executeKw = makeExecuteKw();
  await makeTools(executeKw).handlers.odoo_get_knowledge_articles({
    include_trashed: true,
    roots_only: true,
  });
  const searchRead = required(
    executeKw.calls.find((c) => c.key === "knowledge.article.search_read"),
  );
  assert.deepEqual(searchRead.kwargs.context, { active_test: false });
  assert.ok(
    array(searchRead.args[0]).some(
      (term) => JSON.stringify(term) === JSON.stringify(["parent_id", "=", false]),
    ),
  );
});

test("odoo_get_knowledge_article reads article, redacts secrets, and fetches children", async () => {
  const executeKw = makeExecuteKw({
    "knowledge.article.read": () => [
      {
        id: 479,
        name: "Nuestros MCPs",
        category: "workspace",
        parent_id: [495, "MCPs"],
        child_ids: [497],
        user_has_access: true,
        user_has_write_access: true,
        body: "<p>api_key: my-secret-value</p>",
        article_url: "https://odoo.solunika.com/knowledge/article/479",
      },
    ],
  });
  const result = await makeTools(executeKw).handlers.odoo_get_knowledge_article({
    article_id: 479,
  });
  const text = textContent(result);
  assert.match(text, /Article #479: Nuestros MCPs/);
  assert.match(text, /api_key: \[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(result), /my-secret-value/);
  assert.match(text, /Children \(1\): \[497\] mcp-mysql/);
});

test("odoo_get_knowledge_article enforces user_has_access", async () => {
  const executeKw = makeExecuteKw({
    "knowledge.article.read": () => [
      { id: 960, name: "Private", user_has_access: false },
    ],
  });
  await assert.rejects(
    makeTools(executeKw).handlers.odoo_get_knowledge_article({ article_id: 960 }),
    /Access denied/,
  );
});

test("odoo_create_knowledge_article creates workspace, child, and private articles", async () => {
  const executeKw = makeExecuteKw();
  const { handlers } = makeTools(executeKw);

  await handlers.odoo_create_knowledge_article({
    name: "New Doc",
    body: "Hello world",
    icon: "📘",
  });
  const workspaceCreate = required(
    executeKw.calls.find((c) => c.key === "knowledge.article.create"),
  );
  assert.deepEqual(workspaceCreate.args[0], {
    name: "New Doc",
    body: "<p>Hello world</p>",
    internal_permission: "write",
    icon: "📘",
  });

  await handlers.odoo_create_knowledge_article({
    name: "Secret Notes",
    category: "private",
  });
  const createCalls = executeKw.calls.filter(
    (c) => c.key === "knowledge.article.create",
  );
  assert.deepEqual(createCalls[1].args[0], {
    name: "Secret Notes",
    internal_permission: "none",
    article_member_ids: [[0, 0, { partner_id: 99, permission: "write" }]],
  });

  await handlers.odoo_create_knowledge_article({
    name: "Child Doc",
    parent_id: 479,
  });
  assert.deepEqual(executeKw.calls.filter((c) => c.key === "knowledge.article.create")[2].args[0], {
    name: "Child Doc",
    parent_id: 479,
  });
});

test("odoo_create_knowledge_article rejects private category with parent_id and readonly parent", async () => {
  const executeKw = makeExecuteKw({
    "knowledge.article.read": () => [
      { id: 134, name: "Readonly", active: true, user_has_write_access: false },
    ],
  });
  const { handlers } = makeTools(executeKw);
  await assert.rejects(
    handlers.odoo_create_knowledge_article({
      name: "X",
      parent_id: 134,
      category: "private",
    }),
    /cannot be combined with parent_id/,
  );
  await assert.rejects(
    handlers.odoo_create_knowledge_article({
      name: "X",
      parent_id: 134,
    }),
    /do not have write access to parent article/,
  );
});

test("odoo_update_knowledge_article edits, checks lock, and restores trashed articles", async () => {
  const lockedKw = makeExecuteKw({
    "knowledge.article.read": () => [
      { id: 10, name: "Locked", is_locked: true, user_has_write_access: true },
    ],
  });
  await assert.rejects(
    makeTools(lockedKw).handlers.odoo_update_knowledge_article({
      article_id: 10,
      body: "Edit",
    }),
    /is locked/,
  );

  const unlockKw = makeExecuteKw({
    "knowledge.article.read": () => [
      { id: 10, name: "Locked", is_locked: true, user_has_write_access: true },
    ],
  });
  await makeTools(unlockKw).handlers.odoo_update_knowledge_article({
    article_id: 10,
    is_locked: false,
    body: "Updated",
  });
  const writes = unlockKw.calls.filter((c) => c.key === "knowledge.article.write");
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0].args, [[10], { is_locked: false }]);
  assert.deepEqual(writes[1].args, [[10], { body: "<p>Updated</p>" }]);

  const trashedKw = makeExecuteKw({
    "knowledge.article.read": () => [
      {
        id: 50,
        name: "Trashed",
        active: false,
        to_delete: true,
        user_has_write_access: true,
      },
    ],
  });
  const restored = await makeTools(trashedKw).handlers.odoo_update_knowledge_article({
    article_id: 50,
    restore: true,
  });
  assert.ok(
    trashedKw.calls.some((c) => c.key === "knowledge.article.action_unarchive"),
  );
  assert.equal(structuredContent(restored).restored, true);
});

test("odoo_delete_knowledge_article previews, sends to trash on confirm, and is idempotent", async () => {
  const executeKw = makeExecuteKw({
    "knowledge.article.read": (_args, _kwargs, calls) => {
      const isTrashed = calls.some(
        (c) => c.key === "knowledge.article.action_send_to_trash",
      );
      return [
        {
          id: 497,
          name: "mcp-mysql",
          category: "workspace",
          active: !isTrashed,
          to_delete: isTrashed,
          deletion_date: isTrashed ? "2026-12-13" : false,
          child_ids: [500],
          is_locked: false,
          user_has_write_access: true,
          article_url: "https://odoo.solunika.com/knowledge/article/497",
        },
      ];
    },
  });
  const { handlers } = makeTools(executeKw);

  const preview = await handlers.odoo_delete_knowledge_article({
    article_id: 497,
    confirm: false,
  });
  assert.equal(structuredContent(preview).status, "preview");
  assert.equal(structuredContent(preview).child_count, 1);
  assert.equal(
    executeKw.calls.some((c) => c.key === "knowledge.article.action_send_to_trash"),
    false,
  );

  const trashed = await handlers.odoo_delete_knowledge_article({
    article_id: 497,
    confirm: true,
  });
  assert.equal(
    executeKw.calls.some((c) => c.key === "knowledge.article.action_send_to_trash"),
    true,
  );
  assert.equal(structuredContent(trashed).status, "trashed");
  assert.equal(record(trashed.structuredContent).deletion_date, "2026-12-13");

  const alreadyTrashed = await handlers.odoo_delete_knowledge_article({
    article_id: 497,
    confirm: true,
  });
  assert.equal(structuredContent(alreadyTrashed).status, "already_trashed");
});

test("odoo_get_knowledge_articles rejects invalid category or offset and handles empty", async () => {
  const emptyKw = makeExecuteKw({
    "knowledge.article.search_count": () => 0,
    "knowledge.article.search_read": () => [],
  });
  const { handlers } = makeTools(emptyKw);
  await assert.rejects(
    handlers.odoo_get_knowledge_articles({ category: "invalid" }),
    /Invalid category/,
  );
  await assert.rejects(
    handlers.odoo_get_knowledge_articles({ offset: -1 }),
    /offset must be a nonnegative integer/,
  );
  const empty = await handlers.odoo_get_knowledge_articles({});
  assert.equal(textContent(empty), "No results");
  assert.equal(structuredContent(empty).has_more, false);
});

test("odoo_get_knowledge_article handles missing article and redact_secrets=false / include_children=false", async () => {
  const missingKw = makeExecuteKw({ "knowledge.article.read": () => [] });
  const missing = await makeTools(missingKw).handlers.odoo_get_knowledge_article({
    article_id: 9999,
  });
  assert.equal(textContent(missing), "Article not found");
  assert.equal(structuredContent(missing).found, false);

  const kw = makeExecuteKw({
    "knowledge.article.read": () => [
      {
        id: 479,
        name: "Doc",
        child_ids: [497],
        user_has_access: true,
        body: "<p>token=raw-value</p>",
      },
    ],
  });
  const unredacted = await makeTools(kw).handlers.odoo_get_knowledge_article({
    article_id: 479,
    redact_secrets: false,
    include_children: false,
  });
  assert.match(textContent(unredacted), /token=raw-value/);
  assert.equal(
    kw.calls.some((c) => c.key === "knowledge.article.search_read"),
    false,
  );
});

test("odoo_create_knowledge_article validates inputs, trashed parent, and tolerates verification failure", async () => {
  const { handlers } = makeTools(makeExecuteKw());
  await assert.rejects(
    handlers.odoo_create_knowledge_article({ name: "   " }),
    /name must be a nonblank string/,
  );
  await assert.rejects(
    handlers.odoo_create_knowledge_article({ name: "Ok", body: 123 }),
    /body must be a string/,
  );
  await assert.rejects(
    handlers.odoo_create_knowledge_article({
      name: "Ok",
      internal_permission: "admin",
    }),
    /Invalid internal_permission/,
  );

  const trashedParentKw = makeExecuteKw({
    "knowledge.article.read": () => [
      { id: 10, active: false, to_delete: true, user_has_write_access: true },
    ],
  });
  await assert.rejects(
    makeTools(trashedParentKw).handlers.odoo_create_knowledge_article({
      name: "Child",
      parent_id: 10,
    }),
    /is in Trash/,
  );

  const verifyFailKw = makeExecuteKw({
    "knowledge.article.read": () => {
      throw new Error("Verification read failed");
    },
  });
  const created = await makeTools(verifyFailKw).handlers.odoo_create_knowledge_article({
    name: "Root",
    full_width: true,
    sequence: 5,
  });
  assert.equal(structuredContent(created).created, true);
  assert.equal(structuredContent(created).verified, false);
  assert.equal(structuredContent(created).verification_error, "Verification read failed");
});

test("odoo_update_knowledge_article validates permissions, parent cycle, and clearing fields", async () => {
  const readonlyKw = makeExecuteKw({
    "knowledge.article.read": () => [
      { id: 10, name: "Readonly", user_has_write_access: false },
    ],
  });
  await assert.rejects(
    makeTools(readonlyKw).handlers.odoo_update_knowledge_article({
      article_id: 10,
      name: "New",
    }),
    /do not have write access/,
  );

  const { handlers } = makeTools(makeExecuteKw());
  await assert.rejects(
    handlers.odoo_update_knowledge_article({ article_id: 497, parent_id: 497 }),
    /cannot be its own parent/,
  );
  const noop = await handlers.odoo_update_knowledge_article({ article_id: 497 });
  assert.equal(textContent(noop), "Nothing to update");

  const clearKw = makeExecuteKw();
  await makeTools(clearKw).handlers.odoo_update_knowledge_article({
    article_id: 497,
    parent_id: null,
    icon: null,
  });
  const writeCall = required(
    clearKw.calls.find((c) => c.key === "knowledge.article.write"),
  );
  assert.deepEqual(writeCall.args, [[497], { icon: false, parent_id: false }]);
});

test("odoo_delete_knowledge_article rejects locked or readonly articles", async () => {
  const lockedKw = makeExecuteKw({
    "knowledge.article.read": () => [
      { id: 10, name: "Locked", active: true, is_locked: true, user_has_write_access: true },
    ],
  });
  await assert.rejects(
    makeTools(lockedKw).handlers.odoo_delete_knowledge_article({
      article_id: 10,
      confirm: true,
    }),
    /is locked/,
  );

  const readonlyKw = makeExecuteKw({
    "knowledge.article.read": () => [
      { id: 10, name: "Readonly", active: true, is_locked: false, user_has_write_access: false },
    ],
  });
  await assert.rejects(
    makeTools(readonlyKw).handlers.odoo_delete_knowledge_article({
      article_id: 10,
      confirm: true,
    }),
    /do not have write access/,
  );
});

test("odoo_update_knowledge_article supports append_body, prepend_body, and replace_text", async () => {
  const appendKw = makeExecuteKw({
    "knowledge.article.read": () => [
      { id: 497, name: "Doc", body: "<p>Initial</p>", user_has_write_access: true },
    ],
  });
  await makeTools(appendKw).handlers.odoo_update_knowledge_article({
    article_id: 497,
    append_body: "Appended line",
  });
  const appendWrite = required(
    appendKw.calls.find((c) => c.key === "knowledge.article.write"),
  );
  assert.deepEqual(appendWrite.args, [[497], { body: "<p>Initial</p><p>Appended line</p>" }]);

  const prependKw = makeExecuteKw({
    "knowledge.article.read": () => [
      { id: 497, name: "Doc", body: "<p>Initial</p>", user_has_write_access: true },
    ],
  });
  await makeTools(prependKw).handlers.odoo_update_knowledge_article({
    article_id: 497,
    prepend_body: "<h1>Header</h1>",
  });
  const prependWrite = required(
    prependKw.calls.find((c) => c.key === "knowledge.article.write"),
  );
  assert.deepEqual(prependWrite.args, [[497], { body: "<h1>Header</h1><p>Initial</p>" }]);

  const replaceKw = makeExecuteKw({
    "knowledge.article.read": () => [
      { id: 497, name: "Doc", body: "<p>foo and foo</p>", user_has_write_access: true },
    ],
  });
  await assert.rejects(
    makeTools(replaceKw).handlers.odoo_update_knowledge_article({
      article_id: 497,
      replace_text: { find: "foo", replace: "bar" },
    }),
    /Found 2 occurrences/,
  );
  await makeTools(replaceKw).handlers.odoo_update_knowledge_article({
    article_id: 497,
    replace_text: { find: "foo", replace: "bar", replace_all: true },
  });
  const replaceWrite = required(
    replaceKw.calls.find((c) => c.key === "knowledge.article.write"),
  );
  assert.deepEqual(replaceWrite.args, [[497], { body: "<p>bar and bar</p>" }]);

  await assert.rejects(
    makeTools(replaceKw).handlers.odoo_update_knowledge_article({
      article_id: 497,
      body: "<p>x</p>",
      append_body: "y",
    }),
    /Only one body edit mode/,
  );
});

test("odoo_create_knowledge_article and update support favorites, publishing, items, stages, and properties", async () => {
  const executeKw = makeExecuteKw();
  const { handlers } = makeTools(executeKw);

  await assert.rejects(
    handlers.odoo_create_knowledge_article({ name: "Item", is_article_item: true }),
    /requires parent_id/,
  );

  await handlers.odoo_create_knowledge_article({
    name: "Release v51",
    parent_id: 142,
    is_article_item: true,
    stage_id: 10,
    article_properties: { deadline: "2026-12-01" },
    is_published: true,
    is_favorite: true,
  });
  const createCall = required(
    executeKw.calls.find((c) => c.key === "knowledge.article.create"),
  );
  assert.deepEqual(createCall.args[0], {
    name: "Release v51",
    parent_id: 142,
    is_article_item: true,
    stage_id: 10,
    article_properties: { deadline: "2026-12-01" },
    is_published: true,
  });
  assert.ok(
    executeKw.calls.some((c) => c.key === "knowledge.article.action_toggle_favorite"),
  );

  const noPublishKw = makeExecuteKw({
    "knowledge.article.read": () => [
      { id: 10, name: "Doc", user_has_write_access: true, can_publish: false },
    ],
  });
  await assert.rejects(
    makeTools(noPublishKw).handlers.odoo_update_knowledge_article({
      article_id: 10,
      is_published: true,
    }),
    /do not have permission to publish/,
  );

  const favKw = makeExecuteKw({
    "knowledge.article.read": () => [
      {
        id: 10,
        name: "Doc",
        user_has_write_access: true,
        is_user_favorite: false,
        can_publish: true,
      },
    ],
  });
  const updated = await makeTools(favKw).handlers.odoo_update_knowledge_article({
    article_id: 10,
    is_favorite: true,
    is_published: true,
    stage_id: 11,
    article_properties: { priority: "high_priority" },
  });
  assert.equal(structuredContent(updated).favorite_toggled, true);
  assert.ok(
    favKw.calls.some((c) => c.key === "knowledge.article.action_toggle_favorite"),
  );
});

test("odoo_get_knowledge_articles supports favorites_only, items_only, and stage_id filters", async () => {
  const executeKw = makeExecuteKw();
  await makeTools(executeKw).handlers.odoo_get_knowledge_articles({
    favorites_only: true,
    items_only: true,
    stage_id: 10,
  });
  const searchRead = required(
    executeKw.calls.find((c) => c.key === "knowledge.article.search_read"),
  );
  assert.deepEqual(searchRead.args[0], [
    ["is_template", "=", false],
    ["user_has_access", "=", true],
    ["active", "=", true],
    ["is_article_item", "=", true],
    ["is_user_favorite", "=", true],
    ["stage_id", "=", 10],
  ]);
});
