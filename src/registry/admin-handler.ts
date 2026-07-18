import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteStore } from './store.js';
import type {
  RegisterRequest,
  HeartbeatRequest,
  DeregisterRequest,
  ErrorResponse,
} from '../shared/types.js';
import { readJsonBody, sendJson } from '../shared/http.js';

export type AdminHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<void>;

type StoreResult = { ok: true } | { ok: false; status: number; error: ErrorResponse };

function sendStoreResult(res: ServerResponse, result: StoreResult): Promise<void> {
  if (result.ok) {
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, result.status, result.error);
}

// Dispatches by the LAST non-empty path segment so the handler is agnostic to
// the admin prefix length: `/__registry/register` -> action `register`.
export function createAdminHandler(store: RouteStore): AdminHandler {
  return async function adminHandler(req, res) {
    try {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      const action = pathname.split('/').filter(Boolean).pop() ?? '';
      const method = req.method ?? '';

      if (method === 'GET' && action === 'routes') {
        await sendJson(res, 200, store.list());
        return;
      }

      if (
        method === 'POST' &&
        (action === 'register' ||
          action === 'heartbeat' ||
          action === 'deregister')
      ) {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          await sendJson(res, 400, { error: 'invalid json', detail });
          return;
        }
        const now = Date.now();
        if (action === 'register') {
          await sendStoreResult(
            res,
            store.register(body as RegisterRequest, now),
          );
        } else if (action === 'heartbeat') {
          await sendStoreResult(
            res,
            store.heartbeat(body as HeartbeatRequest, now),
          );
        } else {
          await sendStoreResult(
            res,
            store.deregister(body as DeregisterRequest),
          );
        }
        return;
      }

      await sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      console.error('admin handler error:', err);
      if (!res.headersSent) {
        await sendJson(res, 500, { error: 'internal' });
      }
    }
  };
}
