import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadStaticRoutesFile } from '../src/registry/static-routes.ts';

let tmp: string | undefined;

async function withFile(content: string): Promise<string> {
  if (tmp === undefined) {
    tmp = await mkdtemp(join(tmpdir(), 'sccli-routes-'));
  }
  const p = join(tmp, `routes-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(p, content, 'utf8');
  return p;
}

afterEach(async () => {
  if (tmp !== undefined) {
    await rm(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

describe('loadStaticRoutesFile', () => {
  it('parses a valid routes file', async () => {
    const p = await withFile(
      JSON.stringify([
        { prefix: '/legacy/orders', target: 'http://10.0.0.9:8080' },
        { prefix: '/legacy/pay', target: 'http://10.0.0.10:9000' },
      ]),
    );
    const r = await loadStaticRoutesFile(p);
    assert.deepEqual(r, {
      ok: true,
      routes: [
        { prefix: '/legacy/orders', target: 'http://10.0.0.9:8080' },
        { prefix: '/legacy/pay', target: 'http://10.0.0.10:9000' },
      ],
    });
  });

  it('accepts an empty array', async () => {
    const p = await withFile('[]');
    const r = await loadStaticRoutesFile(p);
    assert.deepEqual(r, { ok: true, routes: [] });
  });

  it('reports an error when the file does not exist', async () => {
    const r = await loadStaticRoutesFile('/nonexistent/nope.json');
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /cannot read/);
  });

  it('reports an error for invalid JSON', async () => {
    const p = await withFile('{ not json');
    const r = await loadStaticRoutesFile(p);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /invalid JSON/);
  });

  it('reports an error when the root is not an array', async () => {
    const p = await withFile('{"prefix":"/a","target":"http://a:1"}');
    const r = await loadStaticRoutesFile(p);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /array/);
  });

  it('reports an error when an entry is not an object', async () => {
    const p = await withFile('["/a"]');
    const r = await loadStaticRoutesFile(p);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /route\[0\]/);
  });

  it('reports an error when prefix is missing or empty', async () => {
    const p1 = await withFile(JSON.stringify([{ target: 'http://a:1' }]));
    const r1 = await loadStaticRoutesFile(p1);
    assert.equal(r1.ok, false);
    if (!r1.ok) assert.match(r1.error, /route\[0\]\.prefix/);

    const p2 = await withFile(JSON.stringify([{ prefix: '', target: 'http://a:1' }]));
    const r2 = await loadStaticRoutesFile(p2);
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.match(r2.error, /route\[0\]\.prefix/);
  });

  it('reports an error when target is missing or empty', async () => {
    const p1 = await withFile(JSON.stringify([{ prefix: '/a' }]));
    const r1 = await loadStaticRoutesFile(p1);
    assert.equal(r1.ok, false);
    if (!r1.ok) assert.match(r1.error, /route\[0\]\.target/);

    const p2 = await withFile(JSON.stringify([{ prefix: '/a', target: '' }]));
    const r2 = await loadStaticRoutesFile(p2);
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.match(r2.error, /route\[0\]\.target/);
  });

  it('parses an optional rewrite rule', async () => {
    const p = await withFile(
      JSON.stringify([
        {
          prefix: '/legacy/orders',
          target: 'http://10.0.0.9:8080',
          rewrite: { pattern: '^/legacy/orders', to: '/orders' },
        },
        { prefix: '/legacy/pay', target: 'http://10.0.0.10:9000' },
      ]),
    );
    const r = await loadStaticRoutesFile(p);
    assert.deepEqual(r, {
      ok: true,
      routes: [
        {
          prefix: '/legacy/orders',
          target: 'http://10.0.0.9:8080',
          rewrite: { pattern: '^/legacy/orders', to: '/orders' },
        },
        { prefix: '/legacy/pay', target: 'http://10.0.0.10:9000' },
      ],
    });
  });

  it('accepts an empty replacement string in rewrite.to', async () => {
    const p = await withFile(
      JSON.stringify([
        { prefix: '/legacy', target: 'http://a:1', rewrite: { pattern: '^/legacy', to: '' } },
      ]),
    );
    const r = await loadStaticRoutesFile(p);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.routes[0]?.rewrite?.to, '');
  });

  it('reports an error when rewrite is not an object', async () => {
    const p = await withFile(
      JSON.stringify([{ prefix: '/a', target: 'http://a:1', rewrite: '^/a' }]),
    );
    const r = await loadStaticRoutesFile(p);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /route\[0\]\.rewrite/);
  });

  it('reports an error when rewrite.pattern is missing or invalid', async () => {
    const p1 = await withFile(
      JSON.stringify([{ prefix: '/a', target: 'http://a:1', rewrite: { to: '' } }]),
    );
    const r1 = await loadStaticRoutesFile(p1);
    assert.equal(r1.ok, false);
    if (!r1.ok) assert.match(r1.error, /rewrite\.pattern/);

    const p2 = await withFile(
      JSON.stringify([
        { prefix: '/a', target: 'http://a:1', rewrite: { pattern: '(', to: '' } },
      ]),
    );
    const r2 = await loadStaticRoutesFile(p2);
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.match(r2.error, /not a valid regular expression/);
  });

  it('reports an error when rewrite.to is missing', async () => {
    const p = await withFile(
      JSON.stringify([{ prefix: '/a', target: 'http://a:1', rewrite: { pattern: '^/a' } }]),
    );
    const r = await loadStaticRoutesFile(p);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /rewrite\.to/);
  });
});
