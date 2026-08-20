/**
 * Streamable HTTP transport for remote MCP servers (e.g. Burp Suite's MCP on
 * `http://localhost:9876/mcp`).
 *
 * The MCP Streamable HTTP protocol is request/response over POST, where each
 * response may be either a single JSON body or an SSE stream of `data:` frames.
 * The server assigns a session via the `Mcp-Session-Id` response header on
 * initialize, which the client echoes on every later request. A `404` on a
 * later request means the session expired and must be re-established — a common
 * real-world failure this transport reports cleanly so the manager can reconnect.
 *
 * Unlike stdio there is no long-lived process; each request is its own fetch
 * with its own hard timeout. That makes this transport naturally crash-resistant
 * — there is nothing to keep alive — but it still must never leak a hanging
 * fetch, so every request is bounded by an AbortSignal timeout.
 *
 * @module dsh-mcp-adapter/transport/http
 */

import { RpcClosedError, RpcServerError, RpcTimeoutError } from './jsonrpc.js';

/**
 * Blank-line event delimiter, matching LF, CRLF, or bare CR forms. Non-global so
 * `.exec` always searches from the string start with no `lastIndex` state.
 */
const SSE_EVENT_DELIMITER = /\r\n\r\n|\n\n|\r\r/;

/** Ceiling on the SSE reassembly buffer, bounding memory against an undelimited stream. */
const MAX_SSE_BUFFER = 16 * 1024 * 1024;

/** Signals that the server session is gone and a reconnect is required. */
export class SessionExpiredError extends Error {
  /** @param {string} message - detail. */
  constructor(message) {
    super(message);
    this.name = 'SessionExpiredError';
    this.code = 'MCP_SESSION_EXPIRED';
  }
}

/**
 * A stateless-per-request HTTP MCP transport.
 */
export class HttpTransport {
  /**
   * @param {object} options - transport config.
   * @param {string} options.url - the MCP endpoint URL.
   * @param {Record<string,string>} [options.headers] - static headers (e.g. Authorization).
   * @param {number} [options.defaultTimeoutMs] - per-request timeout.
   * @param {(notification: object) => void} [options.onNotification] - server notifications from SSE.
   * @param {(msg: string) => void} [options.warn] - warning sink.
   */
  constructor(options) {
    this._url = options.url;
    this._headers = options.headers ?? {};
    this._defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this._onNotification = options.onNotification;
    this._warn = options.warn ?? (() => {});
    this._sessionId = undefined;
    this._nextId = 1;
    this._closed = false;
    this._protocolVersion = '2025-06-18';
  }

  /** No persistent connection to open; validate the URL eagerly. */
  async start() {
    // Throws synchronously on a malformed URL, which the manager treats as a
    // permanent (non-retryable) config error.
    // eslint-disable-next-line no-new
    new URL(this._url);
  }

