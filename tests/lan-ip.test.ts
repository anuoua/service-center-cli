import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

import { detectLanIp } from '../src/server/lan-ip.ts';

const v4 = (address: string, internal = false): os.NetworkInterfaceInfo => ({
  address,
  netmask: '255.255.255.0',
  family: 'IPv4',
  mac: '00:00:00:00:00:00',
  internal,
  cidr: `${address}/24`,
});

describe('detectLanIp', () => {
  it('returns 127.0.0.1 when no interfaces are present', () => {
    assert.equal(detectLanIp({}), '127.0.0.1');
  });

  it('returns 127.0.0.1 when only loopback is present', () => {
    assert.equal(
      detectLanIp({ lo0: [v4('127.0.0.1', true)] }),
      '127.0.0.1',
    );
  });

  it('prefers en0 on a typical macOS layout', () => {
    assert.equal(
      detectLanIp({
        lo0: [v4('127.0.0.1', true)],
        en0: [v4('192.168.1.42')],
        // AirDrop / low-power WLAN interfaces carry routable IPs we must skip
        awdl0: [v4('169.254.10.20')],
        llw0: [v4('169.254.11.21')],
        utun0: [v4('10.0.0.5')],
        bridge100: [v4('172.16.123.1')],
      }),
      '192.168.1.42',
    );
  });

  it('prefers eth0 on a typical Linux layout', () => {
    assert.equal(
      detectLanIp({
        lo: [v4('127.0.0.1', true)],
        eth0: [v4('10.0.0.7')],
        docker0: [v4('172.17.0.1')],
        'br-abc': [v4('172.18.0.1')],
        veth1234: [v4('172.19.0.2')],
      }),
      '10.0.0.7',
    );
  });

  it('falls back to any non-internal IPv4 when no preferred interface exists', () => {
    // E.g. a custom NIC name; pick the routable one, skip tunnel/bridge.
    assert.equal(
      detectLanIp({
        lo: [v4('127.0.0.1', true)],
        mycustom0: [v4('192.168.50.10')],
        vmnet1: [v4('172.16.0.1')],
      }),
      '192.168.50.10',
    );
  });

  it('returns 127.0.0.1 when every routable interface is skipped', () => {
    assert.equal(
      detectLanIp({
        lo0: [v4('127.0.0.1', true)],
        docker0: [v4('172.17.0.1')],
        utun0: [v4('10.0.0.5')],
        bridge100: [v4('172.16.123.1')],
      }),
      '127.0.0.1',
    );
  });

  it('ignores IPv6 addresses', () => {
    assert.equal(
      detectLanIp({
        en0: [
          { address: 'fe80::1', netmask: 'ffff:ffff::', family: 'IPv6', mac: '...', internal: false, cidr: '...' },
          v4('192.168.1.42'),
        ],
      }),
      '192.168.1.42',
    );
  });
});
