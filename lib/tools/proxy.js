/**
 * The `mcp` proxy meta-tool and the `directTools` promotion path.
 *
 * This is the token-saving core. Instead of registering all N tools (each a
 * verbose JSON schema), the adapter registers ONE `mcp` tool of about 200
 * tokens. The model uses it in three modes:
 *
 *   - `{ action: "search", query }`   → ranked tool names + one-line descriptions,
 *   - `{ action: "describe", server, tool }` → the full input schema for a tool,
 *   - `{ action: "call", server, tool, args }` → run it (output-guarded).
 *
 * Frequently-used tools can be promoted to first-class DSH tools via a server's
 * `directTools` config so the model calls them with zero search latency; the
 * long tail stays behind the proxy. Both paths funnel into the same
 * ServerManager, so the reliability guarantees are identical.
 *
 * Every handler returns a value; a failure becomes an `ok:false` result the model
 * can read and react to, never an exception that aborts the turn.
 *
 * @module dsh-mcp-adapter/tools/proxy
 */

import { searchTools } from '../core/search.js';
import { guardOutput } from '../core/output-guard.js';
import { mcpSchemaToParameters } from './schema.js';

/** Per-server budget for a first-search catalog warm-up. */
const WARM_TIMEOUT_MS = 10_000;

/** Match a tool name against a directTools selection (true | string[] of names/globs). */
export function isDirectTool(selection, toolName) {
  if (selection === true) return true;
  if (!Array.isArray(selection)) return false;
  return selection.some((pattern) => globMatch(pattern, toolName));
}

/**
 * Minimal glob match supporting `*` wildcards (enough for tool-name patterns).
 * @param {string} pattern - the pattern.
 * @param {string} value - the candidate.
 * @returns {boolean} whether it matches.
 */
