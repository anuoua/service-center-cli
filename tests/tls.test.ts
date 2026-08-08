import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTlsConfig } from '../src/registry/tls.ts';

let tmp: string | undefined;

async function withFiles(files: Record<string, string>): Promise<string> {
  if (tmp === undefined) {
    tmp = await mkdtemp(join(tmpdir(), 'sccli-tls-'));
  }
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(tmp, name), content, 'utf8');
  }
  return tmp;
}

afterEach(async () => {
  if (tmp !== undefined) {
    await rm(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

describe('createTlsConfig (self-signed)', () => {
  it('generates a key + cert PEM pair', async () => {
    const cfg = await createTlsConfig({ tls: true });
    assert.ok(cfg);
    assert.equal(cfg.mode, 'self-signed');
    assert.match(cfg.key, /BEGIN PRIVATE KEY/);
    assert.match(cfg.cert, /BEGIN CERTIFICATE/);
  });

  it('SAN covers the default loopback aliases', async () => {
    const cfg = await createTlsConfig({ tls: true });
    assert.ok(cfg);
    if (cfg.mode !== 'self-signed') return;
    const cert = new X509Certificate(cfg.cert);
    const san = cert.subjectAltName ?? '';
    assert.match(san, /DNS:localhost/);
    assert.match(san, /IP Address:127\.0\.0\.1/);
    // Node stringifies the ::1 SAN in expanded form.
    assert.match(san, /IP Address:0:0:0:0:0:0:0:1/);
  });

  it('SAN includes caller-provided alt names', async () => {
    const cfg = await createTlsConfig({
      tls: true,
      altNames: ['localhost', '127.0.0.1', '192.168.1.50'],
    });
    assert.ok(cfg);
    if (cfg.mode !== 'self-signed') return;
    const cert = new X509Certificate(cfg.cert);
    const san = cert.subjectAltName ?? '';
    assert.match(san, /IP Address:192\.168\.1\.50/);
  });

  it('returns null when tls is disabled', async () => {
    const cfg = await createTlsConfig({});
    assert.equal(cfg, null);
  });
});

describe('createTlsConfig (provided cert)', () => {
  it('loads key and cert from files', async () => {
    const generated = await createTlsConfig({ tls: true });
    assert.ok(generated);
    const dir = await withFiles({
      'server.key': generated.key,
      'server.crt': generated.cert,
    });
    const cfg = await createTlsConfig({
      tlsCertFile: join(dir, 'server.crt'),
      tlsKeyFile: join(dir, 'server.key'),
    });
    assert.ok(cfg);
    assert.equal(cfg.mode, 'provided');
    assert.equal(cfg.key, generated.key);
    assert.equal(cfg.cert, generated.cert);
  });

  it('throws when only one of cert/key is provided', async () => {
    await assert.rejects(
      createTlsConfig({ tlsCertFile: '/tmp/x.crt' }),
      /together/,
    );
  });

  it('throws with a clear message when a file is missing', async () => {
    await assert.rejects(
      createTlsConfig({ tlsCertFile: '/nonexistent/nope.crt', tlsKeyFile: '/nonexistent/nope.key' }),
      /failed to read TLS certificate\/key/,
    );
  });
});
