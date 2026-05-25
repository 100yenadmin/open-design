type JsonObject = Record<string, unknown>;

interface ToolCliResult {
  exitCode: number;
}

interface ParsedOptions {
  command: string | undefined;
  entry?: string;
  output?: string;
  format: 'screenshot' | 'pdf';
  viewport?: { width: number; height: number };
  fullPage: boolean;
  timeoutMs: number;
  help: boolean;
}

const TERMINAL_STATUSES = new Set(['done', 'failed', 'interrupted']);

const BROWSER_RENDER_USAGE = `Usage:
  od tools browser-render render --entry <project-file.html> [--format screenshot|pdf] [--output <project-file.png|pdf>]

Options:
  --entry <path>          Project-relative HTML entry to render.
  --format <type>         screenshot (default) or pdf.
  --output <path>         Project-relative output path. Defaults beside the entry.
  --viewport <WxH>        Screenshot viewport, for example 1440x900.
  --full-page             Capture the full page for screenshots.
  --timeout-ms <ms>       Overall wait timeout. Default 120000.

Environment:
  OD_NODE_BIN     Node-compatible runtime for agent wrapper invocations
  OD_BIN          Open Design CLI script for agent wrapper invocations
  OD_DAEMON_URL   Daemon base URL injected into agent runs
  OD_TOOL_TOKEN   Bearer token injected into agent runs

Agent runtime invocation:
  "$OD_NODE_BIN" "$OD_BIN" tools browser-render render --entry index.html --output snapshots/index.png
`;

function writeJson(value: unknown, stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

function fail(message: string, details?: unknown): ToolCliResult {
  writeJson({ ok: false, error: { message, ...(details === undefined ? {} : { details }) } }, process.stderr);
  return { exitCode: 1 };
}

function parseOptions(args: string[]): ParsedOptions | { error: string } {
  const [command, ...rest] = args;
  const options: ParsedOptions = {
    command: command === '-h' || command === '--help' ? undefined : command,
    format: 'screenshot',
    fullPage: false,
    timeoutMs: 120_000,
    help: command === '-h' || command === '--help',
  };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--entry') {
      const value = rest[++index];
      if (!isFlagValue(value)) return { error: '--entry requires a project-relative HTML path' };
      options.entry = value;
    } else if (arg === '--output') {
      const value = rest[++index];
      if (!isFlagValue(value)) return { error: '--output requires a project-relative path' };
      options.output = value;
    } else if (arg === '--format') {
      const value = rest[++index];
      if (value !== 'screenshot' && value !== 'pdf') return { error: '--format must be screenshot or pdf' };
      options.format = value;
    } else if (arg === '--viewport') {
      const value = rest[++index];
      if (!isFlagValue(value)) return { error: '--viewport requires WIDTHxHEIGHT' };
      const viewport = parseViewport(value);
      if (!viewport) return { error: '--viewport must be WIDTHxHEIGHT, for example 1440x900' };
      options.viewport = viewport;
    } else if (arg === '--timeout-ms') {
      const value = rest[++index];
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) return { error: '--timeout-ms must be a positive number' };
      options.timeoutMs = Math.floor(parsed);
    } else if (arg === '--full-page') {
      options.fullPage = true;
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else {
      return { error: `unknown option: ${arg}` };
    }
  }

  return options;
}

function isFlagValue(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('-');
}

function parseViewport(value: string): { width: number; height: number } | null {
  const match = /^(\d+)x(\d+)$/iu.exec(value.trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width: Math.floor(width), height: Math.floor(height) };
}

function daemonUrl(): URL | { error: string } {
  const rawUrl = process.env.OD_DAEMON_URL;
  if (!rawUrl) return { error: 'OD_DAEMON_URL is required' };
  try {
    const url = new URL(rawUrl);
    url.pathname = url.pathname.replace(/\/+$/u, '');
    url.search = '';
    url.hash = '';
    return url;
  } catch {
    return { error: 'OD_DAEMON_URL must be a valid URL' };
  }
}

function toolToken(): string | { error: string } {
  const token = process.env.OD_TOOL_TOKEN;
  if (!token) return { error: 'OD_TOOL_TOKEN is required' };
  return token;
}

function endpoint(baseUrl: URL, pathname: string): string {
  const url = new URL(baseUrl.toString());
  url.pathname = `${url.pathname}${pathname}`.replace(/\/+/gu, '/');
  return url.toString();
}

