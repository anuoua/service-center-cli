import type { Logger } from 'pino';

import { createLogger } from '../shared/logging.js';
import { allocatePort } from '../server/port-allocator.js';
import { startChild } from '../server/child-runner.js';
import type { ChildHandle } from '../server/child-runner.js';
import { createRegistrationClient } from '../server/registration-client.js';
import type { RegistrationClient, RpcResult } from '../server/registration-client.js';
import { detectLanIp } from '../server/lan-ip.js';

export type ServerOptions = {
  registryUrl: string;
  prefix: string[];
  bindHost?: string;
  heartbeatMs: number;
  readyTimeoutMs: number;
  logLevel: string;
  childCommand: string;
  childArgs?: string[];
};

const REGISTER_DELAYS_MS = [1000, 2000, 4000] as const;

const sleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));

export async function runServer(opts: ServerOptions): Promise<number> {
  const logger: Logger = createLogger(opts.logLevel);
  const bindHost = opts.bindHost ?? detectLanIp();

  const port = await allocatePort();
  const target = `http://${bindHost}:${port}`;

  const child: ChildHandle = startChild({
    command: opts.childCommand,
    args: opts.childArgs ?? [],
    port,
    readyTimeoutMs: opts.readyTimeoutMs,
  });
  try {
    await child.ready;
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'child not ready');
    await child.kill();
    return 1;
  }

  const client: RegistrationClient = createRegistrationClient({
    registryUrl: opts.registryUrl,
  });

  async function registerPrefix(
    client: RegistrationClient,
    prefix: string,
    target: string,
  ): Promise<RpcResult> {
    for (let attempt = 0; attempt <= REGISTER_DELAYS_MS.length; attempt++) {
      const result = await client.register({ prefix, target });
      if (result.ok) return result;
      if (result.status >= 400 && result.status < 500) return result;
      const delay = REGISTER_DELAYS_MS[attempt];
      if (delay !== undefined) await sleep(delay);
    }
    return { ok: false, status: 0, error: { error: 'max retries exceeded' } };
  }

  const registeredPrefixes: string[] = [];
  for (const prefix of opts.prefix) {
    const result = await registerPrefix(client, prefix, target);
    if (result.ok) {
      registeredPrefixes.push(prefix);
    } else {
      logger.error({ prefix, result }, 'register failed');
      for (const p of registeredPrefixes) {
        await client.deregister({ prefix: p }).catch(() => {});
      }
      await child.kill();
      return 1;
    }
  }

  const interval = setInterval(() => {
    for (const prefix of opts.prefix) {
      client
        .heartbeat({ prefix, target })
        .catch((err: unknown) => {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err), prefix },
            'heartbeat failed',
          );
        });
    }
  }, opts.heartbeatMs);

  let resolver: ((sig: NodeJS.Signals) => void) | null = null;
  const onSignal = (sig: NodeJS.Signals): void => {
    if (resolver) resolver(sig);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const signalPromise = new Promise<NodeJS.Signals>((resolve) => {
    resolver = resolve;
  });

  let exitCode = 0;
  try {
    const winner = await Promise.race([
      signalPromise.then((sig) => ({ kind: 'signal' as const, sig })),
      child.exited.then((r) => ({ kind: 'exit' as const, r })),
    ]);
    if (winner.kind === 'exit') {
      logger.info(
        { code: winner.r.code, signal: winner.r.signal },
        'child exited',
      );
      exitCode = winner.r.code ?? 0;
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    clearInterval(interval);
    for (const prefix of registeredPrefixes) {
      try {
        await client.deregister({ prefix });
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), prefix },
          'deregister failed',
        );
      }
    }
    await child.kill();
  }

  return exitCode;
}
