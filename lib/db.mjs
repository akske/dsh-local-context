// Local FTS5 knowledge base on top of node:sqlite (Node 24 built-in).
// Schema: one trigram-indexed FTS5 table + a small meta table.
// No native modules, no third-party packages.

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeSnippet } from './text.mjs';

export const DB_PATH_ENV = 'DSH_LOCAL_CONTEXT_DB';
export const MAX_INDEX_CHARS = 1_000_000;
export const MAX_INDEX_CHUNKS = 1_000;
export const DEFAULT_LIMIT = 3;
export const MAX_LIMIT = 10;

const SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
  title,
  content,
  source UNINDEXED,
  kind UNINDEXED,
  origin UNINDEXED,
  created_at UNINDEXED,
  tokenize='trigram'
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const connections = new Map();

/**
 * Portable default: $DSH_HOME/local-context/local_context.db, falling back to
 * ~/.dsh/local-context/local_context.db. Deliberately outside the package
 * directory, so a clone never accumulates runtime data.
 */
export function defaultDbPath(env = process.env) {
  const configuredHome = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  const home = configuredHome || join(homedir(), '.dsh');
  return join(home, 'local-context', 'local_context.db');
}

/** Resolve the database path: config.dbPath > env > portable default. */
export function resolveDbPath(config = {}, env = process.env) {
  const configured = typeof config?.dbPath === 'string' ? config.dbPath.trim() : '';
  if (configured) return resolve(configured);
  const fromEnv = typeof env?.[DB_PATH_ENV] === 'string' ? env[DB_PATH_ENV].trim() : '';
  if (fromEnv) return resolve(fromEnv);
  return resolve(defaultDbPath(env));
}

/** Open (once per resolved path) and initialize the database. */
export function openDb(dbPath) {
  const key = resolve(dbPath);
  const cached = connections.get(key);
  if (cached) return cached;

  mkdirSync(dirname(key), { recursive: true });
  const db = new DatabaseSync(key);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  const entry = { db, path: key };
  connections.set(key, entry);
  return entry;
}

export function closeDb(dbPath) {
  const key = resolve(dbPath);
  const entry = connections.get(key);
  if (!entry) return;
  connections.delete(key);
  try { entry.db.close(); } catch { /* ignore */ }
}

export function closeAll() {
  for (const key of [...connections.keys()]) {
    const entry = connections.get(key);
    connections.delete(key);
    try { entry.db.close(); } catch { /* ignore */ }
  }
}

/** Remove every chunk of one source and insert the new chunks atomically. */
export function replaceSource(dbPath, payload) {
  const { source, kind, origin, chunks, createdAt } = payload;
  if (!Array.isArray(chunks) || chunks.length === 0) return 0;
  const { db } = openDb(dbPath);
  const insert = db.prepare(
    'INSERT INTO chunks (title, content, source, kind, origin, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const remove = db.prepare('DELETE FROM chunks WHERE source = ?');
  const stamp = typeof createdAt === 'string' && createdAt ? createdAt : new Date().toISOString();

  db.exec('BEGIN IMMEDIATE');
  try {
    remove.run(source);
    for (const chunk of chunks) {
      insert.run(chunk.title, chunk.content, source, kind ?? '', origin ?? '', stamp);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  }
  return chunks.length;
}

export function countChunks(dbPath) {
  const { db } = openDb(dbPath);
  const row = db.prepare('SELECT count(*) AS total FROM chunks').get();
  return Number(row?.total ?? 0);
}

export function tokenizeQuery(query) {
  const cleaned = String(query ?? '').replace(/["'(){}[\]*:^~]/g, ' ');
  return cleaned.split(/\s+/).map((token) => token.trim()).filter(Boolean);
}

function quoteTerm(token) {
  return `"${token.replace(/"/g, '')}"`;
}

function likePattern(value) {
  return `%${String(value).replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

function toRows(rows, tokens, full) {
  return rows.map((row) => ({
    title: row.title,
    source: row.source,
    kind: row.kind,
    origin: row.origin,
    createdAt: row.created_at,
    rank: row.rank,
    snippet: makeSnippet(row.content, tokens),
    content: full ? row.content : undefined,
  }));
}

/**
 * Relevance search. Strategy: trigram MATCH (all terms) -> MATCH (any term)
 * -> LIKE (short or unindexable queries). Short CJK queries (1-2 chars) are
 * served by the LIKE fallback because the trigram tokenizer needs 3+ chars.
 */
export function searchChunks(dbPath, query, options = {}) {
  const rawQuery = String(query ?? '').trim();
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(options.limit) ? Math.floor(options.limit) : DEFAULT_LIMIT));
  const full = options.full === true;
  const tokens = tokenizeQuery(rawQuery);
  const { db } = openDb(dbPath);
  const total = countChunks(dbPath);

  if (!rawQuery || tokens.length === 0) {
    return { rows: [], total, mode: 'none', limit, full };
  }

  const longTokens = tokens.filter((token) => [...token].length >= 3);
  const attempts = [];
  if (longTokens.length > 0) {
    attempts.push({
      mode: 'fts',
      sql: 'SELECT title, content, source, kind, origin, created_at, bm25(chunks, 5.0, 1.0) AS rank FROM chunks WHERE chunks MATCH ? ORDER BY rank LIMIT ?',
      params: [longTokens.map(quoteTerm).join(' AND '), limit],
    });
    if (longTokens.length > 1) {
      attempts.push({
        mode: 'fts-or',
        sql: 'SELECT title, content, source, kind, origin, created_at, bm25(chunks, 5.0, 1.0) AS rank FROM chunks WHERE chunks MATCH ? ORDER BY rank LIMIT ?',
        params: [longTokens.map(quoteTerm).join(' OR '), limit],
      });
    }
  }

  attempts.push({
    mode: 'like',
    sql: "SELECT title, content, source, kind, origin, created_at, 0.0 AS rank FROM chunks WHERE (content LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\') ORDER BY created_at DESC, title ASC LIMIT ?",
    params: [likePattern(rawQuery), likePattern(rawQuery), limit],
  });
  if (tokens.length > 1) {
    const andClause = tokens.map(() => "(content LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')").join(' AND ');
    attempts.push({
      mode: 'like-and',
      sql: `SELECT title, content, source, kind, origin, created_at, 0.0 AS rank FROM chunks WHERE ${andClause} ORDER BY created_at DESC, title ASC LIMIT ?`,
      params: [...tokens.flatMap((token) => [likePattern(token), likePattern(token)]), limit],
    });
  }

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const rows = db.prepare(attempt.sql).all(...attempt.params);
      // A strategy that executes successfully resets the error: an empty result
      // is a valid outcome, not a failure.
      lastError = null;
      if (rows.length > 0) {
        return { rows: toRows(rows, tokens, full), total, mode: attempt.mode, limit, full };
      }
    } catch (error) {
      // FTS5 syntax/shape errors fall through to the LIKE attempts.
      if (!lastError) lastError = error;
    }
  }

  if (lastError) throw lastError;
  return { rows: [], total, mode: 'none', limit, full };
}
