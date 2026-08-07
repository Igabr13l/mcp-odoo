import assert from "node:assert/strict";
import test from "node:test";
import { createGitLabTools } from "../src/tools/gitlab.js";

function makeFakeOdoo(stubs = {}) {
  const calls = [];
  const executeKw = async (model, method, args = [], kwargs = {}) => {
    calls.push({ model, method, args, kwargs });
    const stub = stubs[`${model}.${method}`];
    if (!stub) throw new Error(`No stub for ${model}.${method}`);
    return stub({ args, kwargs });
  };
  return { executeKw, calls, stubs };
}

function taskBranchStubs(taskId, taskName, branchIds, branchRows) {
  const branchById = new Map(branchRows.map((branch) => [branch.id, branch]));
  return {
    "project.task.read": () => [
      { id: taskId, name: taskName, gitlab_branch_ids: branchIds },
    ],
    "gitlab.task.branch.read": ({ args }) =>
      (Array.isArray(args[0]) ? args[0] : [args[0]])
        .map((id) => branchById.get(Number(id)))
        .filter(Boolean),
  };
}

function makeBranchRow(id, overrides = {}) {
  return {
    id,
    gitlab_origin_project_id: [3, "hubeet/backend"],
    gitlab_branch_name: "odoo/123-feature",
    from_branch: "uat",
    target_branch: "uat",
    gitlab_link: null,
    merge_request_link: null,
    gitlab_user_id: [16, "Gabriel"],
    ...overrides,
  };
}

test("definitions expose all GitLab tools with preserved schemas", async (t) => {
  const { definitions } = createGitLabTools({
    executeKw: async () => [],
    getUid: () => 16,
  });
  assert.deepEqual(
    definitions.map((definition) => definition.name),
    [
      "odoo_get_task_gitlab_branches",
      "odoo_gitlab_list_projects",
      "odoo_gitlab_list_users",
      "odoo_gitlab_add_task_branch",
      "odoo_gitlab_create_branch",
      "odoo_gitlab_create_merge_request",
    ],
  );
  const addBranch = definitions.find(
    (definition) => definition.name === "odoo_gitlab_add_task_branch",
  );
  assert.deepEqual(addBranch.inputSchema.required, [
    "task_id",
    "gitlab_project_id",
    "confirm",
  ]);
  const createBranch = definitions.find(
    (definition) => definition.name === "odoo_gitlab_create_branch",
  );
  assert.deepEqual(createBranch.inputSchema.required, [
    "gitlab_task_branch_id",
    "confirm",
  ]);
});

test("odoo_get_task_gitlab_branches formats linked branches with a single read", async (t) => {
  const branchRows = [
    makeBranchRow(11, {
      gitlab_branch_name: "odoo/123-feature",
      gitlab_link: "https://gitlab.example/repo/-/tree/odoo/123-feature",
      merge_request_link: "https://gitlab.example/repo/-/merge_requests/4",
    }),
  ];
  const fake = makeFakeOdoo(taskBranchStubs(123, "Feature X", [11], branchRows));
  const { handlers } = createGitLabTools({
    executeKw: fake.executeKw,
    getUid: () => 16,
  });
  const result = await handlers.odoo_get_task_gitlab_branches({ task_id: 123 });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /\[11\] hubeet\/backend/);
  assert.match(result.content[0].text, /branch: odoo\/123-feature/);
  assert.match(result.content[0].text, /author: Gabriel/);
  assert.match(result.content[0].text, /from -> target: uat -> uat/);

  const branchReads = fake.calls.filter(
    (call) =>
      call.model === "gitlab.task.branch" && call.method === "read",
  );
  assert.equal(branchReads.length, 1);
});

test("odoo_get_task_gitlab_branches reports missing task and empty branches", async (t) => {
  const notFound = makeFakeOdoo({
    "project.task.read": () => [],
  });
  const { handlers: notFoundHandlers } = createGitLabTools({
    executeKw: notFound.executeKw,
    getUid: () => 16,
  });
  assert.match(
    (await notFoundHandlers.odoo_get_task_gitlab_branches({ task_id: 123 }))
      .content[0].text,
    /Task not found/,
  );

  const empty = makeFakeOdoo(taskBranchStubs(123, "Feature X", [], []));
  const { handlers: emptyHandlers } = createGitLabTools({
    executeKw: empty.executeKw,
    getUid: () => 16,
  });
  assert.match(
    (await emptyHandlers.odoo_get_task_gitlab_branches({ task_id: 123 }))
      .content[0].text,
    /No GitLab branches linked to this task/,
  );
});

