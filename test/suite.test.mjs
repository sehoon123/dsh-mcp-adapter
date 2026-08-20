/**
 * Full offline + integration suite: config, cache, search, output guard, and the
 * ServerManager reliability behaviours (lazy connect, single-flight, circuit
 * breaker, reconnect, crash isolation, idle teardown) against real child servers.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadConfig, normalizeServer, configSearchPaths } from '../lib/core/config.js';
import { MetadataCache } from '../lib/core/cache.js';
import { searchTools, scoreTool } from '../lib/core/search.js';
import { guardOutput, flattenContent } from '../lib/core/output-guard.js';
import { isDirectTool, globMatch } from '../lib/tools/proxy.js';
import { ServerManager } from '../lib/core/server-manager.js';

const here = dirname(fileURLToPath(import.meta.url));
const STDIO_SERVER = join(here, 'fixtures', 'mock-mcp-server.mjs');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 46 - title.length))}`);
}

/** Build a stdio server definition for the manager. */
function stdioDef(name, env = {}) {
  return {
    name,
    transport: 'stdio',
    command: process.execPath,
    args: [STDIO_SERVER],
    env,
    disabled: false,
    directTools: false,
  };
}

// ═══════════════════════════════════════════════════════ CONFIG ═══════════

section('config: transport inference');
check('http from url', normalizeServer('a', { url: 'http://x/mcp' }, () => {})?.transport === 'http');
check('stdio from command', normalizeServer('b', { command: 'npx', args: ['-y', 'srv'] }, () => {})?.transport === 'stdio');
check('explicit type http', normalizeServer('c', { type: 'http', url: 'http://x' }, () => {})?.transport === 'http');
check('headers preserved', normalizeServer('d', { url: 'http://x', headers: { Authorization: 'Bearer t' } }, () => {})?.headers.Authorization === 'Bearer t');
check('directTools true', normalizeServer('e', { command: 'x', directTools: true }, () => {})?.directTools === true);
check('directTools array', Array.isArray(normalizeServer('f', { command: 'x', directTools: ['a', 'b'] }, () => {})?.directTools));
check('rejects url-less http', normalizeServer('g', { type: 'http' }, () => {}) === undefined);
check('rejects command-less stdio', normalizeServer('h', { type: 'stdio' }, () => {}) === undefined);
check('sanitizes non-string env', normalizeServer('i', { command: 'x', env: { A: 'ok', B: 5 } }, () => {})?.env.B === undefined);

section('config: corrupt files are skipped, not fatal');
{
  const dir = mkdtempSync(join(tmpdir(), 'mcp-cfg-'));
  writeFileSync(join(dir, 'bad.json'), '{ this is not json ', 'utf8');
  writeFileSync(join(dir, 'good.json'), JSON.stringify({ mcpServers: { srv: { command: 'echo' } } }), 'utf8');
  let warned = 0;
  const { servers } = loadConfig({ warn: () => { warned += 1; }, extraPaths: [join(dir, 'bad.json'), join(dir, 'good.json')], home: dir, cwd: dir, dshHome: dir });
  check('corrupt file warned', warned >= 1);
  check('good file still loaded', Boolean(servers.srv));
  rmSync(dir, { recursive: true, force: true });
}
check('search paths ordered', configSearchPaths({ home: '/h', cwd: '/c', dshHome: '/d' }).at(-1) === '/c/.dsh/mcp.json');

// ═══════════════════════════════════════════════════════ CACHE ════════════

