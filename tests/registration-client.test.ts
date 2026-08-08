import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createRegistrationClient, isTlsCertificateError } from '../src/server/registration-client.ts';
import type { CreateClientOptions, FetchFn } from '../src/server/registration-client.ts';

type MockResponse = {
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
};

type MockFetch = (url: string, init: MockInit) => Promise<MockResponse>;
type MockInit = { method?: string; headers?: Record<string, string>; body?: string };

function makeClient(
  fetchFn: MockFetch,
  opts: {
    registryUrl?: string;
    adminPrefix?: string;
    insecure?: boolean;
    onAutoInsecure?: () => void;
  } = {},
): ReturnType<typeof createRegistrationClient> {
  const full: CreateClientOptions = {
    registryUrl: opts.registryUrl ?? 'http://127.0.0.1:8080',
    fetchFn: fetchFn as unknown as FetchFn,
  };
  if (opts.adminPrefix !== undefined) {
    full.adminPrefix = opts.adminPrefix;
  }
  if (opts.insecure === true) {
    full.insecure = true;
  }
  if (opts.onAutoInsecure !== undefined) {
    full.onAutoInsecure = opts.onAutoInsecure;
  }
  return createRegistrationClient(full);
}

function okResponse(): MockResponse {
  return { status: 200, text: async () => '', json: async () => ({}) };
}

