import type { Express, Request } from 'express';
import type { PathDeps, RouteDeps } from './server-context.js';
import {
  normalizeBrowserRenderRequest,
  type BrowserRenderArtifactInput,
  type BrowserRenderArtifactResult,
  type BrowserRenderRequest,
} from './browser-render.js';
import {
  getBrowserRenderTask,
  insertBrowserRenderTask,
  listBrowserRenderTasksByProject,
  reconcileBrowserRenderTasksOnBoot,
  updateBrowserRenderTask,
  type BrowserRenderTaskError,
  type BrowserRenderTaskRow,
  type BrowserRenderTaskStatus,
} from './browser-render-tasks.js';

type LiveBrowserRenderTask = BrowserRenderTaskRow & {
  request: BrowserRenderRequest;
  waiters: Set<() => void>;
  gcScheduled?: boolean;
};

export interface RegisterBrowserRenderRoutesDeps
  extends RouteDeps<'auth' | 'db' | 'http' | 'ids' | 'projectStore'> {
  paths: Pick<PathDeps, 'PROJECTS_DIR'>;
  projectFiles: {
    ensureProject?: (...args: any[]) => Promise<any>;
    listFiles?: (...args: any[]) => Promise<any>;
    readProjectFile: (...args: any[]) => Promise<any>;
    writeProjectFile: (...args: any[]) => Promise<any>;
  };
  browserRender: {
    renderBrowserArtifact: (
      input: BrowserRenderArtifactInput,
    ) => Promise<BrowserRenderArtifactResult>;
  };
}

const browserRenderTasks = new Map<string, LiveBrowserRenderTask>();
const TASK_TTL_AFTER_DONE_MS = 10 * 60 * 1000;
const TERMINAL_STATUSES = new Set<BrowserRenderTaskStatus>([
  'done',
  'failed',
  'interrupted',
]);

