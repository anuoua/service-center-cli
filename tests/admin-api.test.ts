import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { createAdminHandler } from '../src/registry/admin-handler.ts';
import { RouteStore } from '../src/registry/store.ts';

const ADMIN = '/__registry';

type JsonBody = unknown;

async function startAdminServer(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const store = new RouteStore({ adminPrefix: ADMIN });
  const handler = createAdminHandler(store);
  const server = http.createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function sendJson(
  url: string,
  init: { method: string; body?: string; headers?: Record<string, string> },
): Promise<{ status: number; body: JsonBody }> {
  const resp = await fetch(url, {
    method: init.method,
    headers: init.headers ?? { 'content-type': 'application/json' },
    body: init.body,
  });
  const text = await resp.text();
  let body: JsonBody = undefined;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: resp.status, body };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('admin api', () => {
  it('registers a route and lists it via GET /routes', async () => {
    const { url, close } = await startAdminServer();
    try {
      const reg = await sendJson(`${url}${ADMIN}/register`, {
        method: 'POST',
        body: JSON.stringify({
          prefix: '/api',
          target: 'http://localhost:3000',
        }),
      });
      assert.equal(reg.status, 200);
      assert.deepEqual(reg.body, { ok: true });

      const list = await sendJson(`${url}${ADMIN}/routes`, { method: 'GET' });
      assert.equal(list.status, 200);
      assert.ok(Array.isArray(list.body));
      const routes = list.body as Array<{
        prefix: string;
        target: string;
        lastSeen: number;
      }>;
      assert.equal(routes.length, 1);
      assert.equal(routes[0].prefix, '/api');
      assert.equal(routes[0].target, 'http://localhost:3000');
      assert.equal(typeof routes[0].lastSeen, 'number');
    } finally {
      await close();
    }
  });

  it('re-registering the same prefix overwrites target', async () => {
    const { url, close } = await startAdminServer();
    try {
      await sendJson(`${url}${ADMIN}/register`, {
        method: 'POST',
        body: JSON.stringify({ prefix: '/api', target: 'http://a:1' }),
      });
      const r2 = await sendJson(`${url}${ADMIN}/register`, {
        method: 'POST',
        body: JSON.stringify({ prefix: '/api', target: 'http://b:2' }),
      });
      assert.equal(r2.status, 200);

      const list = await sendJson(`${url}${ADMIN}/routes`, { method: 'GET' });
      const routes = list.body as Array<{ prefix: string; target: string }>;
      assert.equal(routes.length, 1);
      assert.equal(routes[0].target, 'http://b:2');
    } finally {
      await close();
    }
  });

  it('returns 400 when prefix is missing or malformed', async () => {
    const { url, close } = await startAdminServer();
    try {
      const r1 = await sendJson(`${url}${ADMIN}/register`, {
        method: 'POST',
        body: JSON.stringify({ target: 'http://a:1' }),
      });
      assert.equal(r1.status, 400);

      const r2 = await sendJson(`${url}${ADMIN}/register`, {
        method: 'POST',
        body: JSON.stringify({ prefix: 'no-slash', target: 'http://a:1' }),
      });
      assert.equal(r2.status, 400);
    } finally {
      await close();
    }
  });

  it('returns 400 when prefix collides with admin prefix', async () => {
    const { url, close } = await startAdminServer();
    try {
      const r = await sendJson(`${url}${ADMIN}/register`, {
        method: 'POST',
        body: JSON.stringify({ prefix: '/__registry', target: 'http://a:1' }),
      });
      assert.equal(r.status, 400);
    } finally {
      await close();
    }
  });

  it('returns 404 when heartbeating an unknown prefix', async () => {
    const { url, close } = await startAdminServer();
    try {
      const r = await sendJson(`${url}${ADMIN}/heartbeat`, {
        method: 'POST',
        body: JSON.stringify({ prefix: '/nope', target: 'http://a:1' }),
      });
      assert.equal(r.status, 404);
    } finally {
      await close();
    }
  });

  it('refreshes lastSeen on heartbeat', async () => {
    const { url, close } = await startAdminServer();
    try {
      await sendJson(`${url}${ADMIN}/register`, {
        method: 'POST',
        body: JSON.stringify({ prefix: '/api', target: 'http://a:1' }),
      });
      const before = (
        (await sendJson(`${url}${ADMIN}/routes`, { method: 'GET' })).body as Array<{
          lastSeen: number;
        }>
      )[0].lastSeen;

      await sleep(50);

      await sendJson(`${url}${ADMIN}/heartbeat`, {
        method: 'POST',
        body: JSON.stringify({ prefix: '/api', target: 'http://a:1' }),
      });
      const after = (
        (await sendJson(`${url}${ADMIN}/routes`, { method: 'GET' })).body as Array<{
          lastSeen: number;
        }>
      )[0].lastSeen;

      assert.ok(after > before, 'lastSeen should advance');
    } finally {
      await close();
    }
  });

  it('deregisters an existing prefix', async () => {
    const { url, close } = await startAdminServer();
    try {
      await sendJson(`${url}${ADMIN}/register`, {
        method: 'POST',
        body: JSON.stringify({ prefix: '/api', target: 'http://a:1' }),
      });
      const r = await sendJson(`${url}${ADMIN}/deregister`, {
        method: 'POST',
        body: JSON.stringify({ prefix: '/api' }),
      });
      assert.equal(r.status, 200);

      const list = await sendJson(`${url}${ADMIN}/routes`, { method: 'GET' });
      assert.deepEqual(list.body, []);
    } finally {
      await close();
    }
  });

  it('returns 404 when deregistering an unknown prefix', async () => {
    const { url, close } = await startAdminServer();
    try {
      const r = await sendJson(`${url}${ADMIN}/deregister`, {
        method: 'POST',
        body: JSON.stringify({ prefix: '/nope' }),
      });
      assert.equal(r.status, 404);
    } finally {
      await close();
    }
  });

  it('returns 400 on invalid JSON body', async () => {
    const { url, close } = await startAdminServer();
    try {
      const r = await sendJson(`${url}${ADMIN}/register`, {
        method: 'POST',
        body: 'not-json',
      });
      assert.equal(r.status, 400);
      const body = r.body as { error: string };
      assert.match(body.error, /invalid json/i);
    } finally {
      await close();
    }
  });

  it('returns 404 for unknown admin path', async () => {
    const { url, close } = await startAdminServer();
    try {
      const r = await sendJson(`${url}${ADMIN}/unknown`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      assert.equal(r.status, 404);
    } finally {
      await close();
    }
  });
});
