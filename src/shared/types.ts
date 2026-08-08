// Wire Types shared between registry and server (and tests).
// Keep this file dependency-free so any module can import it.

export type RegisterRequest = {
  prefix: string;
  target: string;
};

export type HeartbeatRequest = {
  prefix: string;
  target: string;
};

export type DeregisterRequest = {
  prefix: string;
};

export type RewriteRule = {
  /** Regular expression string matched against the incoming request path. */
  pattern: string;
  /** Replacement string. */
  to: string;
};

export type Route = {
  prefix: string;
  target: string;
  /** Unix ms timestamp of last register/heartbeat. */
  lastSeen: number;
  /** True for routes declared in the static routes file; never TTL-evicted. */
  static?: boolean;
  /** Path rewrite applied before forwarding (static routes only). */
  rewrite?: RewriteRule;
};

export type OkResponse = { ok: true };

export type ErrorResponse = {
  error: string;
  detail?: string;
};
