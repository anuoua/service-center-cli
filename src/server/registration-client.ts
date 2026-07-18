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
  fetchFn?: typeof fetch;
};

type FetchResponse = {
  status: number;
  text(): Promise<string>;
};

function buildBase(registryUrl: string, adminPrefix: string): string {
  const base = registryUrl.replace(/\/+$/, '');
  const prefix = adminPrefix.startsWith('/') ? adminPrefix : '/' + adminPrefix;
  return base + prefix;
}

async function callRpc(
  fetchFn: typeof fetch,
  url: string,
  body: unknown,
): Promise<RpcResult> {
  let response: FetchResponse;
  try {
    response = (await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })) as unknown as FetchResponse;
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

export function createRegistrationClient(opts: CreateClientOptions): RegistrationClient {
  const base = buildBase(opts.registryUrl, opts.adminPrefix ?? '/__registry');
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  return {
    register: (req) => callRpc(fetchFn, `${base}/register`, req),
    heartbeat: (req) => callRpc(fetchFn, `${base}/heartbeat`, req),
    deregister: (req) => callRpc(fetchFn, `${base}/deregister`, req),
  };
}
