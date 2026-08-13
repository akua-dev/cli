# OpenAPI-first Effect executor implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every public OpenAPI operation a normal, provider-neutral, typed Effect CLI command while removing every raw production `throw` and remaining non-Effect failure path.

**Architecture:** The server's OpenAPI snapshot remains the contract. The CLI generates an Effect `HttpApi` contract, binds a typed `HttpApiClient`, and drives it through a small generic JSON request executor. Every fallible production function uses a typed Effect error channel; pure definitions remain pure. The source invariant blocks raw throws, native Promise control flow, type assertions, unauthorized host I/O, and generated drift.

**Tech Stack:** Bun, TypeScript 5.9, `effect@4.0.0-beta.106`, `@effect/openapi-generator@4.0.0-beta.106`, `effect/unstable/httpapi`, Bun test, GitHub Actions.

---

## Global constraints

- `openapi/public.json` is the sole API input. Never add a provider route or hand-written endpoint shape.
- Production `src/**/*.ts` and `scripts/**/*.ts` contain no `throw`, `Promise`, `async`, `await`, or TypeScript assertion nodes. The only host bridge is a named `*-live.ts` module or an executable terminal guard.
- Every public OpenAPI operation must either generate into the client or fail generation. No warning may silently omit a public operation.
- Generic request input is `--input -` or `--input <file>`; request data is never printed or included in errors.
- Generated output is committed, deterministic, parsed by TypeScript, and checked in CI.

## File structure

| File | Responsibility |
| --- | --- |
| `test/strict-effect-control-flow.test.ts` | Structural invariants and red fixtures for raw throws and non-Effect fallible control flow. |
| `src/runtime/mode.ts` | Typed Effect parser for output flags and environment. |
| `src/commands/auth.ts` | Typed Effect parsers/decoders for device authentication. |
| `src/bin/akua.ts` | Typed Effect parsers for generic CLI routing and command filters. |
| `scripts/fetch-openapi.ts` | Typed Effect OpenAPI URL/document validation. |
| `scripts/generate-commands.ts` | Typed Effect OpenAPI registry parsing and generation. |
| `scripts/runtime/release-services.ts` | Effect-returning release validation helpers. |
| `scripts/runtime/release-host-live.ts` | Effect live service that maps every host/validation failure to a tagged error without `throw`. |
| `scripts/generate-effect-api.ts` | Effect CLI command that normalizes, validates, and generates the public `HttpApi` contract. |
| `src/generated/openapi-api.gen.ts` | Generated Effect `HttpApi` contract. Never hand edit. |
| `src/runtime/public-api.ts` | Small handwritten typed `HttpApiClient` binding, authorization middleware, and generic invocation boundary. |
| `src/commands/generated.ts` | Provider-neutral argument/input parser and generated operation executor. |
| `src/generated/commands.gen.ts` | Generated command metadata extended with request/response requirements. |
| `test/generated-api.test.ts` | Generator compatibility, strict-output, and typed-client contract tests. |
| `test/generated-command.test.ts` | Public command success/error/input-redaction tests. |
| `.github/workflows/update-openapi.yml` | Regenerates and permits only all generated OpenAPI artifacts. |
| `README.md` | Documents executable generated commands and safe JSON-input usage. |

### Task 0: Close the generated-contract compatibility gaps at their source

**Files:**
- Modify in the API repository: `packages/domains/organizations/src/roles.ts`, `packages/domains/organizations/src/schemas.ts`, `packages/domains/installs/src/endpoints/GetInstallLogs.ts`, `apps/api/src/openapi.gen.test.ts`
- Modify in the pinned Effect generator patch or upstream checkout: `OpenApiGenerator.ts`, `ParsedOperation.ts`, `HttpApiTransformer.ts`, and their focused generator tests
- Modify in this CLI repository: `package.json`, `bun.lock`, generator-patch provenance and verification test

- [ ] **Step 1: Write failing producer and generator contract tests.** Prove organization create/update patterns contain no JavaScript literal flag, both bootstrap/drift `201` responses retain a typed `Location` header, `installs.getLogs` produces a typed no-error SSE endpoint, and the optional `orderDrafts.createWorkerBootstrap` body generates without a warning.

