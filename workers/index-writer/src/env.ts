export interface Env {
  readonly DB: D1Database;
  readonly INDEX: R2Bucket;
  /** Bearer token for the admin regen endpoint. Set with `wrangler secret put ADMIN_TOKEN`. */
  readonly ADMIN_TOKEN?: string;
}

/**
 * Constant-time string compare. A length-independent early return on an admin
 * token is a timing oracle, so compare over a fixed width.
 */
export const secretEquals = (left: string, right: string): boolean => {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const width = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let index = 0; index < width; index += 1) {
    diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return diff === 0;
};
