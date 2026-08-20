/**
 * HTTP transport tests against a real node:http MCP server, covering JSON and
 * SSE encodings, auth, session expiry, and timeouts.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { HttpTransport } from '../lib/transport/http.js';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, 'fixtures', 'mock-http-server.mjs');

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
 * Spawn the mock HTTP server and resolve with its base URL + a stop function.
 * @param {Record<string,string>} env - mock behaviour.
 * @returns {Promise<{url: string, stop: () => void}>}
 */
function startServer(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => reject(new Error('server did not report a port')), 5_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const match = /PORT:(\d+)/.exec(out);
      if (match) {
        clearTimeout(timer);
        resolve({ url: `http://127.0.0.1:${match[1]}/mcp`, stop: () => child.kill('SIGTERM') });
      }
    });
    child.on('error', reject);
  });
}

/** Initialize a transport against a server. */
async function init(transport) {
  await transport.start();
  await transport.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  await transport.notify('notifications/initialized');
}

console.log('\n── http: JSON encoding ────────────────────────────');
{
  const { url, stop } = await startServer({ MOCK_MODE: 'json' });
  const t = new HttpTransport({ url, defaultTimeoutMs: 3_000, warn: () => {} });
  try {
    await init(t);
    check('session id captured', typeof t.sessionId === 'string' && t.sessionId.length > 0, t.sessionId);
    const list = await t.request('tools/list');
    check('lists tools (JSON)', list.tools.length === 2);
    const call = await t.request('tools/call', { name: 'send_request', arguments: { url: 'x' } });
    check('calls a tool (JSON)', call.content[0].text.includes('ok: send_request'));
  } finally {
    await t.stop();
    stop();
  }
}

console.log('\n── http: SSE encoding + notification forwarding ───');
{
  const { url, stop } = await startServer({ MOCK_MODE: 'sse' });
  let notifications = 0;
  const t = new HttpTransport({ url, defaultTimeoutMs: 3_000, warn: () => {}, onNotification: () => { notifications += 1; } });
  try {
    await init(t);
    const list = await t.request('tools/list');
    check('lists tools (SSE)', list.tools.length === 2);
    check('forwarded SSE notifications', notifications > 0, `${notifications}`);
  } finally {
    await t.stop();
    stop();
  }
}

console.log('\n── http: auth enforcement ─────────────────────────');
{
  const { url, stop } = await startServer({ MOCK_MODE: 'json', MOCK_REQUIRE_AUTH: 'secret123' });
  // Wrong/absent token -> clean rejection.
  const bad = new HttpTransport({ url, defaultTimeoutMs: 3_000, warn: () => {} });
  try {
    await bad.start();
    await bad.request('initialize', {}, { timeoutMs: 2_000 });
    check('missing auth rejects', false, 'accepted');
  } catch (error) {
    check('missing auth rejects cleanly', Boolean(error.code), error.code);
  } finally {
    await bad.stop();
  }
  // Correct token -> works.
  const good = new HttpTransport({ url, headers: { Authorization: 'Bearer secret123' }, defaultTimeoutMs: 3_000, warn: () => {} });
  try {
    await init(good);
    const list = await good.request('tools/list');
    check('correct auth works', list.tools.length === 2);
  } finally {
    await good.stop();
    stop();
  }
}

console.log('\n── http: session expiry surfaces cleanly ──────────');
{
  const { url, stop } = await startServer({ MOCK_MODE: 'json', MOCK_EXPIRE_AFTER: '1' });
  const t = new HttpTransport({ url, defaultTimeoutMs: 3_000, warn: () => {} });
  try {
    await init(t);
    await t.request('tools/list'); // 1st call ok
    try {
      await t.request('tools/list'); // 2nd call -> 404 session expired
      check('expiry raises', false, 'no error');
    } catch (error) {
      check('session expiry is distinguishable', error.code === 'MCP_SESSION_EXPIRED', error.code);
    }
  } finally {
    await t.stop();
    stop();
  }
}

console.log('\n── http: timeout on a hanging server ──────────────');
{
  const { url, stop } = await startServer({ MOCK_HANG: '1' });
  const t = new HttpTransport({ url, defaultTimeoutMs: 800, warn: () => {} });
  try {
    await t.start();
    const start = Date.now();
    try {
      await t.request('initialize', {}, { timeoutMs: 800 });
      check('hanging request rejects', false, 'resolved');
    } catch (error) {
      const elapsed = Date.now() - start;
      check('hanging request times out', error.code === 'MCP_TIMEOUT', error.code);
      check('http timeout near deadline', elapsed >= 700 && elapsed < 2_500, `${elapsed}ms`);
    }
  } finally {
    await t.stop();
    stop();
  }
}

console.log('\n── http: connection refused is clean ──────────────');
{
  const t = new HttpTransport({ url: 'http://127.0.0.1:1/mcp', defaultTimeoutMs: 2_000, warn: () => {} });
  try {
    await t.start();
    await t.request('initialize', {}, { timeoutMs: 1_500 });
    check('refused connection rejects', false, 'resolved');
  } catch (error) {
    check('refused connection rejects cleanly', Boolean(error.code), error.code);
  } finally {
    await t.stop();
  }
}

console.log(`\n${'═'.repeat(56)}`);
console.log(`  passed: ${passed}   failed: ${failed}`);
if (failures.length) failures.forEach((f) => console.log(`   • ${f}`));
console.log('═'.repeat(56));
process.exit(failed === 0 ? 0 : 1);