  /**
   * Issue a JSON-RPC request over HTTP and return its result.
   *
   * @param {string} method - JSON-RPC method.
   * @param {object} [params] - params.
   * @param {object} [options] - `{ timeoutMs, signal }`.
   * @returns {Promise<unknown>} the result.
   */
  async request(method, params, options = {}) {
    if (this._closed) throw new RpcClosedError(`transport closed; cannot call ${method}`);

    const id = this._nextId;
    this._nextId += 1;
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : this._defaultTimeoutMs;

    const body = JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
    const headers = {
      'content-type': 'application/json',
      // Accept both shapes: some servers answer JSON, others open an SSE stream.
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': this._protocolVersion,
      ...this._headers,
    };
    if (this._sessionId) headers['mcp-session-id'] = this._sessionId;

    // Compose the caller signal (if any) with a hard timeout so no fetch hangs.
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutController.signal])
      : timeoutController.signal;

    let response;
    try {
      response = await fetch(this._url, { method: 'POST', headers, body, signal });
    } catch (error) {
      clearTimeout(timer);
      if (timeoutController.signal.aborted) {
        throw new RpcTimeoutError(`request ${method} timed out after ${timeoutMs}ms`);
      }
      // Connection refused, DNS failure, socket reset — all become a clean close
      // signal the manager can act on.
      throw new RpcClosedError(`request ${method} failed: ${error?.message ?? error}`);
    }

    try {
      // Capture a session id issued on initialize.
      const assigned = response.headers.get('mcp-session-id');
      if (assigned) this._sessionId = assigned;

      if (response.status === 404 && this._sessionId) {
        this._sessionId = undefined;
        throw new SessionExpiredError(`server reported the MCP session expired (404) on ${method}`);
      }
      if (response.status === 202) {
        // Accepted with no body (valid for notifications); nothing to parse.
        return undefined;
      }
      if (!response.ok) {
        const text = await safeText(response);
        throw new RpcClosedError(`HTTP ${response.status} on ${method}: ${text.slice(0, 300)}`);
      }

      const contentType = response.headers.get('content-type') ?? '';
      const result = contentType.includes('text/event-stream')
        ? await this._readSse(response, id, method)
        : await this._readJson(response, id, method);
      return result;
    } catch (error) {
      // The response headers arrived, but reading the BODY can still fail: the
      // timeout can fire mid-stream (aborting the body read with an AbortError),
      // the caller can cancel, or the socket can drop (TypeError). Map all of
      // these to the adapter's coded errors so the manager classifies them
      // correctly (a raw AbortError has no `code`, so its transparent-reconnect
      // path would never trigger).
      if (error instanceof SessionExpiredError || error instanceof RpcServerError
        || error instanceof RpcClosedError || error instanceof RpcTimeoutError) {
        throw error;
      }
      if (timeoutController.signal.aborted) {
        throw new RpcTimeoutError(`request ${method} timed out after ${timeoutMs}ms`);
      }
      if (options.signal?.aborted) {
        throw new RpcClosedError(`request ${method} aborted`);
      }
      throw new RpcClosedError(`request ${method} stream failed: ${error?.message ?? error}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Parse a single-JSON response body and extract our reply.
   * @param {Response} response - the fetch response.
   * @param {number} id - the request id we sent.
   * @param {string} method - method name (for messages).
   * @returns {Promise<unknown>} the JSON-RPC result.
   */
  async _readJson(response, id, method) {
    const text = await safeText(response);
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      throw new RpcClosedError(`server returned non-JSON on ${method}: ${text.slice(0, 200)}`);
    }
    // Some servers wrap batched replies in an array.
    const messages = Array.isArray(message) ? message : [message];
    return this._extractResult(messages, id, method);
  }

  /**
   * Read an SSE stream, forwarding notifications and returning our reply.
   * @param {Response} response - the fetch response with an SSE body.
   * @param {number} id - the request id we sent.
   * @param {string} method - method name (for messages).
   * @returns {Promise<unknown>} the JSON-RPC result.
   */
  async _readSse(response, id, method) {
    if (!response.body) throw new RpcClosedError(`empty SSE body on ${method}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    /** @type {object[]} */
    const collected = [];

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Bound the buffer: a server that streams forever without an event
        // delimiter would otherwise grow it without limit (the request timeout
        // caps time, not memory).
        if (buffer.length > MAX_SSE_BUFFER) {
          throw new RpcClosedError(`SSE stream on ${method} exceeded ${MAX_SSE_BUFFER} chars without a complete event`);
        }

        // SSE events are separated by a blank line. Servers legitimately use LF
        // (`\n\n`), CRLF (`\r\n\r\n`), or bare CR (`\r\r`) — most real HTTP
        // servers use CRLF, so matching only `\n\n` would stall forever on them.
        let match = SSE_EVENT_DELIMITER.exec(buffer);
        while (match) {
          const rawEvent = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          const payload = parseSseData(rawEvent);
          if (payload) {
            let parsed;
            try {
              parsed = JSON.parse(payload);
            } catch {
              this._warn(`http: dropped a non-JSON SSE frame on ${method}`);
              parsed = undefined;
            }
            if (parsed) {
              const items = Array.isArray(parsed) ? parsed : [parsed];
              for (const item of items) {
                if (isOurReply(item, id)) {
                  collected.push(item);
                } else if (item.method !== undefined) {
                  this._forwardNotification(item);
                }
              }
              // Once our reply is in, we can stop reading the stream.
              if (collected.length > 0) {
                return this._extractResult(collected, id, method);
              }
            }
          }
          match = SSE_EVENT_DELIMITER.exec(buffer);
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // stream already closed
      }
    }

    if (collected.length > 0) return this._extractResult(collected, id, method);
    throw new RpcClosedError(`SSE stream on ${method} closed before a reply arrived`);
  }

  /**
   * Pick our reply out of a batch and unwrap result/error.
   * @param {object[]} messages - parsed JSON-RPC messages.
   * @param {number} id - our request id.
   * @param {string} method - method name.
   * @returns {unknown} the result.
   */
  _extractResult(messages, id, method) {
    for (const message of messages) {
      if (message.method !== undefined && message.id === undefined) {
        this._forwardNotification(message);
        continue;
      }
      if (isOurReply(message, id)) {
        if (message.error) {
          throw new RpcServerError(message.error.message ?? 'server error', message.error.code, message.error.data);
        }
        return message.result;
      }
    }
    throw new RpcClosedError(`no reply for ${method} in server response`);
  }

  /**
   * Deliver a server notification to the listener, guarding against faults.
   * @param {object} message - a JSON-RPC notification.
   */
  _forwardNotification(message) {
    if (!this._onNotification) return;
    try {
      this._onNotification(message);
    } catch {
      // A listener fault must not poison the transport.
    }
  }

  /**
   * Send a notification (best-effort; failures are swallowed).
   * @param {string} method - method name.
   * @param {object} [params] - params.
   */
  async notify(method, params) {
    if (this._closed) return;
    try {
      await this.request(method, params, { timeoutMs: 5_000 });
    } catch {
      // Notifications are fire-and-forget.
    }
  }

  /** Mark the transport closed. Idempotent; there is no socket to release. */
  async stop() {
    this._closed = true;
  }

  /** @returns {boolean} whether closed. */
  get closed() {
    return this._closed;
  }

  /** @returns {string | undefined} the negotiated session id, if any. */
  get sessionId() {
    return this._sessionId;
  }
}

/**
 * Read a response body as text without throwing.
 * @param {Response} response - fetch response.
 * @returns {Promise<string>} body text, or empty string on failure.
 */
async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/**
 * Extract the concatenated `data:` payload from one SSE event block.
 * @param {string} rawEvent - the text between blank-line separators.
 * @returns {string | undefined} the data payload, or undefined for non-data events.
 */
function parseSseData(rawEvent) {
  // Split on any line terminator so CRLF streams do not leave a trailing \r on
  // each field (which would ride into the JSON payload).
  const lines = rawEvent.split(/\r\n|\n|\r/);
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  return dataLines.length > 0 ? dataLines.join('\n') : undefined;
}

/**
 * Test whether a message is the reply to our request id.
 * @param {object} message - a JSON-RPC message.
 * @param {number} id - our request id.
 * @returns {boolean} true when it is our response.
 */
function isOurReply(message, id) {
  return message && typeof message === 'object' && message.id === id && message.method === undefined;
}
