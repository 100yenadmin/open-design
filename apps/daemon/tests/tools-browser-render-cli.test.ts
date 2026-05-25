import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runBrowserRenderToolCli } from '../src/tools-browser-render-cli.js';

const ORIGINAL_ENV = { ...process.env };

describe('browser render tool CLI environment', () => {
  let stdoutWrite: { mockRestore: () => void };
  let stderrWrite: { mockRestore: () => void };
  let stdoutOutput: string[];
  let stderrOutput: string[];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    stdoutOutput = [];
    stderrOutput = [];
    stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutOutput.push(String(chunk));
      return true;
    });
    stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrOutput.push(String(chunk));
      return true;
    });
    fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/tools/browser-render')) {
        return new Response(JSON.stringify({ taskId: 'task-1', status: 'queued' }), {
          headers: { 'Content-Type': 'application/json' },
          status: 202,
        });
      }
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
        { headers: { 'Content-Type': 'application/json' }, status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
    process.env = ORIGINAL_ENV;
  });

  it('uses the injected daemon URL and token, starts a render, then waits for pixels', async () => {
    process.env.OD_DAEMON_URL = 'http://127.0.0.1:7456/base/';
    process.env.OD_TOOL_TOKEN = 'agent-run-token';

    const result = await runBrowserRenderToolCli([
      'render',
      '--entry',
      'index.html',
      '--output',
      'snapshots/index.png',
      '--viewport',
      '1440x900',
      '--full-page',
    ]);

    expect(result.exitCode).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:7456/base/api/tools/browser-render',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer agent-run-token',
          Accept: 'application/json',
        }),
        body: JSON.stringify({
          entry: 'index.html',
          format: 'screenshot',
          output: 'snapshots/index.png',
          viewport: { width: 1440, height: 900 },
          fullPage: true,
          timeoutMs: 120_000,
        }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:7456/base/api/tools/browser-render/wait',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer agent-run-token' }),
        body: expect.stringContaining('"taskId":"task-1"'),
      }),
    );
    expect(JSON.parse(stdoutOutput.join(''))).toMatchObject({
      ok: true,
      status: 'done',
      file: { name: 'snapshots/index.png', mime: 'image/png', size: 1234 },
    });
    expect(stderrOutput.join('')).toBe('');
  });

  it('fails before making a request when the injected environment is missing', async () => {
    delete process.env.OD_DAEMON_URL;
    delete process.env.OD_TOOL_TOKEN;

    const result = await runBrowserRenderToolCli(['render', '--entry', 'index.html']);

    expect(result.exitCode).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stderrOutput.join('')).toContain('OD_DAEMON_URL is required');
  });

  it('does not consume the next flag as a missing option value', async () => {
    process.env.OD_DAEMON_URL = 'http://127.0.0.1:7456';
    process.env.OD_TOOL_TOKEN = 'agent-run-token';

    const result = await runBrowserRenderToolCli(['render', '--entry', '--output', 'snapshots/index.png']);

    expect(result.exitCode).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stderrOutput.join('')).toContain('--entry requires a project-relative HTML path');
  });
});