export function registerBrowserRenderRoutes(
  app: Express,
  ctx: RegisterBrowserRenderRoutesDeps,
) {
  const { db } = ctx;
  const { PROJECTS_DIR } = ctx.paths;
  const { isLocalSameOrigin, resolvedPortRef, sendApiError } = ctx.http;
  const { authorizeToolRequest, requestProjectOverride } = ctx.auth;
  const { getProject } = ctx.projectStore;
  const { readProjectFile, writeProjectFile } = ctx.projectFiles;
  const { renderBrowserArtifact } = ctx.browserRender;
  const taskId = () => ctx.ids.randomId?.() ?? ctx.ids.randomUUID?.();

  reconcileBrowserRenderTasksOnBoot(db, {
    terminalTtlMs: TASK_TTL_AFTER_DONE_MS,
  });

  app.post('/api/projects/:id/browser-render', async (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPortRef.current)) {
      return res.status(403).json({
        error:
          'cross-origin request rejected: browser rendering is restricted to the local UI / CLI',
      });
    }

    try {
      const accepted = await enqueueBrowserRenderTask({
        projectId: req.params.id,
        body: req.body ?? {},
        daemonUrl: daemonUrlFromRequest(req, resolvedPortRef.current),
      });
      return res.status(202).json(accepted);
    } catch (err: any) {
      const status = typeof err?.status === 'number' ? err.status : 400;
      return res.status(status).json({
        error: String(err?.message ?? err),
        ...(err?.code ? { code: err.code } : {}),
      });
    }
  });

  app.post('/api/tools/browser-render', async (req, res) => {
    try {
      const toolGrant = authorizeToolRequest(req, res, 'browser-render:create');
      if (!toolGrant) return;
      const suppliedProjectId =
        typeof req.body?.projectId === 'string' ? req.body.projectId : undefined;
      if (requestProjectOverride(suppliedProjectId, toolGrant.projectId)) {
        return sendApiError(res, 403, 'FORBIDDEN', 'projectId is derived from the tool token', {
          details: { suppliedProjectId },
        });
      }

      const accepted = await enqueueBrowserRenderTask({
        projectId: toolGrant.projectId,
        body: req.body ?? {},
        daemonUrl: daemonUrlFromRequest(req, resolvedPortRef.current),
      });
      return res.status(202).json(accepted);
    } catch (err: any) {
      const status = typeof err?.status === 'number' ? err.status : 400;
      return res.status(status).json({
        error: String(err?.message ?? err),
        ...(err?.code ? { code: err.code } : {}),
      });
    }
  });

  app.post('/api/browser-render/tasks/:id/wait', async (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPortRef.current)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }

    const task = getLiveBrowserRenderTask(db, req.params.id);
    if (!task) return res.status(404).json({ error: 'task not found' });

    return waitForBrowserRenderTask(req, res, task);
  });

  app.post('/api/tools/browser-render/wait', async (req, res) => {
    const toolGrant = authorizeToolRequest(req, res, 'browser-render:wait');
    if (!toolGrant) return;

    const taskId = typeof req.body?.taskId === 'string' ? req.body.taskId : '';
    if (!taskId) return res.status(400).json({ error: 'taskId is required' });
    const task = getLiveBrowserRenderTask(db, taskId);
    if (!task) return res.status(404).json({ error: 'task not found' });
    if (task.projectId !== toolGrant.projectId) {
      return sendApiError(res, 403, 'FORBIDDEN', 'task belongs to a different project');
    }

    return waitForBrowserRenderTask(req, res, task);
  });

  app.get('/api/projects/:id/browser-render/tasks', (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPortRef.current)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    const includeDone =
      req.query.includeDone === '1' || req.query.includeDone === 'true';
    const tasks = listBrowserRenderTasksByProject(db, req.params.id, {
      includeTerminal: includeDone,
    }).map((row) => ({
      taskId: row.id,
      status: row.status,
      format: row.format,
      entry: row.entry,
      output: row.output,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      progress: row.progress.slice(-3),
      progressCount: row.progress.length,
      ...(row.status === 'done' ? { file: row.file } : {}),
      ...(row.status === 'failed' || row.status === 'interrupted'
        ? { error: row.error }
        : {}),
    }));
    res.json({ tasks });
  });

  async function enqueueBrowserRenderTask(options: {
    projectId: string;
    body: unknown;
    daemonUrl: string;
  }) {
    const project = getProject(db, options.projectId);
    if (!project) throw routeError(404, 'project not found');

    const request = normalizeBrowserRenderRequest(
      (options.body ?? {}) as Record<string, unknown>,
    );
    try {
      await readProjectFile(PROJECTS_DIR, options.projectId, request.entry, project.metadata);
    } catch (err: any) {
      const status = err?.code === 'ENOENT' ? 404 : 400;
      throw routeError(
        status,
        status === 404 ? 'entry file not found' : String(err?.message ?? err),
      );
    }

    const id = taskId();
    if (typeof id !== 'string' || !id) {
      throw routeError(500, 'failed to create browser render task id');
    }
    const task = createLiveBrowserRenderTask(db, id, options.projectId, request);
    void runBrowserRenderTask(task, {
      daemonUrl: options.daemonUrl,
      projectId: options.projectId,
      projectMetadata: project.metadata,
      projectsRoot: PROJECTS_DIR,
      renderBrowserArtifact,
      writeProjectFile,
      db,
    });

    return {
      taskId: id,
      status: task.status,
      startedAt: task.startedAt,
    };
  }
}

function waitForBrowserRenderTask(
  req: Request,
  res: any,
  task: LiveBrowserRenderTask,
) {
  const since = Number.isFinite(Number(req.body?.since))
    ? Number(req.body.since)
    : 0;
  const requestedTimeout = Number.isFinite(Number(req.body?.timeoutMs))
    ? Number(req.body.timeoutMs)
    : 25_000;
  const timeoutMs = Math.min(Math.max(requestedTimeout, 0), 25_000);

  const respond = () => {
    if (res.writableEnded) return;
    res.json(browserRenderTaskSnapshot(task, since));
  };

  if (
    TERMINAL_STATUSES.has(task.status) ||
    task.progress.length > since ||
    timeoutMs === 0
  ) {
    return respond();
  }

  let resolved = false;
  const wake = () => {
    if (resolved) return;
    resolved = true;
    task.waiters.delete(wake);
    clearTimeout(timer);
    respond();
  };
  task.waiters.add(wake);
  const timer = setTimeout(wake, timeoutMs);
  res.on('close', wake);
}

function routeError(status: number, message: string, code?: string): Error {
  const err = new Error(message) as Error & { status?: number; code?: string };
  err.status = status;
  if (code) err.code = code;
  return err;
}

