/**
 * Stdio transport for local MCP servers spawned as child processes.
 *
 * This is where most real-world crashes originate — a child that dies, a pipe
 * that breaks (EPIPE), a server that floods a partial line — so every failure
 * mode here is handled explicitly and converted into a clean close rather than
 * an unhandled exception that would take the whole DSH process down.
 *
 * Framing is newline-delimited JSON (the MCP stdio convention): each message is
 * one line on stdout. A partial trailing line is buffered until its newline
 * arrives; a line that is not valid JSON is dropped with a warning, never
 * thrown.
 *
 * @module dsh-mcp-adapter/transport/stdio
 */

import { spawn } from 'node:child_process';

import { JsonRpcClient, RpcClosedError } from './jsonrpc.js';

/** Hard ceiling on a single unframed stdout line, to bound memory against a runaway server. */
const MAX_LINE_BYTES = 16 * 1024 * 1024;

/** Hard ceiling on buffered stderr before the tail is retained. */
const MAX_STDERR_BYTES = 1024 * 1024;

/**
 * A live stdio connection to one MCP server process.
 */
export class StdioTransport {
  /**
   * @param {object} options - spawn + behaviour config.
   * @param {string} options.command - executable to run.
   * @param {string[]} [options.args] - command arguments.
   * @param {Record<string, string>} [options.env] - extra environment variables.
   * @param {string} [options.cwd] - working directory.
   * @param {number} [options.defaultTimeoutMs] - per-request timeout.
   * @param {(message: object) => void} [options.onNotification] - server notifications.
   * @param {(reason: Error) => void} [options.onClose] - called once when the transport dies.
   * @param {(line: string) => void} [options.onStderr] - server stderr lines (diagnostics).
   * @param {(msg: string) => void} [options.warn] - warning sink.
   */
  constructor(options) {
    this._options = options;
    this._child = undefined;
    this._stdoutBuffer = '';
    this._closed = false;
    this._closeReason = undefined;
    /** @type {JsonRpcClient | undefined} */
    this.rpc = undefined;
  }

