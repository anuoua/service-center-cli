import os from 'node:os';

// Interface name prefixes that typically represent the primary NIC on common OSes.
// Order matters only weakly: the first matching IPv4 from any of these wins over fallbacks.
const PREFERRED_PREFIXES = [
  'en', // macOS / BSD: en0, en1
  'eth', // Linux classic: eth0, eth1
  'ens', // Linux predictable: ens33, enp0s3 (matched via 'en' too, kept for clarity)
  'enp',
  'enx',
  'wlan', // Linux classic Wi-Fi
  'wlp', // Linux predictable Wi-Fi: wlp3s0
  'wlx',
  'Wi-Fi', // Windows
  'Ethernet', // Windows
];

// Interface name prefixes that are almost certainly virtual / tunnel / bridge and
// should not be advertised as the LAN address.
const SKIP_PREFIXES = [
  'lo', // loopback (also flagged internal, but be defensive)
  'docker',
  'br-', // user-defined docker bridges
  'veth', // docker container veth pairs
  'vmnet', // macOS VM bridges (vmnet0..vmnet8)
  'vEthernet', // Windows Hyper-V
  'virbr', // libvirt bridges
  'utun', // macOS tunnels
  'awdl', // macOS AirDrop wireless
  'llw', // macOS low-power WLAN
  'anpi', // macOS Apple Network Port Interface
  'bridge', // generic bridges
  'tun',
  'tap',
  'ipsec',
  'gif',
  'stf',
];

const FALLBACK = '127.0.0.1';

function matchesAny(name: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => name.startsWith(p));
}

export function detectLanIp(interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string {
  const ifaces = interfaces ?? os.networkInterfaces();

  // Pass 1: a preferred interface with a non-internal IPv4.
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    if (!matchesAny(name, PREFERRED_PREFIXES)) continue;
    const hit = addrs.find((a) => a.family === 'IPv4' && !a.internal);
    if (hit) return hit.address;
  }

  // Pass 2: any non-internal IPv4 not on a virtual/tunnel interface.
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    if (matchesAny(name, SKIP_PREFIXES)) continue;
    const hit = addrs.find((a) => a.family === 'IPv4' && !a.internal);
    if (hit) return hit.address;
  }

  return FALLBACK;
}
