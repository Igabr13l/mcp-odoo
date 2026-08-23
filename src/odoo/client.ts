import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ExecuteKwImplementation,
  GetAvailableFields,
  GetNameMap,
  GetSelectionLabelMap,
  OdooArguments,
  OdooKeywordArguments,
  OdooRecord,
} from "../contracts.js";
import { errorMessage, isRecord } from "../contracts.js";
import { hasValue } from "../utils/format.js";

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_RETRY_BACKOFF_MS = 100;
const READ_ONLY_METHODS = new Set([
  "check_access_rights",
  "check_access_rule",
  "fields_get",
  "get_metadata",
  "get_view",
  "get_views",
  "name_get",
  "name_search",
  "read",
  "read_group",
  "search",
  "search_count",
  "search_fetch",
  "search_read",
  "web_read",
  "web_search_read",
]);

export class OdooRequestError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  outcome: string;
  verificationRequired: boolean;

  constructor(
    message: string,
    {
      code,
      retryable = false,
      outcome = "failed",
      verificationRequired = false,
    }: {
      code: string;
      retryable?: boolean;
      outcome?: string;
      verificationRequired?: boolean;
    },
  ) {
    super(message);
    this.name = "OdooRequestError";
    this.code = code;
    this.retryable = retryable;
    this.outcome = outcome;
    this.verificationRequired = verificationRequired;
  }
}

function requestTimeout(value: unknown): number {
  return Math.max(1000, Math.min(120000, Number(value) || DEFAULT_TIMEOUT_MS));
}

function retryBackoff(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_RETRY_BACKOFF_MS;
}

interface JsonRpcErrorResponse {
  error: {
    message?: string;
    data?: { message?: string; name?: string; exception_type?: string };
  };
  result?: unknown;
}

interface JsonRpcSuccessResponse {
  error?: undefined;
  result?: unknown;
}

type JsonRpcResponse = JsonRpcErrorResponse | JsonRpcSuccessResponse;

function rpcError(data: JsonRpcErrorResponse, fallback: string): OdooRequestError {
  const message = data.error.data?.message || data.error.message || fallback;
  const type = `${data.error.data?.name || ""} ${data.error.data?.exception_type || ""}`;
  if (/accessdenied|authentication|sessionexpired/i.test(`${type} ${message}`)) {
    return new OdooRequestError(message, { code: "AUTHENTICATION_ERROR" });
  }
  if (/validationerror|usererror|warning/i.test(type)) {
    return new OdooRequestError(message, { code: "ODOO_VALIDATION_ERROR" });
  }
  return new OdooRequestError(message, { code: "ODOO_SERVER_ERROR" });
}

function sleep(ms: number): Promise<void> {
  return ms ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export interface FetchResponse {
  ok: boolean;
  status?: number;
  statusText?: string;
  type?: string;
  json?: () => Promise<unknown>;
}

export type FetchImplementation = (
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    redirect?: RequestRedirect;
  },
) => Promise<FetchResponse>;

export interface OdooSession {
  [key: string]: unknown;
  active: boolean;
  stored: boolean;
  verified: boolean;
  uid: number | null;
  login: string | null;
  name: string | null;
  db: string | undefined;
  url: string | undefined;
}

export interface AuthenticateArguments {
  url?: string;
  db?: string;
  login: string;
  password: string;
  remember?: boolean;
}

export interface OdooClient {
  authenticate(args: AuthenticateArguments): Promise<{
    uid: number;
    name: string;
    login: string;
  }>;
  ensureAuthenticated(): Promise<void>;
  executeKw: {
    <T = unknown>(
      model: string,
      method: string,
      args?: OdooArguments,
      kwargs?: OdooKeywordArguments,
    ): Promise<T>;
  };
  getAvailableFields: GetAvailableFields;
  getNameMap: GetNameMap;
  getSelectionLabelMap: GetSelectionLabelMap;
  getSession(): Promise<OdooSession>;
  getUid(): number | null;
  logout(): Promise<void>;
}

