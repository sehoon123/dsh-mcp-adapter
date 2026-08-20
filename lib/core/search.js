/**
 * Tool search ranking.
 *
 * When the model calls the proxy with `{ search: "screenshot" }` it must get the
 * right tool back even though it never saw the full catalog. The ranking here is
 * a field-weighted token/phrase scorer adapted from the approach pi-mcp-adapter
 * uses: exact and prefix phrase matches score highest, then per-token exact and
 * stem matches, across name/server/description/keyword fields with different
 * weights. It is pure and synchronous, so it works entirely from the offline
 * metadata cache without touching any server.
 *
 * @module dsh-mcp-adapter/core/search
 */

/** Shortest field token allowed to stem-match a longer query token. */
const MIN_STEM_LENGTH = 4;

/** Per-field score multipliers; a name hit matters far more than a description hit. */
const FIELD_WEIGHTS = { name: 12, server: 8, description: 5, keywords: 5 };

/**
 * Split camelCase and punctuation into space-separated lowercase text.
 * @param {string} value - raw text.
 * @returns {string} normalized text.
 */
export function normalizeText(value) {
  return String(value ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_./:-]+/g, ' ')
    .toLowerCase();
}

/**
 * Tokenize into lowercase alphanumeric tokens.
 * @param {string} value - raw text.
 * @returns {string[]} tokens.
 */
export function tokenize(value) {
  return normalizeText(value).split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Score one tool against a query. Returns null for no match.
 *
 * @param {object} tool - `{ name, description, keywords? }`.
 * @param {string} server - the server name.
 * @param {string} query - the search query.
 * @returns {number | null} a positive score, or null.
 */
export function scoreTool(tool, server, query) {
  const normalizedQuery = normalizeText(query).trim();
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return null;

  const fields = {
    name: normalizeText(tool.name),
    server: normalizeText(server),
    description: normalizeText(tool.description ?? ''),
    keywords: normalizeText((tool.keywords ?? []).join(' ')),
  };

  let score = 0;
  const matched = new Set();

  for (const [field, value] of Object.entries(fields)) {
    if (!value) continue;
    const weight = FIELD_WEIGHTS[field];
    const fieldTokens = tokenize(value);

    // Whole-query phrase tiers.
    if (value === normalizedQuery) score += weight * 14;
    else if (value.startsWith(normalizedQuery)) score += weight * 9;
    else if (normalizedQuery.length >= 3 && value.includes(normalizedQuery)) score += weight * 6;

    // Per-token tiers.
    for (const token of queryTokens) {
      if (fieldTokens.includes(token)) {
        score += weight * 4;
        matched.add(token);
      } else if (fieldTokens.some((ft) => ft.startsWith(token) || (ft.length >= MIN_STEM_LENGTH && token.startsWith(ft)))) {
        score += weight * 2;
        matched.add(token);
      } else if (token.length >= 3 && value.includes(token)) {
        score += weight;
        matched.add(token);
      }
    }
  }

  // Require at least one real token match; a bare substring coincidence is noise.
  if (matched.size === 0) return null;

  // Reward covering more of the query's tokens.
  score += matched.size * 3;
  return score;
}

/**
 * Rank a catalog of tools against a query.
 *
 * @param {Array<{server: string, name: string, description?: string, keywords?: string[]}>} tools - flat catalog.
 * @param {string} query - the search query.
 * @param {number} [limit] - max results.
 * @returns {Array<{server: string, name: string, description?: string, score: number}>} ranked matches.
 */
export function searchTools(tools, query, limit = 10) {
  const scored = [];
  for (const tool of tools) {
    const score = scoreTool(tool, tool.server, query);
    if (score !== null) scored.push({ ...tool, score });
  }
  scored.sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name));
  return scored.slice(0, Math.max(1, limit));
}
