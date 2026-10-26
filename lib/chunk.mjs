// Markdown-aware, fence-preserving text chunker.
// Pure functions only — no I/O, no dependencies.

export const DEFAULT_CHUNK_CHARS = 1200;
export const DEFAULT_CHUNK_HARD_MAX = 1600;

const HEADING_RE = /^(#{1,6})[ \t]+(.*)$/;
const FENCE_RE = /^[ \t]*(`{3,}|~{3,})/;

function splitLongLine(line, hardMax) {
  if (line.length <= hardMax) return [line];
  const pieces = [];
  let rest = line;
  while (rest.length > hardMax) {
    let cut = hardMax;
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) pieces.push(rest);
  return pieces;
}

/**
 * Split text into chunks of roughly `target` characters (hard cap `hardMax`),
 * preferring heading and fence boundaries. Code fences are kept in one chunk
 * unless they exceed `hardMax * 4`.
 *
 * @returns {{title: string, content: string}[]}
 */
export function chunkText(text, options = {}) {
  const baseTitle = typeof options.title === 'string' ? options.title : '';
  const target = Number.isFinite(options.target) ? options.target : DEFAULT_CHUNK_CHARS;
  const hardMax = Number.isFinite(options.hardMax) ? options.hardMax : DEFAULT_CHUNK_HARD_MAX;
  const splitHeadings = options.splitHeadings !== false;

  const source = String(text ?? '').replace(/\r\n?/g, '\n');
  const lines = source.split('\n');
  const chunks = [];
  const headingStack = [];
  const titleCounts = new Map();

  let buffer = [];
  let bufferLength = 0;
  let inFence = false;
  let fenceMarker = '';

  const headingPath = () => headingStack.map((entry) => entry.text).join(' > ');
  const chunkBaseTitle = () => {
    const heading = splitHeadings ? headingPath() : '';
    if (!heading) return baseTitle || 'untitled';
    return baseTitle ? `${baseTitle} > ${heading}` : heading;
  };

  const emit = () => {
    const content = buffer.join('\n').trim();
    buffer = [];
    bufferLength = 0;
    if (!content) return;
    const base = chunkBaseTitle();
    const seen = (titleCounts.get(base) ?? 0) + 1;
    titleCounts.set(base, seen);
    chunks.push({ title: seen === 1 ? base : `${base} (${seen})`, content });
  };

  for (const line of lines) {
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fenceMatch[1][0];
      } else if (fenceMatch[1][0] === fenceMarker) {
        inFence = false;
      }
    }

    if (!inFence && splitHeadings) {
      const heading = HEADING_RE.exec(line);
      if (heading) {
        if (bufferLength > 0) emit();
        const level = heading[1].length;
        while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
          headingStack.pop();
        }
        headingStack.push({ level, text: heading[2].trim() || `h${level}` });
      }
    }

    for (const piece of splitLongLine(line, hardMax)) {
      if (bufferLength > 0) {
        const projected = bufferLength + 1 + piece.length;
        const fenceGuard = inFence && bufferLength < hardMax * 4;
        if (projected > target && !fenceGuard) emit();
      }
      buffer.push(piece);
      bufferLength = bufferLength === 0 ? piece.length : bufferLength + 1 + piece.length;
      if (!inFence && bufferLength >= hardMax) emit();
    }
  }

  if (bufferLength > 0) emit();
  return chunks;
}
