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
};

export type FetchResponse = {
  status: number;
  text(): Promise<string>;
};

export type FetchFn = (
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<FetchResponse>;

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
    return { ok: false, status: 0, error: { error: 'network', detail } };
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

// Default fetch implementation. Skips TLS certificate verification so
// `sccli server` works out of the box against a registry serving a
// self-signed certificate (`sccli registry --tls`) — this is a dev tool.
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
  const fetchFn: FetchFn = opts.fetchFn ?? insecureFetch;
  return {
    register: (req) => callRpc(fetchFn, `${base}/register`, req),
    heartbeat: (req) => callRpc(fetchFn, `${base}/heartbeat`, req),
    deregister: (req) => callRpc(fetchFn, `${base}/deregister`, req),
  };
}