- [ ] **Step 2: Run focused tests and observe RED.**

Run the API OpenAPI test and the Effect generator's focused test files.

Expected: the public document ends its organization pattern in `/u`; beta.106 reports `response-headers-ignored`, `sse-operation-skipped`, and `optional-request-body-approximated`.

- [ ] **Step 3: Fix the producer and official generator behavior.** Keep the runtime Unicode regular expression but override only its OpenAPI pattern with the plain string. Describe the logs stream as the real SSE event envelope (`id?`, `event`, and string `data`) with the minimal `x-effect-stream: { encoding: "sse" }` contract. In the generator, preserve each response-header schema and emit `HttpApiSchema.WithHeaders` for every response alternative; accept no-error SSE as `StreamSse({ events })`; retain optional request-body `NoContent` unions without warning. Pin the reviewed upstream version or a reproducible package patch. Do not use a CLI postprocess, raw-response mode, or per-operation handwritten client.

- [ ] **Step 4: Generate against the real public snapshot.**

Run: the CLI Effect generator against `openapi/public.json` with warning-as-error enabled.

Expected: zero warnings, `installs.getLogs` present, and both `Location` response schemas preserved in generated TypeScript.

- [ ] **Step 5: Simplify, verify, and commit per repository.** Run each repository's required checks. Keep producer, upstream/patch, and CLI dependency changes as independently reviewable commits.

### Task 1: Make core CLI failure control flow Effect-only (completed in `062e095`)

**Files:**
- Create: `test/strict-effect-control-flow.test.ts`
- Modify: `src/runtime/mode.ts`, `src/commands/auth.ts`, `src/bin/akua.ts`, `test/mode.test.ts`, `test/auth-effect.test.ts`, `test/cli.test.ts`

- [x] **Step 1: Write failing structural and behavior tests.** Add AST assertions that `mode.ts`, `auth.ts`, and `akua.ts` contain no `ThrowStatement`; add a test that an invalid `--output` and an invalid auth argument return typed CLI error envelopes rather than escaping a thrown exception.

```ts
test("core CLI modules contain no throw statements", () => {
  expect(findThrowStatements(["src/runtime/mode.ts", "src/commands/auth.ts", "src/bin/akua.ts"])).toEqual([])
})

test("invalid generated-command arguments render a usage envelope", async () => {
  const result = await runAkua(["commands", "unexpected", "--json"])
  expect(JSON.parse(result.stdout)).toMatchObject({ error: { code: "AKUA_USAGE_ERROR" } })
})
```

- [x] **Step 2: Run the focused tests and observe RED.**

Run: `bun test test/strict-effect-control-flow.test.ts test/mode.test.ts test/auth-effect.test.ts test/cli.test.ts`

Expected: FAIL because the named files still contain `ThrowStatement` nodes.

- [x] **Step 3: Replace every synchronous parser with a typed Effect parser.** Convert `detectOutputMode`, auth parsers/response decoders, and CLI filter parsers to return `Effect.Effect<A, UsageFailure | DeviceRequestFailure>` or `Either` consumed immediately by an Effect constructor. Replace `Effect.try({ try: parser })` callbacks that depend on throwing with explicit predicates and `Effect.fail`.

```ts
const parseOutputMode = (input: OutputInput): Effect.Effect<OutputMode, UsageFailure> =>
  isOutputMode(input.value)
    ? Effect.succeed(input.value)
    : Effect.fail(new UsageFailure({ error: usageError(outputMessage(input)) }))
```

- [x] **Step 4: Run the focused tests and source scan.**

Run: `bun test test/strict-effect-control-flow.test.ts test/mode.test.ts test/auth-effect.test.ts test/cli.test.ts && rg -n '\\bthrow\\b' src/runtime/mode.ts src/commands/auth.ts src/bin/akua.ts`

Expected: tests pass; `rg` prints no rows.

