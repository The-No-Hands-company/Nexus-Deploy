import crypto from "node:crypto";

function keyFromSecret(secret: string) {
  return crypto.createHash("sha256").update(secret).digest();
}

export function encryptJson(secret: string, value: unknown) {
  const iv = crypto.randomBytes(12);
  const key = keyFromSecret(secret);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decryptJson<T>(secret: string, payload: string): T {
  const raw = Buffer.from(payload, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const key = keyFromSecret(secret);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  return JSON.parse(decrypted) as T;
}
