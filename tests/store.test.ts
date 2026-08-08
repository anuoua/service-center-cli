import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { RouteStore } from '../src/registry/store.ts';

describe('RouteStore.register', () => {
  it('inserts a route and exposes it via list()', () => {
    const s = new RouteStore({ adminPrefix: '/__registry' });
    const r = s.register({ prefix: '/api', target: 'http://x:1' }, 100);
    assert.deepEqual(r, { ok: true });
    const list = s.list();
    assert.equal(list.length, 1);
    assert.deepEqual(list[0], {
      prefix: '/api',
      target: 'http://x:1',
      lastSeen: 100,
    });
  });

  it('overwrites the target when the same prefix is re-registered', () => {
    const s = new RouteStore({ adminPrefix: '/__registry' });
    s.register({ prefix: '/api', target: 'http://x:1' }, 100);
    s.register({ prefix: '/api', target: 'http://y:2' }, 200);
    const list = s.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]?.target, 'http://y:2');
    assert.equal(list[0]?.lastSeen, 200);
  });

  it('rejects empty prefix with 400', () => {
    const s = new RouteStore({ adminPrefix: '/__registry' });
    const r = s.register({ prefix: '', target: 'http://x:1' }, 0);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 400);
  });

  it('rejects prefix not starting with /', () => {
    const s = new RouteStore({ adminPrefix: '/__registry' });
    const r = s.register({ prefix: 'api', target: 'http://x:1' }, 0);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 400);
      assert.match(r.error.error, /must start with/i);
    }
  });

  it('rejects prefix equal to admin prefix', () => {
    const s = new RouteStore({ adminPrefix: '/__registry' });
    const r = s.register({ prefix: '/__registry', target: 'http://x:1' }, 0);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 400);
  });

  it('rejects prefix that starts with admin prefix + /', () => {
    const s = new RouteStore({ adminPrefix: '/__registry' });
    const r = s.register({ prefix: '/__registry/x', target: 'http://x:1' }, 0);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 400);
  });

  it('rejects empty target', () => {
    const s = new RouteStore({ adminPrefix: '/__registry' });
    const r = s.register({ prefix: '/api', target: '' }, 0);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 400);
  });

  it('allows multiple prefixes to coexist', () => {
    const s = new RouteStore({ adminPrefix: '/__registry' });
    s.register({ prefix: '/api', target: 'http://x:1' }, 0);
    s.register({ prefix: '/web', target: 'http://y:2' }, 0);
    assert.equal(s.list().length, 2);
  });
});

describe('RouteStore.heartbeat', () => {
  it('refreshes lastSeen', () => {
    const s = new RouteStore({ adminPrefix: '/__registry' });
    s.register({ prefix: '/api', target: 'http://x:1' }, 100);
    const r = s.heartbeat({ prefix: '/api', target: 'http://x:1' }, 500);
    assert.deepEqual(r, { ok: true });
    assert.equal(s.list()[0]?.lastSeen, 500);
  });

  it('updates target if changed', () => {
    const s = new RouteStore({ adminPrefix: '/__registry' });
    s.register({ prefix: '/api', target: 'http://x:1' }, 100);
    s.heartbeat({ prefix: '/api', target: 'http://z:3' }, 500);
    assert.equal(s.list()[0]?.target, 'http://z:3');
  });

  it('returns 404 for unknown prefix', () => {
    const s = new RouteStore({ adminPrefix: '/__registry' });
    const r = s.heartbeat({ prefix: '/nope', target: 'http://x:1' }, 0);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 404);
  });
});

