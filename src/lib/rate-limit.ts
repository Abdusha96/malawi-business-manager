/**
 * In-memory sliding-window limits for public payment endpoints and failed credentials sign-ins.
 * The clock is a parameter so the helpers can be checked without waiting. State is per server
 * process: on several instances the effective limit is higher, and a restart clears it. Use the
 * host's edge rate limiting for distributed-abuse protection.
 */
const hits = new Map<string, number[]>();

function recentHits(key: string, windowMs: number, now: number): number[] {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length > 0) hits.set(key, recent);
  else hits.delete(key);
  return recent;
}

function pruneExpired(now: number, windowMs: number): void {
  // keep the map from growing without bound
  if (hits.size > 5000) {
    for (const [k, v] of Array.from(hits.entries())) {
      if (v.every((t) => now - t >= windowMs)) hits.delete(k);
    }
  }
}

/** Check the current allowance without consuming it, for endpoints that only count failures. */
export function hasRequestCapacity(key: string, limit: number, windowMs: number, now: number = Date.now()): boolean {
  return recentHits(key, windowMs, now).length < limit;
}

/** Add a hit, optionally only after an operation fails. */
export function recordHit(key: string, windowMs: number, now: number = Date.now()): void {
  const recent = recentHits(key, windowMs, now);
  recent.push(now);
  hits.set(key, recent);
  pruneExpired(now, windowMs);
}

export function allowRequest(key: string, limit: number, windowMs: number, now: number = Date.now()): boolean {
  if (!hasRequestCapacity(key, limit, windowMs, now)) return false;
  recordHit(key, windowMs, now);
  return true;
}

export function clientKey(forwardedFor: string | null, token: string): string {
  const ip = (forwardedFor ?? "").split(",")[0].trim() || "unknown";
  return `${ip}|${token}`;
}
