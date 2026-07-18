import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { startRegistry } from '../src/commands/registry.ts';
import type { RegistryOptions, RegistryHandle } from '../src/commands/registry.ts';

const ADMIN = '/__registry';

function defaultRegistryOpts(
  overrides: Partial<RegistryOptions> = {},
): RegistryOptions {
  return {
    port: 0,
    host: '127.0.0.1',
    adminPrefix: ADMIN,
    ttlMs: 30000,
    intervalMs: 10000,
    logLevel: 'warn',
    ui: false,
    ...overrides,
  };
}

type Backend = { port: number; close: () => Promise<void> };

async function startBackend(identifier: string): Promise<Backend> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: identifier,
          method: req.method,
          url: req.url,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function postJson(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let parsed: unknown = undefined;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: resp.status, body: parsed };
}

async function fetchThrough(port: number, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, init);
}

describe('proxy e2e', () => {
  let registry: RegistryHandle;
  let backend: Backend;

  before(async () => {
    registry = await startRegistry(defaultRegistryOpts());
    backend = await startBackend('backend-A');
  });

  after(async () => {
    await registry.stop();
    await backend.close();
  });

  it('happy path: register then GET through proxy returns backend response', async () => {
    const target = `http://127.0.0.1:${backend.port}`;
    const reg = await postJson(`http://127.0.0.1:${registry.port}${ADMIN}/register`, {
      prefix: '/api/happy',
      target,
    });
    assert.equal(reg.status, 200);

    try {
      const resp = await fetchThrough(registry.port, '/api/happy/hello');
      assert.equal(resp.status, 200);
      const body = (await resp.json()) as {
        id: string;
        method: string;
        url: string;
        body: string;
      };
      assert.equal(body.id, 'backend-A');
      assert.equal(body.method, 'GET');
      assert.equal(body.url, '/api/happy/hello');
    } finally {
      await postJson(`http://127.0.0.1:${registry.port}${ADMIN}/deregister`, {
        prefix: '/api/happy',
      });
    }
  });

  it('POST body passes through the proxy', async () => {
    const target = `http://127.0.0.1:${backend.port}`;
    const reg = await postJson(`http://127.0.0.1:${registry.port}${ADMIN}/register`, {
      prefix: '/api/post',
      target,
    });
    assert.equal(reg.status, 200);

    try {
      const payload = JSON.stringify({ hello: 'world' });
      const resp = await fetchThrough(registry.port, '/api/post/echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      });
      assert.equal(resp.status, 200);
      const body = (await resp.json()) as { method: string; body: string };
      assert.equal(body.method, 'POST');
      assert.equal(body.body, payload);
    } finally {
      await postJson(`http://127.0.0.1:${registry.port}${ADMIN}/deregister`, {
        prefix: '/api/post',
      });
    }
  });

  it('returns 404 { error: "no route" } for unknown prefixes', async () => {
    const resp = await fetchThrough(registry.port, '/api/never-registered');
    assert.equal(resp.status, 404);
    const body = await resp.json();
    assert.deepEqual(body, { error: 'no route' });
  });

  it('deregister causes subsequent requests to that prefix to return 404', async () => {
    const target = `http://127.0.0.1:${backend.port}`;
    const reg = await postJson(`http://127.0.0.1:${registry.port}${ADMIN}/register`, {
      prefix: '/api/dere',
      target,
    });
    assert.equal(reg.status, 200);

    const before = await fetchThrough(registry.port, '/api/dere/x');
    assert.equal(before.status, 200);

    const dere = await postJson(`http://127.0.0.1:${registry.port}${ADMIN}/deregister`, {
      prefix: '/api/dere',
    });
    assert.equal(dere.status, 200);

    const after = await fetchThrough(registry.port, '/api/dere/x');
    assert.equal(after.status, 404);
    const body = await after.json();
    assert.deepEqual(body, { error: 'no route' });
  });
});

describe('proxy e2e: TTL eviction', () => {
  let registry: RegistryHandle;
  let backend: Backend;

  before(async () => {
    registry = await startRegistry(
      defaultRegistryOpts({ ttlMs: 100, intervalMs: 50 }),
    );
    backend = await startBackend('backend-TTL');
  });

  after(async () => {
    await registry.stop();
    await backend.close();
  });

  it('evicts a route after ttl expires; subsequent fetch returns 404', async () => {
    const target = `http://127.0.0.1:${backend.port}`;
    const reg = await postJson(`http://127.0.0.1:${registry.port}${ADMIN}/register`, {
      prefix: '/api/ttl',
      target,
    });
    assert.equal(reg.status, 200);

    const before = await fetchThrough(registry.port, '/api/ttl/x');
    assert.equal(before.status, 200);

    await new Promise<void>((r) => setTimeout(r, 250));

    const after = await fetchThrough(registry.port, '/api/ttl/x');
    assert.equal(after.status, 404);
    const body = await after.json();
    assert.deepEqual(body, { error: 'no route' });
  });
});

describe('proxy e2e: longest-prefix routing', () => {
  let registry: RegistryHandle;
  let backendA: Backend;
  let backendB: Backend;

  before(async () => {
    registry = await startRegistry(defaultRegistryOpts());
    backendA = await startBackend('A');
    backendB = await startBackend('B');
    const targetA = `http://127.0.0.1:${backendA.port}`;
    const targetB = `http://127.0.0.1:${backendB.port}`;
    const r1 = await postJson(`http://127.0.0.1:${registry.port}${ADMIN}/register`, {
      prefix: '/api/lp',
      target: targetA,
    });
    assert.equal(r1.status, 200);
    const r2 = await postJson(`http://127.0.0.1:${registry.port}${ADMIN}/register`, {
      prefix: '/api/lp/users',
      target: targetB,
    });
    assert.equal(r2.status, 200);
  });

  after(async () => {
    await registry.stop();
    await backendA.close();
    await backendB.close();
  });

  it('routes the more-specific prefix to backend B', async () => {
    const resp = await fetchThrough(registry.port, '/api/lp/users/42');
    assert.equal(resp.status, 200);
    const body = (await resp.json()) as { id: string };
    assert.equal(body.id, 'B');
  });

  it('routes the less-specific prefix to backend A', async () => {
    const resp = await fetchThrough(registry.port, '/api/lp/other');
    assert.equal(resp.status, 200);
    const body = (await resp.json()) as { id: string };
    assert.equal(body.id, 'A');
  });
});
