import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { createProxyMiddleware, type RequestHandler } from 'http-proxy-middleware';
import type { RouteStore } from './store.js';
import type { RewriteRule } from '../shared/types.js';
import { sendJson } from '../shared/http.js';

export type ProxyHandle = (req: IncomingMessage, res: ServerResponse) => void;
export type UpgradeHandle = (
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
) => void;

export function createProxyHandler(store: RouteStore): {
  handle: ProxyHandle;
  upgrade: UpgradeHandle;
} {
  // Keyed by target + rewrite: the same target may be mounted under several
  // prefixes with different path rewrites, and each needs its own middleware.
  const proxies = new Map<string, RequestHandler>();

  function getProxy(target: string, rewrite?: RewriteRule): RequestHandler {
    const key =
      rewrite === undefined
        ? target
        : `${target}\u0000${rewrite.pattern}\u0000${rewrite.to}`;
    const cached = proxies.get(key);
    if (cached) return cached;
    const instance = createProxyMiddleware({
      target,
      changeOrigin: true,
      ...(rewrite !== undefined
        ? {
            pathRewrite: (path: string): string =>
              path.replace(new RegExp(rewrite.pattern), rewrite.to),
          }
        : {}),
      on: {
        error(err, _req, res) {
          if (res && typeof res === 'object' && 'writeHead' in res) {
            const serverRes = res as ServerResponse;
            if (!serverRes.headersSent) {
              serverRes.writeHead(502, { 'content-type': 'application/json' });
            }
            serverRes.end(
              JSON.stringify({ error: 'bad gateway', detail: err.message }),
            );
          } else if (res && typeof res === 'object' && 'destroy' in res) {
            (res as Socket).destroy(err);
          }
        },
      },
    });
    proxies.set(key, instance);
    return instance;
  }

  return {
    handle(req, res) {
      const resolved = store.resolveTarget(req.url ?? '/');
      if (resolved === null) {
        void sendJson(res, 404, { error: 'no route' });
        return;
      }
      const proxy = getProxy(resolved.target, resolved.rewrite);
      void proxy(req, res, () => {
        void sendJson(res, 502, { error: 'bad gateway' });
      });
    },
    upgrade(req, socket, head) {
      const resolved = store.resolveTarget(req.url ?? '/');
      if (resolved === null) {
        socket.destroy();
        return;
      }
      const proxy = getProxy(resolved.target, resolved.rewrite);
      proxy.upgrade(req, socket, head);
    },
  };
}
