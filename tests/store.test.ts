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
    assert.equal(s.resolveTarget('/api/users/123'), 'http://b:2');
    assert.equal(s.resolveTarget('/api/other'), 'http://a:1');
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
