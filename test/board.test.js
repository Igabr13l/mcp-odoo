import assert from "node:assert/strict";
import test from "node:test";
import { createBoardTools } from "../src/tools/board.js";

test("board keeps same-name stages separate and preserves Odoo progress percent", async () => {
  const executeKw = async (model) => {
    if (model === "project.task") {
      return [
        { id: 1, name: "A", stage_id: [10, "Review"], progress: 25 },
        { id: 2, name: "B", stage_id: [20, "Review"], progress: 75 },
      ];
    }
    if (model === "project.task.type") {
      return [
        { id: 10, name: "Review", sequence: 1, fold: false },
        { id: 20, name: "Review", sequence: 2, fold: true },
      ];
    }
    throw new Error(`Unexpected model ${model}`);
  };
  const tools = createBoardTools({
    executeKw,
    getAvailableFields: async (_model, fields) => fields,
    getNameMap: async () => new Map(),
    getUid: () => 16,
  });
  const result = await tools.handlers.odoo_get_my_board({ project_id: 7 });
  assert.equal(result.structuredContent.stages.length, 2);
  assert.deepEqual(
    result.structuredContent.stages.map((stage) => stage.stage_id),
    [10, 20],
  );
  assert.deepEqual(
    result.structuredContent.stages.map((stage) => stage.tasks[0].progress_percent),
    [25, 75],
  );
});
