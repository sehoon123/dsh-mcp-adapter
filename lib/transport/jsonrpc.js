/**
 * A tiny JSON-RPC 2.0 client core shared by every transport.
 *
 * It owns request/response correlation, per-request timeouts, and the invariant
 * that a pending request is ALWAYS settled exactly once — on reply, on timeout,
 * or on transport close. That invariant is the whole point: a dropped or
 * duplicated settlement is how an MCP client hangs a turn forever or crashes on
 * a late reply, and this adapter must never do either.
 *
 * The transport supplies a `send(message)` function and calls `receive(message)`
 * and `fail(error)`; this core knows nothing about stdio, HTTP, or sockets.
 *
 * @module dsh-mcp-adapter/transport/jsonrpc
 */

/** Error thrown when a request exceeds its deadline. */
export class RpcTimeoutError extends Error {
  /** @param {string} message - human-readable detail. */
  constructor(message) {
    super(message);
    this.name = 'RpcTimeoutError';
    this.code = 'MCP_TIMEOUT';
  }
}

/** Error carrying a JSON-RPC error object returned by the server. */
export class RpcServerError extends Error {
  /**
   * @param {string} message - the server's error message.
   * @param {number} [code] - the JSON-RPC error code.
   * @param {unknown} [data] - optional error data.
   */
  constructor(message, code, data) {
    super(message);
    this.name = 'RpcServerError';
    this.code = 'MCP_SERVER_ERROR';
    this.rpcCode = code;
    this.data = data;
  }
}

/** Error thrown when the transport closes with requests still pending. */
export class RpcClosedError extends Error {
  /** @param {string} message - human-readable detail. */
  constructor(message) {
    super(message);
    this.name = 'RpcClosedError';
    this.code = 'MCP_CLOSED';
  }
}

/**
 * The JSON-RPC correlation core.
 */
export class JsonRpcClient {
  /**
   * @param {object} options - wiring.
   * @param {(message: object) => void} options.send - deliver one message to the wire.
   * @param {number} [options.defaultTimeoutMs] - fallback per-request timeout.
   * @param {(notification: object) => void} [options.onNotification] - server-initiated messages.
   */
  constructor({ send, defaultTimeoutMs = 30_000, onNotification }) {
    this._send = send;
    this._defaultTimeoutMs = defaultTimeoutMs;
    this._onNotification = onNotification;
    this._nextId = 1;
    /** @type {Map<number, {resolve: Function, reject: Function, timer: ReturnType<typeof setTimeout>}>} */
    this._pending = new Map();
    this._closed = false;
  }

  /**
   * Issue a request and resolve with its `result`.
   *
   * @param {string} method - JSON-RPC method.
   * @param {object} [params] - method params.
   * @param {object} [options] - `{ timeoutMs, signal }`.
   * @returns {Promise<unknown>} the server result.
   */
  request(method, params, options = {}) {
    if (this._closed) {
      return Promise.reject(new RpcClosedError(`transport closed; cannot call ${method}`));
    }
    const id = this._nextId;
    this._nextId += 1;
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : this._defaultTimeoutMs;

    return new Promise((resolve, reject) => {
      // The timer is the safety net: even if the server never replies and the
      // transport never closes, this request settles. It is unref'd so a pending
      // MCP call can never, by itself, keep the process alive.
      const timer = setTimeout(() => {
        const pending = this._pending.get(id);
        if (pending) {
          this._pending.delete(id);
          this._cleanup(pending);
          reject(new RpcTimeoutError(`request ${method} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      const settle = { resolve, reject, timer, signal: options.signal, onAbort: undefined };
      this._pending.set(id, settle);

      // Optional caller cancellation, wired to the same single-settle guarantee.
      // The listener is stored on the pending record and removed on EVERY settle
      // path (reply, timeout, reject, close), not just when it fires: `{ once }`
      // alone leaks a listener per request on a long-lived/shared signal until
      // the signal is GC'd, which triggers MaxListenersExceededWarning.
      if (options.signal) {
        if (options.signal.aborted) {
          this._reject(id, new RpcClosedError(`request ${method} aborted`));
          return;
        }
        settle.onAbort = () => this._reject(id, new RpcClosedError(`request ${method} aborted`));
        options.signal.addEventListener('abort', settle.onAbort, { once: true });
      }

      try {
        this._send({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
      } catch (error) {
        // A synchronous send failure (e.g. a dead pipe) must settle now, not hang.
        this._reject(id, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Send a fire-and-forget notification (no id, no reply expected).
   * @param {string} method - JSON-RPC method.
   * @param {object} [params] - method params.
   */
  notify(method, params) {
    if (this._closed) return;
    try {
      this._send({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
    } catch {
      // A failed notification is not worth crashing over; the next request will
      // observe the dead transport and reconnect.
    }
  }

  /**
   * Feed one parsed inbound message from the transport.
   * @param {object} message - a JSON-RPC message object.
   */
  receive(message) {
    if (!message || typeof message !== 'object') return;

    // A response carries an id we issued.
    if (Object.prototype.hasOwnProperty.call(message, 'id') && message.method === undefined) {
      const id = message.id;
      const pending = this._pending.get(id);
      if (!pending) return; // late reply after timeout/close: ignore, never throw
      this._pending.delete(id);
      this._cleanup(pending);
      if (message.error) {
        pending.reject(new RpcServerError(message.error.message ?? 'server error', message.error.code, message.error.data));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    // Otherwise it is a server-initiated request or notification.
    if (message.method !== undefined && this._onNotification) {
      try {
        this._onNotification(message);
      } catch {
        // A listener fault must never poison the receive loop.
      }
    }
  }

  /**
   * Reject one pending request by id, if still present.
   * @param {number} id - request id.
   * @param {Error} error - rejection cause.
   */
  _reject(id, error) {
    const pending = this._pending.get(id);
    if (!pending) return;
    this._pending.delete(id);
    this._cleanup(pending);
    pending.reject(error);
  }

  /**
   * Release the resources held by a pending record: its timeout timer and any
   * abort listener attached to the caller's signal. Idempotent and never throws.
   * @param {{timer: any, signal?: AbortSignal, onAbort?: () => void}} pending - the record.
   */
  _cleanup(pending) {
    clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) {
      try {
        pending.signal.removeEventListener('abort', pending.onAbort);
      } catch {
        // ignore: a detached or exotic signal cannot leak once we drop the ref
      }
      pending.onAbort = undefined;
    }
  }

  /**
   * Close the client, rejecting every pending request exactly once.
   * @param {Error} [cause] - why the transport closed.
   */
  close(cause) {
    if (this._closed) return;
    this._closed = true;
    const error = cause instanceof Error ? cause : new RpcClosedError('transport closed');
    for (const [id, pending] of this._pending) {
      this._cleanup(pending);
      pending.reject(error);
      this._pending.delete(id);
    }
  }

  /** @returns {number} count of in-flight requests. */
  get pendingCount() {
    return this._pending.size;
  }
}
