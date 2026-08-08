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
sccli registry · http://127.0.0.1:8080 · 2 routes · Ctrl+C to stop
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
| `-r, --routes <file>` | — | Static routes JSON file, loaded at startup and reloaded on `SIGHUP` |
| `--tls` | — | Enable HTTPS with an auto-generated self-signed certificate |
| `--tls-cert <file>` | — | TLS certificate PEM file (use with `--tls-key`) |
| `--tls-key <file>` | — | TLS private key PEM file (use with `--tls-cert`) |
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
| `--insecure` | — | Skip TLS certificate verification up front; by default the client auto-falls back to an unverified connection when the registry certificate is not trusted |
| `-- <cmd> [args...]` | _required_ | Child command; `{port}` substituted, `PORT` env injected |

Re-registering the same prefix overwrites the target (idempotent).

## HTTPS (secure context for local dev)

Browsers only grant secure-context APIs (`navigator.clipboard`, `crypto.subtle`,
`getUserMedia`, …) to `https://` origins — or `http://localhost`. When you
reach the registry by **LAN IP** (other devices, mobile testing) you need
HTTPS. Start the registry with:

```bash
sccli registry --tls
# or with your own certs (e.g. from mkcert, for a warning-free setup):
sccli registry --tls-cert ./server.crt --tls-key ./server.key
```

- `--tls` generates an ephemeral self-signed certificate at startup whose SAN
  covers `localhost`, `127.0.0.1`, `::1` and your current LAN IP.
- Browsers warn on the first visit — **proceed anyway**; the page is still a
  secure context and the APIs work. For zero warnings, generate certs with
  [mkcert](https://github.com/FiloSottile/mkcert) and pass them via
  `--tls-cert`/`--tls-key`.
- The route table shows `https://` URLs; WebSocket upgrades work over `wss`.
- `sccli server` talking to the registry over TLS **works out of the box with
  self-signed certificates**: the first verification failure automatically
  falls back to an unverified connection (a warning is logged). Add
  `--insecure` to skip the retry and the warning. If the registry serves a
  properly signed certificate, verification succeeds normally and no
  fallback ever happens.
- `--tls` cannot be combined with `--tls-cert`/`--tls-key`; the two files must
  be provided together.

## Static routes (legacy services)

Services that can't register themselves (already-running processes, services on
other machines, containers, anything you don't want to touch) can be declared
in a JSON file instead:

```bash
sccli registry --port 8080 --routes ./routes.json
```

```json
[
  { "prefix": "/legacy/orders", "target": "http://10.0.0.9:8080" },
  { "prefix": "/legacy/pay",    "target": "http://10.0.0.10:9000" }
]
```

Rules:

- Static and dynamic routes coexist; the longest-prefix rule applies across both.
- Static routes **never expire** — they are exempt from TTL eviction.
- `register` / `heartbeat` / `deregister` on a static prefix return `409`: static routes are owned by the file, not by any service.
- Reload the file at runtime without restarting: `kill -HUP <registry-pid>`. A bad file is rejected and the previous routes are kept.
- The file is validated at startup — syntax errors, missing `target`, or a prefix colliding with the admin prefix abort startup with a clear message.
- The admin API lists them like any other route, with `"static": true`.

### Path rewriting

Legacy services often don't serve the path you want to expose. Add a `rewrite`
rule to remap the path before it hits the upstream:

```json
[
  {
    "prefix": "/legacy/orders",
    "target": "http://10.0.0.9:8080",
    "rewrite": { "pattern": "^/legacy/orders", "to": "/orders" }
  },
  {
    "prefix": "/static",
    "target": "http://10.0.0.10:9000",
    "rewrite": { "pattern": "^/static", "to": "" }
  }
]
```

- `pattern` is a regular expression string (remember to escape backslashes in JSON); `to` is the replacement.
- `"to": ""` strips the prefix: `/static/ping` → `/ping`.
- Applies to WebSocket upgrades too.
- Only static routes can rewrite; dynamic registrations always forward the path as-is.
- Invalid patterns (or a malformed `rewrite`) fail the file load — the registry refuses to start, or keeps the previous routes on SIGHUP.

## Routing rules

- `/api/users` matches `/api/users`, `/api/users/123`, but **not** `/api-users` (segment boundary).
- Longest match wins: `/api` and `/api/users` can coexist; `/api/users/x` goes to the more specific one.
- Path is forwarded as-is: `GET /api/users/123` reaches the upstream as `/api/users/123`. Static routes may opt into path rewriting — see [Static routes](#static-routes-legacy-services).
- WebSocket upgrades and query strings are handled transparently.

## Limitations

- HTTP/HTTPS only (no TLS termination for upstreams, no TCP)
- No auth on the admin API — bind to localhost or a trusted network
- In-memory state: no persistence, no clustering, no load balancing, no metrics

## License

MIT
