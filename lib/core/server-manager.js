/**
 * Server manager: the reliability core of the adapter.
 *
 * It owns the lifecycle of every MCP connection and enforces the rules that keep
 * DSH stable no matter how a server misbehaves:
 *
 *   - **Lazy connect.** A server is spawned/contacted only on first use, so four
 *     configured servers cost nothing until a tool from one is actually called.
 *   - **Single-flight connect.** Concurrent callers racing to use the same
 *     server share one connection attempt; there is never a spawn storm.
 *   - **Circuit breaker.** Repeated connection failures open a breaker with
 *     exponential backoff, so a down server (Burp closed, Falcon not installed)
 *     fails fast with a clear message instead of hammering a dead endpoint.
 *   - **Reconnect on stale session.** An HTTP 404 / closed stdio pipe transparently
 *     reconnects once and retries the call.
 *   - **Idle teardown.** A connection unused past its idle timeout is closed to
 *     release the child process, then transparently re-established on next use.
 *   - **Total isolation.** Every failure is caught and returned as a value; a
 *     server crash can never propagate an unhandled rejection into DSH.
 *
 * @module dsh-mcp-adapter/core/server-manager
 */

import { StdioTransport } from '../transport/stdio.js';
import { HttpTransport } from '../transport/http.js';

/** Backoff schedule (ms) applied after consecutive connect failures. */
const BACKOFF_MS = [0, 1_000, 5_000, 15_000, 30_000, 60_000];

/** Failures before the breaker opens. */
const BREAKER_THRESHOLD = 3;

/**
 * Manages connections to all configured MCP servers.
 */
export class ServerManager {
  /**
   * @param {object} options - `{ servers, defaultRequestTimeoutMs, defaultIdleTimeoutMs, warn, onCatalog }`.
   */
  constructor(options = {}) {
    this._servers = new Map(Object.entries(options.servers ?? {}));
    this._defaultRequestTimeoutMs = options.defaultRequestTimeoutMs ?? 60_000;
    this._defaultIdleTimeoutMs = options.defaultIdleTimeoutMs ?? 5 * 60_000;
    this._warn = options.warn ?? (() => {});
    this._onCatalog = options.onCatalog; // (server, tools) => void, called after a successful list

    /** @type {Map<string, object>} live connections by server name */
    this._conns = new Map();
    /** @type {Map<string, Promise<object>>} in-flight connect attempts (single-flight) */
    this._connecting = new Map();
    /** @type {Map<string, {failures: number, openUntil: number}>} circuit breaker state */
    this._breakers = new Map();
    this._stopped = false;

    // A single periodic sweep tears down idle connections. Unref'd so it never
    // keeps the process alive on its own.
    this._sweepTimer = setInterval(() => this._sweepIdle(), 30_000);
    if (typeof this._sweepTimer.unref === 'function') this._sweepTimer.unref();
  }

  /**
   * Replace the server definition set (e.g. after a config reload).
   * @param {Record<string, object>} servers - normalized definitions.
   */
  setServers(servers) {
    this._servers = new Map(Object.entries(servers ?? {}));
    // Drop connections/breakers for servers that no longer exist.
    for (const name of [...this._conns.keys()]) {
      if (!this._servers.has(name)) this._disconnect(name, 'removed from config');
    }
    for (const name of [...this._breakers.keys()]) {
      if (!this._servers.has(name)) this._breakers.delete(name);
    }
  }

  /**
   * Get a definition by name.
   * @param {string} name - server name.
   * @returns {object | undefined} definition.
   */
  getDefinition(name) {
    return this._servers.get(name);
  }

  /** @returns {string[]} configured, non-disabled server names. */
  get serverNames() {
    return [...this._servers.entries()].filter(([, d]) => !d.disabled).map(([n]) => n);
  }

  /**
   * List a server's tools, connecting if needed. Refreshes the catalog cache.
   *
   * @param {string} name - server name.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<object[]>} the raw MCP tool descriptors.
   */
  async listTools(name, signal) {
    const conn = await this._ensureConnected(name, signal);
    const result = await this._call(conn, 'tools/list', undefined, signal);
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    conn.tools = tools;
    conn.lastUsedAt = Date.now();
    try {
      this._onCatalog?.(name, tools);
    } catch {
      // Catalog listener faults must not fail a list.
    }
    return tools;
  }

