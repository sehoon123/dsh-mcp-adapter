/**
 * @deepseek-ai/dsh-mcp-adapter — context-cheap MCP access for DeepSeek Harness.
 *
 * Instead of the stock one-plugin-per-server model that dumps every MCP tool
 * schema into the prompt, this plugin registers a SINGLE `mcp` proxy tool
 * (~200 tokens) that the model uses to search, describe, and call tools across
 * all configured servers on demand. Servers connect lazily and reconnect
 * automatically, and frequently-used tools can be promoted to first-class DSH
 * tools via `directTools` for zero-latency access.
 *
 * Design priority, in order: (1) never crash DSH, (2) minimize context, (3)
 * stay zero-dependency (only Node built-ins, so the package resolves in every
 * profile/npx tree). Every server fault is caught and returned as a value.
 *
 * @module dsh-mcp-adapter
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

import { loadConfig, normalizeServer } from './core/config.js';
import { MetadataCache } from './core/cache.js';
import { ServerManager } from './core/server-manager.js';
import { registerProxyTools } from './tools/proxy.js';

/** Plugin name, matched by cordis. */
export const name = 'mcp-adapter';

/**
 * Services this plugin needs before `apply` runs.
 *
 * Declaring them here is the proven pattern used by the harness's own
 * `dsh-tool-web`: cordis defers `apply` until every listed service exists, so
 * `ctx.tools` and `ctx.systemPrompt` are guaranteed present and tool
 * registration happens at exactly the right moment. An earlier version used a
 * nested `ctx.inject(...)` fiber, which mounted but never activated in a plain
 * profile, so the `mcp` tool silently never appeared. This is the fix.
 *
 * A profile that mounts no tools registry simply will not load this plugin —
 * which is correct, since there would be nowhere to put the tool.
 */
export const inject = ['tools', 'systemPrompt'];

/** Resolved default configuration. */
export const DEFAULT_CONFIG = Object.freeze({
  // Inline server definitions (same shape as mcp.json `mcpServers`), merged
  // UNDER any on-disk mcp.json so files can override them.
  servers: undefined,
  // Also read standard mcp.json files (Claude/Cursor/pi layout). Set false to
  // use only inline `servers`.
  readConfigFiles: true,
  // Extra explicit config paths to read (highest precedence, in order).
  extraConfigPaths: undefined,
  // Per-request timeout for MCP calls.
  requestTimeoutMs: 60_000,
  // Idle connections are torn down after this long unused.
  idleTimeoutMs: 5 * 60_000,
  // Tool-execution budget for the proxy tool itself.
  toolTimeoutMs: 120_000,
  // Output guard thresholds.
  maxOutputBytes: 50 * 1024,
  maxOutputLines: 2_000,
  // Register the `mcp` proxy tool.
  proxy: true,
});

/**
 * Validate and merge raw config with defaults.
 * @param {object} raw - user config.
 * @returns {object} resolved config.
 */
export function resolveConfig(raw = {}) {
  const config = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (value !== undefined) config[key] = value;
  }
  for (const key of ['requestTimeoutMs', 'idleTimeoutMs', 'toolTimeoutMs', 'maxOutputBytes', 'maxOutputLines']) {
    if (!(Number.isFinite(config[key]) && config[key] > 0)) {
      throw new Error(`dsh-mcp-adapter: ${key} must be a positive number`);
    }
  }
  return config;
}

/**
 * Plugin entry. Cordis awaits this, so tool registration completes before the
 * first turn.
 *
 * @param {object} ctx - the cordis plugin context.
 * @param {object} rawConfig - user configuration.
 * @returns {Promise<void>}
 */
