import { spawn } from 'node:child_process';
import net from 'node:net';
import type { ChildProcess } from 'node:child_process';

type Signals = NodeJS.Signals;

export type StartChildOptions = {
  command: string;
  args: string[];
  port: number;
  env?: Record<string, string>;
  readyTimeoutMs?: number;
  killGraceMs?: number;
  spawnFn?: (command: string, args: string[], opts: { env: Record<string, string> }) => ChildProcess;
  probePort?: (port: number, timeoutMs: number) => Promise<void>;
};

export type ChildHandle = {
  pid: number;
  ready: Promise<void>;
  exited: Promise<{ code: number | null; signal: Signals | null }>;
  kill(): Promise<void>;
};

const DEFAULT_READY_TIMEOUT_MS = 10000;
const DEFAULT_KILL_GRACE_MS = 5000;
const PROBE_POLL_INTERVAL_MS = 100;
const POST_SIGKILL_WAIT_MS = 100;

function defaultSpawn(command: string, args: string[], opts: { env: Record<string, string> }): ChildProcess {
  return spawn(command, args, { stdio: 'inherit', env: opts.env });
}

function defaultProbePort(port: number, timeoutMs: number): Promise<void> {
  const hasDeadline = timeoutMs > 0;
  const deadline = Date.now() + timeoutMs;

  const tryConnect = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ port, host: '127.0.0.1' });
      const cleanup = () => {
        socket.removeAllListeners();
        socket.destroy();
      };
      socket.once('connect', () => {
        cleanup();
        resolve();
      });
      socket.once('error', (err) => {
        cleanup();
        reject(err);
      });
    });

  return new Promise<void>((resolve, reject) => {
    const attempt = (): void => {
      if (hasDeadline && Date.now() >= deadline) {
        reject(new Error(`port ${port} not ready within ${timeoutMs}ms`));
        return;
      }
      tryConnect().then(resolve, () => {
        setTimeout(attempt, PROBE_POLL_INTERVAL_MS);
      });
    };
    attempt();
  });
}

export function startChild(opts: StartChildOptions): ChildHandle {
  const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const spawnFn = opts.spawnFn ?? defaultSpawn;
  const probePort = opts.probePort ?? defaultProbePort;

  const substitutedArgs = opts.args.map((a) => a.split('{port}').join(String(opts.port)));

  const mergedEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PORT: String(opts.port),
    ...(opts.env ?? {}),
  };

  const child = spawnFn(opts.command, substitutedArgs, { env: mergedEnv });

  const exited = new Promise<{ code: number | null; signal: Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code: code ?? null, signal: signal ?? null }));
  });

  // `ready` resolves when the port accepts connections OR rejects if the child
  // exits first / the probe times out. Racing against `exited` prevents the
  // infinite-wait case when `readyTimeoutMs <= 0` and the child dies before binding.
  const ready = Promise.race([
    probePort(opts.port, readyTimeoutMs),
    exited.then(() => {
      throw new Error(`child exited before port ${opts.port} became ready`);
    }),
  ]);

  let killStarted = false;
  const kill = async (): Promise<void> => {
    if (killStarted) {
      return;
    }
    killStarted = true;

    child.kill('SIGTERM');

    const graceWinner = await Promise.race([
      exited.then(() => 'exited' as const),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), killGraceMs)),
    ]);
    if (graceWinner === 'exited') {
      return;
    }

    child.kill('SIGKILL');
    await Promise.race([
      exited,
      new Promise<void>((r) => setTimeout(r, POST_SIGKILL_WAIT_MS)),
    ]);
  };

  return {
    pid: child.pid ?? -1,
    ready,
    exited,
    kill,
  };
}
