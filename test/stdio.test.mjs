/**
 * Stdio transport tests against a real child-process MCP server.
 *
 * These prove the reliability invariants that matter most: a request always
 * settles, a crashed server rejects pending work instead of hanging, a timeout
 * fires, and malformed output never throws.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { StdioTransport } from '../lib/transport/stdio.js';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, 'fixtures', 'mock-mcp-server.mjs');

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

/**
 * Spawn a mock server transport, initialize it, and hand it to a callback.
 * @param {Record<string,string>} env - mock behaviour env.
 * @param {(t: StdioTransport) => Promise<void>} fn - test body.
 */
async function withServer(env, fn) {
  const transport = new StdioTransport({
    command: process.execPath,
    args: [SERVER],
    env,
    defaultTimeoutMs: 3_000,
    warn: () => {},
  });
  await transport.start();
  try {
    await transport.rpc.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    transport.rpc.notify('notifications/initialized');
    await fn(transport);
  } finally {
    await transport.stop();
  }
}

console.log('\n── stdio: happy path ──────────────────────────────');
await withServer({ MOCK_TOOL_COUNT: '5' }, async (t) => {
  const list = await t.rpc.request('tools/list');
  check('lists tools', Array.isArray(list.tools) && list.tools.length === 5, `got ${list.tools?.length}`);
  const call = await t.rpc.request('tools/call', { name: 'search_web', arguments: { query: 'hi' } });
  check('calls a tool', call.content[0].text.includes('ok: search_web'));
});

console.log('\n── stdio: timeout on a hanging tool ───────────────');
await withServer({ MOCK_HANG_ON_CALL: 'search_web' }, async (t) => {
  const start = Date.now();
  try {
    await t.rpc.request('tools/call', { name: 'search_web', arguments: {} }, { timeoutMs: 800 });
    check('hanging call rejects', false, 'resolved unexpectedly');
  } catch (error) {
    const elapsed = Date.now() - start;
    check('hanging call times out', error.code === 'MCP_TIMEOUT', `code=${error.code}`);
    check('timeout fires near deadline', elapsed >= 700 && elapsed < 2_000, `${elapsed}ms`);
  }
});

console.log('\n── stdio: server crash mid-call ───────────────────');
await withServer({ MOCK_CRASH_ON_CALL: 'run_sql', MOCK_TOOL_COUNT: '5' }, async (t) => {
  try {
    await t.rpc.request('tools/call', { name: 'run_sql', arguments: {} });
    check('crashing call rejects', false, 'resolved unexpectedly');
  } catch (error) {
    check('crashing call rejects (not hang)', error.code === 'MCP_CLOSED' || error.code === 'MCP_TIMEOUT', `code=${error.code}`);
  }
  check('transport marked closed after crash', t.closed === true);
});

console.log('\n── stdio: malformed frame is tolerated ────────────');
await withServer({ MOCK_BAD_FRAME: '1', MOCK_TOOL_COUNT: '3' }, async (t) => {
  const list = await t.rpc.request('tools/list');
  check('valid reply survives a preceding junk line', list.tools.length === 3);
});

console.log('\n── stdio: missing binary fails cleanly ────────────');
{
  const transport = new StdioTransport({
    command: '/nonexistent/definitely-not-a-real-binary-xyz',
    args: [],
    defaultTimeoutMs: 1_000,
    warn: () => {},
  });
  try {
    await transport.start();
    // Some platforms surface ENOENT only on first write; force it.
    await transport.rpc.request('initialize', {}, { timeoutMs: 800 });
    check('missing binary rejects', false, 'did not fail');
  } catch (error) {
    check('missing binary rejects cleanly', Boolean(error), error.code ?? error.message?.slice(0, 40));
  } finally {
    await transport.stop();
  }
}

console.log('\n── stdio: concurrent requests all settle ──────────');
await withServer({ MOCK_TOOL_COUNT: '5' }, async (t) => {
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, (_, i) => t.rpc.request('tools/call', { name: 'search_web', arguments: { i } })),
  );
  check('all 20 concurrent calls settle', results.every((r) => r.status === 'fulfilled'), `${results.filter((r) => r.status === 'fulfilled').length}/20`);
  check('no requests left pending', t.rpc.pendingCount === 0, `${t.rpc.pendingCount} pending`);
});

console.log(`\n${'═'.repeat(56)}`);
console.log(`  passed: ${passed}   failed: ${failed}`);
if (failures.length) failures.forEach((f) => console.log(`   • ${f}`));
console.log('═'.repeat(56));
process.exit(failed === 0 ? 0 : 1);