export function createOdooClient({
  env = process.env,
  fetchImpl = fetch,
  retryBackoffMs,
}: {
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchImplementation;
  retryBackoffMs?: number;
} = {}): OdooClient {
  const sessionFile =
    env.ODOO_SESSION_FILE ||
    `${env.HOME || ""}/.config/mcp-odoo/session.json`;
  const timeoutMs = requestTimeout(env.ODOO_REQUEST_TIMEOUT_MS);
  const executeRetryBackoffMs = retryBackoff(
    retryBackoffMs ?? env.ODOO_RETRY_BACKOFF_MS,
  );
  const state: {
    url: string | undefined;
    db: string | undefined;
    uid: number | null;
    login: string | null;
    password: string | null;
    name: string | null;
    verified: boolean;
    sessionLoaded: boolean;
  } = {
    url: env.ODOO_URL,
    db: env.ODOO_DB,
    uid: null,
    login: null,
    password: null,
    name: null,
    verified: false,
    sessionLoaded: false,
  };
  const fieldAvailabilityCache = new Map<string, boolean>();
  const selectionCache = new Map<string, Map<unknown, string>>();
  let authenticationPromise: Promise<void> | null = null;
  let sessionLoadPromise: Promise<void> | null = null;
  let sessionGeneration = 0;

  function clearMetadataCaches() {
    fieldAvailabilityCache.clear();
    selectionCache.clear();
  }

  async function postJsonRpc(
    url: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${url}/jsonrpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new OdooRequestError(
          `Odoo HTTP ${response.status} ${response.statusText}`,
          {
            code: "HTTP_ERROR",
            retryable:
              (response.status !== undefined && response.status >= 500) ||
              response.status === 429,
          },
        );
      }
      try {
        if (!response.json) throw new SyntaxError("Missing JSON reader");
        return (await response.json()) as JsonRpcResponse;
      } catch {
        throw new OdooRequestError("Odoo returned an invalid JSON response", {
          code: "INVALID_JSON",
        });
      }
    } catch (error) {
      if (isRecord(error) && error.name === "AbortError") {
        throw new OdooRequestError(
          `Odoo request timed out after ${timeoutMs}ms`,
          { code: "TIMEOUT", retryable: true },
        );
      }
      if (error instanceof OdooRequestError) throw error;
      const causeObject = isRecord(error) && isRecord(error.cause)
        ? error.cause
        : null;
      const cause = causeObject?.code || causeObject?.message;
      throw new OdooRequestError(
        `Odoo network error: ${errorMessage(error)}${cause ? ` (${String(cause)})` : ""}`,
        { code: "NETWORK_ERROR", retryable: true },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async function callJsonRpc<T>(payload: Record<string, unknown>): Promise<T> {
    const data = await postJsonRpc(state.url, payload);
    if (data.error) {
      throw rpcError(data, "Odoo Server Error");
    }
    return data.result as T;
  }

  async function savePersistedSession(generation: number): Promise<void> {
    await mkdir(dirname(sessionFile), { recursive: true, mode: 0o700 });
    const payload = {
      url: state.url,
      db: state.db,
      uid: state.uid,
      login: state.login,
      password: state.password,
      name: state.name,
      saved_at: Date.now(),
    };
    await writeFile(sessionFile, JSON.stringify(payload, null, 2), {
      mode: 0o600,
    });
    await chmod(sessionFile, 0o600);
    if (generation !== sessionGeneration) {
      await rm(sessionFile, { force: true });
      throw new Error("Authentication was cancelled by logout");
    }
  }

  async function loadPersistedSession() {
    if (state.sessionLoaded) return;
    if (!sessionLoadPromise) {
      sessionLoadPromise = (async () => {
        try {
          const parsed = JSON.parse(
            await readFile(sessionFile, "utf8"),
          ) as Partial<typeof state>;
          if (!parsed?.login || !parsed?.password) return;
          state.url = parsed.url || state.url;
          state.db = parsed.db || state.db;
          state.uid = parsed.uid || null;
          state.login = parsed.login;
          state.password = parsed.password;
          state.name = parsed.name || null;
          state.verified = false;
        } catch {
          // A missing or malformed session is equivalent to no saved session.
        } finally {
          state.sessionLoaded = true;
        }
      })().finally(() => {
        sessionLoadPromise = null;
      });
    }
    await sessionLoadPromise;
  }

  function clearInMemorySession() {
    clearMetadataCaches();
    state.uid = null;
    state.login = null;
    state.password = null;
    state.name = null;
    state.verified = false;
  }

  async function logout() {
    sessionGeneration += 1;
    clearInMemorySession();
    await rm(sessionFile, { force: true });
  }

  async function commonAuthenticate(
    url: string,
    db: string,
    login: string,
    password: string,
  ): Promise<number | null> {
    const data = await postJsonRpc(url, {
      jsonrpc: "2.0",
      method: "call",
      params: {
        service: "common",
        method: "authenticate",
        args: [db, login, password, {}],
      },
      id: Date.now(),
    });
    if (data.error) {
      throw rpcError(data, "Odoo auth error");
    }
    return (data.result as number | null) || null;
  }

  async function ensureAuthenticated() {
    await loadPersistedSession();
    if (state.uid && state.login && state.password) return;
    if (!state.login || !state.password) {
      throw new OdooRequestError("Not authenticated. Run odoo_login first.", {
        code: "AUTHENTICATION_ERROR",
      });
    }
    if (!authenticationPromise) {
      const generation = sessionGeneration;
      const { url, db, login, password } = state;
      authenticationPromise = (async () => {
        const uid = await commonAuthenticate(
          url!,
          db!,
          login,
          password,
        );
        if (generation !== sessionGeneration) {
          throw new Error("Authentication was cancelled by logout");
        }
        if (!uid) {
          await logout();
          throw new OdooRequestError(
            "Stored session is no longer valid. Run odoo_login.",
            { code: "AUTHENTICATION_ERROR" },
          );
        }
        state.uid = uid;
        state.verified = true;
      })().finally(() => {
        authenticationPromise = null;
      });
    }
    await authenticationPromise;
  }

  async function executeKw<T = unknown>(
    model: string,
    method: string,
    args: OdooArguments = [],
    kwargs: OdooKeywordArguments = {},
  ): Promise<T> {
    try {
      await ensureAuthenticated();
      const generation = sessionGeneration;
      const readOnly = READ_ONLY_METHODS.has(method);
      const payload = {
        jsonrpc: "2.0",
        method: "call",
        params: {
          service: "object",
          method: "execute_kw",
          args: [state.db, state.uid, state.password, model, method, args, kwargs],
        },
        id: Date.now(),
      };
      try {
        const result = await callJsonRpc<T>(payload);
        if (generation === sessionGeneration) state.verified = true;
        return result;
      } catch (error) {
        if (!(error instanceof OdooRequestError)) throw error;
        const transportFailure =
          error.code === "NETWORK_ERROR" || error.code === "TIMEOUT";
        if (readOnly && transportFailure && error.retryable) {
          await sleep(executeRetryBackoffMs);
          const result = await callJsonRpc<T>(payload);
          if (generation === sessionGeneration) state.verified = true;
          return result;
        }
        const uncertainTransportFailure =
          transportFailure ||
          error.code === "HTTP_ERROR" ||
          error.code === "INVALID_JSON";
        if (
          !readOnly &&
          uncertainTransportFailure &&
          (error.retryable || error.code === "INVALID_JSON")
        ) {
          error.outcome = "uncertain";
          error.verificationRequired = true;
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof OdooRequestError && error.code === "AUTHENTICATION_ERROR") {
        state.verified = false;
      }
      throw error;
    }
  }

  async function authenticate({
    url,
    db,
    login,
    password,
    remember = true,
  }: AuthenticateArguments) {
    await loadPersistedSession();
    const generation = sessionGeneration;
    const nextUrl = url ? url.replace(/\/$/, "") : state.url;
    const nextDb = db || state.db;
    if (!nextUrl || !nextDb) throw new Error("Odoo URL and database are required");
    const uid = await commonAuthenticate(nextUrl, nextDb, login, password);
    if (generation !== sessionGeneration) {
      throw new Error("Authentication was cancelled by logout");
    }
    if (!uid) {
      throw new OdooRequestError("Authentication failed", {
        code: "AUTHENTICATION_ERROR",
      });
    }

    clearMetadataCaches();
    Object.assign(state, {
      url: nextUrl,
      db: nextDb,
      login,
      password,
      uid,
      verified: true,
    });
    const users = await executeKw<OdooRecord[]>("res.users", "read", [
      [uid],
      ["name", "login"],
    ]);
    state.name = users?.[0]?.name || login;
    if (generation !== sessionGeneration) {
      throw new Error("Authentication was cancelled by logout");
    }
    if (remember !== false) await savePersistedSession(generation);
    return {
      uid,
      name: state.name,
      login: users?.[0]?.login || login,
    } as { uid: number; name: string; login: string };
  }

  async function getSession() {
    await loadPersistedSession();
    return {
      active: Boolean(state.uid && state.login && state.password),
      stored: Boolean(state.login && state.password),
      verified: state.verified,
      uid: state.uid,
      login: state.login,
      name: state.name,
      db: state.db,
      url: state.url,
    };
  }

  async function getAvailableFields(
    model: string,
    fieldNames: string[],
  ): Promise<string[]> {
    const names = fieldNames.filter(Boolean);
    const missing = names.filter(
      (fieldName) => !fieldAvailabilityCache.has(`${model}:${fieldName}`),
    );
    if (missing.length) {
      const metadata = await executeKw<Record<string, unknown>>(
        model,
        "fields_get",
        [missing],
        { attributes: ["type"] },
      );
      for (const fieldName of missing) {
        fieldAvailabilityCache.set(
          `${model}:${fieldName}`,
          Boolean(metadata?.[fieldName]),
        );
      }
    }
    return names.filter((name) => fieldAvailabilityCache.get(`${model}:${name}`));
  }

  async function getSelectionLabelMap(
    model: string,
    fieldName: string,
  ): Promise<Map<unknown, string>> {
    const key = `${model}:${fieldName}:selection`;
    if (selectionCache.has(key)) return selectionCache.get(key)!;
    const metadata = await executeKw<
      Record<string, { selection?: [unknown, string][] }>
    >(model, "fields_get", [[fieldName]], {
      attributes: ["selection"],
    });
    const map = new Map<unknown, string>(
      metadata?.[fieldName]?.selection || [],
    );
    selectionCache.set(key, map);
    return map;
  }

  async function getNameMap(
    model: string,
    ids: number[],
  ): Promise<Map<number, string>> {
    const cleanIds = [
      ...new Set(
        (ids || []).map(Number).filter((id) => Number.isInteger(id) && id > 0),
      ),
    ];
    if (!cleanIds.length) return new Map();
    const rows = await executeKw<OdooRecord[]>(model, "read", [
      cleanIds,
      ["name"],
    ]);
    return new Map(
      (rows || [])
        .filter(
          (row): row is OdooRecord & { id: number; name: string } =>
            Boolean(row?.id) && typeof row?.name === "string" && hasValue(row.name),
        )
        .map((row) => [row.id, row.name]),
    );
  }

  return {
    authenticate,
    ensureAuthenticated,
    executeKw,
    getAvailableFields,
    getNameMap,
    getSelectionLabelMap,
    getSession,
    getUid: () => state.uid,
    logout,
  };
}
