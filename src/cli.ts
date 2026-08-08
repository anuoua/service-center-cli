#!/usr/bin/env node
import { createRequire } from 'node:module';
import { Command } from 'commander';

import { startRegistry } from './commands/registry.js';
import { runServer } from './commands/server.js';

// Read the version from package.json at runtime so --version can never
// drift out of sync with the published release.
const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

const program = new Command();

program
  .name('sccli')
  .description('Service registry and proxy gateway CLI')
  .version(pkg.version);

program
  .command('registry')
  .description('Run the registry / proxy gateway')
  .option('-p, --port <n>', 'proxy port', '8080')
  .option('-H, --host <str>', 'proxy listen host', '0.0.0.0')
  .option('-A, --admin-prefix <p>', 'admin API prefix', '/__registry')
  .option('-r, --routes <file>', 'static routes JSON file (loaded at startup; reloaded on SIGHUP)')
  .option('--tls', 'enable HTTPS with an auto-generated self-signed certificate')
  .option('--tls-cert <file>', 'TLS certificate PEM file (with --tls-key)')
  .option('--tls-key <file>', 'TLS private key PEM file (with --tls-cert)')
  .option('--ttl <ms>', 'heartbeat TTL in ms', '30000')
  .option('--interval <ms>', 'sweep interval in ms', '10000')
  .option('-l, --log-level <str>', 'trace|debug|info|warn|error', 'info')
  .action(async (opts) => {
    const tlsCert = opts.tlsCert !== undefined ? String(opts.tlsCert) : undefined;
    const tlsKey = opts.tlsKey !== undefined ? String(opts.tlsKey) : undefined;
    if ((tlsCert === undefined) !== (tlsKey === undefined)) {
      console.error('error: --tls-cert and --tls-key must be provided together');
      process.exit(1);
    }
    if (opts.tls && tlsCert !== undefined) {
      console.error('error: --tls cannot be combined with --tls-cert/--tls-key');
      process.exit(1);
    }
    const handle = await startRegistry({
      port: Number(opts.port),
      host: String(opts.host),
      adminPrefix: String(opts.adminPrefix),
      ttlMs: Number(opts.ttl),
      intervalMs: Number(opts.interval),
      logLevel: String(opts.logLevel),
      ...(opts.routes !== undefined ? { routesFile: String(opts.routes) } : {}),
      ...(opts.tls ? { tls: true } : {}),
      ...(tlsCert !== undefined ? { tlsCertFile: tlsCert, tlsKeyFile: tlsKey as string } : {}),
    });

    const shutdown = (sig: NodeJS.Signals): void => {
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      void handle
        .stop()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
      void sig;
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    return new Promise<void>(() => {
      // keep process alive via the listening server; resolves never.
    });
  });

program
  .command('server')
  .description('Run a service that registers with the registry')
  .requiredOption('-r, --registry <url>', 'registry URL')
  .requiredOption('-x, --prefix <paths...>', 'route prefix(es)')
  .option('-B, --bind-host <str>', 'target hostname/IP the registry should use to reach this host; defaults to detected LAN IP (127.0.0.1 when nothing found)')
  .option('--heartbeat <ms>', 'heartbeat interval ms', '10000')
  .option('--ready-timeout <ms>', 'max wait for child to bind its port; 0 = never timeout', '0')
  .option('-l, --log-level <str>', 'trace|debug|info|warn|error', 'info')
  .allowExcessArguments()
  .action(async (opts) => {
    const argv = process.argv;
    const dashDash = argv.indexOf('--');
    if (dashDash < 0) {
      console.error('error: server requires a child command after `--`, e.g. `... -- vite --port {port}`');
      process.exit(1);
    }
    const childArgs = argv.slice(dashDash + 1);
    if (childArgs.length === 0) {
      console.error('error: no command found after `--`');
      process.exit(1);
    }
    const childCommand = childArgs[0] as string;
    const childRest = childArgs.length > 1 ? childArgs.slice(1) : undefined;

    const serverOpts = {
      registryUrl: String(opts.registry),
      prefix: opts.prefix,
      heartbeatMs: Number(opts.heartbeat),
      readyTimeoutMs: Number(opts.readyTimeout),
      logLevel: String(opts.logLevel),
      childCommand,
      ...(opts.bindHost !== undefined ? { bindHost: String(opts.bindHost) } : {}),
      ...(childRest !== undefined ? { childArgs: childRest } : {}),
    };

    const code = await runServer(serverOpts);
    process.exit(code);
  });

program.parseAsync().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
