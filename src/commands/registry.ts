import http from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { Logger } from 'pino';

import { RouteStore } from '../registry/store.js';
import { createAdminHandler } from '../registry/admin-handler.js';
import { createProxyHandler } from '../registry/proxy-handler.js';
import { renderRoutes } from '../registry/ui.js';
import { createLogger } from '../shared/logging.js';

export type RegistryOptions = {
  port: number;
  host: string;
  adminPrefix: string;
  ttlMs: number;
  intervalMs: number;
  logLevel: string;
  /** Render the live services table to stdout. Default: true. */
  ui?: boolean;
};

export type RegistryHandle = {
  port: number;
  host: string;
  stop(): Promise<void>;
};

const STOP_GRACE_MS = 5000;

function isAdminPath(url: string, adminPrefix: string): boolean {
  return url === adminPrefix || url.startsWith(adminPrefix + '/');
}

export async function startRegistry(opts: RegistryOptions): Promise<RegistryHandle> {
  const logger: Logger = createLogger(opts.logLevel);
  const store = new RouteStore({ adminPrefix: opts.adminPrefix });
  const adminHandler = createAdminHandler(store);
  const proxy = createProxyHandler(store);

  const server: Server = http.createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? '/';
      if (isAdminPath(url, opts.adminPrefix)) {
        void adminHandler(req, res);
        return;
      }
      proxy.handle(req, res);
    },
  );

  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = req.url ?? '/';
    if (isAdminPath(url, opts.adminPrefix)) {
      socket.destroy();
      return;
    }
    proxy.upgrade(req, socket, head);
  });

  const timer = setInterval(() => {
    const evicted = store.sweep(Date.now(), opts.ttlMs);
    for (const service of evicted) {
      logger.warn({ service }, 'evicted');
    }
  }, opts.intervalMs);
  timer.unref();

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(opts.port, opts.host);
  });

  const address = server.address();
  const actualPort =
    opts.port !== 0 && typeof address === 'string'
      ? opts.port
      : typeof address === 'object' && address !== null
        ? address.port
        : opts.port;

  let uiTimer: NodeJS.Timeout | undefined;
  if (opts.ui !== false) {
    const displayHost = opts.host === '0.0.0.0' || opts.host === '::' ? '127.0.0.1' : opts.host;
    const render = (): void => {
      const frame = renderRoutes(store.list(), {
        host: displayHost,
        port: actualPort,
      });
      process.stdout.write(`\x1B[H\x1B[J${frame}\n`);
    };
    render();
    uiTimer = setInterval(render, 1000);
    uiTimer.unref();
  }

  async function stop(): Promise<void> {
    clearInterval(timer);
    if (uiTimer) clearInterval(uiTimer);
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const killTimer = setTimeout(() => {
        server.closeAllConnections?.();
        finish();
      }, STOP_GRACE_MS);
      killTimer.unref();
      server.close(() => {
        clearTimeout(killTimer);
        finish();
      });
    });
  }

  return { port: actualPort, host: opts.host, stop };
}
