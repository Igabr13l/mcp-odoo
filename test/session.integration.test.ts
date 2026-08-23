import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { array, structuredContent } from "./helpers.js";

interface JsonRpcRequest {
  id: unknown;
  params?: {
    service?: unknown;
    args?: unknown[];
  };
}

interface SessionStatusContent extends Record<string, unknown> {
  stored: boolean;
  verified: boolean;
}

async function startFakeOdoo() {
  let authenticationCount = 0;
  const objectCalls: unknown[][] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const payload = JSON.parse(body) as JsonRpcRequest;
      const isAuthentication = payload.params?.service === "common";
      if (isAuthentication) authenticationCount += 1;
      else if (payload.params?.args) objectCalls.push(payload.params.args);
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

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fake Odoo server did not expose a TCP address");
  }
  return {
    authenticationCount: () => authenticationCount,
    objectCalls: () => objectCalls,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
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
    args: ["dist/src/index.js"],
    env: { ...process.env, ODOO_SESSION_FILE: sessionFile },
  });

  try {
    await client.connect(transport);
    const initialStatus = await client.callTool({
      name: "odoo_session_status",
      arguments: {},
    });
    const initialSession = structuredContent<SessionStatusContent>(initialStatus);
    assert.equal(initialSession.stored, true);
    assert.equal(initialSession.verified, false);
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
    const verifiedSession = structuredContent<SessionStatusContent>(verifiedStatus);
    assert.equal(verifiedSession.verified, true);
    assert.equal(fakeOdoo.authenticationCount(), 1);
    const taskCall = fakeOdoo
      .objectCalls()
      .find((args) => args?.[3] === "project.task");
    const taskArguments = array(taskCall?.[5]);
    assert.deepEqual(taskArguments[0], [["user_ids", "=", 16]]);
  } finally {
    await client.close();
    await fakeOdoo.close();
    await rm(directory, { recursive: true, force: true });
  }
});
