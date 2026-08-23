import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function startFakeOdoo() {
  let authenticationCount = 0;
  const objectCalls = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const payload = JSON.parse(body);
      const isAuthentication = payload.params?.service === "common";
      if (isAuthentication) authenticationCount += 1;
      else objectCalls.push(payload.params?.args);
      setTimeout(() => {
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: isAuthentication ? 16 : [],
          }),
        );
      }, isAuthentication ? 50 : 0);
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    authenticationCount: () => authenticationCount,
    objectCalls: () => objectCalls,
    close: () => new Promise((resolve) => server.close(resolve)),
    url: `http://127.0.0.1:${address.port}`,
  };
}

test("concurrent tool calls authenticate a persisted session only once", async () => {
  const fakeOdoo = await startFakeOdoo();
  const directory = await mkdtemp(join(tmpdir(), "mcp-odoo-test-"));
  const sessionFile = join(directory, "session.json");
  await writeFile(
    sessionFile,
    JSON.stringify({
      url: fakeOdoo.url,
      db: "test",
      uid: null,
      login: "user@example.com",
      password: "password",
    }),
  );

  const client = new Client({ name: "session-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: ["src/index.js"],
    env: { ...process.env, ODOO_SESSION_FILE: sessionFile },
  });

  try {
    await client.connect(transport);
    const initialStatus = await client.callTool({
      name: "odoo_session_status",
      arguments: {},
    });
    assert.equal(initialStatus.structuredContent.stored, true);
    assert.equal(initialStatus.structuredContent.verified, false);
    assert.equal(fakeOdoo.authenticationCount(), 0);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        client.callTool({ name: "odoo_get_my_projects", arguments: {} }),
      ),
    );
    assert.equal(results.every((result) => result.isError !== true), true);
    const verifiedStatus = await client.callTool({
      name: "odoo_session_status",
      arguments: {},
    });
    assert.equal(verifiedStatus.structuredContent.verified, true);
    assert.equal(fakeOdoo.authenticationCount(), 1);
    const taskCall = fakeOdoo
      .objectCalls()
      .find((args) => args?.[3] === "project.task");
    assert.deepEqual(taskCall?.[5]?.[0], [["user_ids", "=", 16]]);
  } finally {
    await client.close();
    await fakeOdoo.close();
    await rm(directory, { recursive: true, force: true });
  }
});
