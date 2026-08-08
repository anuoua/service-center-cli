import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startRegistry } from '../src/commands/registry.ts';
import type { RegistryOptions, RegistryHandle } from '../src/commands/registry.ts';
import { createRegistrationClient } from '../src/server/registration-client.ts';
import { createTlsConfig } from '../src/registry/tls.ts';

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

async function startBackend(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ url: req.url }));
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

// Minimal TLS client that skips certificate verification, mirroring how a
// browser behaves after "proceed anyway".
function httpsGet(
  port: number,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: '127.0.0.1', port, path, rejectUnauthorized: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('registry with --tls (self-signed)', () => {
  let registry: RegistryHandle;
  let backend: { port: number; close: () => Promise<void> };

  before(async () => {
    registry = await startRegistry(defaultRegistryOpts({ tls: true }));
    backend = await startBackend();
  });

  after(async () => {
    await registry.stop();
    await backend.close();
  });

  it('serves the admin API over https', async () => {
    const res = await httpsGet(registry.port, `${ADMIN}/routes`);
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), []);
  });

  it('insecure registration client can register and proxy traffic works over https', async () => {
    const client = createRegistrationClient({
      registryUrl: `https://127.0.0.1:${registry.port}`,
      insecure: true,
    });
    const reg = await client.register({
      prefix: '/api/tls',
      target: `http://127.0.0.1:${backend.port}`,
    });
    assert.deepEqual(reg, { ok: true, status: 200 });

    try {
      const proxied = await httpsGet(registry.port, '/api/tls/hello');
      assert.equal(proxied.status, 200);
      assert.deepEqual(JSON.parse(proxied.body), { url: '/api/tls/hello' });
    } finally {
      await client.deregister({ prefix: '/api/tls' });
    }
  });

  it('without --insecure the client auto-falls back to an unverified connection', async () => {
    let fallbacks = 0;
    const client = createRegistrationClient({
      registryUrl: `https://127.0.0.1:${registry.port}`,
      onAutoInsecure: () => {
        fallbacks += 1;
      },
    });
    const reg = await client.register({
      prefix: '/api/auto',
      target: `http://127.0.0.1:${backend.port}`,
    });
    assert.deepEqual(reg, { ok: true, status: 200 });
    assert.equal(fallbacks, 1);

    // Subsequent calls remember the fallback: heartbeat works without
    // another failure/retry cycle.
    const hb = await client.heartbeat({
      prefix: '/api/auto',
      target: `http://127.0.0.1:${backend.port}`,
    });
    assert.deepEqual(hb, { ok: true, status: 200 });
    assert.equal(fallbacks, 1);

    await client.deregister({ prefix: '/api/auto' });
  });

  it('with --insecure verification is skipped up front (no fallback)', async () => {
    let fallbacks = 0;
    const client = createRegistrationClient({
      registryUrl: `https://127.0.0.1:${registry.port}`,
      insecure: true,
      onAutoInsecure: () => {
        fallbacks += 1;
      },
    });
    const reg = await client.register({
      prefix: '/api/insecure',
      target: `http://127.0.0.1:${backend.port}`,
    });
    assert.deepEqual(reg, { ok: true, status: 200 });
    assert.equal(fallbacks, 0);
    await client.deregister({ prefix: '/api/insecure' });
  });
});

describe('registry with provided cert files', () => {
  let registry: RegistryHandle;
  let backend: { port: number; close: () => Promise<void> };
  let tmpDir: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'sccli-tls-e2e-'));
    const generated = await createTlsConfig({ tls: true });
    assert.ok(generated);
    await writeFile(join(tmpDir, 'server.key'), generated.key, 'utf8');
    await writeFile(join(tmpDir, 'server.crt'), generated.cert, 'utf8');

    registry = await startRegistry(
      defaultRegistryOpts({
        tlsCertFile: join(tmpDir, 'server.crt'),
        tlsKeyFile: join(tmpDir, 'server.key'),
      }),
    );
    backend = await startBackend();
  });

  after(async () => {
    await registry.stop();
    await backend.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('serves https and proxies to a backend', async () => {
    const client = createRegistrationClient({
      registryUrl: `https://127.0.0.1:${registry.port}`,
      insecure: true,
    });
    const reg = await client.register({
      prefix: '/api/cert',
      target: `http://127.0.0.1:${backend.port}`,
    });
    assert.deepEqual(reg, { ok: true, status: 200 });
    try {
      const proxied = await httpsGet(registry.port, '/api/cert/x');
      assert.equal(proxied.status, 200);
    } finally {
      await client.deregister({ prefix: '/api/cert' });
    }
  });
});
