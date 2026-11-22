import { isIP } from 'node:net';

/** A parsed IP address. IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`) are IPv4. */
export interface IpAddress {
  readonly family: 4 | 6;
  /** 4 or 16 bytes, network order. */
  readonly bytes: Uint8Array;
}

function parseIpv4(text: string): Uint8Array {
  return Uint8Array.from(text.split('.'), Number);
}

function parseIpv6(text: string): Uint8Array {
  let source = text;
  // A dotted IPv4 tail takes the place of the last two groups.
  const lastColon = source.lastIndexOf(':');
  const tail = source.slice(lastColon + 1);
  if (tail.includes('.')) {
    const [a = 0, b = 0, c = 0, d = 0] = parseIpv4(tail);
    source = `${source.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', rest] = source.split('::');
  const leading = head === '' ? [] : head.split(':');
  const trailing = rest === undefined || rest === '' ? [] : rest.split(':');
  const zeros = rest === undefined ? 0 : 8 - leading.length - trailing.length;
  const groups = [...leading, ...Array<string>(zeros).fill('0'), ...trailing];
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    const value = Number.parseInt(group, 16);
    bytes[index * 2] = value >> 8;
    bytes[index * 2 + 1] = value & 0xff;
  });
  return bytes;
}

const isMappedIpv4 = (bytes: Uint8Array): boolean =>
  bytes.subarray(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;

/**
 * Parses an IPv4 or IPv6 literal, with or without brackets and zone id.
 * `null` for anything else (host names, empty strings, `unknown`).
 */
export function parseIp(text: string): IpAddress | null {
  let literal = text.trim();
  if (literal.startsWith('[') && literal.endsWith(']')) literal = literal.slice(1, -1);
  const zone = literal.indexOf('%');
  if (zone !== -1) literal = literal.slice(0, zone);
  const family = isIP(literal);
  if (family === 4) return { family: 4, bytes: parseIpv4(literal) };
  if (family !== 6) return null;
  const bytes = parseIpv6(literal);
  return isMappedIpv4(bytes) ? { family: 4, bytes: bytes.slice(12) } : { family: 6, bytes };
}

/** Canonical text: dotted IPv4, or eight lowercase hex groups without `::` compression. */
export function formatIp(ip: IpAddress): string {
  if (ip.family === 4) return ip.bytes.join('.');
  const groups: string[] = [];
  for (let index = 0; index < 16; index += 2) {
    groups.push((((ip.bytes[index] ?? 0) << 8) | (ip.bytes[index + 1] ?? 0)).toString(16));
  }
  return groups.join(':');
}

/** `127.0.0.0/8` and `::1`. */
export function isLoopbackIp(ip: IpAddress): boolean {
  if (ip.family === 4) return ip.bytes[0] === 127;
  return ip.bytes.subarray(0, 15).every((byte) => byte === 0) && ip.bytes[15] === 1;
}

/** Whether a bind address keeps the socket on this machine. Host names other than `localhost` do not count. */
export function isLoopbackHost(host: string): boolean {
  if (host.toLowerCase() === 'localhost') return true;
  const ip = parseIp(host);
  return ip !== null && isLoopbackIp(ip);
}

interface Network {
  readonly family: 4 | 6;
  readonly bytes: Uint8Array;
  readonly prefix: number;
}

function parseNetwork(entry: string): Network | null {
  const slash = entry.indexOf('/');
  const ip = parseIp(slash === -1 ? entry : entry.slice(0, slash));
  if (!ip) return null;
  const bits = ip.bytes.length * 8;
  if (slash === -1) return { ...ip, prefix: bits };
  const prefixText = entry.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixText)) return null;
  let prefix = Number(prefixText);
  // `::ffff:10.0.0.0/104` was folded to IPv4 by parseIp; fold its prefix too.
  if (ip.family === 4 && entry.includes(':')) prefix -= 96;
  if (prefix < 0 || prefix > bits) return null;
  return { ...ip, prefix };
}

function contains(network: Network, ip: IpAddress): boolean {
  if (network.family !== ip.family) return false;
  const whole = network.prefix >> 3;
  for (let index = 0; index < whole; index++) {
    if (network.bytes[index] !== ip.bytes[index]) return false;
  }
  const rest = network.prefix & 7;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return ((network.bytes[whole] ?? 0) & mask) === ((ip.bytes[whole] ?? 0) & mask);
}

/**
 * Compiles a list of IP addresses and CIDR ranges into a predicate.
 * @throws Error naming the first entry that is neither.
 */
export function createAddressMatcher(entries: readonly string[]): (ip: IpAddress) => boolean {
  const networks = entries.map((entry) => {
    const network = parseNetwork(entry.trim());
    if (!network) throw new Error(`Not an IP address or CIDR range: "${entry}"`);
    return network;
  });
  return (ip) => networks.some((network) => contains(network, ip));
}

/**
 * The key under which a client's failed sign-in attempts are counted: the
 * address itself for IPv4, the /64 for IPv6 (one host usually owns all of it).
 */
export function rateLimitKey(address: string): string {
  const ip = parseIp(address);
  if (!ip) return address;
  if (ip.family === 4) return formatIp(ip);
  const network = new Uint8Array(16);
  network.set(ip.bytes.subarray(0, 8));
  return `${formatIp({ family: 6, bytes: network })}/64`;
}
