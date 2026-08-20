/**
 * Output guard: keep a single tool result from blowing up the context window.
 *
 * MCP tools — a Burp scan, a Falcon incident dump, a SQL result — can return
 * megabytes. Feeding that verbatim into the model both wastes the context you
 * were trying to save and can destabilize a turn. This guard measures a result;
 * if it is within budget it passes through untouched, and if not it keeps a
 * head preview, spills the full text to a mode-0600 temp file, and tells the
 * model exactly how to read the rest.
 *
 * Adapted from pi-mcp-adapter's output guard, trimmed to text/image blocks.
 *
 * @module dsh-mcp-adapter/core/output-guard
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Default maximum bytes of tool text kept inline. */
export const DEFAULT_MAX_BYTES = 50 * 1024;
/** Default maximum lines kept inline. */
export const DEFAULT_MAX_LINES = 2_000;

/**
 * Measure text size in bytes and lines.
 * @param {string} text - the text.
 * @returns {{bytes: number, lines: number}} stats.
 */
function measure(text) {
  return { bytes: Buffer.byteLength(text, 'utf8'), lines: text.length === 0 ? 0 : text.split('\n').length };
}

/**
 * Truncate text to a byte and line budget, cutting on a line boundary.
 * @param {string} text - source text.
 * @param {number} maxBytes - byte budget.
 * @param {number} maxLines - line budget.
 * @returns {string} the head slice.
 */
function head(text, maxBytes, maxLines) {
  const lines = text.split('\n');
  const out = [];
  let bytes = 0;
  for (let i = 0; i < lines.length && i < maxLines; i += 1) {
    const lineBytes = Buffer.byteLength(lines[i], 'utf8') + 1;
    if (bytes + lineBytes > maxBytes) break;
    out.push(lines[i]);
    bytes += lineBytes;
  }
  return out.join('\n');
}

/**
 * Spill full text to a private temp file. Returns the path, or undefined if the
 * write fails (in which case the caller keeps the preview only).
 * @param {string} text - full text.
 * @param {(msg: string) => void} warn - warning sink.
 * @returns {string | undefined} the file path.
 */
function spill(text, warn) {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-mcp-output-'));
    const path = join(dir, 'output.txt');
    writeFileSync(path, text, { encoding: 'utf8', mode: 0o600 });
    return path;
  } catch (error) {
    warn?.(`could not spill oversized MCP output: ${error.message}`);
    return undefined;
  }
}

/**
 * Flatten MCP `content` blocks into one text string plus a count of image blocks.
 * @param {unknown} content - MCP result content array.
 * @returns {{text: string, images: number}} flattened text and image count.
 */
export function flattenContent(content) {
  if (!Array.isArray(content)) {
    // Non-standard result: stringify defensively so it is still bounded later.
    return { text: typeof content === 'string' ? content : JSON.stringify(content ?? null), images: 0 };
  }
  const parts = [];
  let images = 0;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image') images += 1;
    else if (block.type === 'resource' && block.resource?.text) parts.push(String(block.resource.text));
    else parts.push(JSON.stringify(block));
  }
  return { text: parts.join('\n'), images };
}

/**
 * Guard a tool result's text, spilling to a file when oversized.
 *
 * @param {unknown} content - MCP result `content` array.
 * @param {object} [options] - `{ maxBytes, maxLines, warn }`.
 * @returns {{text: string, truncated: boolean, images: number, fullPath?: string, originalBytes: number}}
 */
export function guardOutput(content, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const warn = options.warn;

  const { text, images } = flattenContent(content);
  const stats = measure(text);

  if (stats.bytes <= maxBytes && stats.lines <= maxLines) {
    return { text, truncated: false, images, originalBytes: stats.bytes };
  }

  // Reserve a little room so the notice itself fits within budget.
  const preview = head(text, Math.max(1_024, maxBytes - 512), maxLines);
  const fullPath = spill(text, warn);
  const notice = fullPath
    ? `\n\n[MCP output truncated: ${stats.lines.toLocaleString()} lines / ${formatSize(stats.bytes)}. Full output saved to ${fullPath} — use the read tool with offset/limit, or grep, to inspect it.]`
    : `\n\n[MCP output truncated: ${stats.lines.toLocaleString()} lines / ${formatSize(stats.bytes)}. The remainder was dropped because it could not be written to a temp file.]`;

  return { text: preview + notice, truncated: true, images, fullPath, originalBytes: stats.bytes };
}

/**
 * Human-readable byte size.
 * @param {number} bytes - size in bytes.
 * @returns {string} formatted size.
 */
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