test("odoo_gitlab_list_projects and list_users use name_search with normalized limits", async (t) => {
  const fake = makeFakeOdoo({
    "gitlab.project.name_search": () => [
      [3, "hubeet/backend"],
      [7, "hubeet/frontend"],
    ],
  });
  const { handlers } = createGitLabTools({
    executeKw: fake.executeKw,
    getUid: () => 16,
  });

  const defaultLimit = await handlers.odoo_gitlab_list_projects({
    query: "hubeet",
  });
  assert.match(defaultLimit.content[0].text, /\[3\] hubeet\/backend/);
  assert.deepEqual(fake.calls[0].args, ["hubeet", [], "ilike", 20]);

  const customLimit = await handlers.odoo_gitlab_list_projects({
    query: "hubeet",
    limit: 5,
  });
  assert.deepEqual(fake.calls[1].args, ["hubeet", [], "ilike", 5]);

  const usersFake = makeFakeOdoo({
    "res.users.name_search": () => [[16, "Gabriel"]],
  });
  const { handlers: usersHandlers } = createGitLabTools({
    executeKw: usersFake.executeKw,
    getUid: () => 16,
  });
  const users = await usersHandlers.odoo_gitlab_list_users({
    query: "gab",
    limit: 3,
  });
  assert.match(users.content[0].text, /\[16\] Gabriel/);
  assert.deepEqual(usersFake.calls[0].args, ["gab", [], "ilike", 3]);
});

test("odoo_gitlab_add_task_branch requires confirm, defaults reviewer and branch name", async (t) => {
  const fake = makeFakeOdoo({
    ...taskBranchStubs(123, "Feature X", [], []),
    "gitlab.task.branch.create": () => 41,
    "gitlab.task.branch.read": () => [
      makeBranchRow(41, { gitlab_branch_name: "odoo/123-feature-x" }),
    ],
  });
  const { handlers } = createGitLabTools({
    executeKw: fake.executeKw,
    getUid: () => 16,
  });

  const preview = await handlers.odoo_gitlab_add_task_branch({
    task_id: 123,
    gitlab_project_id: 3,
  });
  assert.match(preview.content[0].text, /Preview only; no row created/);
  assert.match(preview.content[0].text, /branch: odoo\/123-feature-x/);
  assert.equal(fake.calls.some((call) => call.method === "create"), false);

  const created = await handlers.odoo_gitlab_add_task_branch({
    task_id: 123,
    gitlab_project_id: 3,
    confirm: true,
  });
  assert.match(created.content[0].text, /GitLab task branch row created: 41/);
  assert.match(created.content[0].text, /reviewer: Gabriel/);

  const createCall = fake.calls.find((call) => call.method === "create");
  assert.equal(createCall.args[0].task_id, 123);
  assert.equal(createCall.args[0].gitlab_origin_project_id, 3);
  assert.equal(createCall.args[0].gitlab_user_id, 16);
});

test("odoo_gitlab_add_task_branch is idempotent for an existing matching row", async (t) => {
  const branchRows = [
    makeBranchRow(11, {
      gitlab_branch_name: "odoo/123-feature-x",
      gitlab_link: "https://gitlab.example/repo/-/tree/odoo/123-feature-x",
    }),
  ];
  const fake = makeFakeOdoo(taskBranchStubs(123, "Feature X", [11], branchRows));
  const { handlers } = createGitLabTools({
    executeKw: fake.executeKw,
    getUid: () => 16,
  });
  const result = await handlers.odoo_gitlab_add_task_branch({
    task_id: 123,
    gitlab_project_id: 3,
    confirm: true,
  });
  assert.match(result.content[0].text, /GitLab task branch row already exists: 11/);
  assert.match(result.content[0].text, /https:\/\/gitlab.example\/repo\/-\/tree\/odoo\/123-feature-x/);
  assert.equal(fake.calls.some((call) => call.method === "create"), false);
});

test("odoo_gitlab_create_branch is idempotent and requires confirm", async (t) => {
  const recorded = makeFakeOdoo({
    "gitlab.task.branch.read": () => [
      makeBranchRow(7, {
        gitlab_link: "https://gitlab.example/repo/-/tree/odoo/123-feature",
      }),
    ],
  });
  const { handlers: recordedHandlers } = createGitLabTools({
    executeKw: recorded.executeKw,
    getUid: () => 16,
  });
  const recordedResult = await recordedHandlers.odoo_gitlab_create_branch({
    gitlab_task_branch_id: 7,
    confirm: true,
  });
  assert.match(recordedResult.content[0].text, /Branch already recorded/);
  assert.equal(
    recorded.calls.some((call) => call.method === "create_branch"),
    false,
  );

  const previewFake = makeFakeOdoo({
    "gitlab.task.branch.read": () => [makeBranchRow(7)],
  });
  const { handlers: previewHandlers } = createGitLabTools({
    executeKw: previewFake.executeKw,
    getUid: () => 16,
  });
  const preview = await previewHandlers.odoo_gitlab_create_branch({
    gitlab_task_branch_id: 7,
  });
  assert.match(preview.content[0].text, /Preview only; no branch created/);
  assert.match(preview.content[0].text, /branch_name: odoo\/123-feature/);
  assert.equal(
    previewFake.calls.some((call) => call.method === "create_branch"),
    false,
  );
});

