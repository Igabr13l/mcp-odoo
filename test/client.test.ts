import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createOdooClient,
  OdooRequestError,
  type FetchImplementation,
  type FetchResponse,
  type OdooClient,
} from "../src/odoo/client.js";
import { deferred } from "./helpers.js";

async function withStoredClient(
  fetchImpl: FetchImplementation,
  callback: (client: OdooClient) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "mcp-odoo-client-"));
  const sessionFile = join(directory, "session.json");
  await writeFile(
    sessionFile,
    JSON.stringify({
      url: "https://odoo.example",
      db: "test",
      uid: 16,
      login: "user@example.com",
      password: "secret-password",
    }),
  );
  const client = createOdooClient({
    env: { ODOO_SESSION_FILE: sessionFile },
    fetchImpl,
    retryBackoffMs: 0,
  });
  try {
    await callback(client);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function jsonResponse(body: unknown): FetchResponse {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
  };
}

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
  const response = deferred<unknown>();
  const started = deferred<void>();
  const fetchImpl = async () => {
    started.resolve();
    return {
      ok: true,
      json: () => response.promise,
    };
  };
  const client = createOdooClient({
    env: { ODOO_SESSION_FILE: sessionFile },
    fetchImpl,
  });

  try {
    const authentication = client.ensureAuthenticated();
    await started.promise;
    await client.logout();
    response.resolve({ result: 16 });
    await assert.rejects(authentication, /cancelled by logout/);
    const session = await client.getSession();
    assert.equal(session.active, false);
    assert.equal(session.stored, false);
    assert.equal(session.verified, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persisted sessions are loaded but unverified in a new process", async () => {
  await withStoredClient(async () => {
    assert.fail("session status should not authenticate");
  }, async (client) => {
    const session = await client.getSession();
    assert.equal(session.active, true);
    assert.equal(session.stored, true);
    assert.equal(session.verified, false);
  });
});

test("successful executeKw verifies a persisted session", async () => {
  await withStoredClient(async () => jsonResponse({ result: [] }), async (client) => {
    await client.executeKw("res.users", "read", [[16]]);
    assert.equal((await client.getSession()).verified, true);
    await client.logout();
    assert.equal((await client.getSession()).verified, false);
  });
});

test("executeKw authentication failure clears process-local verification", async () => {
  let calls = 0;
  await withStoredClient(async () => {
    calls += 1;
    if (calls === 1) return jsonResponse({ result: [] });
    return jsonResponse({
      error: {
        data: {
          name: "odoo.exceptions.AccessDenied",
          message: "Session expired",
        },
      },
    });
  }, async (client) => {
    await client.executeKw("res.users", "read", [[16]]);
    assert.equal((await client.getSession()).verified, true);

    await assert.rejects(
      client.executeKw("res.users", "read", [[16]]),
      { code: "AUTHENTICATION_ERROR" },
    );
    assert.equal((await client.getSession()).verified, false);
  });
});

test("successful authentication verifies a persisted session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-odoo-client-"));
  const sessionFile = join(directory, "session.json");
  await writeFile(sessionFile, JSON.stringify({
    url: "https://odoo.example",
    db: "test",
    uid: null,
    login: "user@example.com",
    password: "password",
  }));
  const client = createOdooClient({
    env: { ODOO_SESSION_FILE: sessionFile },
    fetchImpl: async () => jsonResponse({ result: 16 }),
  });

  try {
    await client.ensureAuthenticated();
    assert.equal((await client.getSession()).verified, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("explicit login verifies the session", async () => {
  let calls = 0;
  const client = createOdooClient({
    env: {
      ODOO_SESSION_FILE: join(tmpdir(), `login-${Date.now()}.json`),
      ODOO_URL: "https://odoo.example",
      ODOO_DB: "test",
    },
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({
        result: calls === 1
          ? 16
          : [{ id: 16, name: "Test User", login: "user@example.com" }],
      });
    },
  });

  await client.authenticate({
    login: "user@example.com",
    password: "password",
    remember: false,
  });
  const session = await client.getSession();
  assert.equal(session.active, true);
  assert.equal(session.verified, true);
});

test("read-only executeKw retries a retryable network failure exactly once", async () => {
  let calls = 0;
  await withStoredClient(async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("connection reset");
    return jsonResponse({ result: [{ id: 1 }] });
  }, async (client) => {
    const result = await client.executeKw("res.users", "read", [[1]]);
    assert.deepEqual(result, [{ id: 1 }]);
    assert.equal(calls, 2);
  });
});

test("read-only executeKw retries a timeout exactly once", async () => {
  let calls = 0;
  await withStoredClient(async () => {
    calls += 1;
    if (calls === 1) {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }
    return jsonResponse({ result: 3 });
  }, async (client) => {
    assert.equal(await client.executeKw("res.users", "search_count"), 3);
    assert.equal(calls, 2);
  });
});

test("mutating executeKw is never retried and marks transport outcome uncertain", async () => {
  const methods = [
    "create",
    "write",
    "unlink",
    "message_post",
    "create_branch",
    "create_merge_request",
    "custom_action",
  ];
  for (const method of methods) {
    let calls = 0;
    await withStoredClient(async () => {
      calls += 1;
      throw new TypeError("socket closed");
    }, async (client) => {
      await assert.rejects(client.executeKw("x.model", method), (error) => {
        assert.ok(error instanceof OdooRequestError);
        assert.equal(error.code, "NETWORK_ERROR");
        assert.equal(error.retryable, true);
        assert.equal(error.outcome, "uncertain");
        assert.equal(error.verificationRequired, true);
        assert.doesNotMatch(error.message, /secret-password/);
        return true;
      });
      assert.equal(calls, 1);
    });
  }
});