function createLiveBrowserRenderTask(
  db: any,
  id: string,
  projectId: string,
  request: BrowserRenderRequest,
): LiveBrowserRenderTask {
  const row = insertBrowserRenderTask(db, {
    id,
    projectId,
    status: 'queued',
    format: request.format,
    entry: request.entry,
    output: request.output,
    startedAt: Date.now(),
    progress: [],
  });
  const task = hydrateBrowserRenderTask(row);
  task.request = request;
  browserRenderTasks.set(task.id, task);
  return task;
}

function getLiveBrowserRenderTask(
  db: any,
  id: string,
): LiveBrowserRenderTask | null {
  const cached = browserRenderTasks.get(id);
  if (cached) return cached;
  const row = getBrowserRenderTask(db, id);
  return row ? hydrateBrowserRenderTask(row) : null;
}

function hydrateBrowserRenderTask(row: BrowserRenderTaskRow): LiveBrowserRenderTask {
  const task: LiveBrowserRenderTask = {
    ...row,
    request: normalizeBrowserRenderRequest({
      format: row.format,
      entry: row.entry,
      output: row.output,
    }),
    progress: row.progress.slice(),
    waiters: new Set(),
  };
  browserRenderTasks.set(task.id, task);
  scheduleTerminalTaskGc(task);
  return task;
}

function persistBrowserRenderTask(db: any, task: LiveBrowserRenderTask): void {
  updateBrowserRenderTask(db, task.id, {
    status: task.status,
    progress: task.progress,
    file: task.file,
    error: task.error,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
  });
}

function notifyTaskWaiters(task: LiveBrowserRenderTask): void {
  const wakers = Array.from(task.waiters);
  for (const wake of wakers) {
    try {
      wake();
    } catch {
      // Keep one failed waiter from blocking the rest.
    }
  }
  scheduleTerminalTaskGc(task);
}

function scheduleTerminalTaskGc(task: LiveBrowserRenderTask): void {
  if (TERMINAL_STATUSES.has(task.status) && !task.gcScheduled) {
    task.gcScheduled = true;
    setTimeout(() => {
      if (task.waiters.size === 0) {
        browserRenderTasks.delete(task.id);
      }
    }, TASK_TTL_AFTER_DONE_MS).unref?.();
  }
}

function browserRenderTaskSnapshot(
  task: BrowserRenderTaskRow,
  since = 0,
): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {
    taskId: task.id,
    status: task.status,
    format: task.format,
    entry: task.entry,
    output: task.output,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    progress: task.progress.slice(since),
    nextSince: task.progress.length,
  };
  if (task.status === 'done') snapshot.file = task.file;
  if (task.status === 'failed' || task.status === 'interrupted') {
    snapshot.error = task.error;
  }
  return snapshot;
}

async function runBrowserRenderTask(
  task: LiveBrowserRenderTask,
  options: {
    daemonUrl: string;
    projectId: string;
    projectMetadata: unknown;
    projectsRoot: string;
    db: any;
    renderBrowserArtifact: (
      input: BrowserRenderArtifactInput,
    ) => Promise<BrowserRenderArtifactResult>;
    writeProjectFile: (...args: any[]) => Promise<any>;
  },
): Promise<void> {
  task.status = 'running';
  persistBrowserRenderTask(options.db, task);
  try {
    const result = await options.renderBrowserArtifact({
      daemonUrl: options.daemonUrl,
      projectId: options.projectId,
      request: task.request,
    });
    const meta = await options.writeProjectFile(
      options.projectsRoot,
      options.projectId,
      result.output,
      result.bytes,
      {},
      options.projectMetadata,
    );
    task.status = 'done';
    task.file = {
      ...meta,
      name: result.output,
      path: result.output,
      mime: result.mime,
      size: result.size,
      format: result.format,
    };
    task.endedAt = Date.now();
    persistBrowserRenderTask(options.db, task);
    notifyTaskWaiters(task);
  } catch (err: any) {
    task.status = 'failed';
    task.error = renderError(err);
    task.endedAt = Date.now();
    persistBrowserRenderTask(options.db, task);
    notifyTaskWaiters(task);
  }
}

function daemonUrlFromRequest(req: Request, port: number): string {
  const host = req.get('host') || `127.0.0.1:${port}`;
  return `${req.protocol || 'http'}://${host}`;
}

function renderError(err: any): BrowserRenderTaskError {
  return {
    message: String(err?.message ?? err),
    status: typeof err?.status === 'number' ? err.status : 500,
    ...(err?.code ? { code: String(err.code) } : {}),
  };
}
