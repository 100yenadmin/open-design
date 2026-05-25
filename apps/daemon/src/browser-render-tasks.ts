import type Database from 'better-sqlite3';
import type { BrowserRenderFormat } from './browser-render.js';

export type BrowserRenderTaskStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'interrupted';

export interface BrowserRenderTaskError {
  message: string;
  status?: number;
  code?: string;
}

export interface BrowserRenderTaskRow {
  id: string;
  projectId: string;
  status: BrowserRenderTaskStatus;
  format: BrowserRenderFormat;
  entry: string;
  output: string;
  progress: string[];
  file: unknown | null;
  error: BrowserRenderTaskError | null;
  startedAt: number;
  endedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface BrowserRenderTaskInsert {
  id: string;
  projectId: string;
  status?: BrowserRenderTaskStatus;
  format: BrowserRenderFormat;
  entry: string;
  output: string;
  progress?: string[];
  file?: unknown | null;
  error?: BrowserRenderTaskError | null;
  startedAt?: number;
  endedAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
}

export interface BrowserRenderTaskPatch {
  status?: BrowserRenderTaskStatus;
  progress?: string[];
  file?: unknown | null;
  error?: BrowserRenderTaskError | null;
  startedAt?: number;
  endedAt?: number | null;
  updatedAt?: number;
}

interface RawBrowserRenderTaskRow {
  id: string;
  projectId: string;
  status: string;
  format: string;
  entry: string;
  output: string;
  progressJson: string | null;
  fileJson: string | null;
  errorJson: string | null;
  startedAt: number;
  endedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

const VALID_STATUSES: ReadonlySet<string> = new Set([
  'queued',
  'running',
  'done',
  'failed',
  'interrupted',
]);

const VALID_FORMATS: ReadonlySet<string> = new Set(['screenshot', 'pdf']);
const TERMINAL_STATUSES = new Set(['done', 'failed', 'interrupted']);

const COLS = `
  id,
  project_id AS projectId,
  status,
  format,
  entry,
  output,
  progress_json AS progressJson,
  file_json AS fileJson,
  error_json AS errorJson,
  started_at AS startedAt,
  ended_at AS endedAt,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

export function migrateBrowserRenderTasks(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS browser_render_tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN
        ('queued','running','done','failed','interrupted')),
      format TEXT NOT NULL CHECK (format IN ('screenshot','pdf')),
      entry TEXT NOT NULL,
      output TEXT NOT NULL,
      progress_json TEXT NOT NULL DEFAULT '[]',
      file_json TEXT,
      error_json TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_browser_render_tasks_project
      ON browser_render_tasks(project_id, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_browser_render_tasks_status
      ON browser_render_tasks(status, updated_at DESC);
  `);
}