  /**
   * Call a tool on a server, connecting if needed, with one transparent
   * reconnect on a stale session.
   *
   * @param {string} name - server name.
   * @param {string} toolName - the tool to call.
   * @param {object} args - tool arguments.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<object>} the raw MCP call result.
   */
  async callTool(name, toolName, args, signal) {
    let conn = await this._ensureConnected(name, signal);
    try {
      const result = await this._call(conn, 'tools/call', { name: toolName, arguments: args ?? {} }, signal);
      conn.lastUsedAt = Date.now();
      return result;
    } catch (error) {
      // A stale session or dropped pipe gets exactly one transparent retry on a
      // fresh connection. Anything else propagates as a clean error value.
      if (isReconnectable(error) && !this._stopped) {
        this._warn(`mcp: "${name}" connection was stale (${error.code}); reconnecting once`);
        this._disconnect(name, 'stale connection');
        conn = await this._ensureConnected(name, signal);
        const result = await this._call(conn, 'tools/call', { name: toolName, arguments: args ?? {} }, signal);
        conn.lastUsedAt = Date.now();
        return result;
      }
      throw error;
    }
  }

  /**
   * Ensure a live connection to a server, honoring the circuit breaker and
   * single-flight rules.
   * @param {string} name - server name.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<object>} the live connection.
   */
  async _ensureConnected(name, signal) {
    if (this._stopped) throw errorWith('adapter is shutting down', 'MCP_CLOSED');
    const definition = this._servers.get(name);
    if (!definition) throw errorWith(`no MCP server named "${name}" is configured`, 'MCP_NO_SERVER');
    if (definition.disabled) throw errorWith(`MCP server "${name}" is disabled`, 'MCP_DISABLED');

    const existing = this._conns.get(name);
    if (existing && !existing.transport.closed) return existing;

    // Circuit breaker: fail fast while open.
    const breaker = this._breakers.get(name);
    if (breaker && breaker.openUntil > Date.now()) {
      const seconds = Math.ceil((breaker.openUntil - Date.now()) / 1000);
      throw errorWith(
        `MCP server "${name}" is temporarily unavailable after ${breaker.failures} failed attempts; retrying in ~${seconds}s`,
        'MCP_CIRCUIT_OPEN',
      );
    }

    // Single-flight: share one in-flight attempt.
    const inFlight = this._connecting.get(name);
    if (inFlight) return inFlight;

    const attempt = this._connect(name, definition, signal).then(
      (conn) => {
        this._connecting.delete(name);
        // If the manager was stopped while this connect was in flight, the child
        // it just spawned is not in `_conns` and stop() could not have killed it.
        // Reap it here so a shutdown mid-connect never orphans a process.
        if (this._stopped) {
          conn.transport.stop().catch(() => {});
          throw errorWith('adapter is shutting down', 'MCP_CLOSED');
        }
        this._breakers.delete(name); // success clears the breaker
        this._conns.set(name, conn);
        return conn;
      },
      (error) => {
        this._connecting.delete(name);
        this._recordFailure(name);
        throw error;
      },
    );
    this._connecting.set(name, attempt);
    return attempt;
  }

  /**
   * Establish and initialize a new connection.
   * @param {string} name - server name.
   * @param {object} definition - normalized definition.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<object>} the connection.
   */
  async _connect(name, definition, signal) {
    const requestTimeoutMs = definition.requestTimeoutMs ?? this._defaultRequestTimeoutMs;
    let transport;
    let rpc;

    if (definition.transport === 'stdio') {
      transport = new StdioTransport({
        command: definition.command,
        args: definition.args,
        env: definition.env,
        cwd: definition.cwd,
        defaultTimeoutMs: requestTimeoutMs,
        warn: this._warn,
        onClose: () => this._onTransportClose(name),
        onStderr: () => {},
      });
      await transport.start();
      rpc = transport.rpc;
    } else {
      transport = new HttpTransport({
        url: definition.url,
        headers: definition.headers,
        defaultTimeoutMs: requestTimeoutMs,
        warn: this._warn,
      });
      await transport.start();
      // The HTTP transport IS its own request surface.
      rpc = { request: (m, p, o) => transport.request(m, p, o), notify: (m, p) => transport.notify(m, p) };
    }

    // MCP handshake with a bounded timeout.
    const initTimeout = Math.min(requestTimeoutMs, 30_000);
    try {
      await rpc.request(
        'initialize',
        {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'dsh-mcp-adapter', version: '1.0.0' },
        },
        { timeoutMs: initTimeout, signal },
      );
      rpc.notify('notifications/initialized');
    } catch (error) {
      await transport.stop();
      throw errorWith(`MCP server "${name}" failed to initialize: ${error.message}`, error.code ?? 'MCP_INIT_FAILED');
    }

