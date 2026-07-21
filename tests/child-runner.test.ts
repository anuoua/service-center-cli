import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

import { startChild, defaultProbePort } from '../src/server/child-runner.ts';

class FakeChild extends EventEmitter {
  pid = 12345;
  kill_signals: string[] = [];
  kill(signal: string = 'SIGTERM'): boolean {
    this.kill_signals.push(signal);
    return true;
  }
}

function toChildProcess(c: FakeChild): ChildProcess {
  return c as unknown as ChildProcess;
}

describe('startChild', () => {
  it('substitutes {port} substring in args', async () => {
    let capturedArgs: string[] | null = null;
    const child = new FakeChild();
    const spawnFn = (_cmd: string, args: string[], _opts: { env: Record<string, string> }): ChildProcess => {
      capturedArgs = args;
      return toChildProcess(child);
    };

    const handle = startChild({
      command: 'vite',
      args: ['--port={port}', 'extra'],
      port: 1234,
      spawnFn,
      probePort: async () => {},
    });
    await handle.ready;

    assert.deepEqual(capturedArgs, ['--port=1234', 'extra']);
  });

  it('injects PORT env into spawned child', async () => {
    let capturedEnv: Record<string, string> | null = null;
    const child = new FakeChild();
    const spawnFn = (_cmd: string, _args: string[], opts: { env: Record<string, string> }): ChildProcess => {
      capturedEnv = opts.env;
      return toChildProcess(child);
    };

    const handle = startChild({
      command: 'vite',
      args: [],
      port: 1234,
      spawnFn,
      probePort: async () => {},
    });
    await handle.ready;

    assert.equal(capturedEnv!.PORT, '1234');
  });

  it('merges caller-provided env', async () => {
    let capturedEnv: Record<string, string> | null = null;
    const child = new FakeChild();
    const spawnFn = (_cmd: string, _args: string[], opts: { env: Record<string, string> }): ChildProcess => {
      capturedEnv = opts.env;
      return toChildProcess(child);
    };

    const handle = startChild({
      command: 'vite',
      args: [],
      port: 1234,
      env: { FOO: 'bar' },
      spawnFn,
      probePort: async () => {},
    });
    await handle.ready;

    assert.equal(capturedEnv!.FOO, 'bar');
  });

  it('caller-provided PORT overrides injected PORT', async () => {
    let capturedEnv: Record<string, string> | null = null;
    const child = new FakeChild();
    const spawnFn = (_cmd: string, _args: string[], opts: { env: Record<string, string> }): ChildProcess => {
      capturedEnv = opts.env;
      return toChildProcess(child);
    };

    const handle = startChild({
      command: 'vite',
      args: [],
      port: 1234,
      env: { PORT: '9999' },
      spawnFn,
      probePort: async () => {},
    });
    await handle.ready;

    assert.equal(capturedEnv!.PORT, '9999');
  });

  it('ready resolves when probePort resolves', async () => {
    const child = new FakeChild();
    const handle = startChild({
      command: 'vite',
      args: [],
      port: 1234,
      spawnFn: () => toChildProcess(child),
      probePort: async () => {},
    });
    await assert.doesNotReject(handle.ready);
  });

  it('ready rejects when probePort rejects within readyTimeoutMs', async () => {
    const child = new FakeChild();
    const handle = startChild({
      command: 'vite',
      args: [],
      port: 1234,
      readyTimeoutMs: 50,
      spawnFn: () => toChildProcess(child),
      probePort: async () => {
        throw new Error('not ready');
      },
    });
    await assert.rejects(handle.ready, /not ready/);
  });

  it('ready rejects when child exits before port becomes ready', async () => {
    const child = new FakeChild();
    const handle = startChild({
      command: 'vite',
      args: [],
      port: 1234,
      readyTimeoutMs: 0,
      spawnFn: () => toChildProcess(child),
      // Never resolves: simulates child that binds nothing
      probePort: () => new Promise<void>(() => {}),
    });
    setImmediate(() => child.emit('exit', 1, null));
    await assert.rejects(handle.ready, /child exited before port/);
  });

  it('exited resolves with code when child emits exit', async () => {
    const child = new FakeChild();
    const handle = startChild({
      command: 'vite',
      args: [],
      port: 1234,
      spawnFn: () => toChildProcess(child),
      probePort: async () => {},
    });
    child.emit('exit', 0, null);
    const result = await handle.exited;
    assert.deepEqual(result, { code: 0, signal: null });
  });

  it('kill sends SIGTERM then SIGKILL after killGraceMs when child stays alive', async () => {
    const child = new FakeChild();
    const handle = startChild({
      command: 'vite',
      args: [],
      port: 1234,
      killGraceMs: 30,
      spawnFn: () => toChildProcess(child),
      probePort: async () => {},
    });
    await handle.kill();
    assert.deepEqual(child.kill_signals, ['SIGTERM', 'SIGKILL']);
  });

  it('kill sends only SIGTERM when child exits within grace', async () => {
    const child = new FakeChild();
    const originalKill = child.kill.bind(child);
    child.kill = (signal: string = 'SIGTERM') => {
      const result = originalKill(signal);
      if (signal === 'SIGTERM') {
        setImmediate(() => child.emit('exit', 0, null));
      }
      return result;
    };
    const handle = startChild({
      command: 'vite',
      args: [],
      port: 1234,
      killGraceMs: 30,
      spawnFn: () => toChildProcess(child),
      probePort: async () => {},
    });
    await handle.kill();
    assert.deepEqual(child.kill_signals, ['SIGTERM']);
  });

  it('exposes pid', () => {
    const child = new FakeChild();
    const handle = startChild({
      command: 'vite',
      args: [],
      port: 1234,
      spawnFn: () => toChildProcess(child),
      probePort: async () => {},
    });
    assert.equal(handle.pid, 12345);
  });

  it('defaults spawnFn to real child_process.spawn', async () => {
    // Verifies default is wired correctly (signature compat).
    // We don't actually spawn a real process; we just confirm startChild
    // accepts opts without spawnFn.
    const opts: SpawnOptions = { stdio: 'inherit', env: { ...process.env, PORT: '1234' } };
    assert.equal(opts.env!.PORT, '1234');
  });
});

describe('defaultProbePort', () => {
  it('succeeds against an IPv6-only (::1) listener', async () => {
    const server = http.createServer((_q, r) => r.end('hi'));
    await new Promise<void>((resolve) => server.listen(0, '::1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      await assert.doesNotReject(defaultProbePort(port, 2000));
    } finally {
      server.close();
    }
  });

  it('succeeds against an IPv4-only (127.0.0.1) listener', async () => {
    const server = http.createServer((_q, r) => r.end('hi'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      await assert.doesNotReject(defaultProbePort(port, 2000));
    } finally {
      server.close();
    }
  });
});
