/**
 * Where an app is reachable, and which loopback ports it may use.
 *
 * Every node-specific value comes in as an argument so that nothing here names
 * a particular domain: the same code runs on any node with a different
 * BASE_DOMAIN. tests/no-hardcoded-domain.test.ts enforces that for all of src/.
 */

/** `{slug}` and `{BASE_DOMAIN}` are the only substitutions. */
export function appHost(slug: string, pattern: string, baseDomain: string): string {
  if (!pattern.includes("{slug}")) {
    throw new Error("APP_HOST_PATTERN must contain {slug}");
  }
  return pattern.replaceAll("{slug}", slug).replaceAll("{BASE_DOMAIN}", baseDomain);
}

export function appUrl(slug: string, pattern: string, baseDomain: string): string {
  return `https://${appHost(slug, pattern, baseDomain)}`;
}

export type PortRange = { min: number; max: number };

/** "20000-29999" → { min: 20000, max: 29999 }. Ports below 1024 are never allowed. */
export function parsePortRange(raw: string): PortRange {
  const match = /^(\d{1,5})-(\d{1,5})$/.exec(raw.trim());
  const min = match ? Number(match[1]) : Number.NaN;
  const max = match ? Number(match[2]) : Number.NaN;
  if (!match || min < 1024 || max > 65535 || min > max) {
    throw new Error(`APP_PORT_RANGE must look like 20000-29999 (got "${raw}")`);
  }
  return { min, max };
}
