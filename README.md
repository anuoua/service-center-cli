# service-center-cli

A single-binary CLI that acts as an **HTTP API gateway + service registry**. Run the registry as a reverse proxy; services register their route prefix and heartbeat; the registry proxies incoming traffic to the matching service.

- Single binary, two subcommands: `registry` and `server`
- Path-prefix routing, longest-match wins
- Built-in port allocation + child-process mode — wire it ahead of `vite`, `next dev`, etc.

## Requirements

Node.js >= 22.15

## Install

```bash
npm install -g service-center-cli
# or one-off: npx service-center-cli --help
```

The package installs two binaries that do the same thing: **`sccli`** (short) and **`service-center-cli`** (long). Examples below use `sccli`; substitute the long name if you prefer.

## Quick start

```bash
# 1) start the registry (gateway + admin API + live route table)
sccli registry --port 8080

# 2) start a service that registers itself
sccli server \
  --registry http://127.0.0.1:8080 \
  --prefix /api/users \
  -- node -e "require('http').createServer((q,r)=>r.end('hi')).listen(process.env.PORT)"
```

The registry prints a live route table to stdout:

```
sccli registry · 2 routes · ttl=30s · sweep=10s · Ctrl+C to stop
────────────────────────────────────────────────────────────────────────
PREFIX       TARGET                URL
/api/orders  http://10.0.0.6:4000  http://127.0.0.1:8080/api/orders
/api/users   http://10.0.0.5:3000  http://127.0.0.1:8080/api/users
────────────────────────────────────────────────────────────────────────
```

## Auto port + auto register

The CLI allocates a free port, starts your dev server on it, waits for it to be ready, then registers — all in one line:

```bash
sccli server \
  --registry http://127.0.0.1:8080 \
  --prefix /web \
  --bind-host 127.0.0.1 \
  -- vite --port {port} --strictPort
```

- `{port}` in the child command is substituted with the allocated port
- `PORT=<port>` env var is also injected (so `npm run dev` works without flags)
- `Ctrl+C`: deregister first, then SIGTERM the child
- `--bind-host` is the hostname/IP the **registry** uses to reach this host. Defaults to a detected LAN IP (first non-internal IPv4 on a real NIC, skipping docker/vmnet/utun/etc.); falls back to `127.0.0.1`. Override when the auto-detection picks the wrong NIC, or for Docker / multi-NIC / NAT setups.

## Flags

### `sccli registry`

| Flag | Default | Notes |
| --- | --- | --- |
| `-p, --port` | `8080` | Proxy + admin listen port |
| `-H, --host` | `0.0.0.0` | Listen host |
| `-A, --admin-prefix` | `/__registry` | Reserved prefix for the admin API (service prefixes can't collide with it) |
| `--ttl` | `30000` | Heartbeat TTL in ms; routes older than this are evicted |
| `--interval` | `10000` | Sweep interval for eviction |
| `-l, --log-level` | `info` | `trace` \| `debug` \| `info` \| `warn` \| `error` |

Logs go to **stderr**; the route table goes to **stdout**.

### `sccli server`

| Flag | Default | Notes |
| --- | --- | --- |
| `-r, --registry` | _required_ | Registry URL |
| `-x, --prefix` | _required_ | Route prefix (also the route's identity) |
| `-B, --bind-host` | auto-detected LAN IP | Hostname/IP the registry uses to reach this host |
| `--heartbeat` | `10000` | Heartbeat interval in ms |
| `--ready-timeout` | `0` | Max wait for the child to bind its port in ms; `0` = never timeout |
| `-- <cmd> [args...]` | _required_ | Child command; `{port}` substituted, `PORT` env injected |

Re-registering the same prefix overwrites the target (idempotent).

## Routing rules

- `/api/users` matches `/api/users`, `/api/users/123`, but **not** `/api-users` (segment boundary).
- Longest match wins: `/api` and `/api/users` can coexist; `/api/users/x` goes to the more specific one.
- Path is forwarded as-is: `GET /api/users/123` reaches the upstream as `/api/users/123`.
- WebSocket upgrades and query strings are handled transparently.

## Limitations

- HTTP only (no TLS termination, no TCP)
- No auth on the admin API — bind to localhost or a trusted network
- In-memory state: no persistence, no clustering, no load balancing, no metrics

## License

MIT
