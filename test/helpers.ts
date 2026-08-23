import assert from "node:assert/strict";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function required<T>(
  value: T | null | undefined,
  message = "Expected value to be present",
): T {
  assert.ok(value !== null && value !== undefined, message);
  return value;
}

export function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

export function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

export function structuredContent<T extends Record<string, unknown>>(
  result: unknown,
): T {
  return record(record(result).structuredContent) as T;
}

export function textContent(
  result: { content: CallToolResult["content"] },
  index = 0,
): string {
  const content = required(result.content[index]);
  assert.equal(content.type, "text");
  return content.text;
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve: Deferred<T>["resolve"] | undefined;
  let reject: Deferred<T>["reject"] | undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    promise,
    resolve: required(resolve),
    reject: required(reject),
  };
}