test("odoo_gitlab_create_branch retries with a suffix on collision and keeps the rename on success", async (t) => {
  const row = makeBranchRow(7);
  let branchCalls = 0;
  const fake = makeFakeOdoo({
    "gitlab.task.branch.read": () => [row],
    "gitlab.task.branch.write": ({ args }) => {
      Object.assign(row, args[1]);
      return true;
    },
    "gitlab.task.branch.create_branch": () => {
      branchCalls += 1;
      if (branchCalls === 1) {
        throw new Error("GitLab API Error: Branch already exists");
      }
      row.gitlab_link =
        "https://gitlab.example/repo/-/tree/odoo/123-feature-2";
      return true;
    },
  });
  const { handlers } = createGitLabTools({
    executeKw: fake.executeKw,
    getUid: () => 16,
  });
  const result = await handlers.odoo_gitlab_create_branch({
    gitlab_task_branch_id: 7,
    confirm: true,
  });
  assert.match(result.content[0].text, /retry_count: 1/);
  assert.match(result.content[0].text, /renamed_on_conflict: true/);
  assert.match(
    result.content[0].text,
    /gitlab_link: https:\/\/gitlab.example\/repo\/-\/tree\/odoo\/123-feature-2/,
  );
  assert.equal(row.gitlab_branch_name, "odoo/123-feature-2");

  const writes = fake.calls.filter((call) => call.method === "write");
  assert.deepEqual(
    writes.map((call) => call.args[1].gitlab_branch_name),
    ["odoo/123-feature-2"],
  );
});

test("odoo_gitlab_create_branch restores the original name on terminal collision", async (t) => {
  const row = makeBranchRow(7);
  const fake = makeFakeOdoo({
    "gitlab.task.branch.read": () => [row],
    "gitlab.task.branch.write": ({ args }) => {
      Object.assign(row, args[1]);
      return true;
    },
    "gitlab.task.branch.create_branch": () => {
      throw new Error("GitLab API Error: Branch already exists");
    },
  });
  const { handlers } = createGitLabTools({
    executeKw: fake.executeKw,
    getUid: () => 16,
  });
  await assert.rejects(
    () =>
      handlers.odoo_gitlab_create_branch({
        gitlab_task_branch_id: 7,
        confirm: true,
      }),
    /name collision/,
  );
  assert.equal(row.gitlab_branch_name, "odoo/123-feature");

  const writes = fake.calls.filter((call) => call.method === "write");
  assert.equal(writes.length, 8);
  assert.equal(
    writes[writes.length - 1].args[1].gitlab_branch_name,
    "odoo/123-feature",
  );
});

test("odoo_gitlab_create_merge_request guards, confirms and reports the result", async (t) => {
  const missingLink = makeFakeOdoo({
    "gitlab.task.branch.read": () => [makeBranchRow(7)],
  });
  const { handlers: missingLinkHandlers } = createGitLabTools({
    executeKw: missingLink.executeKw,
    getUid: () => 16,
  });
  await assert.rejects(
    () =>
      missingLinkHandlers.odoo_gitlab_create_merge_request({
        gitlab_task_branch_id: 7,
        confirm: true,
      }),
    /Create the GitLab branch before creating a merge request/,
  );

  const row = makeBranchRow(7, {
    gitlab_link: "https://gitlab.example/repo/-/tree/odoo/123-feature",
  });
  const fake = makeFakeOdoo({
    "gitlab.task.branch.read": () => [row],
    "gitlab.task.branch.create_merge_request": () => {
      row.merge_request_link =
        "https://gitlab.example/repo/-/merge_requests/9";
      return true;
    },
  });
  const { handlers } = createGitLabTools({
    executeKw: fake.executeKw,
    getUid: () => 16,
  });

  const preview = await handlers.odoo_gitlab_create_merge_request({
    gitlab_task_branch_id: 7,
  });
  assert.match(preview.content[0].text, /Preview only; no merge request created/);
  assert.equal(
    fake.calls.some((call) => call.method === "create_merge_request"),
    false,
  );

  const created = await handlers.odoo_gitlab_create_merge_request({
    gitlab_task_branch_id: 7,
    confirm: true,
  });
  assert.match(created.content[0].text, /create_merge_request result: true/);
  assert.match(
    created.content[0].text,
    /merge_request_link: https:\/\/gitlab.example\/repo\/-\/merge_requests\/9/,
  );

  const again = await handlers.odoo_gitlab_create_merge_request({
    gitlab_task_branch_id: 7,
    confirm: true,
  });
  assert.match(again.content[0].text, /Merge request already recorded/);
});
