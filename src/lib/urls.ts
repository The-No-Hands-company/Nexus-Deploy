/**
 * A project can ask Deploy to POST a notification to a URL when a deploy
 * finishes. That makes this server send a request to an address a member chose,
 * which is a request-forgery risk: pointed at loopback or the LAN it would reach
 * services only this machine can see. So the URL must be https and must not name
 * such a host.
 *
 * This checks the URL as written. It cannot see through DNS (a public name that
 * resolves to a private address), which is a known limit of the check.
 */
const PRIVATE_V4: Array<[number, number]> = [
  [0x7f000000, 0xff000000], // 127.0.0.0/8
  [0x0a000000, 0xff000000], // 10.0.0.0/8
  [0xac100000, 0xfff00000], // 172.16.0.0/12
  [0xc0a80000, 0xffff0000], // 192.168.0.0/16
  [0xa9fe0000, 0xffff0000], // 169.254.0.0/16 (link-local, cloud metadata)
  [0x64400000, 0xffc00000], // 100.64.0.0/10 (carrier-grade NAT)
  [0x00000000, 0xff000000], // 0.0.0.0/8
];

function ipv4ToInt(host: string): number | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    value = value * 256 + Number(part);
  }
  return value;
}

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  const v4 = ipv4ToInt(host);
  if (v4 !== null) return PRIVATE_V4.some(([net, mask]) => (v4 & mask) >>> 0 === net);
  if (host.includes(":")) {
    // IPv6 literal: loopback, unspecified, unique-local (fc00::/7), link-local (fe80::/10),
    // and IPv4-mapped addresses, which could smuggle a private IPv4.
    return host === "::1" || host === "::" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith("::ffff:");
  }
  return false;
}

export function validateNotifyUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw new Error("notifyUrl must be an https URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("notifyUrl must be an https URL");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("notifyUrl must be an https URL without credentials");
  }
  if (isPrivateHost(url.hostname)) throw new Error("notifyUrl must not point at a private or local address");
  return url.toString();
}
