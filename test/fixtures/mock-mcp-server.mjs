#!/usr/bin/env node
/**
 * A minimal but faithful stdio MCP server for tests.
 *
 * It speaks the real wire protocol — newline-delimited JSON-RPC 2.0 over
 * stdin/stdout — so the adapter's stdio transport is exercised against genuine
 * framing, not a mock of itself. Behaviour is controlled by env vars so a single
 * file can stand in for a healthy server, a slow one, a crasher, and a flapper:
 *
 *   MOCK_TOOL_COUNT      how many tools to advertise (default 5)
 *   MOCK_CRASH_ON_CALL   tool name that makes the process exit(1) mid-call
 *   MOCK_HANG_ON_CALL    tool name that never responds (tests client timeout)
 *   MOCK_SLOW_INIT_MS    delay before answering initialize
 *   MOCK_HUGE_OUTPUT     tool name that returns a multi-MB text block
 *   MOCK_BAD_FRAME       emit one malformed line before the real reply
 *   MOCK_EXIT_AFTER_MS   exit(0) unprompted after N ms (tests reconnect)
 *   MOCK_FLOOD_STDOUT    tool name that streams unframed stdout forever (no newline)
 *   MOCK_IGNORE_SIGTERM  ignore SIGTERM so stop() must escalate to SIGKILL
 *   MOCK_IMAGE_TOOL      tool name that returns a real PNG image block
 *   MOCK_RICH_SCHEMA     advertise realistic per-tool inputSchemas (for directTools)
 */

import process from 'node:process';

const TOOL_COUNT = Number(process.env.MOCK_TOOL_COUNT ?? 5);
const CRASH_ON_CALL = process.env.MOCK_CRASH_ON_CALL;
const HANG_ON_CALL = process.env.MOCK_HANG_ON_CALL;
const SLOW_INIT_MS = Number(process.env.MOCK_SLOW_INIT_MS ?? 0);
const HUGE_OUTPUT = process.env.MOCK_HUGE_OUTPUT;
const BAD_FRAME = process.env.MOCK_BAD_FRAME;
const EXIT_AFTER_MS = Number(process.env.MOCK_EXIT_AFTER_MS ?? 0);
const FLOOD_STDOUT = process.env.MOCK_FLOOD_STDOUT;
const IMAGE_TOOL = process.env.MOCK_IMAGE_TOOL;
const RICH_SCHEMA = process.env.MOCK_RICH_SCHEMA === '1';

/** A real 1x1 red PNG, base64 — small but a valid decodable image. */
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

/** Realistic per-tool input schemas, so directTools schema fidelity can be tested. */
const RICH_SCHEMAS = {
  take_screenshot: {
    type: 'object',
    properties: {
      format: { type: 'string', enum: ['png', 'jpeg'], description: 'Image encoding.' },
      fullPage: { type: 'boolean', description: 'Capture the entire scrollable page.' },
      selector: { type: 'string', description: 'CSS selector to clip the capture to.' },
    },
    required: [],
  },
  quarantine_host: {
    type: 'object',
    properties: {
      hostId: { type: 'string', description: 'The agent/host identifier to isolate.' },
      reason: { type: 'string', description: 'Why the host is being isolated.' },
    },
    required: ['hostId'],
  },
};
const IGNORE_SIGTERM = process.env.MOCK_IGNORE_SIGTERM === '1';

if (EXIT_AFTER_MS > 0) setTimeout(() => process.exit(0), EXIT_AFTER_MS).unref();

/** Build the advertised tool list. */
function buildTools() {
  const names = [
    ['search_web', 'Search the public web for a query and return ranked results.'],
    ['take_screenshot', 'Capture a screenshot of the current browser page as a PNG image.'],
    ['run_sql', 'Execute a read-only SQL query against the connected database.'],
    ['list_incidents', 'List active security incidents from the detection platform.'],
    ['quarantine_host', 'Isolate a compromised host from the network immediately.'],
  ];
  const tools = [];
  for (let i = 0; i < TOOL_COUNT; i += 1) {
    const [name, description] = names[i % names.length];
    const suffix = i < names.length ? '' : `_${i}`;
    const toolName = `${name}${suffix}`;
    const rich = RICH_SCHEMA ? RICH_SCHEMAS[toolName] : undefined;
    tools.push({
      name: toolName,
      description,
      inputSchema: rich ?? {
        type: 'object',
        properties: { query: { type: 'string', description: 'The input value.' } },
        required: i % 2 === 0 ? ['query'] : [],
      },
    });
  }
  return tools;
}

/** Write one JSON-RPC message as a single newline-terminated line. */
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handleLine(line);
    index = buffer.indexOf('\n');
  }
});

/** Dispatch one received JSON-RPC line. */
function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // ignore junk from the client, as a real server would
  }
  const { id, method, params } = msg;

  if (method === 'initialize') {
    const reply = () =>
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'mock-mcp-server', version: '1.0.0' },
        },
      });
    if (SLOW_INIT_MS > 0) setTimeout(reply, SLOW_INIT_MS);
    else reply();
    return;
  }

  if (method === 'notifications/initialized') return;

  if (method === 'tools/list') {
    if (BAD_FRAME) process.stdout.write('this is not json\n');
    send({ jsonrpc: '2.0', id, result: { tools: buildTools() } });
    return;
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    if (CRASH_ON_CALL && toolName === CRASH_ON_CALL) {
      process.exit(1); // simulate a server that dies mid-request
    }
    if (FLOOD_STDOUT && toolName === FLOOD_STDOUT) {
      // Stream chunks with NO newline, forever, to exercise the transport's
      // unframed-overflow guard and child reaping.
      const blob = 'X'.repeat(256 * 1024);
      const pump = () => {
        if (!process.stdout.write(blob)) process.stdout.once('drain', pump);
        else setImmediate(pump);
      };
      pump();
      return;
    }
    if (HANG_ON_CALL && toolName === HANG_ON_CALL) {
      return; // never reply: the client's timeout must fire
    }
    if (IMAGE_TOOL && toolName === IMAGE_TOOL) {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            { type: 'text', text: 'Screenshot captured.' },
            { type: 'image', data: TINY_PNG, mimeType: 'image/png' },
          ],
        },
      });
      return;
    }
    if (HUGE_OUTPUT && toolName === HUGE_OUTPUT) {
      const big = 'X'.repeat(3 * 1024 * 1024);
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: big }] } });
      return;
    }
    send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: `ok: ${toolName}(${JSON.stringify(params?.arguments ?? {})})` }] },
    });
    return;
  }

  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }

  // Unknown method: reply with a JSON-RPC error, never crash.
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

if (IGNORE_SIGTERM) {
  process.on('SIGTERM', () => {}); // force stop() to escalate to SIGKILL
} else {
  process.on('SIGTERM', () => process.exit(0));
}
process.on('SIGINT', () => process.exit(0));
