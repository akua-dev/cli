# OpenAPI-first Effect CLI design

## Decision

The public OpenAPI document is the sole API contract for the `akua` CLI. The
CLI generates Effect `Schema` values, an Effect `HttpApi` contract, and a
typed `HttpApiClient` from that document. It does not contain provider-specific
commands, provider-specific routes, or hand-written HTTP request shapes.

The generated client is static source committed to the repository and checked
in CI. An installed CLI never fetches or interprets an arbitrary OpenAPI
document at runtime.

All production control flow is Effect control flow. Production `src/` and
`scripts/` contain no `throw` statement, native Promise control flow, or
untyped failure helper. A module that can fail exposes an `Effect.Effect` and
uses a typed error channel; a module that only declares immutable types,
constants, or generated static data may remain pure and does not acquire a
meaningless Effect import.

## Goals

- Make every public OpenAPI operation executable through the normal CLI.
- Preserve typed request payloads, response decoding, and status-specific
  errors in Effect.
- Keep OpenAPI as the only route, schema, and error-contract source.
- Allow API evolution through deterministic regeneration, reviewable diffs,
  and release artifacts rather than hand-maintained command implementations.
- Keep credential input provider-neutral and safe for humans and agents.

## Non-goals

- Do not retain the old `agent-os` or HCloud ingress command or endpoint.
- Do not build a runtime generic OpenAPI interpreter. It would turn generated
  contracts into `unknown`, remove compile-time guarantees, and make a binary's
  behavior change without review.
- Do not translate the server API manually into a second Effect `HttpApi`
  contract.
- Do not manufacture command-specific flags for every JSON property in the
  first delivery. The portable request surface is a JSON document supplied by
  stdin or an explicitly named file.

## Generated contract

`@effect/openapi-generator` pinned to the same Effect V4 beta as the CLI
generates three deterministic artifacts from `openapi/public.json`:

1. Effect `Schema` definitions and a public `HttpApi` contract.
2. An `HttpApiClient` service derived from that contract.
3. CLI command metadata mapping public `operationId` values to command words,
   positional path parameters, header/query parameters, accepted content type,
   and result format.

The CLI owns only a small generic adapter that supplies authenticated Effect
HTTP transport, decodes a JSON input document through the generated request
schema, invokes the generated operation, and renders the generated success or
error result. The adapter has no knowledge of providers or individual routes.

For example, an API operation whose ID is `secrets.create` is called as
`akua secrets create --input -`. The JSON body determines its documented
`kind`; the command name itself does not encode a provider.

## Request interface

Every generated public operation supports a stable, generic transport shape:

```text
akua <resource> <action> [path arguments] [--query name=value] [--header name=value] [--input -|<file>]
```

`--input -` reads JSON from stdin. `--input <file>` reads JSON from that exact
path. A request body is required only when the OpenAPI operation requires one.
Headers and query parameters are admitted only when declared by the generated
metadata. Authentication is injected from `AKUA_API_TOKEN` or the configured
device-login credential, never accepted as an API payload property.

Secret-bearing values may flow through stdin or a caller-selected file because
those are normal machine interfaces; they must never be echoed, logged, placed
in generated examples, or persisted by the CLI. The generic renderer redacts
known request input and reports only structured server errors.

## Error model

Generated operations return Effect values with a union of:

- Effect transport failures;
- request or response `Schema` failures; and
- one tagged error payload per non-success OpenAPI response status.

The generic executor maps only the outer categories into existing CLI envelopes.
It preserves the generated operation ID, HTTP status, server error code, and
safe server message where present. It does not collapse endpoint errors into a
provider-specific error type.

## Generation and CI

The repository keeps `openapi/public.json` plus all generated output checked
in. `spec:fetch` obtains the published document. `generate` regenerates every
artifact. `generate:check` regenerates in memory and fails on any drift.

Generation is an explicit compatibility gate:

- Reject non-OpenAPI 3 documents and unsupported schemas before writing output.
- Fail on generator warnings that would omit a public operation, response
  header, or streaming contract. A documented, versioned compatibility patch
  may normalize a known standard gap, but only with a matching contract test.
- Parse generated TypeScript and reject native `Promise`, `async`, `await`, and
  TypeScript assertions. Generated source must meet the same strict Effect
  invariant as handwritten production source.
- Typecheck a generated client against the pinned Effect version and exercise
  representative success and status-error decoding with a test HTTP layer.

## Compatibility fixes

OpenAPI `pattern` values are plain ECMA-262 regular-expression strings, not
JavaScript literal syntax. The server-side OpenAPI emitter must publish the
organization-name pattern without its JavaScript `/u` literal suffix while
keeping Unicode validation at runtime. This is an API-producer correction, not
a CLI normalization exception.

The current generator's `httpclient` output emits TypeScript assertions for
query serialization. The CLI therefore uses generated `httpapi` output plus
Effect `HttpApiClient`, whose generated contract has no assertions. The
generator's beta.106 `httpapi` path currently drops response-header schemas,
requires an error schema for every SSE stream, and warns despite correctly
representing optional request bodies as a `NoContent` union. Before CLI
generation begins, the pinned generator must gain typed response-header output,
faithful no-error SSE support, and a non-warning optional-body representation.
The install-log OpenAPI producer must describe its actual SSE event envelope
and use the resulting minimal `x-effect-stream` extension. A CLI postprocess,
raw-response workaround, or manual endpoint is prohibited because each loses
the contract's generated type information.

## Delete-before-optimize pass

- **Provider ingress command:** owned by no general CLI user path; deleting it
  leaves the normal `secrets.create` operation. It is removed.
- **Hand-written API client:** duplicates OpenAPI and would drift. It is not
  added.
- **Runtime specification interpreter:** has no user-facing need and sacrifices
  static guarantees. It is rejected.
- **Per-provider command flags:** duplicate API payloads and make the CLI
  provider-bound. They are rejected.
- **Generic JSON request adapter:** required for shell pipelines and agent-led
  onboarding; it remains deliberately small.

## Verification

Tests prove that a public operation is emitted, invoked through the generated
Effect client, decodes a documented success response, renders a documented
error response, rejects undeclared flags, and never exposes stdin/file request
contents. CI proves generated artifacts are current, syntactically strict, and
typecheck against the pinned dependency set.

The production invariant additionally rejects `throw`, `Promise`, `async`,
`await`, type assertions, Effect runtime execution outside terminals, and host
I/O outside explicitly named live adapters. Pure data modules are audited for
the absence of failure-capable control flow rather than forced to import Effect.

## Migration order

1. Remove the obsolete AgentOS/HCloud surface and its archive documentation.
2. Correct the server OpenAPI contract and pin a tested Effect generator patch
   for response headers, no-error SSE, and optional bodies.
3. Add the generated `HttpApi` artifact and consume the typed `HttpApiClient`
   through the existing Effect service boundary.
4. Replace the registry-only route with the generic command executor and its
   secure JSON-input contract.
5. Make the scheduled spec-update workflow regenerate all artifacts and reject
   any changed non-generated file.
