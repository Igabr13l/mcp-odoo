import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createOdooClient } from "../src/odoo/client.js";
import { createSessionTools } from "../src/tools/session.js";

test("session status distinguishes loaded credentials from verification", async () => {
  const session = {
    active: true,
    stored: true,
    verified: false,
    uid: 16,
    login: "user@example.com",
    name: "Test User",
    db: "test",
    url: "https://odoo.example",
  };
  const tools = createSessionTools({ getSession: async () => session });

  const result = await tools.handlers.odoo_session_status();

  assert.match(result.content[0].text, /active=true stored=true verified=false/);
  assert.deepEqual(result.structuredContent, session);
});

test("whoami verifies a persisted session with a res.users read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-odoo-session-"));
  const sessionFile = join(directory, "session.json");
  await writeFile(sessionFile, JSON.stringify({
    url: "https://odoo.example",
    db: "test",
    uid: 16,
    login: "user@example.com",
    password: "password",
    name: "Stored Name",
  }));
  let requestPayload;
  const client = createOdooClient({
    env: { ODOO_SESSION_FILE: sessionFile },
    fetchImpl: async (_url, options) => {
      requestPayload = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          result: [{ id: 16, name: "Verified User", login: "user@example.com" }],
        }),
      };
    },
  });

  try {
    const result = await createSessionTools(client).handlers.odoo_whoami();

    assert.equal(requestPayload.params.service, "object");
    assert.deepEqual(requestPayload.params.args.slice(3), [
      "res.users",
      "read",
      [[16], ["name", "login"]],
      {},
    ]);
    assert.match(result.content[0].text, /Connected as Verified User/);
    assert.match(result.content[0].text, /verified=true/);
    assert.equal(result.structuredContent.verified, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