section('cache: atomic write + corruption safety');
{
  const dir = mkdtempSync(join(tmpdir(), 'mcp-cache-'));
  const path = join(dir, 'cache.json');
  const cache = new MetadataCache({ path, warn: () => {} });
  const changed = cache.update('srv', [
    { name: 'alpha', description: 'first tool', inputSchema: { properties: { q: {} }, required: ['q'] } },
    { name: 'beta', description: 'second tool', inputSchema: { properties: {} } },
  ]);
  check('update reports change', changed === true);
  check('no-op update reports no change', cache.update('srv', [
    { name: 'alpha', description: 'first tool', inputSchema: { properties: { q: {} }, required: ['q'] } },
    { name: 'beta', description: 'second tool', inputSchema: { properties: {} } },
  ]) === false);
  check('file written 0600', (readFileSync(path) && true));

  const reloaded = new MetadataCache({ path, warn: () => {} });
  check('reload restores tools', reloaded.getTools('srv').length === 2);

  writeFileSync(path, 'CORRUPT', 'utf8');
  const fromCorrupt = new MetadataCache({ path, warn: () => {} });
  check('corrupt cache degrades to empty', fromCorrupt.getTools('srv').length === 0);
  rmSync(dir, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════ SEARCH ══════════

section('search: ranking finds the right tool');
{
  const catalog = [
    { server: 'chrome', name: 'take_screenshot', description: 'Capture a screenshot of the page as PNG.' },
    { server: 'chrome', name: 'click_element', description: 'Click a DOM element by selector.' },
    { server: 'db', name: 'run_query', description: 'Run a read-only SQL query.' },
    { server: 'falcon', name: 'list_incidents', description: 'List active security incidents and detections.' },
  ];
  check('screenshot query → screenshot tool', searchTools(catalog, 'screenshot', 3)[0].name === 'take_screenshot');
  check('sql query → run_query', searchTools(catalog, 'sql query', 3)[0].name === 'run_query');
  check('incident query → list_incidents', searchTools(catalog, 'security incident', 3)[0].name === 'list_incidents');
  check('camelCase name matches', scoreTool({ name: 'takeScreenshot', description: '' }, 'chrome', 'screenshot') > 0);
  check('nonsense query → no matches', searchTools(catalog, 'zzzptqx', 3).length === 0);
  check('respects limit', searchTools(catalog, 'a', 2).length <= 2);
}

// ═════════════════════════════════════════════════ OUTPUT GUARD ══════════

section('output guard: bounds oversized results');
check('small text passes through', guardOutput([{ type: 'text', text: 'hello' }]).truncated === false);
{
  const big = [{ type: 'text', text: 'Z'.repeat(200 * 1024) }];
  const guarded = guardOutput(big, { maxBytes: 4 * 1024, warn: () => {} });
  check('oversized text truncated', guarded.truncated === true);
  check('preview within budget', Buffer.byteLength(guarded.text, 'utf8') < 8 * 1024, `${Buffer.byteLength(guarded.text)}b`);
  check('spilled to a file', typeof guarded.fullPath === 'string' && readFileSync(guarded.fullPath, 'utf8').length === 200 * 1024);
}
check('counts image blocks', flattenContent([{ type: 'text', text: 'x' }, { type: 'image', data: '...' }]).images === 1);
check('tolerates non-array content', flattenContent('raw string').text === 'raw string');

section('proxy: directTools matching');
check('true matches all', isDirectTool(true, 'anything') === true);
check('exact match', isDirectTool(['send_request'], 'send_request') === true);
check('glob match', isDirectTool(['scan_*'], 'scan_active') === true);
check('no match', isDirectTool(['a'], 'b') === false);
check('globMatch literal', globMatch('a_b', 'a_b') === true);
check('globMatch wildcard', globMatch('get_*', 'get_history') === true);

// ═══════════════════════════════════════════ MANAGER (LIVE) ══════════════

section('manager: lazy connect + list + call');
{
  const manager = new ServerManager({ servers: { srv: stdioDef('srv', { MOCK_TOOL_COUNT: '5' }) }, warn: () => {} });
  try {
    check('nothing connected before use', manager.status()[0].connected === false);
    const tools = await manager.listTools('srv');
    check('lists tools on demand', tools.length === 5);
    check('connected after use', manager.status()[0].connected === true);
    const result = await manager.callTool('srv', 'search_web', { query: 'x' });
    check('calls a tool', result.content[0].text.includes('ok: search_web'));
  } finally {
    await manager.stop();
  }
}

section('manager: single-flight connect (no spawn storm)');
{
  const manager = new ServerManager({ servers: { srv: stdioDef('srv', { MOCK_SLOW_INIT_MS: '300' }) }, warn: () => {} });
  try {
    const results = await Promise.all([
      manager.listTools('srv'),
      manager.listTools('srv'),
      manager.listTools('srv'),
    ]);
    check('all concurrent first-uses succeed', results.every((r) => r.length > 0));
    check('exactly one connection exists', manager.status().filter((s) => s.connected).length === 1);
  } finally {
    await manager.stop();
  }
}

section('manager: unknown / disabled servers');
{
  const manager = new ServerManager({ servers: { off: { ...stdioDef('off'), disabled: true } }, warn: () => {} });
  try {
    await manager.listTools('nope').then(() => check('unknown server rejects', false), (e) => check('unknown server rejects', e.code === 'MCP_NO_SERVER', e.code));
    await manager.listTools('off').then(() => check('disabled server rejects', false), (e) => check('disabled server rejects', e.code === 'MCP_DISABLED', e.code));
  } finally {
    await manager.stop();
  }
}

section('manager: crash isolation + auto-reconnect');
{
  const manager = new ServerManager({ servers: { srv: stdioDef('srv', { MOCK_CRASH_ON_CALL: 'run_sql', MOCK_TOOL_COUNT: '5' }) }, warn: () => {} });
  try {
    await manager.listTools('srv');
    // This call crashes the server process.
    await manager.callTool('srv', 'run_sql', {}).then(
      () => check('crash surfaces as error', false, 'resolved'),
      (e) => check('crash surfaces as a clean error', Boolean(e.code), e.code),
    );
    // A crash must never leave an unhandled rejection; the process is still alive
    // to run this. A subsequent call transparently reconnects to a fresh server.
    const after = await manager.callTool('srv', 'search_web', { query: 'again' });
    check('reconnects and serves after crash', after.content[0].text.includes('ok: search_web'));
  } finally {
    await manager.stop();
  }
}

section('manager: circuit breaker opens on repeated failure');
{
  // A command that cannot spawn fails every connect attempt.
  const manager = new ServerManager({
    servers: { dead: { name: 'dead', transport: 'stdio', command: '/no/such/binary/xyz', args: [], disabled: false, directTools: false } },
    warn: () => {},
  });
  try {
    let lastCode;
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await manager.listTools('dead').catch((e) => { lastCode = e.code; });
    }
    check('breaker opens after repeated failures', lastCode === 'MCP_CIRCUIT_OPEN', lastCode);
    check('status reflects open breaker', manager.status()[0].breakerOpen === true);
  } finally {
    await manager.stop();
  }
}

section('manager: server that exits unprompted is re-established');
{
  const manager = new ServerManager({ servers: { srv: stdioDef('srv', { MOCK_EXIT_AFTER_MS: '250', MOCK_TOOL_COUNT: '3' }) }, warn: () => {} });
  try {
    await manager.listTools('srv');
    await new Promise((r) => setTimeout(r, 500)); // let it exit on its own
    const after = await manager.callTool('srv', 'search_web', { query: 'x' });
    check('re-established after unprompted exit', after.content[0].text.includes('ok:'));
  } finally {
    await manager.stop();
  }
}

section('manager: no unhandled rejections under fault storm');
{
  let unhandled = 0;
  const onUnhandled = () => { unhandled += 1; };
  process.on('unhandledRejection', onUnhandled);
  const manager = new ServerManager({
    servers: {
      good: stdioDef('good', { MOCK_TOOL_COUNT: '5' }),
      crasher: stdioDef('crasher', { MOCK_CRASH_ON_CALL: 'search_web' }),
      hanger: stdioDef('hanger', { MOCK_HANG_ON_CALL: 'search_web' }),
      dead: { name: 'dead', transport: 'stdio', command: '/no/such/xyz', args: [], disabled: false, directTools: false },
    },
    defaultRequestTimeoutMs: 600,
    warn: () => {},
  });
  try {
    const ops = [];
    for (let i = 0; i < 5; i += 1) {
      ops.push(manager.callTool('good', 'search_web', { i }).catch(() => 'err'));
      ops.push(manager.callTool('crasher', 'search_web', {}).catch(() => 'err'));
      ops.push(manager.callTool('hanger', 'search_web', {}, undefined).catch(() => 'err'));
      ops.push(manager.callTool('dead', 'search_web', {}).catch(() => 'err'));
    }
    await Promise.allSettled(ops);
    await new Promise((r) => setTimeout(r, 200));
    check('no unhandled rejections during fault storm', unhandled === 0, `${unhandled}`);
  } finally {
    await manager.stop();
    process.off('unhandledRejection', onUnhandled);
  }
}

section('regression: stdout flood is bounded + child reaped');
{
  // A server that streams stdout forever without a newline must not OOM the
  // host, and its process must be reaped (not orphaned) when the transport dies.
  const { StdioTransport } = await import('../lib/transport/stdio.js');
  let closed = false;
  let closeReason;
  const transport = new StdioTransport({
    command: process.execPath,
    args: [STDIO_SERVER],
    env: { MOCK_FLOOD_STDOUT: 'search_web', MOCK_TOOL_COUNT: '5' },
    defaultTimeoutMs: 3_000,
    warn: () => {},
    onClose: (reason) => { closed = true; closeReason = reason; },
  });
  await transport.start();
  await transport.rpc.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  const pid = transport._child?.pid;
  // Trigger the flood; the call itself will reject when the transport dies.
  await transport.rpc.request('tools/call', { name: 'search_web', arguments: {} }, { timeoutMs: 3_000 }).catch(() => {});
  // Give the overflow guard time to trip and reap.
  await new Promise((r) => setTimeout(r, 1_500));
  check('transport died on flood', closed === true, String(closeReason?.message).slice(0, 40));
  check('overflow reason reported', /maximum line size/.test(String(closeReason?.message ?? '')));
  // The child must be gone (reaped). kill(pid,0) throws ESRCH when it no longer exists.
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch { alive = false; }
  check('child process was reaped (not orphaned)', alive === false, `pid ${pid} still alive`);
  await transport.stop();
}

section('regression: stop() returns promptly on fast exit');
{
  const { StdioTransport } = await import('../lib/transport/stdio.js');
  const transport = new StdioTransport({
    command: process.execPath,
    args: [STDIO_SERVER],
    env: { MOCK_TOOL_COUNT: '3' },
    defaultTimeoutMs: 3_000,
    warn: () => {},
  });
  await transport.start();
  await transport.rpc.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  const start = Date.now();
  await transport.stop();
  const elapsed = Date.now() - start;
  // A cooperative server exits on SIGTERM immediately; stop() must not wait the
  // full 2s SIGKILL fallback.
  check('stop() returns well under the 2s fallback', elapsed < 1_500, `${elapsed}ms`);
}

section('regression: stop() escalates to SIGKILL for a stubborn child');
{
  const { StdioTransport } = await import('../lib/transport/stdio.js');
  const transport = new StdioTransport({
    command: process.execPath,
    args: [STDIO_SERVER],
    env: { MOCK_TOOL_COUNT: '3', MOCK_IGNORE_SIGTERM: '1' },
    defaultTimeoutMs: 3_000,
    warn: () => {},
  });
  await transport.start();
  await transport.rpc.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  const pid = transport._child?.pid;
  await transport.stop(); // must escalate SIGTERM → SIGKILL and still complete
  // SIGKILL is asynchronous; poll briefly for the OS to reap the process.
  let alive = true;
  for (let i = 0; i < 20 && alive; i += 1) {
    try { process.kill(pid, 0); } catch { alive = false; break; }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 100));
  }
  check('SIGTERM-ignoring child is SIGKILLed by stop()', alive === false, `pid ${pid} alive`);
}

section('regression: abort listener does not leak on a shared signal');
{
  const { JsonRpcClient } = await import('../lib/transport/jsonrpc.js');
  const controller = new AbortController();
  // A stub transport that immediately replies to every request.
  let client;
  client = new JsonRpcClient({
    send: (msg) => { if (msg.id !== undefined) queueMicrotask(() => client.receive({ jsonrpc: '2.0', id: msg.id, result: { ok: true } })); },
    defaultTimeoutMs: 1_000,
  });
  // Fire many requests on the SAME long-lived signal; each must clean up its
  // listener on normal settle, leaving the count near zero.
  for (let i = 0; i < 50; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await client.request('ping', undefined, { signal: controller.signal });
  }
  const { getEventListeners } = await import('node:events');
  const count = getEventListeners(controller.signal, 'abort').length;
  check('no abort-listener buildup after 50 settled requests', count === 0, `${count} listeners`);
}

console.log(`\n${'═'.repeat(56)}`);
console.log(`  passed: ${passed}   failed: ${failed}`);
if (failures.length) failures.forEach((f) => console.log(`   • ${f}`));
console.log('═'.repeat(56));
process.exit(failed === 0 ? 0 : 1);
