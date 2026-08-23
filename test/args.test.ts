import assert from "node:assert/strict";
import test from "node:test";
import { normalizeLimit, positiveInt } from "../src/utils/args.js";

test("normalizeLimit applies defaults, floors, and clamps", () => {
  assert.equal(normalizeLimit(undefined), 100);
  assert.equal(normalizeLimit("12.9"), 12);
  assert.equal(normalizeLimit(1000, { fallback: 20, maximum: 50 }), 50);
  assert.equal(normalizeLimit("invalid", { fallback: 20 }), 20);
});

test("positiveInt validates and labels ids", () => {
  assert.equal(positiveInt("12", "task_id"), 12);
  assert.throws(() => positiveInt(0, { label: "task_id" }), /task_id/);
  assert.throws(() => positiveInt(1.5), /positive integer/);
});