describe('createRegistrationClient', () => {
  describe('register', () => {
    it('returns { ok: true, status: 200 } when fetch resolves with 200', async () => {
      const fetchFn: MockFetch = async () => okResponse();
      const client = makeClient(fetchFn);
      const result = await client.register({
        prefix: '/api',
        target: 'http://10.0.0.5:3000',
      });
      assert.deepEqual(result, { ok: true, status: 200 });
    });

    it('returns the parsed JSON error on a 4xx', async () => {
      const body = { error: 'prefix must start with /' };
      const fetchFn: MockFetch = async () => ({
        status: 400,
        text: async () => JSON.stringify(body),
        json: async () => body,
      });
      const client = makeClient(fetchFn);
      const result = await client.register({
        prefix: '/api',
        target: 'http://10.0.0.5:3000',
      });
      assert.deepEqual(result, { ok: false, status: 400, error: body });
    });

    it('returns a network error result when fetch rejects', async () => {
      const fetchFn: MockFetch = async () => {
        throw new Error('ECONNREFUSED');
      };
      const client = makeClient(fetchFn);
      const result = await client.register({
        prefix: '/api',
        target: 'http://10.0.0.5:3000',
      });
      assert.deepEqual(result, {
        ok: false,
        status: 0,
        error: { error: 'network', detail: 'ECONNREFUSED' },
      });
    });

    it('falls back to an unverified connection on TLS certificate failure', async () => {
      const certErr = new TypeError('fetch failed');
      Object.assign(certErr, {
        cause: new Error('self-signed certificate'),
      });
      const fetchFn: MockFetch = async () => {
        throw certErr;
      };
      let fallbacks = 0;
      const client = makeClient(fetchFn, {
        onAutoInsecure: () => {
          fallbacks += 1;
        },
      });
      // The secure fetch always throws; the fallback retry is a real
      // (unverified) connection that fails because no registry is listening.
      const result = await client.register({
        prefix: '/api',
        target: 'http://10.0.0.5:3000',
      });
      assert.equal(fallbacks, 1);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.status, 0);
        assert.equal(result.error.error, 'network');
      }
    });

    it('detects certificate errors nested deeper in the cause chain', async () => {
      const inner = new Error('self-signed certificate');
      const middle = new Error('TLS handshake failed', { cause: inner });
      const outer = new TypeError('fetch failed', { cause: middle });
      const fetchFn: MockFetch = async () => {
        throw outer;
      };
      let fallbacks = 0;
      const client = makeClient(fetchFn, {
        onAutoInsecure: () => {
          fallbacks += 1;
        },
      });
      await client.register({ prefix: '/api', target: 'http://10.0.0.5:3000' });
      assert.equal(fallbacks, 1);
    });

    it('remembers the fallback for subsequent calls', async () => {
      const certErr = new TypeError('fetch failed');
      Object.assign(certErr, { cause: new Error('self-signed certificate') });
      let secureCalls = 0;
      let fallbacks = 0;
      const fetchFn: MockFetch = async () => {
        secureCalls += 1;
        throw certErr;
      };
      const client = makeClient(fetchFn, {
        onAutoInsecure: () => {
          fallbacks += 1;
        },
      });
      await client.register({ prefix: '/api', target: 'http://10.0.0.5:3000' });
      assert.equal(secureCalls, 1);
      assert.equal(fallbacks, 1);

      // Second call goes straight to the unverified path: no more secure
      // fetches, no second fallback notification.
      const result = await client.deregister({ prefix: '/api' });
      assert.equal(secureCalls, 1);
      assert.equal(fallbacks, 1);
      assert.equal(result.ok, false);
    });

    it('skips verification up front when insecure is set (no fallback)', async () => {
      let secureCalls = 0;
      let fallbacks = 0;
      const fetchFn: MockFetch = async () => {
        secureCalls += 1;
        return okResponse();
      };
      const client = makeClient(fetchFn, {
        insecure: true,
        onAutoInsecure: () => {
          fallbacks += 1;
        },
      });
      const result = await client.register({
        prefix: '/api',
        target: 'http://10.0.0.5:3000',
      });
      assert.equal(secureCalls, 0);
      assert.equal(fallbacks, 0);
      assert.equal(result.ok, false);
    });

    it('does not annotate unrelated network errors', async () => {
      const fetchFn: MockFetch = async () => {
        throw new Error('socket hang up');
      };
      let fallbacks = 0;
      const client = makeClient(fetchFn, {
        onAutoInsecure: () => {
          fallbacks += 1;
        },
      });
      const result = await client.register({
        prefix: '/api',
        target: 'http://10.0.0.5:3000',
      });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.detail, 'socket hang up');
        assert.equal(isTlsCertificateError(result), false);
      }
      assert.equal(fallbacks, 0);
    });

    it('POSTs to <base>/register with JSON content-type and stringified body', async () => {
      const captured: { url: string | null; init: MockInit | null } = { url: null, init: null };
      const fetchFn: MockFetch = async (url, init) => {
        captured.url = url;
        captured.init = init;
        return okResponse();
      };
      const client = makeClient(fetchFn);
      const req = {
        prefix: '/api',
        target: 'http://10.0.0.5:3000',
      };
      await client.register(req);
      assert.equal(captured.url, 'http://127.0.0.1:8080/__registry/register');
      assert.ok(captured.init);
      assert.equal(captured.init.method, 'POST');
      assert.equal(captured.init.headers?.['content-type'], 'application/json');
      assert.deepEqual(JSON.parse(captured.init.body ?? '{}'), req);
    });
  });

  describe('heartbeat', () => {
    it('POSTs to <base>/heartbeat', async () => {
      const captured: { url: string | null; init: MockInit | null } = { url: null, init: null };
      const fetchFn: MockFetch = async (url, init) => {
        captured.url = url;
        captured.init = init;
        return okResponse();
      };
      const client = makeClient(fetchFn);
      await client.heartbeat({ prefix: '/api', target: 'http://10.0.0.5:3000' });
      assert.equal(captured.url, 'http://127.0.0.1:8080/__registry/heartbeat');
      assert.equal(captured.init?.method, 'POST');
    });
  });

  describe('deregister', () => {
    it('POSTs to <base>/deregister', async () => {
      let capturedUrl: string | null = null;
      const fetchFn: MockFetch = async (url) => {
        capturedUrl = url;
        return okResponse();
      };
      const client = makeClient(fetchFn);
      await client.deregister({ prefix: '/api' });
      assert.equal(capturedUrl, 'http://127.0.0.1:8080/__registry/deregister');
    });
  });

  describe('URL construction', () => {
    it('trims a trailing slash from registryUrl', async () => {
      let capturedUrl: string | null = null;
      const fetchFn: MockFetch = async (url) => {
        capturedUrl = url;
        return okResponse();
      };
      const client = makeClient(fetchFn, { registryUrl: 'http://127.0.0.1:8080/' });
      await client.register({ prefix: '/api', target: 'http://1' });
      assert.equal(capturedUrl, 'http://127.0.0.1:8080/__registry/register');
    });

    it('honors a custom adminPrefix that already starts with a slash', async () => {
      let capturedUrl: string | null = null;
      const fetchFn: MockFetch = async (url) => {
        capturedUrl = url;
        return okResponse();
      };
      const client = makeClient(fetchFn, {
        registryUrl: 'http://127.0.0.1:8080',
        adminPrefix: '/__admin',
      });
      await client.register({ prefix: '/api', target: 'http://1' });
      assert.equal(capturedUrl, 'http://127.0.0.1:8080/__admin/register');
    });

    it('prepends a slash when adminPrefix is given without one', async () => {
      let capturedUrl: string | null = null;
      const fetchFn: MockFetch = async (url) => {
        capturedUrl = url;
        return okResponse();
      };
      const client = makeClient(fetchFn, {
        registryUrl: 'http://127.0.0.1:8080',
        adminPrefix: '__admin',
      });
      await client.register({ prefix: '/api', target: 'http://1' });
      assert.equal(capturedUrl, 'http://127.0.0.1:8080/__admin/register');
    });
  });

  describe('error body parsing', () => {
    it('falls back to a generic http error when a 5xx body is not JSON', async () => {
      const fetchFn: MockFetch = async () => ({
        status: 500,
        text: async () => 'Internal Server Error',
        json: async () => {
          throw new SyntaxError('Unexpected token I');
        },
      });
      const client = makeClient(fetchFn);
      const result = await client.register({
        prefix: '/api',
        target: 'http://1',
      });
      assert.deepEqual(result, {
        ok: false,
        status: 500,
        error: { error: 'http 500', detail: 'Internal Server Error' },
      });
    });

    it('truncates the fallback detail to 200 characters', async () => {
      const longText = 'x'.repeat(500);
      const fetchFn: MockFetch = async () => ({
        status: 502,
        text: async () => longText,
        json: async () => {
          throw new SyntaxError('nope');
        },
      });
      const client = makeClient(fetchFn);
      const result = await client.register({
        prefix: '/api',
        target: 'http://1',
      });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.status, 502);
        assert.equal(result.error.error, 'http 502');
        const detail = result.error.detail as string;
        assert.equal(detail.length, 200);
        assert.equal(detail, 'x'.repeat(200));
      }
    });

    it('treats an empty 4xx body as a generic http error with empty detail', async () => {
      const fetchFn: MockFetch = async () => ({
        status: 400,
        text: async () => '',
        json: async () => {
          throw new SyntaxError('empty');
        },
      });
      const client = makeClient(fetchFn);
      const result = await client.register({
        prefix: '/api',
        target: 'http://1',
      });
      assert.deepEqual(result, {
        ok: false,
        status: 400,
        error: { error: 'http 400', detail: '' },
      });
    });
  });
});
