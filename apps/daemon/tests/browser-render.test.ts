import { describe, expect, it } from 'vitest';

import {
  buildBrowserRenderExportUrl,
  defaultBrowserRenderOutput,
  normalizeBrowserRenderRequest,
  renderBrowserArtifact,
} from '../src/browser-render.js';

describe('browser render core', () => {
  it('normalizes screenshot requests with a deterministic default output', () => {
    const request = normalizeBrowserRenderRequest({
      format: 'screenshot',
      entry: 'screens/home.html',
      viewport: { width: 390, height: 844 },
      fullPage: true,
    });

    expect(request).toMatchObject({
      format: 'screenshot',
      entry: 'screens/home.html',
      output: 'screens/home.png',
      viewport: { width: 390, height: 844 },
      fullPage: true,
    });
  });

  it('normalizes PDF requests with a deterministic default output', () => {
    expect(defaultBrowserRenderOutput('deck/index.html', 'pdf')).toBe('deck/index.pdf');
  });

  it.each([
    '../secret.html',
    '/tmp/secret.html',
    'https://example.com/page.html',
    'nested/../../secret.html',
    '.env',
  ])('rejects unsafe entry path %s', (entry) => {
    expect(() => normalizeBrowserRenderRequest({ format: 'screenshot', entry })).toThrow(
      /project-relative HTML entry/,
    );
  });

  it('builds an inline export URL with encoded path segments', () => {
    expect(
      buildBrowserRenderExportUrl({
        daemonUrl: 'http://127.0.0.1:7456/base/',
        projectId: 'proj 1',
        entry: 'nested/view one.html',
      }),
    ).toBe(
      'http://127.0.0.1:7456/base/api/projects/proj%201/export/nested/view%20one.html?inline=1',
    );
  });

  it('renders screenshots through an injected browser engine', async () => {
    const calls: string[] = [];
    const result = await renderBrowserArtifact(
      {
        daemonUrl: 'http://127.0.0.1:7456',
        projectId: 'project-1',
        request: normalizeBrowserRenderRequest({
          format: 'screenshot',
          entry: 'index.html',
          output: 'preview.png',
          viewport: { width: 800, height: 600 },
        }),
      },
      {
        launchBrowser: async () => ({
          newPage: async (options) => {
            calls.push(`viewport:${options.viewport?.width}x${options.viewport?.height}`);
            return {
              goto: async (url, options) => {
                calls.push(`goto:${url}`);
                calls.push(`goto-options:${JSON.stringify(options)}`);
              },
              screenshot: async (options) => {
                calls.push(`screenshot:${options.fullPage === true ? 'full' : 'viewport'}`);
                return Buffer.from('png-bytes');
              },
              pdf: async () => {
                throw new Error('pdf should not be called');
              },
              close: async () => {
                calls.push('page:close');
              },
            };
          },
          close: async () => {
            calls.push('browser:close');
          },
        }),
      },
    );

    expect(result).toMatchObject({
      bytes: Buffer.from('png-bytes'),
      mime: 'image/png',
      output: 'preview.png',
      format: 'screenshot',
    });
    expect(calls).toEqual([
      'viewport:800x600',
      'goto:http://127.0.0.1:7456/api/projects/project-1/export/index.html?inline=1',
      'goto-options:{"waitUntil":"networkidle","timeout":30000}',
      'screenshot:viewport',
      'page:close',
      'browser:close',
    ]);
  });
});
