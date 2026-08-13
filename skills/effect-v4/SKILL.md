---
name: effect-v4
description: Use when creating, refactoring, reviewing, or debugging production Effect v4 CLI commands, runtimes, adapters, or scripts.
---

# Effect v4 CLI quality

Use the audited dependency exactly as locked: `effect@4.0.0-beta.106`. Do not
apply Effect v3 examples or upgrade guidance without a separate dependency
audit.

## Production model

- In production `src/` and `scripts/`, do not use native `Promise`, `async`,
  `await`, or raw `throw`; a command returns `Effect.Effect` rather than
  exposing a Promise.
- Put dependencies behind Effect services and layers (`Context.Service`,
  `Layer.succeed`, `Layer.mergeAll`). Commands request services; live adapters
  are supplied at composition.
- Model every failure as a typed `Data.TaggedError` value and keep it in the
  Effect error channel. Do not throw generic errors, use untyped failure
  helpers, or return an out-of-band sentinel from command flow.
- Plain TypeScript is reserved for immutable types, constants, and static data.
  A module that performs work or can fail must expose an `Effect.Effect` value.
- In production `src/` and `scripts/`, keep direct host I/O (`fetch`, Bun, Node
  filesystem, `process`, and console) out of commands, workflows, and scripts.
  A live service layer may bridge a host API only inside an Effect constructor,
  mapping failure to a tagged error.
- Each executable terminal owns its own runtime/fiber handoff: the CLI binary
  and every executable script may call `Runtime.makeRunMain` only in its
  minimal `if (import.meta.main)` guard. Exported functions, commands, runtime
  helpers, and service modules never call `runPromise` (`Effect.runPromise`),
  `runFork`, or a runtime directly. A terminal itself must not use native
  `async`/`await`; its host reads, writes, and output stay in the same guard.

```ts
class DeviceFailure extends Data.TaggedError("DeviceFailure")<{
  readonly cause: unknown;
}> {}

export class DeviceApi extends Context.Service<DeviceApi, {
  readonly inspect: (id: string) => Effect.Effect<Device, DeviceFailure>;
}>()("cli/DeviceApi") {}

export const inspect = (id: string) =>
  Effect.gen(function* () {
    return yield* (yield* DeviceApi).inspect(id);
  });
```

Use `Effect.try`, `Effect.tryPromise`, or an Effect platform adapter at the
service boundary; callbacks must not be native `async` functions. Preserve
cancellation and map every expected failure into a typed tagged error.

## Types and tests

Do not use TypeScript assertions (`as`, `as const`) in production `src/` or
`scripts/`. Prefer schemas that decode unknown input, explicit type guards,
discriminated unions, constructor functions, and `satisfies` for checked
literals. `Effect.as` is an Effect combinator, not a TypeScript assertion.

Tests supply service test layers instead of host dependencies. Use `TestClock`
and test layers for time, I/O, process, browser, and console behavior; advance
the clock deterministically instead of sleeping. Execute test Effects only in
the test harness.

## Source scan and verification

Before handoff, inspect every production hit; the first scan must have no
unapproved uses outside the binary terminal, and the host-I/O scan must point
only to deliberate live-layer bridges:

```sh
rg -n '\b(Promise|async|await|throw|runPromise)\b|\bas const\b|\bas [A-Za-z_{]' src scripts
rg -n '\b(fetch|Bun\.(file|write|spawn)|process\.|console\.|readFile|writeFile)\b' src/commands src/runtime scripts
bun test
mise run check
```

Review `package.json` and `bun.lock` together to confirm the audited exact
Effect version before changing any Effect API surface.

## Red flags

- “This adapter already returns a Promise, so `async` is harmless.” Wrap it in
  an Effect service instead.
- “A cast is quicker than validation.” Decode with a schema or type guard.
- “I can run this small Effect from the command.” Only the binary terminal owns
  the runtime/fiber handoff.
- “Real time or live I/O proves the integration.” Use `TestClock` and test
  layers for deterministic unit tests.