  /**
   * Spawn the process and wire up the JSON-RPC core. Resolves once the child is
   * running; it does NOT wait for `initialize` (the caller does that).
   * @returns {Promise<void>}
   */
  async start() {
    const { command, args = [], env, cwd } = this._options;

    // A spawn failure (ENOENT for a missing binary) surfaces as an async
    // 'error' event, not a throw, so it is caught and turned into a close.
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(env ?? {}) },
      ...(cwd ? { cwd } : {}),
    });
    this._child = child;

    this.rpc = new JsonRpcClient({
      send: (message) => this._write(message),
      defaultTimeoutMs: this._options.defaultTimeoutMs,
      onNotification: this._options.onNotification,
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this._onStdout(chunk));
    child.stdout.on('error', (error) => this._die(error));

    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      let stderrBuffer = '';
      child.stderr.on('data', (chunk) => {
        if (this._closed) return;
        stderrBuffer += chunk;
        // Bound stderr the same way as stdout: a server that logs a huge line
        // without a newline (progress bar, memory dump, runaway loop) must not
        // grow this buffer without limit. Keep only the most recent tail.
        if (stderrBuffer.length > MAX_STDERR_BYTES) {
          stderrBuffer = stderrBuffer.slice(-64 * 1024);
        }
        let index = stderrBuffer.indexOf('\n');
        while (index !== -1) {
          const line = stderrBuffer.slice(0, index);
          stderrBuffer = stderrBuffer.slice(index + 1);
          if (line && this._options.onStderr) this._options.onStderr(line);
          index = stderrBuffer.indexOf('\n');
        }
      });
      child.stderr.on('error', () => {}); // stderr faults are non-fatal
    }

    // stdin EPIPE is the classic crasher: writing to a dead child throws
    // asynchronously on the stream. A broken pipe does not prove the child is
    // gone, so reap it to avoid an orphan.
    child.stdin.on('error', (error) => this._die(error, { reap: true }));

    // A spawn/runtime 'error' (e.g. ENOENT) usually means no live child, but
    // reap defensively; the kill is guarded on exitCode.
    child.on('error', (error) => this._die(error, { reap: true }));
    // On 'exit' the child is already gone — no reap needed.
    child.on('exit', (code, signal) => {
      this._die(new RpcClosedError(`server process exited (code=${code}, signal=${signal})`));
    });

    // Give the event loop a tick so an immediate spawn error (ENOENT) settles
    // the transport before the caller tries to initialize.
    await new Promise((resolve) => setImmediate(resolve));
    if (this._closed) throw this._closeReason ?? new RpcClosedError('server failed to start');
  }

  /**
   * Serialize and write one message to the child's stdin.
   * @param {object} message - a JSON-RPC message.
   */
  _write(message) {
    if (this._closed || !this._child) throw new RpcClosedError('stdio transport is closed');
    const line = `${JSON.stringify(message)}\n`;
    // A false return means the kernel buffer is full; that is backpressure, not
    // an error — the write is still queued. A genuine failure arrives via the
    // 'error' event wired in start().
    this._child.stdin.write(line);
  }

  /**
   * Accumulate stdout and dispatch each complete line.
   * @param {string} chunk - decoded stdout text.
   */
  _onStdout(chunk) {
    // Once dead, stop consuming: without this guard a server that keeps
    // streaming after an overflow death would append forever (the second _die
    // is a no-op, so the size check never re-fires) and OOM the host.
    if (this._closed) return;
    this._stdoutBuffer += chunk;
    if (this._stdoutBuffer.length > MAX_LINE_BYTES) {
      // A server that never emits a newline would otherwise grow unbounded.
      // Drop the buffer and reap the child NOW; _die alone does not kill it, and
      // the manager's close handler does not either, so it would orphan.
      this._stdoutBuffer = '';
      this._die(new RpcClosedError('server stdout exceeded the maximum line size without framing'), { reap: true });
      return;
    }
    let index = this._stdoutBuffer.indexOf('\n');
    while (index !== -1) {
      const line = this._stdoutBuffer.slice(0, index).trim();
      this._stdoutBuffer = this._stdoutBuffer.slice(index + 1);
      if (line) this._dispatchLine(line);
      index = this._stdoutBuffer.indexOf('\n');
    }
  }

  /**
   * Parse and route one line, tolerating malformed input.
   * @param {string} line - a single stdout line.
   */
  _dispatchLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this._options.warn?.(`stdio: dropped a non-JSON line from server (${line.length} chars)`);
      return;
    }
    this.rpc?.receive(message);
  }

  /**
   * Settle the transport as dead exactly once, rejecting pending requests.
   * @param {Error} reason - why it died.
   */
  _die(reason, { reap = false } = {}) {
    if (this._closed) return;
    this._closed = true;
    this._closeReason = reason;
    // Reap the child only for deaths that originate INSIDE the transport while
    // the child may still be alive (stdout overflow, stdin EPIPE, spawn error):
    // the manager's onClose handler does not kill the process, so without this
    // it would orphan. The normal 'exit' path passes reap:false (already gone),
    // and stop() does its own graceful SIGTERM→SIGKILL, so it passes reap:false
    // too — an unconditional kill here would defeat that grace period.
    if (reap) {
      const child = this._child;
      if (child && child.exitCode === null && child.signalCode === null) {
        try {
          child.stdout?.destroy();
          child.kill('SIGKILL');
        } catch {
          // already gone or not killable
        }
      }
    }
    this.rpc?.close(reason);
    try {
      this._options.onClose?.(reason);
    } catch {
      // an onClose listener fault must not re-enter or escape _die
    }
  }

  /**
   * Terminate the child and release resources. Idempotent.
   * @returns {Promise<void>}
   */
  async stop() {
    const child = this._child;
    this._die(new RpcClosedError('transport stopped by adapter'));
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill('SIGTERM');
    } catch {
      return;
    }
    // Escalate to SIGKILL if the child ignores SIGTERM, so a stuck server can
    // never wedge shutdown.
    await new Promise((resolve) => {
      // The child may already have exited between the kill above and here; if we
      // only registered once('exit') we would wait the full 2s for an event that
      // already fired. Check synchronously first.
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
        resolve();
      }, 2_000);
      if (typeof timer.unref === 'function') timer.unref();
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** @returns {boolean} whether the transport is closed. */
  get closed() {
    return this._closed;
  }
}
