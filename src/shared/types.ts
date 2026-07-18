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

export type Route = {
  prefix: string;
  target: string;
  /** Unix ms timestamp of last register/heartbeat. */
  lastSeen: number;
};

export type OkResponse = { ok: true };

export type ErrorResponse = {
  error: string;
  detail?: string;
};
