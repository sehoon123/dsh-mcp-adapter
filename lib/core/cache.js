/**
 * Persistent tool-metadata cache.
 *
 * The whole point of the proxy is to answer `search`/`describe` without loading
 * every server. To do that even before a server is connected, the adapter
 * remembers each server's tool catalog on disk and searches it offline. When a
 * server later connects and its catalog differs, the cache is refreshed.
 *
 * Writes are atomic (temp file + rename) and mode 0600, and every read tolerates
 * a corrupt or partial file by falling back to empty — a damaged cache degrades
 * to "search finds nothing until a server connects", never a crash.
 *
 * @module dsh-mcp-adapter/core/cache
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** Current on-disk schema version; a mismatch is treated as an empty cache. */
const CACHE_VERSION = 1;

/**
 * Resolve the cache file path.
 * @param {object} [options] - `{ dshHome, home }`.
 * @returns {string} absolute cache path.
 */
export function cachePath({ dshHome, home = homedir() } = {}) {
  const dsh = dshHome || process.env.DSH_HOME || join(home, '.dsh');
  return join(dsh, '.mcp-adapter-cache.json');
}

/**
 * The metadata cache. In-memory map of server → tool summaries, persisted lazily.
 */
export class MetadataCache {
  /**
   * @param {object} [options] - `{ path, warn }`.
   */
  constructor(options = {}) {
    this._path = options.path ?? cachePath(options);
    this._warn = options.warn ?? (() => {});
    /** @type {Map<string, {fingerprint: string, tools: object[], updatedAt: number}>} */
    this._servers = new Map();
    this._loaded = false;
  }

  /** Load the cache from disk once; safe to call repeatedly. */
  load() {
    if (this._loaded) return;
    this._loaded = true;
    let text;
    try {
      text = readFileSync(this._path, 'utf8');
    } catch {
      return; // no cache yet is normal
    }
    try {
      const parsed = JSON.parse(text);
      if (!parsed || parsed.version !== CACHE_VERSION || typeof parsed.servers !== 'object') return;
      for (const [name, entry] of Object.entries(parsed.servers)) {
        if (entry && Array.isArray(entry.tools)) {
          this._servers.set(name, {
            fingerprint: String(entry.fingerprint ?? ''),
            tools: entry.tools.filter((t) => t && typeof t.name === 'string'),
            updatedAt: Number(entry.updatedAt ?? 0),
          });
        }
      }
    } catch (error) {
      // Corrupt cache: start clean rather than crash.
      this._warn(`mcp cache is corrupt (${error.message}); starting with an empty cache`);
    }
  }

  /**
   * Return the cached tool summaries for a server (or empty).
   * @param {string} server - server name.
   * @returns {object[]} tool summaries.
   */
  getTools(server) {
    this.load();
    return this._servers.get(server)?.tools ?? [];
  }

  /**
   * Return every cached tool as a flat catalog tagged with its server.
   * @param {Set<string>|string[]} [onlyServers] - restrict to these servers.
   * @returns {Array<{server: string, name: string, description?: string, keywords?: string[]}>}
   */
  allTools(onlyServers) {
    this.load();
    const filter = onlyServers ? new Set(onlyServers) : undefined;
    const out = [];
    for (const [server, entry] of this._servers) {
      if (filter && !filter.has(server)) continue;
      for (const tool of entry.tools) out.push({ server, ...tool });
    }
    return out;
  }

  /**
   * Replace a server's catalog if it changed, and persist.
   *
   * @param {string} server - server name.
   * @param {object[]} tools - raw MCP tool descriptors (`{name, description, inputSchema}`).
   * @returns {boolean} whether the catalog changed.
   */
  update(server, tools) {
    this.load();
    const summaries = tools.map((tool) => ({
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description : '',
      // A compact required-params hint is kept for `describe`, but the full
      // schema is not cached — it is fetched live when a tool is actually called.
      required: Array.isArray(tool.inputSchema?.required) ? tool.inputSchema.required : [],
      paramCount: tool.inputSchema?.properties ? Object.keys(tool.inputSchema.properties).length : 0,
    }));
    const fingerprint = fingerprintTools(summaries);
    const existing = this._servers.get(server);
    if (existing && existing.fingerprint === fingerprint) return false;

    this._servers.set(server, { fingerprint, tools: summaries, updatedAt: Date.now() });
    this._persist();
    return true;
  }

  /**
   * Forget a server's cached catalog (e.g. when it is removed from config).
   * @param {string} server - server name.
   */
  forget(server) {
    this.load();
    if (this._servers.delete(server)) this._persist();
  }

  /** Atomically write the cache to disk, mode 0600. Never throws. */
  _persist() {
    const payload = { version: CACHE_VERSION, servers: {} };
    for (const [name, entry] of this._servers) payload.servers[name] = entry;
    try {
      mkdirSync(dirname(this._path), { recursive: true });
      const tmp = `${this._path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, this._path); // atomic replace
    } catch (error) {
      // A cache we cannot persist is a performance regression, not a failure.
      this._warn(`could not persist mcp cache: ${error.message}`);
    }
  }

  /** @returns {string[]} names of servers with cached catalogs. */
  get servers() {
    this.load();
    return [...this._servers.keys()];
  }
}

/**
 * Compute a stable fingerprint of a tool summary list.
 * @param {object[]} summaries - tool summaries.
 * @returns {string} a fingerprint string.
 */
function fingerprintTools(summaries) {
  return summaries
    .map((t) => `${t.name}:${t.description.length}:${t.required.join(',')}`)
    .sort()
    .join('|');
}
