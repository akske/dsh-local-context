// Pure text helpers: character-safe truncation and search snippets.
// No I/O, no dependencies — safe to unit test in isolation.

export const TRUNCATE_THRESHOLD = 5000;
export const KEEP_HEAD = 2000;
export const KEEP_TAIL = 2000;

export const TRUNCATION_WARNING =
  '[警告：输出过长已被智能截断，完整原始输出已存入本地知识库。你可以使用 ctx_search 工具搜索关键信息]';

/**
 * Prefix of at most `maxChars` UTF-16 code units that never ends on a lone
 * high surrogate (which would be invalid once JSON-encoded).
 */
export function charSafePrefix(str, maxChars) {
  if (maxChars <= 0) return '';
  if (str.length <= maxChars) return str;
  let end = maxChars;
  const code = str.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return str.slice(0, end);
}

/** Suffix of at most `maxChars` units that never starts on a lone low surrogate. */
export function charSafeSuffix(str, maxChars) {
  if (maxChars <= 0) return '';
  if (str.length <= maxChars) return str;
  let start = str.length - maxChars;
  const code = str.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1;
  return str.slice(start);
}

/**
 * Keep the head and tail of `output` when it is longer than `limit` characters,
 * replacing the middle with the exact omission marker required by the spec.
 * Characters are UTF-16 code units; surrogate pairs are never split.
 */
export function truncateOutput(output, options = {}) {
  const text = typeof output === 'string' ? output : String(output ?? '');
  const limit = Number.isFinite(options.limit) ? options.limit : TRUNCATE_THRESHOLD;
  const headMax = Number.isFinite(options.head) ? options.head : KEEP_HEAD;
  const tailMax = Number.isFinite(options.tail) ? options.tail : KEEP_TAIL;
  const total = text.length;
  if (total <= limit) {
    return { text, truncated: false, omitted: 0, total };
  }
  const head = charSafePrefix(text, headMax);
  const tail = charSafeSuffix(text, tailMax);
  const omitted = Math.max(0, total - head.length - tail.length);
  const marker = `\n... [省略 ${omitted} 个字符的输出] ...\n`;
  return { text: head + marker + tail, truncated: true, omitted, total };
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Wrap up to `max` case-insensitive occurrences of the terms in `**...**`. */
export function highlightTerms(text, terms, max = 3) {
  const list = Array.isArray(terms)
    ? terms.filter((term) => typeof term === 'string' && term.length > 0)
    : [];
  if (list.length === 0 || max <= 0) return text;
  const pattern = list
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
  if (!pattern) return text;
  let count = 0;
  try {
    return text.replace(new RegExp(pattern, 'gi'), (match) => {
      count += 1;
      return count <= max ? `**${match}**` : match;
    });
  } catch {
    return text;
  }
}

/**
 * Build a short snippet centered on the earliest matched term (or the head of
 * the chunk when nothing matches) and highlight up to three terms.
 */
export function makeSnippet(content, terms, maxChars = 400) {
  const text = typeof content === 'string' ? content : String(content ?? '');
  if (text.length <= maxChars) return highlightTerms(text, terms);

  const lower = text.toLowerCase();
  let index = -1;
  for (const term of Array.isArray(terms) ? terms : []) {
    if (!term) continue;
    const found = lower.indexOf(term.toLowerCase());
    if (found >= 0 && (index < 0 || found < index)) index = found;
  }
  if (index < 0) index = 0;

  const half = Math.floor(maxChars / 2);
  let start = Math.max(0, index - half);
  let end = Math.min(text.length, start + maxChars);
  start = Math.max(0, end - maxChars);

  if (start > 0) {
    const code = text.charCodeAt(start);
    if (code >= 0xdc00 && code <= 0xdfff) start += 1;
  }
  if (end < text.length) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }

  let snippet = text.slice(start, end);
  if (start > 0) snippet = `…${snippet}`;
  if (end < text.length) snippet = `${snippet}…`;
  return highlightTerms(snippet, terms);
}
