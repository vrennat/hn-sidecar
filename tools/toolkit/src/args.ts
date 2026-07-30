/**
 * CLI argument helpers for the build-path tools.
 *
 * This exists as one module because the obvious inline version is wrong in a way
 * that is very hard to see:
 *
 *   const value = process.argv[process.argv.indexOf(`--${name}`) + 1];
 *
 * When the flag is absent, `indexOf` returns -1 and `argv[-1 + 1]` is `argv[0]` —
 * the interpreter's own path. So the "default" silently becomes
 * `/path/to/bun`, and a tool that takes an output directory happily tries to
 * mkdir over the binary. Every default was wrong until a flag was passed.
 */

export const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  // A flag at the end of argv, or immediately followed by another flag, has no value.
  if (value === undefined || value.startsWith('--')) return fallback;
  return value;
};

export const intArg = (name: string, fallback: number): number => {
  const raw = arg(name, String(fallback));
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} expected an integer, got "${raw}"`);
  return parsed;
};

export const floatArg = (name: string, fallback: number): number => {
  const raw = arg(name, String(fallback));
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} expected a number, got "${raw}"`);
  return parsed;
};

export const flag = (name: string): boolean => process.argv.includes(`--${name}`);
