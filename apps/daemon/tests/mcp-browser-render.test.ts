import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleMcpToolCall } from '../src/mcp.js';

const originalFetch = globalThis.fetch;

function firstText(result: { content: Array<{ text: string }> }): string {
  const item = result.content[0];
  if (!item) throw new Error('expected MCP text content');
  return item.text;
}

describe('public MCP browser_render', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = originalFetch;
  });

  it('resolves project names, starts a browser render, and waits for the written file', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/projects')) {
        return new Response(JSON.stringify({ projects: [{ id: 'project-1', name: 'Demo Site' }] }), { status: 200 });
      }
      if (url.endsWith('/api/projects/project-1/browser-render')) {
        return new Response(JSON.stringify({ taskId: 'task-1', status: 'queued' }), { status: 202 });
      }
      if (url.endsWith('/api/browser-render/tasks/task-1/wait')) {
        return new Response(
          JSON.stringify({
            taskId: 'task-1',
            status: 'done',
            format: 'screenshot',
            entry: 'index.html',
            output: 'snapshots/index.png',
            progress: [],
            nextSince: 0,
            file: { name: 'snapshots/index.png', mime: 'image/png', size: 1234 },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ error: 'unexpected url' }), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleMcpToolCall('http://127.0.0.1:17456', 'browser_render', {
      project: 'Demo',
      entry: 'index.html',
      output: 'snapshots/index.png',
      viewport: { width: 1440, height: 900 },
      fullPage: true,
      timeoutMs: 120_000,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://127.0.0.1:17456/api/projects/project-1/browser-render');
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      entry: 'index.html',
      output: 'snapshots/index.png',
      viewport: { width: 1440, height: 900 },
      fullPage: true,
      timeoutMs: 120_000,
    });
    expect(JSON.parse(firstText(result))).toMatchObject({
      status: 'done',
      file: { name: 'snapshots/index.png', mime: 'image/png', size: 1234 },
      resolvedProject: { id: 'project-1', name: 'Demo Site' },
    });
  });

  it('uses the active file when project and entry are omitted', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith('/api/active')) {
        return new Response(
          JSON.stringify({ active: true, projectId: 'active-1', projectName: 'Active', fileName: 'index.html' }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/projects/active-1/browser-render')) {
        return new Response(JSON.stringify({ taskId: 'task-active', status: 'queued' }), { status: 202 });
      }
      if (url.endsWith('/api/browser-render/tasks/task-active/wait')) {
        return new Response(
          JSON.stringify({
            taskId: 'task-active',
            status: 'done',
            entry: 'index.html',
            output: 'index.png',
            progress: [],
            nextSince: 0,
            file: { name: 'index.png', mime: 'image/png', size: 4321 },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ error: 'unexpected url' }), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleMcpToolCall('http://127.0.0.1:17456', 'browser_render', {});

    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ entry: 'index.html' });
    expect(JSON.parse(firstText(result))).toMatchObject({
      status: 'done',
      usedActiveContext: { projectId: 'active-1', projectName: 'Active', fileName: 'index.html' },
    });
  });
});
