import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { readJsonBody, sendJson } from '../src/shared/http.ts';

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

function startServer(handler: Handler): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      void handler(req, res);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('readJsonBody', () => {
  it('parses a valid JSON request body', async () => {
    let captured: unknown = null;
    const { server, url } = await startServer(async (req, res) => {
      captured = await readJsonBody(req);
      await sendJson(res, 200, { ok: true });
    });
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hello: 'world', n: 42 }),
      });
      assert.equal(resp.status, 200);
      assert.deepEqual(captured, { hello: 'world', n: 42 });
    } finally {
      await close(server);
    }
  });

  it('throws when the body is empty', async () => {
    let caught: unknown = null;
    const { server, url } = await startServer(async (req, res) => {
      try {
        await readJsonBody(req);
      } catch (err) {
        caught = err;
        await sendJson(res, 400, { error: 'bad body' });
        return;
      }
      await sendJson(res, 200, { ok: true });
    });
    try {
      const resp = await fetch(url, { method: 'POST' });
      assert.equal(resp.status, 400);
      assert.ok(caught instanceof Error, 'expected an Error to be thrown');
    } finally {
      await close(server);
    }
  });

  it('throws when the body is invalid JSON', async () => {
    let caught: unknown = null;
    const { server, url } = await startServer(async (req, res) => {
      try {
        await readJsonBody(req);
      } catch (err) {
        caught = err;
        await sendJson(res, 400, { error: 'bad json' });
        return;
      }
      await sendJson(res, 200, { ok: true });
    });
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      });
      assert.equal(resp.status, 400);
      assert.ok(caught instanceof Error, 'expected an Error to be thrown');
    } finally {
      await close(server);
    }
  });
});

describe('sendJson', () => {
  it('writes the given status code, content-type, and JSON body', async () => {
    const payload = { error: 'prefix conflict', detail: { prefix: '/api', owner: 'x' } };
    const { server, url } = await startServer(async (_req, res) => {
      await sendJson(res, 409, payload);
    });
    try {
      const resp = await fetch(url, { method: 'GET' });
      assert.equal(resp.status, 409);
      assert.equal(resp.headers.get('content-type'), 'application/json');
      const body = await resp.json();
      assert.deepEqual(body, payload);
    } finally {
      await close(server);
    }
  });

  it('writes a 200 with the exact body for an ok response', async () => {
    const { server, url } = await startServer(async (_req, res) => {
      await sendJson(res, 200, { ok: true });
    });
    try {
      const resp = await fetch(url, { method: 'GET' });
      assert.equal(resp.status, 200);
      assert.equal(resp.headers.get('content-type'), 'application/json');
      const body = await resp.json();
      assert.deepEqual(body, { ok: true });
    } finally {
      await close(server);
    }
  });
});
