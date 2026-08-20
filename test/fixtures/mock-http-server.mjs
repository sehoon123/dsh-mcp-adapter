#!/usr/bin/env node
/**
 * A minimal Streamable HTTP MCP server for tests, using only node:http.
 *
 * It covers the branches the HttpTransport must survive: JSON replies, SSE
 * replies, session-id issuance and expiry (404), auth header enforcement, and a
 * hanging endpoint for timeout tests. It prints its bound port as the first
 * stdout line so the test harness can find it.
 *
 *   MOCK_MODE=json|sse       response encoding (default json)
 *   MOCK_REQUIRE_AUTH=token  reject requests without this bearer token
 *   MOCK_EXPIRE_AFTER=N       return 404 after N tool calls (session expiry)
 *   MOCK_HANG=1               never respond (timeout test)
 */

import http from 'node:http';

const MODE = process.env.MOCK_MODE ?? 'json';
const REQUIRE_AUTH = process.env.MOCK_REQUIRE_AUTH;
const EXPIRE_AFTER = Number(process.env.MOCK_EXPIRE_AFTER ?? 0);
const HANG = process.env.MOCK_HANG === '1';

let sessionCounter = 0;
let callsSinceInit = 0;
const sessions = new Set();

const TOOLS = [
  { name: 'send_request', description: 'Send a raw HTTP request through the proxy.', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'get_history', description: 'Return recent proxy history entries.', inputSchema: { type: 'object', properties: {} } },
];

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }
  if (REQUIRE_AUTH) {
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${REQUIRE_AUTH}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
  }

  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    if (HANG) return; // never respond

    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const { id, method, params } = msg;

    if (method === 'initialize') {
      sessionCounter += 1;
      const sid = `sess-${sessionCounter}`;
      sessions.add(sid);
      callsSinceInit = 0;
      reply(res, id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'mock-http-mcp', version: '1.0.0' },
      }, sid);
      return;
    }

    if (method === 'notifications/initialized') {
      res.writeHead(202);
      res.end();
      return;
    }

    // Session expiry simulation.
    if (EXPIRE_AFTER > 0 && (method === 'tools/call' || method === 'tools/list')) {
      callsSinceInit += 1;
      if (callsSinceInit > EXPIRE_AFTER) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'session not found' }));
        return;
      }
    }

    if (method === 'tools/list') {
      reply(res, id, { tools: TOOLS });
      return;
    }
    if (method === 'tools/call') {
      reply(res, id, { content: [{ type: 'text', text: `ok: ${params?.name}` }] });
      return;
    }
    if (method === 'ping') {
      reply(res, id, {});
      return;
    }
    reply(res, id, {}, undefined, { code: -32601, message: `method not found: ${method}` });
  });
});

/** Send a JSON-RPC reply, in either JSON or SSE encoding. */
function reply(res, id, result, sessionId, error) {
  const message = error
    ? { jsonrpc: '2.0', id, error }
    : { jsonrpc: '2.0', id, result };
  const headers = {};
  if (sessionId) headers['mcp-session-id'] = sessionId;

  if (MODE === 'sse') {
    res.writeHead(200, { ...headers, 'content-type': 'text/event-stream' });
    // Emit an unrelated notification first to exercise notification forwarding.
    res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info' } })}\n\n`);
    res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
    res.end();
  } else {
    res.writeHead(200, { ...headers, 'content-type': 'application/json' });
    res.end(JSON.stringify(message));
  }
}

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  process.stdout.write(`PORT:${port}\n`);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