test("classifies HTTP and invalid JSON responses", async () => {
  const responses: {
    response: FetchResponse;
    code: string;
    retryable: boolean;
  }[] = [
    {
      response: { ok: false, status: 503, statusText: "Unavailable" },
      code: "HTTP_ERROR",
      retryable: true,
    },
    {
      response: {
        ...jsonResponse(null),
        json: async () => {
          throw new SyntaxError();
        },
      },
      code: "INVALID_JSON",
      retryable: false,
    },
  ];
  for (const { response, code, retryable } of responses) {
    await withStoredClient(async () => response, async (client) => {
      await assert.rejects(client.executeKw("res.users", "read"), (error) => {
        assert.ok(error instanceof OdooRequestError);
        assert.equal(error.code, code);
        assert.equal(error.retryable, retryable);
        assert.equal(error.outcome, "failed");
        assert.equal(error.verificationRequired, false);
        return true;
      });
    });
  }
});

test("classifies Odoo validation, server, and authentication errors", async () => {
  const errors = [
    {
      body: {
        error: {
          data: {
            name: "odoo.exceptions.ValidationError",
            message: "Invalid value",
          },
        },
      },
      code: "ODOO_VALIDATION_ERROR",
    },
    {
      body: {
        error: {
          data: { name: "builtins.RuntimeError", message: "Server broke" },
        },
      },
      code: "ODOO_SERVER_ERROR",
    },
    {
      body: {
        error: {
          data: {
            name: "odoo.exceptions.AccessDenied",
            message: "Access denied",
          },
        },
      },
      code: "AUTHENTICATION_ERROR",
    },
  ];
  for (const { body, code } of errors) {
    await withStoredClient(async () => jsonResponse(body), async (client) => {
      await assert.rejects(client.executeKw("res.users", "read"), (error) => {
        assert.ok(error instanceof OdooRequestError);
        assert.equal(error.code, code);
        assert.equal(error.retryable, false);
        return true;
      });
    });
  }
});

test("retryable HTTP mutation failures require verification without retry", async () => {
  let calls = 0;
  await withStoredClient(async () => {
    calls += 1;
    return { ok: false, status: 503, statusText: "Unavailable" };
  }, async (client) => {
    await assert.rejects(client.executeKw("x.model", "create"), (error) => {
      assert.ok(error instanceof OdooRequestError);
      assert.equal(error.code, "HTTP_ERROR");
      assert.equal(error.retryable, true);
      assert.equal(error.outcome, "uncertain");
      assert.equal(error.verificationRequired, true);
      return true;
    });
    assert.equal(calls, 1);
  });
});

test("invalid JSON after a mutation requires verification without retry", async () => {
  let calls = 0;
  await withStoredClient(async () => {
    calls += 1;
    return {
      ...jsonResponse(null),
      json: async () => {
        throw new SyntaxError("truncated response");
      },
    };
  }, async (client) => {
    await assert.rejects(client.executeKw("x.model", "create"), (error) => {
      assert.ok(error instanceof OdooRequestError);
      assert.equal(error.code, "INVALID_JSON");
      assert.equal(error.retryable, false);
      assert.equal(error.outcome, "uncertain");
      assert.equal(error.verificationRequired, true);
      return true;
    });
    assert.equal(calls, 1);
  });
});

test("missing authentication has stable classified properties", async () => {
  const client = createOdooClient({
    env: { ODOO_SESSION_FILE: join(tmpdir(), `missing-${Date.now()}.json`) },
    fetchImpl: async () => assert.fail("fetch should not be called"),
  });
  await assert.rejects(client.executeKw("res.users", "read"), (error) => {
    assert.ok(error instanceof OdooRequestError);
    assert.equal(error.code, "AUTHENTICATION_ERROR");
    assert.equal(error.retryable, false);
    assert.equal(error.outcome, "failed");
    assert.equal(error.verificationRequired, false);
    return true;
  });
});

test("normalizes trailing slashes from ODOO_URL and persisted session URL", async () => {
  const requestedUrls: string[] = [];
  const directory = await mkdtemp(join(tmpdir(), "mcp-odoo-url-"));
  const sessionFile = join(directory, "session.json");
  await writeFile(
    sessionFile,
    JSON.stringify({
      url: "https://odoo.example///",
      db: "test",
      uid: 16,
      login: "user@example.com",
      password: "secret-password",
    }),
  );
  const client = createOdooClient({
    env: {
      ODOO_SESSION_FILE: sessionFile,
      ODOO_URL: "https://fallback.example/",
    },
    fetchImpl: async (url) => {
      requestedUrls.push(url);
      return jsonResponse({ result: [] });
    },
  });
  try {
    await client.executeKw("res.users", "read", [[16]]);
    assert.deepEqual(requestedUrls, ["https://odoo.example/jsonrpc"]);
    assert.equal((await client.getSession()).url, "https://odoo.example");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
