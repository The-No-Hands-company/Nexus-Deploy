/**
 * Environment variables a member sets on a project. They end up in an env file
 * read by `docker run --env-file`, which has no quoting: a newline would end one
 * variable and start another. So a value may not contain one.
 */
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_ENTRIES = 100;
const MAX_VALUE = 4096;

export function validateEnv(input: unknown): Record<string, string> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("env must be an object of names to string values");
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > MAX_ENTRIES) throw new Error(`env may have at most ${MAX_ENTRIES} variables`);
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!KEY_RE.test(key)) throw new Error(`"${key}" is not a valid environment variable name`);
    if (typeof value !== "string") throw new Error(`${key} must be a string`);
    if (value.length > MAX_VALUE) throw new Error(`${key} is longer than ${MAX_VALUE} characters`);
    if (/[\n\r\0]/.test(value)) throw new Error(`${key} must not contain a line break`);
    out[key] = value;
  }
  return out;
}

/** Name=value lines for `docker run --env-file`. */
export function toEnvFile(env: Record<string, string>): string {
  return `${Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}