- [x] **Step 5: Simplify and commit.** Run the simplify review, eliminate duplicated typed parser branches, then commit only the files listed for this task.

```bash
git add test/strict-effect-control-flow.test.ts src/runtime/mode.ts src/commands/auth.ts src/bin/akua.ts test/mode.test.ts test/auth-effect.test.ts test/cli.test.ts
git commit -m "refactor(cli): remove throws from core command flow"
```

### Task 2: Make OpenAPI scripts and release validation Effect-only (completed in `6722a51` and `35659a4`)

**Files:**
- Modify: `scripts/fetch-openapi.ts`, `scripts/generate-commands.ts`, `scripts/runtime/release-services.ts`, `scripts/runtime/release-host-live.ts`, `scripts/runtime/services-live.ts`, related existing tests
- Modify: `test/strict-effect-control-flow.test.ts`, `test/fetch-openapi.test.ts`, `test/generate-commands.test.ts`, `test/release.test.ts`

- [x] **Step 1: Extend the failing invariant and regression tests.** Require no `ThrowStatement` in the five script files. Add focused tests for invalid HTTPS URL, malformed OpenAPI document, invalid release version, and unsafe release output; each must fail through an Effect error channel.

```ts
test("script and release modules contain no throw statements", () => {
  expect(findThrowStatements(scriptFiles)).toEqual([])
})

test("invalid OpenAPI URL is an Effect failure", () => {
  expectExit(resolveSpecUrlEffect("http://example.test"))).toMatchObject({ _tag: "Failure" })
})
```

- [x] **Step 2: Run the focused tests and observe RED.**

Run: `bun test test/strict-effect-control-flow.test.ts test/fetch-openapi.test.ts test/generate-commands.test.ts test/release.test.ts`

Expected: FAIL solely on the new raw-throw invariant and typed failure assertions.

- [x] **Step 3: Replace script and release throw sites with typed Effects.** Give URL/document parsers and registry collection typed `Effect` return values. Make release validation helpers return `Effect` rather than throwing. Within `release-host-live.ts`, use `Effect.fail(new ScriptHostFailure({ cause }))` and composed validation Effects; do not put `throw` inside `Effect.try` callbacks.

```ts
const validateReleaseVersion = (version: string): Effect.Effect<string, ScriptHostFailure> =>
  VERSION.test(version)
    ? Effect.succeed(version)
    : Effect.fail(new ScriptHostFailure({ cause: new Error("Invalid release version") }))
```

- [x] **Step 4: Run the focused suite and production scan.**

Run: `bun test test/strict-effect-control-flow.test.ts test/fetch-openapi.test.ts test/generate-commands.test.ts test/release.test.ts && rg -n '\\bthrow\\b' scripts`

Expected: tests pass; `rg` prints no production rows.

- [x] **Step 5: Simplify and commit.** Extract one shared typed validation helper if repeated, then commit explicit files.

```bash
git add scripts/fetch-openapi.ts scripts/generate-commands.ts scripts/runtime/release-services.ts scripts/runtime/release-host-live.ts scripts/runtime/services-live.ts test/strict-effect-control-flow.test.ts test/fetch-openapi.test.ts test/generate-commands.test.ts test/release.test.ts
git commit -m "refactor(cli): remove throws from Effect scripts"
```

### Task 3: Generate a strict Effect HttpApi contract

**Files:**
- Modify: `package.json`, `bun.lock`, `scripts/generate-commands.ts`, `test/strict-effect-control-flow.test.ts`
- Create: `scripts/generate-effect-api.ts`, `src/generated/openapi-api.gen.ts`, `test/generated-api.test.ts`

- [ ] **Step 1: Add failing generation contract tests.** Test that generation consumes the checked-in spec, fails on every warning for public routes, emits `secretsCreate`, `installsGetLogs`, and typed `Location` headers, and parses with zero TypeScript assertions or raw throws.

```ts
test("generated Effect contract is strict and contains secrets.create", () => {
  const source = runEffectGeneration(publicSpec)
  expect(source).toContain('HttpApiEndpoint.post("secretsCreate", "/v1/secrets"')
  expect(typeAssertions(source)).toEqual([])
  expect(throwStatements(source)).toEqual([])
})
```

