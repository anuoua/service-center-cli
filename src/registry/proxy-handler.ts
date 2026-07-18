import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { createProxyMiddleware, type RequestHandler } from 'http-proxy-middleware';
import type { RouteStore } from './store.js';
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
  const proxies = new Map<string, RequestHandler>();

  function getProxy(target: string): RequestHandler {
    const cached = proxies.get(target);
    if (cached) return cached;
    const instance = createProxyMiddleware({
      target,
      changeOrigin: true,
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
    proxies.set(target, instance);
    return instance;
  }

  return {
    handle(req, res) {
      const target = store.resolveTarget(req.url ?? '/');
      if (target === null) {
        void sendJson(res, 404, { error: 'no route' });
        return;
      }
      const proxy = getProxy(target);
      void proxy(req, res, () => {
        void sendJson(res, 502, { error: 'bad gateway' });
      });
    },
    upgrade(req, socket, head) {
      const target = store.resolveTarget(req.url ?? '/');
      if (target === null) {
        socket.destroy();
        return;
      }
      const proxy = getProxy(target);
      proxy.upgrade(req, socket, head);
    },
  };
}
