import type {
  RegisterRequest,
  HeartbeatRequest,
  DeregisterRequest,
  Route,
  RewriteRule,
  ErrorResponse,
} from '../shared/types.js';
import type { StaticRouteInput } from './static-routes.js';
import { longestMatch } from './matcher.js';

export type StoreOk = { ok: true };
export type StoreErr<Status extends number> = {
  ok: false;
  status: Status;
  error: ErrorResponse;
};
export type RegisterResult = StoreOk | StoreErr<400> | StoreErr<409>;
export type HeartbeatResult = StoreOk | StoreErr<404> | StoreErr<409>;
export type DeregisterResult = StoreOk | StoreErr<404> | StoreErr<409>;
export type LoadStaticResult =
  | { ok: true; count: number }
  | StoreErr<400>;
export type ResolvedRoute = {
  target: string;
  rewrite?: RewriteRule;
};

export class RouteStore {
  private readonly adminPrefix: string;
  private readonly routesByPrefix = new Map<string, Route>();

  constructor(opts: { adminPrefix: string }) {
    this.adminPrefix = opts.adminPrefix;
  }

  register(req: RegisterRequest, now: number): RegisterResult {
    const prefixErr = this.validatePrefix(req.prefix);
    if (prefixErr) return prefixErr;
    if (!req.target || req.target.length === 0) {
      return {
        ok: false,
        status: 400,
        error: { error: 'target required' },
      };
    }
    const existing = this.routesByPrefix.get(req.prefix);
    if (existing?.static) {
      return {
        ok: false,
        status: 409,
        error: { error: `prefix '${req.prefix}' is managed by a static route` },
      };
    }

    this.routesByPrefix.set(req.prefix, {
      prefix: req.prefix,
      target: req.target,
      lastSeen: now,
    });
    return { ok: true };
  }

  heartbeat(req: HeartbeatRequest, now: number): HeartbeatResult {
    const existing = this.routesByPrefix.get(req.prefix);
    if (!existing) {
      return {
        ok: false,
        status: 404,
        error: { error: 'unknown prefix' },
      };
    }
    if (existing.static) {
      return {
        ok: false,
        status: 409,
        error: {
          error: `prefix '${req.prefix}' is a static route; heartbeats are not required`,
        },
      };
    }
    existing.target = req.target;
    existing.lastSeen = now;
    return { ok: true };
  }

  deregister(req: DeregisterRequest): DeregisterResult {
    const existing = this.routesByPrefix.get(req.prefix);
    if (!existing) {
      return {
        ok: false,
        status: 404,
        error: { error: 'unknown prefix' },
      };
    }
    if (existing.static) {
      return {
        ok: false,
        status: 409,
        error: {
          error: `prefix '${req.prefix}' is a static route; cannot deregister`,
        },
      };
    }
    this.routesByPrefix.delete(req.prefix);
    return { ok: true };
  }

  /**
   * Replace all static routes with the given ones. Validates the whole list
   * first; on any error nothing is changed (atomic for reloads).
   */
  loadStatic(routes: readonly StaticRouteInput[]): LoadStaticResult {
    const seen = new Set<string>();
    for (const r of routes) {
      const prefixErr = this.validatePrefix(r.prefix);
      if (prefixErr) {
        return {
          ok: false,
          status: 400,
          error: {
            error: prefixErr.error.error,
            detail: `static route ${JSON.stringify(r)}: ${prefixErr.error.error}`,
          },
        };
      }
      if (seen.has(r.prefix)) {
        return {
          ok: false,
          status: 400,
          error: {
            error: `duplicate static prefix '${r.prefix}' in routes file`,
          },
        };
      }
      seen.add(r.prefix);
    }

    // All entries valid: drop previous static routes, then insert the new set.
    this.clearStatic();
    for (const r of routes) {
      this.routesByPrefix.set(r.prefix, {
        prefix: r.prefix,
        target: r.target,
        lastSeen: 0,
        static: true,
        ...(r.rewrite !== undefined ? { rewrite: r.rewrite } : {}),
      });
    }
    return { ok: true, count: routes.length };
  }

  private clearStatic(): void {
    for (const [prefix, route] of this.routesByPrefix) {
      if (route.static) this.routesByPrefix.delete(prefix);
    }
  }

  resolveTarget(url: string): ResolvedRoute | null {
    const match = longestMatch(
      [...this.routesByPrefix.keys()],
      url,
    );
    if (match === null) return null;
    const route = this.routesByPrefix.get(match);
    if (!route) return null;
    return {
      target: route.target,
      ...(route.rewrite !== undefined ? { rewrite: route.rewrite } : {}),
    };
  }

  list(): Route[] {
    return [...this.routesByPrefix.values()];
  }

  sweep(now: number, ttlMs: number): string[] {
    const evicted: string[] = [];
    for (const [prefix, route] of this.routesByPrefix) {
      if (route.static) continue;
      if (now - route.lastSeen > ttlMs) {
        this.routesByPrefix.delete(prefix);
        evicted.push(prefix);
      }
    }
    return evicted;
  }

  private validatePrefix(prefix: string): StoreErr<400> | null {
    if (!prefix || prefix.length === 0) {
      return {
        ok: false,
        status: 400,
        error: { error: 'prefix required' },
      };
    }
    if (!prefix.startsWith('/')) {
      return {
        ok: false,
        status: 400,
        error: { error: 'prefix must start with /' },
      };
    }
    if (prefix === this.adminPrefix || prefix.startsWith(this.adminPrefix + '/')) {
      return {
        ok: false,
        status: 400,
        error: { error: 'prefix conflicts with admin prefix' },
      };
    }
    return null;
  }
}