export function insertBrowserRenderTask(
  db: Database.Database,
  input: BrowserRenderTaskInsert,
): BrowserRenderTaskRow {
  const now = Date.now();
  const status = input.status ?? 'queued';
  assertValidStatus(status);
  assertValidFormat(input.format);
  const startedAt = input.startedAt ?? now;
  db.prepare(
    `INSERT INTO browser_render_tasks
       (id, project_id, status, format, entry, output, progress_json,
        file_json, error_json, started_at, ended_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.projectId,
    status,
    input.format,
    input.entry,
    input.output,
    JSON.stringify(input.progress ?? []),
    jsonOrNull(input.file ?? null),
    jsonOrNull(input.error ?? null),
    startedAt,
    input.endedAt ?? null,
    input.createdAt ?? startedAt,
    input.updatedAt ?? now,
  );
  const row = getBrowserRenderTask(db, input.id);
  if (row === null) {
    throw new Error(`Failed to fetch browser render task after insert: ${input.id}`);
  }
  return row;
}

export function getBrowserRenderTask(
  db: Database.Database,
  id: string,
): BrowserRenderTaskRow | null {
  const raw = db
    .prepare(`SELECT ${COLS} FROM browser_render_tasks WHERE id = ?`)
    .get(id) as RawBrowserRenderTaskRow | undefined;
  return raw ? normalizeRow(raw) : null;
}

export function updateBrowserRenderTask(
  db: Database.Database,
  id: string,
  patch: BrowserRenderTaskPatch,
): BrowserRenderTaskRow | null {
  const existing = getBrowserRenderTask(db, id);
  if (existing === null) return null;
  const status = patch.status ?? existing.status;
  assertValidStatus(status);
  const updatedAt = patch.updatedAt ?? Date.now();
  db.prepare(
    `UPDATE browser_render_tasks
        SET status = ?,
            progress_json = ?,
            file_json = ?,
            error_json = ?,
            started_at = ?,
            ended_at = ?,
            updated_at = ?
      WHERE id = ?`,
  ).run(
    status,
    JSON.stringify(patch.progress ?? existing.progress),
    'file' in patch ? jsonOrNull(patch.file ?? null) : jsonOrNull(existing.file),
    'error' in patch ? jsonOrNull(patch.error ?? null) : jsonOrNull(existing.error),
    patch.startedAt ?? existing.startedAt,
    'endedAt' in patch ? patch.endedAt ?? null : existing.endedAt,
    updatedAt,
    id,
  );
  return getBrowserRenderTask(db, id);
}

export function listBrowserRenderTasksByProject(
  db: Database.Database,
  projectId: string,
  options: { includeTerminal?: boolean } = {},
): BrowserRenderTaskRow[] {
  const includeTerminal = options.includeTerminal === true;
  const rows = db
    .prepare(
      `SELECT ${COLS}
         FROM browser_render_tasks
        WHERE project_id = ?
        ORDER BY started_at DESC`,
    )
    .all(projectId) as RawBrowserRenderTaskRow[];
  return rows
    .map(normalizeRow)
    .filter((row) => includeTerminal || !TERMINAL_STATUSES.has(row.status));
}

export function deleteBrowserRenderTask(db: Database.Database, id: string): void {
  db.prepare(`DELETE FROM browser_render_tasks WHERE id = ?`).run(id);
}

export function reconcileBrowserRenderTasksOnBoot(
  db: Database.Database,
  options: { terminalTtlMs: number; now?: number },
): { interrupted: number; deleted: number } {
  const now = options.now ?? Date.now();
  const cutoff = now - options.terminalTtlMs;
  const interruptedError: BrowserRenderTaskError = {
    message: 'browser render task interrupted by daemon restart',
    status: 5,
    code: 'DAEMON_RESTART',
  };
  const tx = db.transaction(() => {
    const interrupted = db
      .prepare(
        `UPDATE browser_render_tasks
            SET status = 'interrupted',
                error_json = ?,
                ended_at = COALESCE(ended_at, ?),
                updated_at = ?
          WHERE status IN ('queued', 'running')`,
      )
      .run(JSON.stringify(interruptedError), now, now).changes;

    const deleted = db
      .prepare(
        `DELETE FROM browser_render_tasks
          WHERE status IN ('done', 'failed', 'interrupted')
            AND COALESCE(ended_at, updated_at) < ?`,
      )
      .run(cutoff).changes;

    return { interrupted, deleted };
  });
  return tx() as { interrupted: number; deleted: number };
}

function normalizeRow(raw: RawBrowserRenderTaskRow): BrowserRenderTaskRow {
  assertValidStatus(raw.status);
  assertValidFormat(raw.format);
  return {
    id: raw.id,
    projectId: raw.projectId,
    status: raw.status as BrowserRenderTaskStatus,
    format: raw.format as BrowserRenderFormat,
    entry: raw.entry,
    output: raw.output,
    progress: parseArray(raw.progressJson),
    file: parseJson(raw.fileJson),
    error: normalizeError(parseJson(raw.errorJson)),
    startedAt: Number(raw.startedAt),
    endedAt: raw.endedAt == null ? null : Number(raw.endedAt),
    createdAt: Number(raw.createdAt),
    updatedAt: Number(raw.updatedAt),
  };
}

function assertValidStatus(status: string): void {
  if (!VALID_STATUSES.has(status)) {
    throw new RangeError(`Invalid browser render task status: "${status}"`);
  }
}

function assertValidFormat(format: string): void {
  if (!VALID_FORMATS.has(format)) {
    throw new RangeError(`Invalid browser render format: "${format}"`);
  }
}

function parseArray(json: string | null): string[] {
  const parsed = parseJson(json);
  return Array.isArray(parsed)
    ? parsed.filter((line): line is string => typeof line === 'string')
    : [];
}

function normalizeError(value: unknown): BrowserRenderTaskError | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const message = typeof obj.message === 'string' ? obj.message : '';
  if (!message) return null;
  const error: BrowserRenderTaskError = { message };
  if (typeof obj.status === 'number') error.status = obj.status;
  if (typeof obj.code === 'string') error.code = obj.code;
  return error;
}

function parseJson(json: string | null): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function jsonOrNull(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}
