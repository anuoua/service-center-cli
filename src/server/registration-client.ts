import https from 'node:https';
import http from 'node:http';
import type {
  DeregisterRequest,
  HeartbeatRequest,
  RegisterRequest,
  ErrorResponse,
} from '../shared/types.js';

export type RpcOk = { ok: true; status: number };
export type RpcErr = { ok: false; status: number; error: ErrorResponse };
export type RpcResult = RpcOk | RpcErr;

export type RegistrationClient = {
  register(req: RegisterRequest): Promise<RpcResult>;
  heartbeat(req: HeartbeatRequest): Promise<RpcResult>;
  deregister(req: DeregisterRequest): Promise<RpcResult>;
};

export type CreateClientOptions = {
  registryUrl: string;
  adminPrefix?: string;
  fetchFn?: FetchFn;
  /** Skip TLS certificate verification (self-signed dev certificates). */
  insecure?: boolean;
};

export type FetchResponse = {
  status: number;
  text(): Promise<string>;
};

export type FetchFn = (
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<FetchResponse>;

// Error messages/codes that indicate TLS certificate verification failed
// (e.g. a self-signed registry cert). Matched across the error cause chain.
const CERT_ERROR_PATTERNS = [
  /self[\-\s]signed certificate/i,
  /unable to verify/i,
  /unable to get local issuer/i,
  /certificate has expired/i,
  /unable to get certificate/i,
] as const;

function isCertificateError(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current !== null && typeof current === 'object') {
    if (seen.has(current)) break;
    seen.add(current);
    const rec = current as { message?: unknown; code?: unknown };
    const message = typeof rec.message === 'string' ? rec.message : '';
    const code = typeof rec.code === 'string' ? rec.code : '';
    if (
      CERT_ERROR_PATTERNS.some((p) => p.test(message)) ||
      /CERT|SIGNED|ISSUER|VERIFY/i.test(code)
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

const TLS_HINT_MARKER = 'TLS certificate verification failed';

/** True when an RPC result failed because the registry's TLS certificate was not trusted. */
export function isTlsCertificateError(result: RpcResult): boolean {
  return !result.ok && (result.error.detail ?? '').includes(TLS_HINT_MARKER);
}

function buildBase(registryUrl: string, adminPrefix: string): string {
  const base = registryUrl.replace(/\/+$/, '');
  const prefix = adminPrefix.startsWith('/') ? adminPrefix : '/' + adminPrefix;
  return base + prefix;
}

async function callRpc(
  fetchFn: FetchFn,
  url: string,
  body: unknown,
): Promise<RpcResult> {
  let response: FetchResponse;
  try {
    response = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const certIssue = isCertificateError(err);
    return {
      ok: false,
      status: 0,
      error: {
        error: 'network',
        detail: certIssue
          ? `${detail} (${TLS_HINT_MARKER} — the registry may use a self-signed certificate; retry with --insecure to skip verification)`
          : detail,
      },
    };
  }

  const status = response.status;
  if (status >= 200 && status < 300) {
    return { ok: true, status };
  }

  let text = '';
  try {
    text = await response.text();
  } catch {
    text = '';
  }

  if (text.length > 0) {
    try {
      const parsed = JSON.parse(text) as ErrorResponse;
      return { ok: false, status, error: parsed };
    } catch {
      // not JSON; fall through to generic fallback
    }
  }

  return {
    ok: false,
    status,
    error: { error: `http ${status}`, detail: text.slice(0, 200) },
  };
}

// fetch-like client that ignores TLS certificate verification, for talking
// to a registry that serves a self-signed certificate. Only used in
// `--insecure` mode; keeps the zero-extra-dependency story intact.
function insecureFetch(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<FetchResponse> {
  return new Promise<FetchResponse>((resolve, reject) => {
    const parsed = new URL(url);
    const options: http.RequestOptions = {
      method: init.method ?? 'GET',
      headers: init.headers,
    };
    const handler = (res: http.IncomingMessage): void => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          text: async () => Buffer.concat(chunks).toString('utf8'),
        });
      });
    };
    const req =
      parsed.protocol === 'https:'
        ? https.request(
            parsed,
            { ...options, rejectUnauthorized: false },
            handler,
          )
        : http.request(parsed, options, handler);
    req.on('error', reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

export function createRegistrationClient(opts: CreateClientOptions): RegistrationClient {
  const base = buildBase(opts.registryUrl, opts.adminPrefix ?? '/__registry');
  const fetchFn: FetchFn =
    opts.fetchFn ??
    (opts.insecure === true
      ? insecureFetch
      : (globalThis.fetch as unknown as FetchFn));
  return {
    register: (req) => callRpc(fetchFn, `${base}/register`, req),
    heartbeat: (req) => callRpc(fetchFn, `${base}/heartbeat`, req),
    deregister: (req) => callRpc(fetchFn, `${base}/deregister`, req),
  };
}
