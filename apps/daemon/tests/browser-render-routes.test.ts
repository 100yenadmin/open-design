import express from 'express';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { closeDatabase, getProject, insertProject, openDatabase } from '../src/db.js';
import { isLocalSameOrigin } from '../src/origin-validation.js';
import { registerBrowserRenderRoutes } from '../src/browser-render-routes.js';
import { insertBrowserRenderTask } from '../src/browser-render-tasks.js';
import {
  ensureProject,
  listFiles,
  readProjectFile,
  writeProjectFile,
} from '../src/projects.js';

describe('browser render routes', () => {
  let server: http.Server | null = null;
  let tempRoot: string | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = null;
    }
    closeDatabase();
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  it('recovers a pre-restart running task so wait returns interrupted instead of 404', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-browser-render-'));
    tempRoot = root;
    const db = openDatabase(root);
    const projectId = `project_${randomUUID()}`;
    const taskId = `task_${randomUUID()}`;
    const now = Date.now() - 5_000;

    insertProject(db, {
      id: projectId,
      name: 'Recovered render project',
      createdAt: now,
      updatedAt: now,
    });
    insertBrowserRenderTask(db, {
      id: taskId,
      projectId,
      status: 'running',
      format: 'screenshot',
      entry: 'index.html',
      output: 'index.png',
      progress: ['browser launch accepted'],
      startedAt: now,
      updatedAt: now,
    });

    const baseUrl = await startBrowserRenderRouteServer({
      tempRoot: root,
      render: async () => {
        throw new Error('render should not be called');
      },
    });

    const response = await fetch(`${baseUrl}/api/browser-render/tasks/${encodeURIComponent(taskId)}/wait`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ since: 0, timeoutMs: 0 }),
    });
    const body = await response.json() as {
      status?: string;
      progress?: string[];
      error?: { code?: string; message?: string };
    };

    expect(response.status).toBe(200);
    expect(body.status).toBe('interrupted');
    expect(body.progress).toEqual(['browser launch accepted']);
    expect(body.error).toMatchObject({
      code: 'DAEMON_RESTART',
      message: 'browser render task interrupted by daemon restart',
    });
  });

  it('renders a project HTML file through the daemon renderer and writes the output file', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-browser-render-'));
    tempRoot = root;
    const db = openDatabase(root);
    const projectId = `project_${randomUUID()}`;
    const now = Date.now();
    const projectsRoot = path.join(root, '.od/projects');
    insertProject(db, {
      id: projectId,
      name: 'Browser render project',
      createdAt: now,
      updatedAt: now,
    });
    await writeProjectFile(projectsRoot, projectId, 'index.html', '<h1>Hello</h1>');

    const baseUrl = await startBrowserRenderRouteServer({
      tempRoot: root,
      render: async ({ request }) => ({
        bytes: Buffer.from('fake-png'),
        format: request.format,
        output: request.output,
        mime: 'image/png',
        size: 8,
      }),
    });

    const response = await fetch(`${baseUrl}/api/projects/${encodeURIComponent(projectId)}/browser-render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: baseUrl },
      body: JSON.stringify({ format: 'screenshot', entry: 'index.html', output: 'snapshots/home.png' }),
    });
    const accepted = await response.json() as { taskId?: string };
    expect(response.status).toBe(202);
    expect(typeof accepted.taskId).toBe('string');

    const wait = await fetch(`${baseUrl}/api/browser-render/tasks/${encodeURIComponent(accepted.taskId!)}/wait`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: baseUrl },
      body: JSON.stringify({ since: 0, timeoutMs: 5_000 }),
    });
    const snapshot = await wait.json() as { status?: string; file?: { name?: string; mime?: string; size?: number } };

    expect(wait.status).toBe(200);
    expect(snapshot.status).toBe('done');
    expect(snapshot.file).toMatchObject({
      name: 'snapshots/home.png',
      mime: 'image/png',
      size: 8,
    });

    const written = await readProjectFile(projectsRoot, projectId, 'snapshots/home.png');
    expect(written.buffer.toString('utf8')).toBe('fake-png');
  });

  it('renders through the token-gated agent tool route and derives project from the token', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-browser-render-'));
    tempRoot = root;
    const db = openDatabase(root);
    const projectId = `project_${randomUUID()}`;
    const now = Date.now();
    const projectsRoot = path.join(root, '.od/projects');
    insertProject(db, {
      id: projectId,
      name: 'Agent browser render project',
      createdAt: now,
      updatedAt: now,
    });
    await writeProjectFile(projectsRoot, projectId, 'index.html', '<h1>Agent</h1>');

    const baseUrl = await startBrowserRenderRouteServer({
      tempRoot: root,
      toolProjectId: projectId,
      render: async ({ request }) => ({
        bytes: Buffer.from('agent-png'),
        format: request.format,
        output: request.output,
        mime: 'image/png',
        size: 9,
      }),
    });

    const response = await fetch(`${baseUrl}/api/tools/browser-render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ entry: 'index.html', output: 'agent/snap.png' }),
    });
    const accepted = await response.json() as { taskId?: string };
    expect(response.status).toBe(202);
    expect(typeof accepted.taskId).toBe('string');

    const wait = await fetch(`${baseUrl}/api/tools/browser-render/wait`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ taskId: accepted.taskId, since: 0, timeoutMs: 5_000 }),
    });
    const snapshot = await wait.json() as { status?: string; file?: { name?: string; mime?: string; size?: number } };

    expect(wait.status).toBe(200);
    expect(snapshot.status).toBe('done');
    expect(snapshot.file).toMatchObject({
      name: 'agent/snap.png',
      mime: 'image/png',
      size: 9,
    });

    const written = await readProjectFile(projectsRoot, projectId, 'agent/snap.png');
    expect(written.buffer.toString('utf8')).toBe('agent-png');
  });

  async function startBrowserRenderRouteServer(options: {
    tempRoot: string;
    render: Parameters<typeof registerBrowserRenderRoutes>[1]['browserRender']['renderBrowserArtifact'];
    toolProjectId?: string;
  }): Promise<string> {
    const app = express();
    app.use(express.json({ limit: '4mb' }));
    const db = openDatabase(options.tempRoot);
    const projectsRoot = path.join(options.tempRoot, '.od/projects');

    registerBrowserRenderRoutes(app, {
      auth: {
        authorizeToolRequest: (_req: unknown, _res: unknown, operation: string) => ({
          token: 'token',
          runId: 'run-1',
          projectId: options.toolProjectId ?? 'tool-project',
          allowedEndpoints: ['/api/tools/browser-render', '/api/tools/browser-render/wait'],
          allowedOperations: [operation],
          issuedAt: new Date(0).toISOString(),
          expiresAt: new Date(60_000).toISOString(),
        }),
        requestProjectOverride: (projectId: unknown, tokenProjectId: string) =>
          typeof projectId === 'string' && projectId.length > 0 && projectId !== tokenProjectId,
      },
      db,
      http: {
        createSseResponse: () => undefined,
        isLocalSameOrigin,
        requireLocalDaemonRequest: (_req: unknown, _res: unknown, next: () => void) => next(),
        resolvedPortRef: {
          get current() {
            const address = server?.address();
            return typeof address === 'object' && address ? address.port : 0;
          },
        },
        sendApiError: (res: express.Response, status: number, code: string, message: string, extra?: object) =>
          res.status(status).json({ code, error: message, ...(extra ?? {}) }),
        sendLiveArtifactRouteError: () => undefined,
        sendMulterError: () => undefined,
      },
      paths: {
        PROJECTS_DIR: projectsRoot,
      },
      ids: {
        randomId: () => `task_${randomUUID()}`,
      },
      projectStore: {
        getProject,
      },
      projectFiles: {
        ensureProject,
        listFiles,
        readProjectFile,
        writeProjectFile,
      },
      browserRender: {
        renderBrowserArtifact: options.render,
      },
    });

    return await new Promise<string>((resolve, reject) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server?.address();
        if (!address || typeof address !== 'object' || typeof address.port !== 'number') {
          reject(new Error('browser render test server did not expose a numeric port'));
          return;
        }
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
  }
});