async function requestJson(baseUrl: URL, token: string, pathname: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const response = await fetch(endpoint(baseUrl, pathname), {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  });
  const text = await response.text();
  let body: unknown = text;
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = { message: text };
    }
  }
  return { status: response.status, body };
}

function normalizeCliError(body: unknown): JsonObject {
  const rawError = body && typeof body === 'object' && 'error' in body ? (body as JsonObject).error : body;
  if (typeof rawError === 'string') return { message: rawError };
  if (!rawError || typeof rawError !== 'object') return { message: String(rawError ?? 'request failed') };
  const error = rawError as JsonObject;
  return {
    ...(typeof error.code === 'string' ? { code: error.code } : {}),
    message: typeof error.message === 'string' ? error.message : String(error.error ?? 'request failed'),
    ...(error.details === undefined ? {} : { details: error.details }),
  };
}

async function waitForTask(baseUrl: URL, token: string, taskId: string, timeoutMs: number): Promise<{ status: number; body: unknown }> {
  const deadline = Date.now() + timeoutMs;
  let since = 0;
  while (Date.now() <= deadline) {
    const perRequestTimeout = Math.min(25_000, Math.max(0, deadline - Date.now()));
    if (perRequestTimeout <= 0) break;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), perRequestTimeout);
    let response: { status: number; body: unknown };
    try {
      response = await requestJson(baseUrl, token, '/api/tools/browser-render/wait', {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({
          taskId,
          since,
          timeoutMs: perRequestTimeout,
        }),
      });
    } catch (err) {
      if (controller.signal.aborted) break;
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (response.status < 200 || response.status >= 300) return response;
    const body = response.body as JsonObject;
    if (typeof body.nextSince === 'number') since = body.nextSince;
    if (typeof body.status === 'string' && TERMINAL_STATUSES.has(body.status)) return response;
  }
  return {
    status: 408,
    body: { error: { message: `browser render task ${taskId} did not finish within ${timeoutMs}ms` } },
  };
}

function printApiResult(response: { status: number; body: unknown }): ToolCliResult {
  if (response.status < 200 || response.status >= 300) {
    writeJson({ ok: false, status: response.status, error: normalizeCliError(response.body) }, process.stderr);
    return { exitCode: 1 };
  }
  const body = response.body && typeof response.body === 'object' && !Array.isArray(response.body)
    ? response.body as JsonObject
    : { result: response.body };
  if (body.status === 'failed' || body.status === 'interrupted') {
    writeJson({ ok: false, status: 500, error: normalizeCliError(body.error ?? body) }, process.stderr);
    return { exitCode: 1 };
  }
  writeJson({ ok: true, ...body });
  return { exitCode: 0 };
}

export async function runBrowserRenderToolCli(args: string[]): Promise<ToolCliResult> {
  const options = parseOptions(args);
  if ('error' in options) return fail(options.error);
  if (options.help || !options.command) {
    process.stdout.write(BROWSER_RENDER_USAGE);
    return { exitCode: options.command ? 0 : 1 };
  }

  const baseUrl = daemonUrl();
  if ('error' in baseUrl) return fail(baseUrl.error);
  const token = toolToken();
  if (typeof token !== 'string') return fail(token.error);

  if (options.command !== 'render') return fail(`unknown browser-render command: ${options.command}`);
  if (!options.entry) return fail('render requires --entry <project-file.html>');

  const accepted = await requestJson(baseUrl, token, '/api/tools/browser-render', {
    method: 'POST',
    body: JSON.stringify({
      entry: options.entry,
      format: options.format,
      ...(options.output ? { output: options.output } : {}),
      ...(options.viewport ? { viewport: options.viewport } : {}),
      ...(options.fullPage ? { fullPage: true } : {}),
      timeoutMs: options.timeoutMs,
    }),
  });
  if (accepted.status < 200 || accepted.status >= 300) return printApiResult(accepted);

  const acceptedBody = accepted.body as JsonObject;
  const taskId = typeof acceptedBody.taskId === 'string' ? acceptedBody.taskId : '';
  if (!taskId) return fail('daemon did not return a browser render task id', accepted.body);

  return printApiResult(await waitForTask(baseUrl, token, taskId, options.timeoutMs));
}
