import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { allocatePort } from '../src/server/port-allocator.ts';

/**
 * End-to-end CLI smoke test: spawn the real `registry` and `server` binaries
 * as subprocesses, with the server in child mode (`-- node -e ...`).
 * Verifies the full flow: allocate port → spawn child → ready probe → register
 * → proxy → SIGINT → deregister → child killed.
 */
describe('server CLI end-to-end (child mode)', () => {
  let registryProc: ReturnType<typeof spawn>;
  let registryPort: number;

  before(async () => {
    registryPort = await allocatePort();

    registryProc = spawn(
      'node',
      ['bin/cli.js', 'registry', '--port', String(registryPort), '--log-level', 'error'],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
    registryProc.on('exit', (code, signal) => {
      if (code !== 0 && code !== null && signal !== 'SIGINT') {
        // surface unexpected registry deaths
        console.error('registry exited unexpectedly:', { code, signal });
      }
    });

    // wait for registry to accept connections
    await new Promise<void>((resolve) => {
      const tick = () => {
        const req = http.get(`http://127.0.0.1:${registryPort}/__registry/routes`, (res) => {
          res.resume();
          res.on('end', () => resolve());
        });
        req.on('error', () => setTimeout(tick, 50));
      };
      tick();
    });
  });

  after(async () => {
    if (!registryProc.killed) {
      registryProc.kill('SIGINT');
      await new Promise<void>((r) => registryProc.once('exit', () => r()));
    }
  });

  it('allocates a port, spawns the child, registers, and proxies', async () => {
    const childScript = `
      const http = require('node:http');
      const port = Number(process.env.PORT);
      http.createServer((req, res) => {
        res.end('child:' + req.url);
      }).listen(port, '127.0.0.1');
    `;

    const serverProc = spawn(
      'node',
      [
        'bin/cli.js', 'server',
        '--registry', `http://127.0.0.1:${registryPort}`,
        '--prefix', '/api',
        '--bind-host', '127.0.0.1',
        '--heartbeat', '500',
        '--ready-timeout', '5000',
        '--log-level', 'error',
        '--', 'node', '-e', childScript,
      ],
      { stdio: 'ignore' },
    );

    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        serverProc.once('exit', (code, signal) => resolve({ code, signal: signal ?? null }));
      },
    );

    // Wait for registration to land.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('route never appeared')), 5000);
      const tick = () => {
        http.get(`http://127.0.0.1:${registryPort}/__registry/routes`, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            try {
              const arr = JSON.parse(body);
              if (Array.isArray(arr) && arr.some((r) => r.prefix === '/api')) {
                clearTimeout(timeout);
                return resolve();
              }
            } catch { /* ignore */ }
            setTimeout(tick, 50);
          });
        }).on('error', () => setTimeout(tick, 50));
      };
      tick();
    });

    // Request through the proxy reaches the child.
    const proxied = await new Promise<string>((resolve, reject) => {
      http.get(`http://127.0.0.1:${registryPort}/api/hello`, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(body));
      }).on('error', reject);
    });
    assert.equal(proxied, 'child:/api/hello');

    // SIGINT: deregister + kill child + clean exit.
    serverProc.kill('SIGINT');
    const result = await exitPromise;
    assert.equal(result.code, 0, 'server exit code');

    // Route is gone.
    await new Promise<void>((r) => setTimeout(r, 200));
    const afterStatus = await new Promise<number>((resolve) => {
      http.get(`http://127.0.0.1:${registryPort}/api/hello`, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      }).on('error', () => resolve(0));
    });
    assert.equal(afterStatus, 404, 'route should be gone after deregister');
  });

  it('exits with code 1 when no command follows --', async () => {
    const proc = spawn(
      'node',
      [
        'bin/cli.js', 'server',
        '--registry', `http://127.0.0.1:${registryPort}`,
        '--prefix', '/nope',
      ],
      { stdio: 'ignore' },
    );
    const { code } = await new Promise<{ code: number | null }>((resolve) => {
      proc.once('exit', (c) => resolve({ code: c }));
    });
    assert.equal(code, 1);
  });
});
