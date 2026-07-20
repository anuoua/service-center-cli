import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { renderRoutes } from '../src/registry/ui.ts';
import type { Route } from '../src/shared/types.ts';

const META = { host: '127.0.0.1', port: 8080 };

describe('renderRoutes', () => {
  it('renders an empty state when no routes', () => {
    const out = renderRoutes([], META);
    assert.match(out, /0 routes/);
    assert.match(out, /no routes registered/);
  });

  it('renders the registry URL in the header', () => {
    const out = renderRoutes([], META);
    assert.match(out, /http:\/\/127\.0\.0\.1:8080/);
    assert.match(out, /Ctrl\+C to stop/);
  });

  it('renders PREFIX, TARGET, URL columns', () => {
    const route: Route = {
      prefix: '/api/users',
      target: 'http://localhost:3000',
      lastSeen: 0,
    };
    const out = renderRoutes([route], META);
    assert.match(out, /1 route\b/);
    assert.match(out, /PREFIX/);
    assert.match(out, /TARGET/);
    assert.match(out, /URL/);
    assert.doesNotMatch(out, /SERVICE/);
    assert.doesNotMatch(out, /SEEN/);
    assert.match(out, /\/api\/users/);
    assert.match(out, /http:\/\/localhost:3000/);
    assert.match(out, /http:\/\/127\.0\.0\.1:8080\/api\/users/);
  });

  it('pluralizes "routes"', () => {
    const base = { target: 't', lastSeen: 0 } as const;
    const out = renderRoutes(
      [{ prefix: '/a', ...base }, { prefix: '/b', ...base }],
      META,
    );
    assert.match(out, /2 routes/);
  });

  it('sorts routes alphabetically by prefix', () => {
    const base = { target: 't', lastSeen: 0 } as const;
    const out = renderRoutes(
      [{ prefix: '/zeta', ...base }, { prefix: '/alpha', ...base }],
      META,
    );
    const alphaIdx = out.indexOf('/alpha');
    const zetaIdx = out.indexOf('/zeta');
    assert.ok(alphaIdx > 0 && zetaIdx > 0);
    assert.ok(alphaIdx < zetaIdx);
  });

  it('uses displayHost and port for the URL column', () => {
    const out = renderRoutes(
      [{ prefix: '/x', target: 't', lastSeen: 0 }],
      { host: 'example.com', port: 9090 },
    );
    assert.match(out, /http:\/\/example\.com:9090\/x/);
  });
});
