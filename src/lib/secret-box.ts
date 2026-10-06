import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

/**
 * Module 74 – encryption for the one kind of secret this app stores on a customer's behalf: a
 * business's own payment gateway keys. AES-256-GCM (authenticated: a changed byte fails to decrypt
 * instead of yielding garbage), a fresh random 12-byte IV per value, and a version prefix so a future
 * key rotation can tell old values from new. Pure Node `crypto`, no database, no network.
 *
 * The key is `APP_ENCRYPTION_KEY`: 32 bytes as 64 hex characters or as base64 (generate with
 * `openssl rand -base64 32`). Without it `readEncryptionKey()` reports why, and the feature that
 * needs it switches itself off rather than storing a key in the clear. Losing or changing the key
 * makes stored secrets unreadable; the business simply enters its key again.
 *
 * Format: `v1:<iv base64url>:<tag base64url>:<ciphertext base64url>`.
 */

export type KeyRead = { ok: true; key: Buffer } | { ok: false; reason: string };

export function readEncryptionKey(env: Record<string, string | undefined>): KeyRead {
  const raw = (env.APP_ENCRYPTION_KEY ?? "").trim();
  if (!raw) return { ok: false, reason: "APP_ENCRYPTION_KEY is not set." };
  let key: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) key = Buffer.from(raw, "hex");
  else {
    try {
      const b = Buffer.from(raw, "base64");
      if (b.length === 32) key = b;
    } catch {
      key = null;
    }
  }
  if (!key || key.length !== 32) return { ok: false, reason: "APP_ENCRYPTION_KEY must be 32 bytes: 64 hex characters or base64 (openssl rand -base64 32)." };
  return { ok: true, key };
}

export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${ct.toString("base64url")}`;
}

/** Returns the plaintext, or null if the value is malformed, from another key, or was altered. Never throws. */
export function decryptSecret(stored: string, key: Buffer): string | null {
  try {
    const [v, ivB, tagB, ctB] = stored.split(":");
    if (v !== "v1" || !ivB || !tagB || !ctB) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB, "base64url"));
    decipher.setAuthTag(Buffer.from(tagB, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ctB, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Last four characters, for "key ending in ...1234" on a settings page. Never enough to use the key. */
export function secretHint(secret: string): string {
  const t = secret.trim();
  return t.length <= 8 ? "****" : t.slice(-4);
}
