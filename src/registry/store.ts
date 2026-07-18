import type {
  RegisterRequest,
  HeartbeatRequest,
  DeregisterRequest,
  Route,
  ErrorResponse,
} from '../shared/types.js';
import { longestMatch } from './matcher.js';

export type StoreOk = { ok: true };
export type StoreErr<Status extends number> = {
  ok: false;
  status: Status;
  error: ErrorResponse;
};
export type RegisterResult = StoreOk | StoreErr<400>;
export type HeartbeatResult = StoreOk | StoreErr<404>;
export type DeregisterResult = StoreOk | StoreErr<404>;

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
    existing.target = req.target;
    existing.lastSeen = now;
    return { ok: true };
  }

  deregister(req: DeregisterRequest): DeregisterResult {
    if (!this.routesByPrefix.has(req.prefix)) {
      return {
        ok: false,
        status: 404,
        error: { error: 'unknown prefix' },
      };
    }
    this.routesByPrefix.delete(req.prefix);
    return { ok: true };
  }

  resolveTarget(url: string): string | null {
    const match = longestMatch(
      [...this.routesByPrefix.keys()],
      url,
    );
    if (match === null) return null;
    return this.routesByPrefix.get(match)?.target ?? null;
  }

  list(): Route[] {
    return [...this.routesByPrefix.values()];
  }

  sweep(now: number, ttlMs: number): string[] {
    const evicted: string[] = [];
    for (const [prefix, route] of this.routesByPrefix) {
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