    return {
      name,
      definition,
      transport,
      rpc,
      tools: undefined,
      lastUsedAt: Date.now(),
      idleTimeoutMs: definition.idleTimeoutMs ?? this._defaultIdleTimeoutMs,
    };
  }

  /**
   * Issue a request on a connection, translating transport errors.
   * @param {object} conn - the connection.
   * @param {string} method - JSON-RPC method.
   * @param {object} [params] - params.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<unknown>} the result.
   */
  async _call(conn, method, params, signal) {
    const timeoutMs = conn.definition.requestTimeoutMs ?? this._defaultRequestTimeoutMs;
    return conn.rpc.request(method, params, { timeoutMs, signal });
  }

  /**
   * Handle a transport that closed on its own (server crash, pipe break).
   * @param {string} name - server name.
   */
  _onTransportClose(name) {
    const conn = this._conns.get(name);
    if (conn && conn.transport.closed) {
      this._conns.delete(name);
      // Not counted as a connect failure: it connected fine, then the server
      // went away. The next call will attempt a fresh connect and only THEN
      // feed the breaker if that also fails.
    }
  }

  /**
   * Record a connect failure and open the breaker past the threshold.
   * @param {string} name - server name.
   */
  _recordFailure(name) {
    const breaker = this._breakers.get(name) ?? { failures: 0, openUntil: 0 };
    breaker.failures += 1;
    if (breaker.failures >= BREAKER_THRESHOLD) {
      const step = Math.min(breaker.failures - BREAKER_THRESHOLD + 1, BACKOFF_MS.length - 1);
      breaker.openUntil = Date.now() + BACKOFF_MS[step];
    }
    this._breakers.set(name, breaker);
  }

  /**
   * Tear down a connection immediately.
   * @param {string} name - server name.
   * @param {string} reason - why.
   */
  _disconnect(name, reason) {
    const conn = this._conns.get(name);
    if (!conn) return;
    this._conns.delete(name);
    conn.transport.stop().catch(() => {});
    this._warn?.(`mcp: disconnected "${name}" (${reason})`);
  }

  /** Close connections idle past their timeout. */
  _sweepIdle() {
    const now = Date.now();
    for (const [name, conn] of [...this._conns]) {
      if (conn.transport.closed) {
        this._conns.delete(name);
        continue;
      }
      if (now - conn.lastUsedAt > conn.idleTimeoutMs) {
        this._disconnect(name, 'idle timeout');
      }
    }
  }

  /**
   * Shut down: stop the sweep and close every connection. Idempotent.
   * @returns {Promise<void>}
   */
  async stop() {
    if (this._stopped) return;
    this._stopped = true;
    clearInterval(this._sweepTimer);
    const closes = [...this._conns.values()].map((conn) => conn.transport.stop().catch(() => {}));
    this._conns.clear();
    await Promise.allSettled(closes);
  }

  /**
   * Status snapshot for the `/mcp` command and diagnostics.
   * @returns {object[]} per-server status rows.
   */
  status() {
    const rows = [];
    for (const [name, definition] of this._servers) {
      const conn = this._conns.get(name);
      const breaker = this._breakers.get(name);
      rows.push({
        name,
        transport: definition.transport,
        disabled: Boolean(definition.disabled),
        connected: Boolean(conn && !conn.transport.closed),
        toolCount: conn?.tools?.length,
        breakerOpen: Boolean(breaker && breaker.openUntil > Date.now()),
        failures: breaker?.failures ?? 0,
      });
    }
    return rows;
  }
}

/**
 * Whether an error means "reconnect and retry once".
 * @param {Error & {code?: string}} error - the error.
 * @returns {boolean} true if reconnectable.
 */
function isReconnectable(error) {
  return error?.code === 'MCP_SESSION_EXPIRED' || error?.code === 'MCP_CLOSED';
}

/**
 * Build an Error with a stable code.
 * @param {string} message - message.
 * @param {string} code - error code.
 * @returns {Error} the error.
 */
function errorWith(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