export function globMatch(pattern, value) {
  if (pattern === value) return true;
  if (!pattern.includes('*')) return false;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

/**
 * Populate the offline catalog for any configured server we have never listed.
 *
 * Only servers with an EMPTY cached catalog are contacted, so this is a one-time
 * cost per server rather than a per-search cost. Each warm-up is independently
 * time-boxed and its failure is swallowed — an unreachable server must degrade
 * the search, never break it.
 *
 * @param {object} manager - ServerManager.
 * @param {object} cache - MetadataCache.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @param {(msg: string) => void} [warn] - warning sink.
 * @returns {Promise<string[]>} names of servers that could not be catalogued.
 */
async function warmUncachedServers(manager, cache, signal, warn) {
  const cold = manager.serverNames.filter((name) => cache.getTools(name).length === 0);
  if (cold.length === 0) return [];

  /** @type {string[]} */
  const unreachable = [];
  await Promise.allSettled(
    cold.map(async (name) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), WARM_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      try {
        await manager.listTools(name, signal ?? controller.signal);
      } catch (error) {
        unreachable.push(name);
        warn?.(`could not catalog "${name}" for search (${error?.code ?? error?.message})`);
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  return unreachable;
}

/**
 * Build the model-facing text for a `search` result.
 * @param {object[]} matches - ranked matches.
 * @param {string} query - the query.
 * @param {string[]} [unreachable] - servers that could not be catalogued.
 * @returns {string} formatted text.
 */
function renderSearch(matches, query, unreachable = []) {
  const caveat = unreachable.length > 0
    ? `\n\nNote: ${unreachable.join(', ')} could not be reached, so its tools are not included in this search.`
    : '';
  if (matches.length === 0) {
    return `No MCP tools matched "${query}". Try broader terms, or run mcp({ action: "list" }) to see which servers are configured.${caveat}`;
  }
  const lines = matches.map(
    (m) => `- ${m.server}/${m.name}${m.description ? ` — ${truncate(m.description, 160)}` : ''}`,
  );
  return [
    `Found ${matches.length} MCP tool(s) for "${query}":`,
    ...lines,
    '',
    'To see a tool\'s parameters: mcp({ action: "describe", server, tool }).',
    'To run it: mcp({ action: "call", server, tool, args }).',
  ].join('\n') + caveat;
}

/**
 * Truncate a string with an ellipsis.
 * @param {string} text - text.
 * @param {number} max - max length.
 * @returns {string} truncated.
 */
function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Register the `mcp` proxy tool plus any promoted direct tools.
 *
 * @param {object} ctx - the plugin context (scoped; has `tools`, maybe `systemPrompt`).
 * @param {object} runtime - `{ manager, cache, config, warn }`.
 * @param {Function} defineTool - `defineTool` from `@deepseek-ai/dsh-tools`.
 * @returns {{proxyRegistered: boolean, directCount: number}} what was registered.
 */
export function registerProxyTools(ctx, runtime, defineTool) {
  const { manager, cache, config } = runtime;

  registerProxyMetaTool(ctx, runtime, defineTool);

  // Promote configured directTools. This needs each server's catalog; we use the
  // offline cache so registration never blocks on a live connection. A server
  // with directTools but no cached catalog yet is promoted lazily on the first
  // catalog refresh (handled by the caller re-invoking this after a connect).
  let directCount = 0;
  for (const name of manager.serverNames) {
    const definition = manager.getDefinition(name);
    const selection = definition?.directTools;
    if (!selection) continue;
    const cached = cache.getTools(name);
    for (const tool of cached) {
      if (!isDirectTool(selection, tool.name)) continue;
      registerDirectTool(ctx, runtime, defineTool, name, tool);
      directCount += 1;
    }
  }

  return { proxyRegistered: true, directCount };
}

/**
 * Register the single `mcp` proxy meta-tool.
 * @param {object} ctx - scoped plugin context.
 * @param {object} runtime - adapter runtime.
 * @param {Function} defineTool - tool factory.
 */
function registerProxyMetaTool(ctx, runtime, defineTool) {
  const { manager, cache, config } = runtime;
  const maxBytes = config.maxOutputBytes;
  const maxLines = config.maxOutputLines;

  ctx.systemPrompt?.section?.({
    name: 'tool:mcp',
    order: 120,
    text:
      'Use the mcp tool to reach external MCP servers without their schemas filling context. ' +
      'First mcp({ action: "search", query }) to find a tool, optionally mcp({ action: "describe", server, tool }) ' +
      'to see its parameters, then mcp({ action: "call", server, tool, args }) to run it. ' +
      'Prefer this over guessing tool names.',
  });

  ctx.tools.register(
    defineTool({
      name: 'mcp',
      description:
        'Access external MCP servers on demand without loading every tool schema. ' +
        'Actions: "search" (find tools by keyword), "describe" (get one tool\'s parameters), ' +
        '"call" (run a tool), "list" (list configured servers). Servers connect lazily and reconnect automatically.',
      parameters: {
        action: {
          type: 'string',
          enum: ['search', 'describe', 'call', 'list'],
          required: true,
          description: 'search = find tools; describe = show a tool\'s params; call = run a tool; list = list servers.',
        },
        query: { type: 'string', description: 'For action "search": the keywords to match tool names/descriptions.' },
        server: { type: 'string', description: 'For "describe"/"call": the MCP server name.' },
        tool: { type: 'string', description: 'For "describe"/"call": the tool name.' },
        args: { type: 'json', description: 'For "call": the tool arguments object.' },
        limit: { type: 'integer', description: 'For "search": max results (default 10).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            action: { type: 'string', required: true },
            text: { type: 'string', required: true },
            images: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  // A durable attachment reference is plain JSON, so it can live in
                  // the canonical value and let `render` stay pure.
                  attachment: { type: 'json', required: true },
                },
              },
            },
            truncated: { type: 'boolean' },
            fullOutputPath: { type: 'string' },
          },
        },
        /**
         * @param {object} _args - validated args.
         * @param {object} value - canonical value.
         * @returns {object[]} content blocks.
         */
        render(_args, value) {
          return renderWithImages(value);
        },
      },
      timeoutMs: config.toolTimeoutMs,
      isConcurrencySafe: (args) => args.action === 'search' || args.action === 'describe' || args.action === 'list',
      /**
       * @param {object} args - validated args.
       * @param {object} exec - execution context.
       * @returns {Promise<object>} canonical value.
       */
      async execute(args, exec) {
        const signal = exec?.signal;
        try {
          switch (args.action) {
            case 'list':
              return okResult('list', renderServerList(manager));
            case 'search': {
              if (!args.query) return failResult('search', 'action "search" requires a query.');
              // Search reads the offline cache, which is empty on a fresh install:
              // without this warm-up the very first search reported "no tools
              // matched" even though the servers expose plenty, making the adapter
              // look broken. Populate any server we have never catalogued, then search.
              const unreachable = await warmUncachedServers(manager, cache, signal, runtime.warn);
              const catalog = cache.allTools(manager.serverNames);
              const matches = searchTools(catalog, args.query, args.limit ?? 10);
              return okResult('search', renderSearch(matches, args.query, unreachable));
            }
            case 'describe': {
              if (!args.server || !args.tool) return failResult('describe', 'action "describe" requires server and tool.');
              return await describeTool(manager, args.server, args.tool, signal);
            }
            case 'call': {
              if (!args.server || !args.tool) return failResult('call', 'action "call" requires server and tool.');
              return await callViaProxy(ctx, manager, args.server, args.tool, args.args, { maxBytes, maxLines, warn: runtime.warn }, signal);
            }
            default:
              return failResult(String(args.action), `unknown action "${args.action}".`);
          }
        } catch (error) {
          // Absolute backstop: no proxy action ever throws into DSH.
          return failResult(String(args.action ?? 'mcp'), `mcp error: ${error?.message ?? error}`);
        }
      },
    }),
  );
}

