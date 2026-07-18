import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { longestMatch } from '../src/registry/matcher.ts';

describe('longestMatch', () => {
  it('returns null for an empty prefixes array', () => {
    assert.equal(longestMatch([], '/api'), null);
  });

  it('matches an exact-equal path', () => {
    assert.equal(longestMatch(['/api'], '/api'), '/api');
  });

  it('matches a sub-path under a prefix', () => {
    assert.equal(longestMatch(['/api'], '/api/users'), '/api');
    assert.equal(longestMatch(['/api'], '/api/users/123'), '/api');
  });

  it('rejects a prefix that shares leading characters but crosses a segment boundary', () => {
    assert.equal(longestMatch(['/api'], '/api-foo'), null);
    assert.equal(longestMatch(['/api'], '/apis'), null);
    assert.equal(longestMatch(['/api'], '/ap'), null);
    assert.equal(longestMatch(['/api'], '/a'), null);
  });

  it('rejects a sibling that looks like the prefix but is shorter', () => {
    assert.equal(longestMatch(['/api/users'], '/api/users-foo'), null);
    assert.equal(longestMatch(['/api/users'], '/api/user'), null);
  });

  it('returns the longest matching prefix among nested prefixes', () => {
    assert.equal(longestMatch(['/api', '/api/users'], '/api/users/123'), '/api/users');
    assert.equal(longestMatch(['/api', '/api/users'], '/api/health'), '/api');
  });

  it('handles deeply nested prefixes', () => {
    const prefixes = ['/api', '/api/users', '/api/users/permissions'];
    assert.equal(longestMatch(prefixes, '/api/users/permissions/42'), '/api/users/permissions');
    assert.equal(longestMatch(prefixes, '/api/users/42'), '/api/users');
    assert.equal(longestMatch(prefixes, '/api/orgs'), '/api');
  });

  it('strips the query string before matching', () => {
    assert.equal(longestMatch(['/api'], '/api?x=1'), '/api');
    assert.equal(longestMatch(['/api/users'], '/api/users/123?a=b&c=d'), '/api/users');
  });

  it('returns null when nothing matches', () => {
    assert.equal(longestMatch(['/api'], '/health'), null);
  });

  it('returns null for a url without a leading slash', () => {
    assert.equal(longestMatch(['/api'], 'api/foo'), null);
  });

  it('returns the longest unique prefix when duplicates are present', () => {
    assert.equal(longestMatch(['/api', '/api', '/api/users'], '/api/users/1'), '/api/users');
  });

  it('matches root prefix exactly', () => {
    assert.equal(longestMatch(['/'], '/'), '/');
    assert.equal(longestMatch(['/'], '/anything'), '/');
  });

  it('returns null for url shorter than the only candidate prefix', () => {
    assert.equal(longestMatch(['/api/users'], '/api'), null);
  });
});
