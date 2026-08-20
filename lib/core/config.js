/**
 * Configuration loading and normalization.
 *
 * Reads MCP server definitions from standard `mcp.json` files (the same shape
 * Claude Desktop, Cursor, and pi-mcp-adapter use) plus adapter-specific options,
 * and merges them by a fixed precedence. Every step is corruption-safe: a
 * missing file is normal, and a malformed file is skipped with a warning rather
 * than throwing — a broken config on one layer must never stop DSH from booting.
 *
 * @module dsh-mcp-adapter/core/config
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Candidate config paths, lowest precedence first. A later file overrides an
 * earlier one at the per-server level, mirroring pi-mcp-adapter's precedence so
 * users can carry their existing files over unchanged.
 *
 * @param {object} env - `{ home, cwd, dshHome }`.
 * @returns {string[]} absolute candidate paths, low → high precedence.
 */
export function configSearchPaths({ home = homedir(), cwd = process.cwd(), dshHome } = {}) {
  const dsh = dshHome || process.env.DSH_HOME || join(home, '.dsh');
  return [
    join(home, '.config', 'mcp', 'mcp.json'),
    join(home, '.agents', 'mcp.json'),
    join(home, '.agents', 'mcp', 'mcp.json'),
    join(dsh, 'mcp.json'),
    join(home, '.pi', 'agent', 'mcp.json'),
    join(cwd, '.mcp.json'),
    join(cwd, '.dsh', 'mcp.json'),
  ];
}

/**
 * Read and parse one JSON file, returning undefined on any failure.
 * @param {string} path - file path.
 * @param {(msg: string) => void} warn - warning sink.
 * @returns {object | undefined} parsed object, or undefined.
 */
function readJsonSafe(path, warn) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined; // absent file is the normal case
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      warn(`mcp config at ${path} is not a JSON object; ignoring it`);
      return undefined;
    }
    return parsed;
  } catch (error) {
    // A corrupt file is skipped, not fatal.
    warn(`mcp config at ${path} is not valid JSON (${error.message}); ignoring it`);
    return undefined;
  }
}

/**
 * Normalize one raw server definition into the adapter's internal shape.
 *
 * Transport is inferred the way real configs express it: an explicit `type`
 * (`http`/`stdio`), or a `url` (→ http) versus a `command` (→ stdio).
 *
 * @param {string} name - server name (the object key).
 * @param {object} raw - raw definition.
 * @param {(msg: string) => void} warn - warning sink.
 * @returns {object | undefined} normalized definition, or undefined if invalid.
 */
export function normalizeServer(name, raw, warn) {
  if (!raw || typeof raw !== 'object') {
    warn(`mcp server "${name}" is not an object; skipping`);
    return undefined;
  }

  const declaredType = typeof raw.type === 'string' ? raw.type.toLowerCase() : undefined;
  const isHttp = declaredType === 'http' || declaredType === 'streamable-http' || declaredType === 'sse' || (!declaredType && typeof raw.url === 'string');
  const isStdio = declaredType === 'stdio' || (!declaredType && typeof raw.command === 'string');

  if (isHttp) {
    if (typeof raw.url !== 'string' || raw.url.length === 0) {
      warn(`mcp server "${name}" is http but has no url; skipping`);
      return undefined;
    }
    return {
      name,
      transport: 'http',
      url: raw.url,
      headers: sanitizeStringMap(raw.headers),
      ...commonFields(raw),
    };
  }

  if (isStdio) {
    if (typeof raw.command !== 'string' || raw.command.length === 0) {
      warn(`mcp server "${name}" is stdio but has no command; skipping`);
      return undefined;
    }
    return {
      name,
      transport: 'stdio',
      command: raw.command,
      args: Array.isArray(raw.args) ? raw.args.filter((a) => typeof a === 'string') : [],
      env: sanitizeStringMap(raw.env),
      cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
      ...commonFields(raw),
    };
  }

  warn(`mcp server "${name}" has neither url nor command; skipping`);
  return undefined;
}

/**
 * Extract adapter-specific per-server options shared by both transports.
 * @param {object} raw - raw definition.
 * @returns {object} the common option subset.
 */
function commonFields(raw) {
  return {
    disabled: raw.disabled === true,
    // directTools: true (all), false/undefined (none), or an array of names/globs.
    directTools: normalizeDirectTools(raw.directTools),
    // How long an idle connection is kept before being torn down.
    idleTimeoutMs: positiveInt(raw.idleTimeoutMs),
    // Per-request timeout override for this server.
    requestTimeoutMs: positiveInt(raw.requestTimeoutMs),
    // Extra search keywords the model can match against, keyed by tool name/glob.
    searchKeywords: raw.searchKeywords && typeof raw.searchKeywords === 'object' ? raw.searchKeywords : undefined,
  };
}

/**
 * Normalize the `directTools` option into `true`, `false`, or a string[].
 * @param {unknown} value - raw value.
 * @returns {boolean | string[]} normalized selection.
 */
function normalizeDirectTools(value) {
  if (value === true) return true;
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string');
  return false;
}

/**
 * Coerce a value into a positive integer or undefined.
 * @param {unknown} value - raw value.
 * @returns {number | undefined} the integer, or undefined.
 */
function positiveInt(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/**
 * Keep only string→string entries of a map (defends against malformed env/headers).
 * @param {unknown} value - raw map.
 * @returns {Record<string,string> | undefined} sanitized map, or undefined.
 */
function sanitizeStringMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof k === 'string' && typeof v === 'string') out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Load and merge all config layers into a normalized server map.
 *
 * @param {object} [options] - `{ home, cwd, dshHome, warn, extraPaths, inlineServers }`.
 * @returns {{servers: Record<string, object>, sources: string[]}} merged result.
 */
export function loadConfig(options = {}) {
  const warn = options.warn ?? (() => {});
  const paths = [...configSearchPaths(options), ...(options.extraPaths ?? [])];

  /** @type {Record<string, object>} raw definitions by name, last-writer-wins */
  const rawByName = {};
  const sources = [];

  // Inline servers (from the plugin's own cordis config) sit at the base layer
  // so file configs can still override them by name.
  if (options.inlineServers && typeof options.inlineServers === 'object') {
    for (const [name, raw] of Object.entries(options.inlineServers)) {
      rawByName[name] = raw;
    }
    if (Object.keys(options.inlineServers).length > 0) sources.push('(inline plugin config)');
  }

  for (const path of paths) {
    const parsed = readJsonSafe(path, warn);
    const servers = parsed?.mcpServers ?? parsed?.servers;
    if (!servers || typeof servers !== 'object') continue;
    let used = false;
    for (const [name, raw] of Object.entries(servers)) {
      rawByName[name] = raw;
      used = true;
    }
    if (used) sources.push(path);
  }

  /** @type {Record<string, object>} */
  const servers = {};
  for (const [name, raw] of Object.entries(rawByName)) {
    const normalized = normalizeServer(name, raw, warn);
    if (normalized) servers[name] = normalized;
  }

  return { servers, sources };
}