describe('RouteStore.deregister', () => {
  it('removes the route', () => {
    const s = new RouteStore({ adminPrefix: '/__registry' });
    s.register({ prefix: '/api', target: 'http://x:1' }, 0);
    const r = s.deregister({ prefix: '/api' });
    assert.deepEqual(r, { ok: true });
    assert.equal(s.list().length, 0);
  });

  it('returns 404 for unknown prefix', () => {
    const s = new RouteStore({ adminPrefix: '/__registry' });
    const r = s.deregister({ prefix: '/nope' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 404);
  });
});

describe('RouteStore.resolveTarget', () => {
  it('uses the longest match across prefixes', () => {
    const s = new RouteStore({ adminPrefix: '/__registry' });
    s.register({ prefix: '/api', target: 'http://a:1' }, 0);
    s.register({ prefix: '/api/users', target: 'http://b:2' }, 0);
    assert.deepEqual(s.resolveTarget('/api/users/123'), { target: 'http://b:2' });
    assert.deepEqual(s.resolveTarget('/api/other'), { target: 'http://a:1' });
  });

  it('returns null when nothing is registered', () => {
    const s = new RouteStore({ adminPrefix: '/__registry' });
    assert.equal(s.resolveTarget('/api'), null);
  });

  it('returns null when no prefix matches', () => {
    const s = new RouteStore({ adminPrefix: '/__registry' });
    s.register({ prefix: '/api', target: 'http://a:1' }, 0);
    assert.equal(s.resolveTarget('/nope'), null);
  });
});

describe('RouteStore.sweep', () => {
  it('evicts expired routes and returns their prefixes', () => {
    const s = new RouteStore({ adminPrefix: '/__registry' });
    s.register({ prefix: '/a', target: 'http://a:1' }, 100);
    s.register({ prefix: '/b', target: 'http://b:1' }, 500);
    const evicted = s.sweep(600, 200);
    assert.deepEqual(evicted, ['/a']);
    assert.equal(s.list().length, 1);
    assert.equal(s.list()[0]?.prefix, '/b');
  });

  it('does not evict routes at exactly ttl boundary (strictly greater)', () => {
    const s = new RouteStore({ adminPrefix: '/__registry' });
    s.register({ prefix: '/a', target: 'http://a:1' }, 100);
    const evicted = s.sweep(100 + 200, 200);
    assert.deepEqual(evicted, []);
  });

  it('returns an empty array when the store is empty', () => {
    const s = new RouteStore({ adminPrefix: '/__registry' });
    assert.deepEqual(s.sweep(1000, 100), []);
  });
});

describe('RouteStore static routes', () => {
  it('loadStatic inserts routes flagged static', () => {
    const s = new RouteStore({ adminPrefix: '/__registry' });
    const r = s.loadStatic([
      { prefix: '/legacy/orders', target: 'http://a:1' },
      { prefix: '/legacy/pay', target: 'http://b:2' },
    ]);
    assert.deepEqual(r, { ok: true, count: 2 });
    assert.deepEqual(s.list(), [
      { prefix: '/legacy/orders', target: 'http://a:1', lastSeen: 0, static: true },
      { prefix: '/legacy/pay', target: 'http://b:2', lastSeen: 0, static: true },
    ]);
  });

  it('loadStatic replaces the previous static set (reload semantics)', () => {
    const s = new RouteStore({ adminPrefix: '/__registry' });
    s.loadStatic([
      { prefix: '/a', target: 'http://a:1' },
      { prefix: '/b', target: 'http://b:1' },
    ]);
    const r = s.loadStatic([
      { prefix: '/b', target: 'http://b:2' },
      { prefix: '/c', target: 'http://c:1' },
    ]);
    assert.deepEqual(r, { ok: true, count: 2 });
    assert.deepEqual(
      s.list().map((x) => x.prefix),
      ['/b', '/c'],
    );
  });

  it('loadStatic rejects a prefix that does not start with /', () => {
    const s = new RouteStore({ adminPrefix: '/__registry' });
    const r = s.loadStatic([{ prefix: 'no-slash', target: 'http://a:1' }]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 400);
  });

  it('loadStatic rejects a prefix colliding with the admin prefix', () => {
    const s = new RouteStore({ adminPrefix: '/__registry' });
    const r = s.loadStatic([{ prefix: '/__registry', target: 'http://a:1' }]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 400);
  });

  it('loadStatic rejects duplicate prefixes without partial application', () => {
    const s = new RouteStore({ adminPrefix: '/__registry' });
    s.loadStatic([{ prefix: '/keep', target: 'http://keep:1' }]);
    const r = s.loadStatic([
      { prefix: '/x', target: 'http://x:1' },
      { prefix: '/x', target: 'http://y:1' },
    ]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 400);
    // previous static set is untouched
    assert.deepEqual(
      s.list().map((x) => x.prefix),
      ['/keep'],
    );
  });

  it('rejects dynamic register on a static prefix with 409', () => {
    const s = new RouteStore({ adminPrefix: '/__registry' });
    s.loadStatic([{ prefix: '/legacy', target: 'http://a:1' }]);
    const r = s.register({ prefix: '/legacy', target: 'http://b:2' }, 100);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 409);
      assert.match(r.error.error, /static route/i);
    }
  });

  it('rejects heartbeat on a static prefix with 409', () => {
    const s = new RouteStore({ adminPrefix: '/__registry' });
    s.loadStatic([{ prefix: '/legacy', target: 'http://a:1' }]);
    const r = s.heartbeat({ prefix: '/legacy', target: 'http://a:1' }, 500);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 409);
  });

  it('rejects deregister on a static prefix with 409', () => {
    const s = new RouteStore({ adminPrefix: '/__registry' });
    s.loadStatic([{ prefix: '/legacy', target: 'http://a:1' }]);
    const r = s.deregister({ prefix: '/legacy' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 409);
  });

  it('sweep never evicts static routes', () => {
    const s = new RouteStore({ adminPrefix: '/__registry' });
    s.loadStatic([{ prefix: '/legacy', target: 'http://a:1' }]);
    s.register({ prefix: '/dyn', target: 'http://b:1' }, 100);
    const evicted = s.sweep(1_000_000, 1);
    assert.deepEqual(evicted, ['/dyn']);
    assert.deepEqual(
      s.list().map((x) => x.prefix),
      ['/legacy'],
    );
  });

  it('static and dynamic routes coexist; longest match wins across both', () => {
    const s = new RouteStore({ adminPrefix: '/__registry' });
    s.loadStatic([{ prefix: '/api', target: 'http://static:1' }]);
    s.register({ prefix: '/api/users', target: 'http://dyn:2' }, 0);
    assert.deepEqual(s.resolveTarget('/api/other'), { target: 'http://static:1' });
    assert.deepEqual(s.resolveTarget('/api/users/1'), { target: 'http://dyn:2' });
  });

  it('resolveTarget returns the rewrite of a static route', () => {
    const s = new RouteStore({ adminPrefix: '/__registry' });
    s.loadStatic([
      {
        prefix: '/legacy/orders',
        target: 'http://a:1',
        rewrite: { pattern: '^/legacy/orders', to: '/orders' },
      },
    ]);
    assert.deepEqual(s.resolveTarget('/legacy/orders/123'), {
      target: 'http://a:1',
      rewrite: { pattern: '^/legacy/orders', to: '/orders' },
    });
  });

  it('loadStatic stores routes with a rewrite', () => {
    const s = new RouteStore({ adminPrefix: '/__registry' });
    const r = s.loadStatic([
      {
        prefix: '/legacy/orders',
        target: 'http://a:1',
        rewrite: { pattern: '^/legacy/orders', to: '' },
      },
    ]);
    assert.deepEqual(r, { ok: true, count: 1 });
    assert.deepEqual(s.list(), [
      {
        prefix: '/legacy/orders',
        target: 'http://a:1',
        lastSeen: 0,
        static: true,
        rewrite: { pattern: '^/legacy/orders', to: '' },
      },
    ]);
  });
});
