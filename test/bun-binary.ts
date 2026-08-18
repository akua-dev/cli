/**
 * Resolves the bun executable used by tests that spawn a subprocess running
 * Bun (either the `akua` CLI or `bun x <tool>`). `bun run`/`npm run` set
 * `npm_execpath` to the fully resolved bun binary, which avoids paying a
 * mise-shim resolution on every spawned process and stays correct now that
 * tests run inside a vitest worker (a real Node process, not Bun) rather
 * than `bun test`.
 */
export function resolveBunBinary(): string {
  return process.env.npm_execpath ?? "bun";
}