- [ ] **Step 2: Run the generator tests and observe RED.**

Run: `bun test test/generated-api.test.ts`

Expected: FAIL because no generated Effect API artifact or generator command exists.

- [ ] **Step 3: Add the reviewed exact generator dependency and deterministic generator command.** Add the Task 0-reviewed `@effect/openapi-generator` and matching platform package as development dependencies. Implement `generate-effect-api` with Effect CLI/services, use the `httpapi` format, turn every generator warning into an Effect failure, and write `src/generated/openapi-api.gen.ts`. No contract normalization occurs in the CLI.

```ts
const source = yield* OpenApiGenerator.OpenApiGenerator.generate(spec, {
  name: "PublicApi",
  format: "httpapi",
  onWarning: warnings.push,
})
if (warnings.length > 0) return yield* Effect.fail(new GenerationFailure({ warnings }))
```

- [ ] **Step 4: Generate, typecheck, and run focused tests.**

Run: `bun scripts/generate-effect-api.ts && bun test test/generated-api.test.ts && bun run build`

Expected: generated file is current, tests pass, and build succeeds.

- [ ] **Step 5: Simplify and commit.** Keep normalization data-only and narrowly tested; do not hand-edit generated code.

```bash
git add package.json bun.lock scripts/generate-effect-api.ts src/generated/openapi-api.gen.ts scripts/generate-commands.ts test/generated-api.test.ts test/strict-effect-control-flow.test.ts
git commit -m "feat(cli): generate Effect API contract from OpenAPI"
```

### Task 4: Bind the generated client and execute normal public commands

**Files:**
- Create: `src/runtime/public-api.ts`, `src/commands/generated.ts`, `test/generated-command.test.ts`
- Modify: `src/runtime/services.ts`, `src/runtime/services-live.ts`, `src/runtime/effect-runtime.ts`, `src/bin/akua.ts`, `src/runtime/registry.ts`, `src/generated/commands.gen.ts`, `test/cli.test.ts`

- [ ] **Step 1: Write failing normal-command tests.** Cover `secrets create --input -`, a typed documented success payload, one documented 409 error payload, a required body omitted error, an undeclared query/header rejection, and a sentinel input string absent from stdout/stderr/error output.

```ts
test("secrets create pipes JSON to its generated API operation", async () => {
  const result = await runGenerated(["secrets", "create", "--input", "-"], '{"name":"provider","kind":"cloud_provider/hcloud","value":"sentinel"}', clientLayer)
  expect(result.payload.data).toMatchObject({ id: "sec_123" })
  expect(result.serialized).not.toContain("sentinel")
})
```

- [ ] **Step 2: Run the focused command tests and observe RED.**

Run: `bun test test/generated-command.test.ts test/cli.test.ts`

Expected: FAIL because generated command routing still reports `commandNotImplemented`.

- [ ] **Step 3: Implement the generic executor.** Derive `HttpApiClient` from generated `PublicApi`; provide it with the authenticated Effect HTTP client in a single `public-api.ts` live layer. Parse only generated path/query/header metadata and `--input`; decode JSON via generated request schemas; invoke the generated operation; map its typed errors through `runCli`; redact all request input from output.

```ts
return decodeGeneratedInput(definition, input).pipe(
  Effect.flatMap((request) => client[definition.operation_id](request)),
  Effect.map(renderGeneratedSuccess),
  Effect.mapError(renderGeneratedFailure),
)
```

- [ ] **Step 4: Run focused tests, all tests, and the strict scans.**

Run: `bun test test/generated-command.test.ts test/cli.test.ts && bun test && rg -n '\\b(throw|Promise|async|await|runPromise)\\b|\\bas const\\b|\\bas [A-Za-z_{]' src scripts && mise run check`

Expected: all tests pass; scan has no production hits; `mise run check` passes.

- [ ] **Step 5: Simplify and commit.** Keep provider values data-only in JSON. Do not add provider-specific command branches.

