import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { allocatePort } from '../src/server/port-allocator.ts';

describe('allocatePort', () => {
  it('returns a positive integer port number', async () => {
    const port = await allocatePort();
    assert.equal(Number.isInteger(port), true);
    assert.ok(port > 0, `expected positive port, got ${port}`);
    assert.ok(port <= 65535, `expected port <= 65535, got ${port}`);
  });

  it('returned port can immediately be bound by another server', async () => {
    const port = await allocatePort();

    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('two consecutive calls return different ports', async () => {
    const first = await allocatePort();
    const second = await allocatePort();
    assert.notEqual(first, second, `expected different ports, got ${first} twice`);
  });
});
