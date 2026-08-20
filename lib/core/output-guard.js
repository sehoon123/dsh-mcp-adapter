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

/** Media types an attachment store will accept. */
const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** Cap on images carried out of one tool result. */
export const MAX_IMAGES = 8;

/** Cap on a single decoded image, to bound memory and attachment size. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * Flatten MCP `content` blocks into text plus the decoded image blocks.
 *
 * Image blocks are RETAINED (decoded to bytes), not merely counted: an MCP tool
 * like a browser `take_screenshot` returns its whole answer as an image, so
 * dropping it makes the tool useless to a vision-capable model.
 *
 * @param {unknown} content - MCP result content array.
 * @returns {{text: string, images: {bytes: Buffer, mediaType: string}[], skippedImages: number}}
 *   flattened text, decoded images, and a count of image blocks that could not be used.
 */
export function flattenContent(content) {
  if (!Array.isArray(content)) {
    // Non-standard result: stringify defensively so it is still bounded later.
    return {
      text: typeof content === 'string' ? content : JSON.stringify(content ?? null),
      images: [],
      skippedImages: 0,
    };
  }
  const parts = [];
  /** @type {{bytes: Buffer, mediaType: string}[]} */
  const images = [];
  let skippedImages = 0;

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
      continue;
    }
    if (block.type === 'image') {
      const decoded = decodeImageBlock(block);
      if (decoded && images.length < MAX_IMAGES) images.push(decoded);
      else skippedImages += 1;
      continue;
    }
    // An embedded resource may carry text or an image payload.
    if (block.type === 'resource' && block.resource && typeof block.resource === 'object') {
      const resource = block.resource;
      if (typeof resource.text === 'string') {
        parts.push(resource.text);
        continue;
      }
      const decoded = decodeImageBlock({ data: resource.blob, mimeType: resource.mimeType });
      if (decoded) {
        if (images.length < MAX_IMAGES) images.push(decoded);
        else skippedImages += 1;
        continue;
      }
    }
    parts.push(JSON.stringify(block));
  }
  return { text: parts.join('\n'), images, skippedImages };
}

/**
 * Decode one base64 image payload into bytes, rejecting anything unusable.
 * @param {{data?: unknown, mimeType?: unknown}} block - an image-bearing block.
 * @returns {{bytes: Buffer, mediaType: string} | undefined} decoded image, or undefined.
 */
function decodeImageBlock(block) {
  const mediaType = typeof block?.mimeType === 'string' ? block.mimeType.toLowerCase().split(';')[0].trim() : '';
  if (!SUPPORTED_IMAGE_TYPES.has(mediaType)) return undefined;
  if (typeof block.data !== 'string' || block.data.length === 0) return undefined;
  try {
    const bytes = Buffer.from(block.data, 'base64');
    // Reject an empty or absurdly large decode rather than pushing it downstream.
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return undefined;
    // Node's base64 decoder SILENTLY IGNORES invalid characters instead of
    // throwing, so a corrupt or mislabeled payload decodes to garbage bytes.
    // Verify the container signature so the attachment store is never handed
    // something it will reject with a confusing error.
    if (!matchesSignature(bytes, mediaType)) return undefined;
    return { bytes, mediaType };
  } catch {
    return undefined;
  }
}

/**
 * Verify decoded bytes carry the magic signature of their declared media type.
 * @param {Buffer} bytes - decoded image bytes.
 * @param {string} mediaType - the declared media type.
 * @returns {boolean} true when the signature matches.
 */
function matchesSignature(bytes, mediaType) {
  if (mediaType === 'image/png') {
    return bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
      && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  }
  if (mediaType === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mediaType === 'image/gif') {
    return bytes.length >= 6 && bytes.subarray(0, 4).toString('latin1') === 'GIF8';
  }
  if (mediaType === 'image/webp') {
    return bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF'
      && bytes.subarray(8, 12).toString('latin1') === 'WEBP';
  }
  return false;
}

/**
 * Guard a tool result's text, spilling to a file when oversized.
 *
 * @param {unknown} content - MCP result `content` array.
 * @param {object} [options] - `{ maxBytes, maxLines, warn }`.
 * @returns {{text: string, truncated: boolean, images: {bytes: Buffer, mediaType: string}[], skippedImages: number, fullPath?: string, originalBytes: number}}
 */
export function guardOutput(content, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const warn = options.warn;

  const { text, images, skippedImages } = flattenContent(content);
  const stats = measure(text);

  if (stats.bytes <= maxBytes && stats.lines <= maxLines) {
    return { text, truncated: false, images, skippedImages, originalBytes: stats.bytes };
  }

  // Reserve a little room so the notice itself fits within budget.
  const preview = head(text, Math.max(1_024, maxBytes - 512), maxLines);
  const fullPath = spill(text, warn);
  const notice = fullPath
    ? `\n\n[MCP output truncated: ${stats.lines.toLocaleString()} lines / ${formatSize(stats.bytes)}. Full output saved to ${fullPath} — use the read tool with offset/limit, or grep, to inspect it.]`
    : `\n\n[MCP output truncated: ${stats.lines.toLocaleString()} lines / ${formatSize(stats.bytes)}. The remainder was dropped because it could not be written to a temp file.]`;

  // Images are NOT dropped by truncation: only the text is oversized, and the
  // image is often the entire answer (a screenshot).
  return { text: preview + notice, truncated: true, images, skippedImages, fullPath, originalBytes: stats.bytes };
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
