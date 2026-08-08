import { readFile } from 'node:fs/promises';
import net from 'node:net';
import * as selfsigned from 'selfsigned';

// TLS material for the registry listener. `--tls` generates an ephemeral
// self-signed certificate at startup (SAN covers localhost + LAN IP so it
// matches how the registry is actually reached); `--tls-cert`/`--tls-key`
// accept user-provided PEM files instead (e.g. from mkcert, for a
// warning-free browser experience).

export type TlsConfig =
  | { mode: 'self-signed'; key: string; cert: string; altNames: readonly string[] }
  | { mode: 'provided'; key: string; cert: string };

export type TlsOptions = {
  tls?: boolean;
  tlsCertFile?: string;
  tlsKeyFile?: string;
  /** Extra SAN entries for the self-signed certificate (default: localhost, 127.0.0.1, ::1). */
  altNames?: readonly string[];
};

export async function createTlsConfig(opts: TlsOptions): Promise<TlsConfig | null> {
  if (opts.tlsCertFile !== undefined || opts.tlsKeyFile !== undefined) {
    if (opts.tlsCertFile === undefined || opts.tlsKeyFile === undefined) {
      throw new Error('--tls-cert and --tls-key must be provided together');
    }
    let cert: string;
    let key: string;
    try {
      [cert, key] = await Promise.all([
        readFile(opts.tlsCertFile, 'utf8'),
        readFile(opts.tlsKeyFile, 'utf8'),
      ]);
    } catch (err) {
      throw new Error(
        `failed to read TLS certificate/key: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { mode: 'provided', key, cert };
  }

  if (opts.tls !== true) return null;

  const altNames = [...(opts.altNames ?? ['localhost', '127.0.0.1', '::1'])];
  const pems = await selfsigned.generate(
    [{ name: 'commonName', value: 'localhost' }],
    {
      algorithm: 'sha256',
      keySize: 2048,
      extensions: [
        { name: 'basicConstraints', cA: false },
        {
          name: 'keyUsage',
          digitalSignature: true,
          keyEncipherment: true,
        },
        { name: 'extKeyUsage', serverAuth: true },
        {
          name: 'subjectAltName',
          altNames: altNames.map((name) =>
            net.isIP(name) !== 0
              ? { type: 7 as const, ip: name }
              : { type: 2 as const, value: name },
          ),
        },
      ],
    },
  );
  return { mode: 'self-signed', key: pems.private, cert: pems.cert, altNames };
}
