import path from 'node:path';

export type BrowserRenderFormat = 'screenshot' | 'pdf';

export interface BrowserRenderViewport {
  width: number;
  height: number;
}

export interface BrowserRenderRequestInput {
  format?: unknown;
  entry?: unknown;
  output?: unknown;
  viewport?: unknown;
  fullPage?: unknown;
}

export interface BrowserRenderRequest {
  format: BrowserRenderFormat;
  entry: string;
  output: string;
  viewport: BrowserRenderViewport;
  fullPage: boolean;
}

export interface BrowserRenderArtifactInput {
  daemonUrl: string;
  projectId: string;
  request: BrowserRenderRequest;
}

export interface BrowserRenderArtifactResult {
  bytes: Buffer;
  format: BrowserRenderFormat;
  output: string;
  mime: string;
  size: number;
}

export interface BrowserRenderPage {
  goto(url: string, options?: unknown): Promise<unknown>;
  screenshot(options: { fullPage?: boolean; type?: 'png' }): Promise<Buffer | Uint8Array>;
  pdf(options?: unknown): Promise<Buffer | Uint8Array>;
  close(): Promise<unknown>;
}

export interface BrowserRenderBrowser {
  newPage(options: { viewport?: BrowserRenderViewport }): Promise<BrowserRenderPage>;
  close(): Promise<unknown>;
}

export interface BrowserRenderDeps {
  launchBrowser?: () => Promise<BrowserRenderBrowser>;
}

const DEFAULT_VIEWPORT: BrowserRenderViewport = { width: 1440, height: 900 };
const PROJECT_RELATIVE_HTML_ENTRY_MESSAGE =
  'browser render requires a project-relative HTML entry';

export function normalizeBrowserRenderRequest(
  input: BrowserRenderRequestInput,
): BrowserRenderRequest {
  const format = normalizeFormat(input.format);
  const entry = normalizeProjectPath(input.entry, PROJECT_RELATIVE_HTML_ENTRY_MESSAGE);
  if (!/\.html?$/i.test(entry)) {
    throw new Error(PROJECT_RELATIVE_HTML_ENTRY_MESSAGE);
  }

  const output =
    typeof input.output === 'string' && input.output.trim()
      ? normalizeProjectPath(input.output, 'browser render output must be project-relative')
      : defaultBrowserRenderOutput(entry, format);

  return {
    format,
    entry,
    output,
    viewport: normalizeViewport(input.viewport),
    fullPage: input.fullPage === true,
  };
}

export function defaultBrowserRenderOutput(
  entry: string,
  format: BrowserRenderFormat,
): string {
  const normalizedEntry = normalizeProjectPath(entry, PROJECT_RELATIVE_HTML_ENTRY_MESSAGE);
  const ext = format === 'pdf' ? '.pdf' : '.png';
  return normalizedEntry.replace(/\.html?$/i, ext);
}

export function buildBrowserRenderExportUrl(input: {
  daemonUrl: string;
  projectId: string;
  entry: string;
}): string {
  const url = new URL(input.daemonUrl);
  const basePath = url.pathname.replace(/\/$/, '');
  const encodedEntry = normalizeProjectPath(
    input.entry,
    PROJECT_RELATIVE_HTML_ENTRY_MESSAGE,
  )
    .split('/')
    .map(encodeURIComponent)
    .join('/');
  url.pathname = [
    basePath,
    'api',
    'projects',
    encodeURIComponent(input.projectId),
    'export',
    encodedEntry,
  ]
    .filter(Boolean)
    .join('/');
  if (!url.pathname.startsWith('/')) url.pathname = `/${url.pathname}`;
  url.search = 'inline=1';
  url.hash = '';
  return url.toString();
}

export async function renderBrowserArtifact(
  input: BrowserRenderArtifactInput,
  deps: BrowserRenderDeps = {},
): Promise<BrowserRenderArtifactResult> {
  const request = normalizeBrowserRenderRequest(input.request);
  const launchBrowser = deps.launchBrowser ?? launchDefaultBrowser;
  const browser = await launchBrowser();
  let page: BrowserRenderPage | null = null;
  try {
    page = await browser.newPage({ viewport: request.viewport });
    await page.goto(
      buildBrowserRenderExportUrl({
        daemonUrl: input.daemonUrl,
        projectId: input.projectId,
        entry: request.entry,
      }),
      { waitUntil: 'networkidle', timeout: 30_000 },
    );

    if (request.format === 'pdf') {
      const bytes = Buffer.from(
        await page.pdf({ printBackground: true, preferCSSPageSize: true }),
      );
      return {
        bytes,
        format: 'pdf',
        output: request.output,
        mime: 'application/pdf',
        size: bytes.byteLength,
      };
    }

    const bytes = Buffer.from(
      await page.screenshot({ fullPage: request.fullPage, type: 'png' }),
    );
    return {
      bytes,
      format: 'screenshot',
      output: request.output,
      mime: 'image/png',
      size: bytes.byteLength,
    };
  } finally {
    await page?.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

function normalizeFormat(value: unknown): BrowserRenderFormat {
  if (value === 'screenshot' || value === undefined || value === null) {
    return 'screenshot';
  }
  if (value === 'pdf') return 'pdf';
  throw new Error('browser render format must be screenshot or pdf');
}

function normalizeViewport(value: unknown): BrowserRenderViewport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_VIEWPORT };
  }
  const obj = value as Record<string, unknown>;
  const width = normalizeDimension(obj.width, DEFAULT_VIEWPORT.width);
  const height = normalizeDimension(obj.height, DEFAULT_VIEWPORT.height);
  return { width, height };
}

function normalizeDimension(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), 1), 10_000);
}

function normalizeProjectPath(value: unknown, message: string): string {
  if (typeof value !== 'string') throw new Error(message);
  const trimmed = value.trim().replace(/\\/g, '/');
  if (
    !trimmed ||
    trimmed.includes('\0') ||
    trimmed.startsWith('/') ||
    /^[A-Za-z]:/.test(trimmed) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed)
  ) {
    throw new Error(message);
  }
  const normalized = path.posix.normalize(trimmed);
  const parts = normalized.split('/').filter(Boolean);
  if (
    normalized.startsWith('../') ||
    normalized === '..' ||
    parts.length === 0 ||
    parts.some((part) => part === '.' || part === '..' || part.startsWith('.'))
  ) {
    throw new Error(message);
  }
  return parts.join('/');
}

async function launchDefaultBrowser(): Promise<BrowserRenderBrowser> {
  const { chromium } = await import('playwright-core');
  const explicitChannel = process.env.OD_BROWSER_RENDER_CHANNEL?.trim();
  const preferredChannel = explicitChannel || defaultBrowserRenderChannel();

  if (preferredChannel) {
    try {
      return await chromium.launch({
        channel: preferredChannel,
        headless: true,
      });
    } catch (err) {
      if (explicitChannel) throw err;
    }
  }

  return await chromium.launch({ headless: true });
}

function defaultBrowserRenderChannel(): string | undefined {
  return process.platform === 'darwin' || process.platform === 'win32'
    ? 'chrome'
    : undefined;
}
