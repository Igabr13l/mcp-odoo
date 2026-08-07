import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { hasValue } from "../utils/format.js";

const DEFAULT_TIMEOUT_MS = 15000;

function requestTimeout(value) {
  return Math.max(1000, Math.min(120000, Number(value) || DEFAULT_TIMEOUT_MS));
}

export function createOdooClient({ env = process.env, fetchImpl = fetch } = {}) {
  const sessionFile =
    env.ODOO_SESSION_FILE ||
    `${env.HOME || ""}/.config/mcp-odoo/session.json`;
  const timeoutMs = requestTimeout(env.ODOO_REQUEST_TIMEOUT_MS);
  const state = {
    url: env.ODOO_URL,
    db: env.ODOO_DB,
    uid: null,
    login: null,
    password: null,
    name: null,
    sessionLoaded: false,
  };
  const fieldAvailabilityCache = new Map();
  const selectionCache = new Map();
  let authenticationPromise = null;
  let sessionLoadPromise = null;
  let sessionGeneration = 0;

  function clearMetadataCaches() {
    fieldAvailabilityCache.clear();
    selectionCache.clear();
  }

  async function postJsonRpc(url, payload) {
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
        throw new Error(`Odoo HTTP ${response.status} ${response.statusText}`);
      }
      try {
        return await response.json();
      } catch {
        throw new Error("Odoo returned an invalid JSON response");
      }
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error(`Odoo request timed out after ${timeoutMs}ms`);
      }
      if (error?.message?.startsWith("Odoo ")) throw error;
      const cause = error?.cause?.code || error?.cause?.message;
      throw new Error(
        `Odoo network error: ${error?.message || String(error)}${cause ? ` (${cause})` : ""}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async function callJsonRpc(payload) {
    const data = await postJsonRpc(state.url, payload);
    if (data.error) {
      throw new Error(
        data.error.data?.message || data.error.message || "Odoo Server Error",
      );
    }
    return data.result;
  }

  async function savePersistedSession(generation) {
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
          const parsed = JSON.parse(await readFile(sessionFile, "utf8"));
          if (!parsed?.login || !parsed?.password) return;
          state.url = parsed.url || state.url;
          state.db = parsed.db || state.db;
          state.uid = parsed.uid || null;
          state.login = parsed.login;
          state.password = parsed.password;
          state.name = parsed.name || null;
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
  }

  async function logout() {
    sessionGeneration += 1;
    clearInMemorySession();
    await rm(sessionFile, { force: true });
  }

  async function commonAuthenticate(url, db, login, password) {
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
      throw new Error(
        data.error.data?.message || data.error.message || "Odoo auth error",
      );
    }
    return data.result || null;
  }

  async function ensureAuthenticated() {
    await loadPersistedSession();
    if (state.uid && state.login && state.password) return;
    if (!state.login || !state.password) {
      throw new Error("Not authenticated. Run odoo_login first.");
    }
    if (!authenticationPromise) {
      const generation = sessionGeneration;
      authenticationPromise = (async () => {
        const uid = await commonAuthenticate(
          state.url,
          state.db,
          state.login,
          state.password,
        );
        if (generation !== sessionGeneration) {
          throw new Error("Authentication was cancelled by logout");
        }
        if (!uid) {
          await logout();
          throw new Error("Stored session is no longer valid. Run odoo_login.");
        }
        state.uid = uid;
      })().finally(() => {
        authenticationPromise = null;
      });
    }
    await authenticationPromise;
  }

  async function executeKw(model, method, args = [], kwargs = {}) {
    await ensureAuthenticated();
    return callJsonRpc({
      jsonrpc: "2.0",
      method: "call",
      params: {
        service: "object",
        method: "execute_kw",
        args: [state.db, state.uid, state.password, model, method, args, kwargs],
      },
      id: Date.now(),
    });
  }

  async function authenticate({ url, db, login, password, remember = true }) {
    await loadPersistedSession();
    const generation = sessionGeneration;
    const nextUrl = url ? url.replace(/\/$/, "") : state.url;
    const nextDb = db || state.db;
    if (!nextUrl || !nextDb) throw new Error("Odoo URL and database are required");
    const uid = await commonAuthenticate(nextUrl, nextDb, login, password);
    if (generation !== sessionGeneration) {
      throw new Error("Authentication was cancelled by logout");
    }
    if (!uid) throw new Error("Authentication failed");

    clearMetadataCaches();
    Object.assign(state, {
      url: nextUrl,
      db: nextDb,
      login,
      password,
      uid,
    });
    const users = await executeKw("res.users", "read", [[uid], ["name", "login"]]);
    state.name = users?.[0]?.name || login;
    if (generation !== sessionGeneration) {
      throw new Error("Authentication was cancelled by logout");
    }
    if (remember !== false) await savePersistedSession(generation);
    return { uid, name: state.name, login: users?.[0]?.login || login };
  }

  async function getSession() {
    await loadPersistedSession();
    return {
      active: Boolean(state.uid && state.login && state.password),
      stored: Boolean(state.login && state.password),
      uid: state.uid,
      login: state.login,
      name: state.name,
      db: state.db,
      url: state.url,
    };
  }

  async function getAvailableFields(model, fieldNames) {
    const names = fieldNames.filter(Boolean);
    const missing = names.filter(
      (fieldName) => !fieldAvailabilityCache.has(`${model}:${fieldName}`),
    );
    if (missing.length) {
      const metadata = await executeKw(model, "fields_get", [missing], {
        attributes: ["type"],
      });
      for (const fieldName of missing) {
        fieldAvailabilityCache.set(
          `${model}:${fieldName}`,
          Boolean(metadata?.[fieldName]),
        );
      }
    }
    return names.filter((name) => fieldAvailabilityCache.get(`${model}:${name}`));
  }

  async function getSelectionLabelMap(model, fieldName) {
    const key = `${model}:${fieldName}:selection`;
    if (selectionCache.has(key)) return selectionCache.get(key);
    const metadata = await executeKw(model, "fields_get", [[fieldName]], {
      attributes: ["selection"],
    });
    const map = new Map(metadata?.[fieldName]?.selection || []);
    selectionCache.set(key, map);
    return map;
  }

  async function getNameMap(model, ids) {
    const cleanIds = [
      ...new Set(
        (ids || []).map(Number).filter((id) => Number.isInteger(id) && id > 0),
      ),
    ];
    if (!cleanIds.length) return new Map();
    const rows = await executeKw(model, "read", [cleanIds, ["name"]]);
    return new Map(
      (rows || [])
        .filter((row) => row?.id && hasValue(row?.name))
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