```bash
git add src/runtime/public-api.ts src/commands/generated.ts src/runtime/services.ts src/runtime/services-live.ts src/runtime/effect-runtime.ts src/bin/akua.ts src/runtime/registry.ts src/generated/commands.gen.ts test/generated-command.test.ts test/cli.test.ts
git commit -m "feat(cli): execute generated public API commands"
```

### Task 5: Enforce artifact drift and publish the normal interface

**Files:**
- Modify: `package.json`, `.github/workflows/update-openapi.yml`, `README.md`, `AGENTS.md`, `test/workflows.test.ts`, `test/docs.test.ts`, `test/production-effect-invariants.test.ts`
- Delete: `docs/superpowers/plans/2026-07-14-agent-os-hcloud-provider-loader-cli.md`

- [ ] **Step 1: Write failing workflow/docs/invariant tests.** Require `generate:check` to generate both artifacts, the update workflow to allow only the spec plus both generated files, README examples to use `akua secrets create --input -`, and no active AgentOS/HCloud planning document.

```ts
expect(workflow).toContain('src/generated/openapi-api.gen.ts')
expect(readme).toContain('akua secrets create --input -')
expect(existsSync("docs/superpowers/plans/2026-07-14-agent-os-hcloud-provider-loader-cli.md")).toBe(false)
```

- [ ] **Step 2: Run the focused tests and observe RED.**

Run: `bun test test/workflows.test.ts test/docs.test.ts test/production-effect-invariants.test.ts`

Expected: FAIL because the update workflow and docs still describe registry-only generation and the historical plan remains.

- [ ] **Step 3: Update scripts, workflow, docs, and global invariants.** Include `generate-effect-api` in `generate` and `generate:check`; update the scheduled PR paths and diff guard; delete the obsolete old-plan document; update README and AGENTS to describe fully executable generated commands and no-throw Effect control flow. Expand the invariant to scan all `src/` and `scripts/` production files.

`AGENTS.md` must state these durable rules in this level of detail: public
OpenAPI is the only endpoint/schema/error source; public command behavior is
generated and provider-neutral; a command may accept only generated
path/query/header/body shape; request input is redacted; production fallibility
uses typed Effect errors and has no raw `throw`; `generate:check`, source scans,
and `mise run check` are mandatory before handoff. It points to the generated
contract and design instead of duplicating individual endpoint details.

- [ ] **Step 4: Run full verification.**

Run: `mise run generate && mise run generate:check && bun test && bun run build && mise run check && git diff --check && git status --short`

Expected: deterministic generated output, green checks, and only intended changes before commit.

- [ ] **Step 5: Run simplify, coverage, and commit.**

Run: `bun test --coverage --coverage.include='src/**' --coverage.include='scripts/**'`

Then stage explicit paths and commit. The obsolete provider-loader plan is a
documentation deletion, so it does not need the test-deletion footer.

```bash
git add package.json .github/workflows/update-openapi.yml README.md AGENTS.md test/workflows.test.ts test/docs.test.ts test/production-effect-invariants.test.ts docs/superpowers/plans/2026-07-14-agent-os-hcloud-provider-loader-cli.md
git commit -m "chore(cli): enforce generated Effect API drift"
```

## Plan self-review

- **Spec coverage:** Task 0 makes the public contract and generator faithfully represent headers, SSE, optional bodies, and OpenAPI regexes. Tasks 1–2 remove every existing raw `throw`; Task 3 generates the strict typed Effect contract; Task 4 executes it without provider branching; Task 5 makes drift and documentation permanent.
- **Delete-before-optimize:** Task 5 deletes the obsolete provider-loader plan; Tasks 3–4 do not retain a second HTTP client, runtime interpreter, or provider flags.
- **Consistency:** `PublicApi` is generated in Task 3, bound in Task 4, and included in CI in Task 5. The generic input interface is introduced only after the typed client exists.
- **No placeholders:** Every task names paths, tests, red command, green command, and commit scope. Task 0 is deliberately before client generation because beta.106 cannot otherwise produce every public route and response type truthfully.