/**
 * Register one promoted direct tool that forwards to a server.
 * @param {object} ctx - scoped plugin context.
 * @param {object} runtime - adapter runtime.
 * @param {Function} defineTool - tool factory.
 * @param {string} server - server name.
 * @param {object} toolSummary - cached tool summary `{name, description}`.
 */
function registerDirectTool(ctx, runtime, defineTool, server, toolSummary) {
  const { manager, config } = runtime;
  const safeName = `mcp_${server}_${toolSummary.name}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 60);

  // Give the model the tool's REAL parameters when the server published a schema
  // we can convert. Without this the model only sees an opaque `args` object and
  // guesses parameter names — which it demonstrably does wrong.
  const { parameters, passthrough } = mcpSchemaToParameters(toolSummary.inputSchema);

  ctx.tools.register(
    defineTool({
      name: safeName,
      description: `[${server}] ${toolSummary.description || toolSummary.name}`,
      parameters,
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            text: { type: 'string', required: true },
            images: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  // A durable attachment reference is plain JSON, so it can live in
                  // the canonical value and let `render` stay pure.
                  attachment: { type: 'json', required: true },
                },
              },
            },
            truncated: { type: 'boolean' },
            fullOutputPath: { type: 'string' },
          },
        },
        render(_args, value) {
          return renderWithImages(value);
        },
      },
      timeoutMs: config.toolTimeoutMs,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        try {
          // With a converted schema the validated args ARE the tool arguments;
          // in passthrough mode they live under the freeform `args` key.
          const toolArgs = passthrough ? args.args : args;
          const result = await callViaProxy(
            ctx,
            manager,
            server,
            toolSummary.name,
            toolArgs,
            { maxBytes: config.maxOutputBytes, maxLines: config.maxOutputLines, warn: runtime.warn },
            exec?.signal,
          );
          return {
            ok: result.ok,
            text: result.text,
            ...(result.images ? { images: result.images } : {}),
            ...(result.truncated ? { truncated: true } : {}),
            ...(result.fullOutputPath ? { fullOutputPath: result.fullOutputPath } : {}),
          };
        } catch (error) {
          return { ok: false, text: `mcp error: ${error?.message ?? error}` };
        }
      },
    }),
  );
}

/**
 * Render a proxy/direct-tool value as content blocks, including real image blocks.
 *
 * Pure by contract: the attachment refs it emits are read from the canonical
 * value, never captured from an execution closure.
 *
 * @param {object} value - the canonical tool value.
 * @returns {object[]} content blocks.
 */
function renderWithImages(value) {
  /** @type {object[]} */
  const blocks = [{ type: 'text', text: value.text }];
  for (const image of value.images ?? []) {
    if (image?.attachment) blocks.push({ type: 'image', attachment: image.attachment });
  }
  return blocks;
}

/**
 * Persist images returned by an MCP tool as durable attachments.
 *
 * An MCP tool such as a browser `take_screenshot` answers ENTIRELY with an image,
 * so the bytes must reach the model — counting them and dropping the data (the
 * previous behaviour) made those tools useless. Attachment refs are plain JSON,
 * which lets them ride in the tool's canonical value so a PURE `render()` can
 * emit real image blocks.
 *
 * Degrades gracefully: with no attachment store mounted (or on a store error)
 * the caller still gets the text plus an explicit note.
 *
 * @param {object} ctx - the plugin context.
 * @param {{bytes: Buffer, mediaType: string}[]} images - decoded images.
 * @param {string} label - short source label used in attachment names.
 * @returns {Promise<{refs: {attachment: object}[], note?: string}>}
 */
async function storeImages(ctx, images, label) {
  if (!images || images.length === 0) return { refs: [] };
  const attachments = ctx.get?.('attachments');
  if (!attachments) {
    return { refs: [], note: `${images.length} image(s) were returned but no attachment store is mounted, so they cannot be shown.` };
  }
  try {
    const saved = await attachments.saveImages(
      images.map((image, index) => ({
        // Raw bytes, NOT base64: a base64 string is rejected during decode with
        // "Unsupported or malformed image data".
        data: new Uint8Array(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength),
        mediaType: image.mediaType,
        name: `${label}-${index + 1}.${image.mediaType === 'image/png' ? 'png' : 'img'}`,
      })),
    );
    return { refs: saved.map((attachment) => ({ attachment })) };
  } catch (error) {
    return { refs: [], note: `image(s) could not be stored: ${String(error?.message ?? error)}` };
  }
}

/**
 * Execute a tool call through the manager and guard its output.
 * @param {object} ctx - the plugin context (for the attachment store).
 * @param {object} manager - ServerManager.
 * @param {string} server - server name.
 * @param {string} tool - tool name.
 * @param {object} args - tool args.
 * @param {object} guard - `{ maxBytes, maxLines, warn }`.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<object>} canonical proxy value.
 */
async function callViaProxy(ctx, manager, server, tool, args, guard, signal) {
  let result;
  try {
    result = await manager.callTool(server, tool, args ?? {}, signal);
  } catch (error) {
    return failResult('call', `calling ${server}/${tool} failed: ${error?.message ?? error}`);
  }
  // An MCP tool can report a domain error via isError while still returning 200.
  const guarded = guardOutput(result?.content, guard);
  const stored = await storeImages(ctx, guarded.images, `${server}-${tool}`);

  const notes = [];
  if (stored.note) notes.push(stored.note);
  if (guarded.skippedImages > 0) {
    notes.push(`${guarded.skippedImages} image block(s) were skipped (unsupported media type, or over the per-result image limit).`);
  }

  const prefix = result?.isError ? 'The tool reported an error:\n' : '';
  const body = [guarded.text, ...notes.map((note) => `[${note}]`)].filter(Boolean).join('\n');
  return {
    ok: !result?.isError,
    action: 'call',
    text: `${prefix}${body}` || '(empty result)',
    ...(stored.refs.length > 0 ? { images: stored.refs } : {}),
    ...(guarded.truncated ? { truncated: true } : {}),
    ...(guarded.fullPath ? { fullOutputPath: guarded.fullPath } : {}),
  };
}

/**
 * Describe a tool's parameters by fetching the live catalog.
 * @param {object} manager - ServerManager.
 * @param {string} server - server name.
 * @param {string} tool - tool name.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<object>} canonical proxy value.
 */
async function describeTool(manager, server, tool, signal) {
  let tools;
  try {
    tools = await manager.listTools(server, signal);
  } catch (error) {
    return failResult('describe', `could not reach ${server}: ${error?.message ?? error}`);
  }
  const found = tools.find((t) => t.name === tool);
  if (!found) {
    const names = tools.slice(0, 20).map((t) => t.name).join(', ');
    return failResult('describe', `${server} has no tool "${tool}". Available: ${names}${tools.length > 20 ? ', …' : ''}`);
  }
  const schema = found.inputSchema ? JSON.stringify(found.inputSchema, null, 2) : '(no input schema published)';
  const text = [
    `${server}/${found.name}`,
    found.description ? `\n${found.description}` : '',
    `\n\nInput schema:\n${schema}`,
    `\n\nRun with: mcp({ action: "call", server: "${server}", tool: "${found.name}", args: { … } })`,
  ].join('');
  return okResult('describe', text);
}

/**
 * Render the configured-server list.
 * @param {object} manager - ServerManager.
 * @returns {string} formatted list.
 */
function renderServerList(manager) {
  const rows = manager.status();
  if (rows.length === 0) return 'No MCP servers are configured.';
  return [
    'Configured MCP servers:',
    ...rows.map((r) => {
      const state = r.disabled ? 'disabled' : r.connected ? `connected, ${r.toolCount ?? '?'} tools` : r.breakerOpen ? 'temporarily unavailable' : 'idle (connects on first use)';
      return `- ${r.name} [${r.transport}] — ${state}`;
    }),
    '',
    'Use mcp({ action: "search", query }) to find tools across these servers.',
  ].join('\n');
}

/** Build a success result. */
function okResult(action, text) {
  return { ok: true, action, text };
}

/** Build a failure result (still a value, not a throw). */
function failResult(action, text) {
  return { ok: false, action, text };
}
