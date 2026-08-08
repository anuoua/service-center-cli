import http from 'node:http';
import https from 'node:https';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { Logger } from 'pino';

import { RouteStore } from '../registry/store.js';
import { createAdminHandler } from '../registry/admin-handler.js';
import { createProxyHandler } from '../registry/proxy-handler.js';
import { loadStaticRoutesFile } from '../registry/static-routes.js';
import { createTlsConfig } from '../registry/tls.js';
import { renderRoutes } from '../registry/ui.js';
import { detectLanIp } from '../server/lan-ip.js';
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
  /** Path to a JSON file of static routes; loaded at startup, reloaded on SIGHUP. */
  routesFile?: string;
  /** Enable HTTPS with an auto-generated self-signed certificate. */
  tls?: boolean;
  /** User-provided TLS certificate PEM file (with tlsKeyFile). */
  tlsCertFile?: string;
  /** User-provided TLS private key PEM file (with tlsCertFile). */
  tlsKeyFile?: string;
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

  // Self-signed SANs must cover how the registry is actually reached: the
  // loopback aliases plus the current LAN IP (for other devices / browsers
  // on the network hitting it by IP).
  const altNames = ['localhost', '127.0.0.1', '::1'];
  const lanIp = detectLanIp();
  if (lanIp !== '127.0.0.1' && !altNames.includes(lanIp)) altNames.push(lanIp);
  const tls = await createTlsConfig({
    ...(opts.tls !== undefined ? { tls: opts.tls } : {}),
    ...(opts.tlsCertFile !== undefined ? { tlsCertFile: opts.tlsCertFile } : {}),
    ...(opts.tlsKeyFile !== undefined ? { tlsKeyFile: opts.tlsKeyFile } : {}),
    altNames,
  });

  if (opts.routesFile !== undefined) {
    const loaded = await loadStaticRoutesFile(opts.routesFile);
    if (!loaded.ok) {
      throw new Error(loaded.error);
    }
    const applied = store.loadStatic(loaded.routes);
    if (!applied.ok) {
      const detail = applied.error.detail !== undefined ? `: ${applied.error.detail}` : '';
      throw new Error(`${applied.error.error}${detail}`);
    }
    logger.info(
      { file: opts.routesFile, count: applied.count },
      'static routes loaded',
    );
  }

  const requestListener = (
    req: IncomingMessage,
    res: ServerResponse,
  ): void => {
    const url = req.url ?? '/';
    if (isAdminPath(url, opts.adminPrefix)) {
      void adminHandler(req, res);
      return;
    }
    proxy.handle(req, res);
  };

  const server: Server = tls
    ? https.createServer({ key: tls.key, cert: tls.cert }, requestListener)
    : http.createServer(requestListener);

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

  if (tls) {
    if (tls.mode === 'self-signed') {
      logger.info(
        { altNames: [...tls.altNames] },
        'https enabled (self-signed certificate); browsers will warn on first visit — proceed anyway, secure-context APIs work; use mkcert + --tls-cert/--tls-key for a warning-free setup',
      );
    } else {
      logger.info({}, 'https enabled (provided certificate)');
    }
  }

  let uiTimer: NodeJS.Timeout | undefined;
  if (opts.ui !== false) {
    const displayHost = opts.host === '0.0.0.0' || opts.host === '::' ? '127.0.0.1' : opts.host;
    const render = (): void => {
      const frame = renderRoutes(store.list(), {
        host: displayHost,
        port: actualPort,
        scheme: tls ? 'https' : 'http',
      });
      process.stdout.write(`\x1B[H\x1B[J${frame}\n`);
    };
    render();
    uiTimer = setInterval(render, 1000);
    uiTimer.unref();
  }

  const onReload = (): void => {
    if (opts.routesFile === undefined) return;
    void loadStaticRoutesFile(opts.routesFile)
      .then((loaded) => {
        if (!loaded.ok) {
          logger.error(
            { err: loaded.error },
            'static routes reload failed; keeping previous routes',
          );
          return;
        }
        const applied = store.loadStatic(loaded.routes);
        if (!applied.ok) {
          logger.error(
            { err: applied.error.detail ?? applied.error.error },
            'static routes reload failed; keeping previous routes',
          );
          return;
        }
        logger.info({ count: applied.count }, 'static routes reloaded');
      })
      .catch((err: unknown) => {
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          'static routes reload failed; keeping previous routes',
        );
      });
  };
  process.on('SIGHUP', onReload);

  async function stop(): Promise<void> {
    clearInterval(timer);
    if (uiTimer) clearInterval(uiTimer);
    process.off('SIGHUP', onReload);
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
