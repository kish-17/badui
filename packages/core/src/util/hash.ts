/**
 * Small, dependency-free, non-cryptographic hash used to derive stable,
 * idempotent identifiers (re-ingesting the same SMS must not create a second
 * observation). Never use it for secrets.
 */
export function stableHash(input: string): string {
  // cyrb53 — 53-bit hash with good distribution for short keys.
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(36).padStart(11, "0");
}

/** Deterministic id with a readable prefix, e.g. `obs_0k3j9x...`. */
export function stableId(prefix: string, ...parts: ReadonlyArray<string | number | undefined>): string {
  return `${prefix}_${stableHash(parts.map((p) => (p === undefined ? "" : String(p))).join("␟"))}`;
}