export async function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig);
  const logger = ctx.logger;
  const warn = (msg) => logger?.warn?.(`mcp-adapter: ${msg}`);

  // 1. Load and merge server definitions. A bad config file is skipped, not fatal.
  const { servers, sources } = config.readConfigFiles
    ? loadConfig({ warn, inlineServers: config.servers, extraPaths: config.extraConfigPaths })
    : { servers: normalizeInlineOnly(config.servers, warn), sources: ['(inline only)'] };

  const serverCount = Object.keys(servers).length;
  if (serverCount === 0) {
    logger?.info?.('mcp-adapter: no MCP servers configured; the mcp tool will report an empty server list');
  } else {
    logger?.info?.(`mcp-adapter: ${serverCount} MCP server(s) from ${sources.join(', ') || 'config'}`);
  }

  // 2. Metadata cache (offline search) + server manager (connections).
  const cache = new MetadataCache({ warn });
  cache.load();

  const manager = new ServerManager({
    servers,
    defaultRequestTimeoutMs: config.requestTimeoutMs,
    defaultIdleTimeoutMs: config.idleTimeoutMs,
    warn,
    // Whenever a server's live catalog is fetched, refresh the offline cache.
    onCatalog: (server, tools) => {
      try {
        cache.update(server, tools);
      } catch (error) {
        warn(`cache update for "${server}" failed: ${error.message}`);
      }
    },
  });

  const runtime = { manager, cache, config, warn };

  // 3. Register the proxy tool (+ any directTools promoted from cache). `apply`
  //    only runs once `tools` and `systemPrompt` exist (see `inject` above), so
  //    `ctx.tools` is guaranteed here — the same contract dsh-tool-web relies on.
  if (config.proxy !== false) {
    // Warm the cache for servers with directTools configured but no cached
    // catalog yet, so their tools can be promoted on this boot. Best-effort and
    // time-boxed: a down server must not delay or break startup.
    await warmDirectToolServers(manager, cache, warn);

    const { directCount } = registerProxyTools(ctx, runtime, defineTool);
    logger?.info?.(`mcp-adapter: registered the mcp proxy tool${directCount ? ` + ${directCount} direct tool(s)` : ''}`);
  }

  // 4. Clean shutdown: stop the manager (kills child processes) when the plugin
  //    is disposed.
  ctx.effect?.(() => async () => {
    await manager.stop();
  }, 'mcp-adapter: stop server manager');
}

/**
 * Warm the catalog cache for servers configured with directTools.
 *
 * Only these servers need an eager catalog (to promote their direct tools);
 * every other server stays fully lazy. Each warm-up is time-boxed and its
 * failure is swallowed so a down server cannot delay or break boot.
 *
 * @param {object} manager - ServerManager.
 * @param {object} cache - MetadataCache.
 * @param {(msg: string) => void} warn - warning sink.
 * @returns {Promise<void>}
 */
async function warmDirectToolServers(manager, cache, warn) {
  const targets = manager.serverNames.filter((name) => {
    const selection = manager.getDefinition(name)?.directTools;
    return selection === true || (Array.isArray(selection) && selection.length > 0);
  });
  if (targets.length === 0) return;

  await Promise.allSettled(
    targets.map(async (name) => {
      // A per-server abort keeps a slow server from stalling startup; the cached
      // catalog (if any) is still used for promotion on the next boot.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8_000);
      if (typeof timer.unref === 'function') timer.unref();
      try {
        await manager.listTools(name, controller.signal);
      } catch (error) {
        warn(`could not warm directTools for "${name}" (${error?.code ?? error?.message}); it will connect on first use`);
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}

/**
 * Normalize inline-only server definitions when file reading is disabled.
 * @param {object} inline - inline server map.
 * @param {(msg: string) => void} warn - warning sink.
 * @returns {Record<string, object>} normalized servers.
 */
function normalizeInlineOnly(inline, warn) {
  if (!inline || typeof inline !== 'object') return {};
  /** @type {Record<string, object>} */
  const servers = {};
  for (const [serverName, raw] of Object.entries(inline)) {
    const normalized = normalizeServer(serverName, raw, warn);
    if (normalized) servers[serverName] = normalized;
  }
  return servers;
}
