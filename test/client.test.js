import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createOdooClient } from "../src/odoo/client.js";

test("logout invalidates an authentication already in flight", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-odoo-client-"));
  const sessionFile = join(directory, "session.json");
  await writeFile(
    sessionFile,
    JSON.stringify({
      url: "https://odoo.example",
      db: "test",
      uid: null,
      login: "user@example.com",
      password: "password",
    }),
  );
  let resolveResponse;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const fetchImpl = async () => {
    markStarted();
    return {
      ok: true,
      json: () => new Promise((resolve) => {
        resolveResponse = resolve;
      }),
    };
  };
  const client = createOdooClient({
    env: { ODOO_SESSION_FILE: sessionFile },
    fetchImpl,
  });

  try {
    const authentication = client.ensureAuthenticated();
    await started;
    await client.logout();
    resolveResponse({ result: 16 });
    await assert.rejects(authentication, /cancelled by logout/);
    const session = await client.getSession();
    assert.equal(session.active, false);
    assert.equal(session.stored, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
