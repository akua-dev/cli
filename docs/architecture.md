# Akua Cloud CLI Architecture

Status: initial greenfield spec and scaffold.

## Decisions And Non-Goals

- Binary: `akua`.
- Runtime: Bun and TypeScript.
- Repository: standalone open-source `akua-dev/cli`.
- Packaging: Bun self-contained executable via `bun build --compile`.
- API source of truth: `https://api.akua.dev/v1/openapi.json`.
- First release: public API commands only.
- Compatibility: no `cnap` binary, Go module, config path, env var, or command
  compatibility unless a later captain decision changes this.
- No live infrastructure mutation is required for development or tests. The
  spec fetch task performs only a read-only OpenAPI GET and rejects non-HTTPS
  source URLs.

## Current Repo Boundary

The old Go/CNAP implementation is removed from the active build surface. The
new repository shape is:

```text
openapi/public.json              fetched public OpenAPI snapshot
scripts/fetch-openapi.ts         guarded production spec fetcher
scripts/generate-commands.ts     operationId-driven command registry generator
src/bin/akua.ts                  executable entrypoint
src/runtime/                     output, errors, exit codes, command contracts
src/generated/commands.gen.ts    generated public command registry
.github/workflows/update-openapi.yml
                                 idempotent public OpenAPI update automation
.github/workflows/release-please.yml
                                 release PR, tag, and GitHub release automation
.github/workflows/release.yml    tag-triggered binary artifact build
release-please-config.json       Release Please manifest-mode config
.release-please-manifest.json    Release Please root package version manifest
docs/architecture.md             this spec
test/                            Bun tests for scaffold contracts
```

## OpenAPI And Command Generation

The CLI is operationId-driven. Public OpenAPI operations become generated command
definitions when all of these are true:

- `x-platform-visibility` is `PUBLIC`;
- `operationId` is present;
- HTTP method and path are present;
- tags, summary, operation-level auth requirement, and parameters are copied
  into the command model when present.

The initial command derivation is mechanical:

```text
operationId: workspaces.list
command:     akua workspaces list

operationId: customDomains.delete
command:     akua custom-domains delete

operationId: health
command:     akua health get
```

An operationId segment before the first dot becomes the resource, the next
segment becomes the action, and single-segment operationIds fall back to the
HTTP method as the action. The generator assumes OpenAPI operationIds are
unique; it does not currently enforce uniqueness itself.

The generator deliberately produces a registry, not hand-written API coverage.
Execution is stubbed until the API client and request/body binding layer lands.
The next implementation step should add a small CLI overlay file for exceptions
that cannot be inferred safely from OpenAPI alone, such as preferred aliases,
default list fields, destructive-command confirmation labels, and resource-
specific next steps.

Generation tasks:

```sh
mise run spec:fetch      # writes openapi/public.json
mise run generate        # writes src/generated/commands.gen.ts
mise run generate:check  # fails on drift
```

`mise run spec:fetch` defaults to `AKUA_OPENAPI_URL`, which is set to the
production source in `mise.toml`, and `scripts/fetch-openapi.ts` also accepts an
explicit URL argument. The scheduled `Update OpenAPI` workflow runs weekly,
fetches the snapshot, regenerates the registry, and then fails if files outside
`openapi/public.json` and `src/generated/commands.gen.ts` changed. It is
idempotent when those files match the repository: unchanged runs report a no-op
and do not run `mise run check` or open/update a pull request. Changed runs
execute `mise run check` and open or update a pull request containing only the
snapshot and generated registry.

## API, Auth, And Config Model

Default API base URL:

```text
https://api.akua.dev/v1
```

Authentication:

- bearer tokens use `Authorization: Bearer sk_akua_...`;
- `AKUA_API_TOKEN` is the primary noninteractive credential env var;
- broad tokens select workspace/scope with the `Akua-Context` header;
- workspace-owned tokens may imply workspace context.

Configuration should live under the Akua namespace:

```text
~/.config/akua/config.json
```

Recommended config precedence:

1. command flags such as `--api-url`, `--workspace`, and `--profile`;
2. environment variables;
3. profile config;
4. built-in production defaults.

The first release should implement `akua auth login --token <token>`, `akua auth
status`, and `akua auth logout` before browser/device login. Tokens must be
stored with user-only file permissions.

## Output And UX Modes

The default output mode is adaptive:

- `human`: interactive TTY without automation or coding-agent signals;
- `agent`: known coding-agent env vars, CI env vars, or non-TTY stdout;
- `json`: explicit `--json`, `--output json`, `-o json`, or
  `AKUA_OUTPUT=json`;
- `quiet`: explicit `--quiet`, `-q`, `--output quiet`, `-o quiet`, or
  `AKUA_OUTPUT=quiet`.

`--output`/`-o` and `AKUA_OUTPUT` accept only `human`, `agent`, `json`, and
`quiet`. `--json` and `--quiet` take precedence over other output mode signals.

Agent mode follows AXI patterns studied from `https://axi.md/` and the public
`gh-axi` example:

- compact structured output, currently TOON-like text;
- small list schemas by default;
- explicit empty states;
- contextual `next_steps`;
- stdout for success data and structured errors;
- stderr for progress, debug logs, and warnings;
- no spinners or prompts in agent, JSON, quiet, CI, or non-TTY modes;
- unknown routed commands and flags must fail loudly.

Human mode can use tables and prose, but should stay content-first. A no-args
`akua` invocation should show live state once API execution exists; the scaffold
currently shows registry state and next-step commands.

The implemented scaffold command surface is intentionally small:

```sh
akua                                      # registry status home view
akua commands                            # first 20 generated public commands
akua commands --resource workspaces      # resource filter
akua commands --operation-id workspaces.list
akua commands --limit 5                  # positive integer limit
akua --help                              # also -h
akua --version                           # also -v or -V
```

## Structured Errors

Errors preserve API envelope details instead of collapsing them into strings:

```json
{
  "error": {
    "type": "validation_error",
    "code": "INVALID_ARGUMENT",
    "status": 400,
    "message": "workspace_id is required",
    "path": ["body", "workspace_id"],
    "request_id": "req_123",
    "next_steps": [
      {"command": "akua workspaces list --fields id,name"}
    ]
  }
}
```

The same payload shape is used in JSON and agent modes. Human mode can render a
readable summary, but should include request IDs and next steps.

## Exit Codes

Initial contract:

- `0`: success, including idempotent no-op success;
- `1`: runtime or API error;
- `2`: local usage error, unknown command, unknown flag, invalid local args;
- `3`: authentication/session required;
- `4`: confirmation required or unsafe noninteractive mutation refused;
- `5`: conflict/precondition failure, including `If-Match` mismatch;
- `6`: retryable upstream failure or rate limit.

This can be simplified later, but it must remain deterministic and tested.

## Public-Only First Release

The first release command surface is generated only from public operations.
Internal, admin, preview, trusted-partner, and private operations must be absent
from generated commands and docs unless a separate build target is deliberately
added later.

Recommended MVP order:

1. `auth` and config/profile commands;
2. workspace/context commands;
3. read-only `list` and `get` commands for public resources;
4. operations status/watch commands;
5. selected mutations with idempotency and confirmation safety.

## Mutations And Safety

For create/update/delete commands:

- destructive actions require explicit resource IDs;
- noninteractive destructive actions require `--yes` or `--force`;
- `Idempotency-Key` is required when the API supports it, generated if omitted,
  and included in structured output;
- `If-Match` must be supported for resources with `etag`;
- `--dry-run`, `--wait`, `--watch`, and structured streaming should be added only
  where the API contract supports them;
- prompts are forbidden in automation modes.

## Packaging

The packaging path is:

```sh
bun build src/bin/akua.ts --compile --target=bun-linux-x64 --outfile dist/akua-linux-x64
```

The local task `mise run build:binary` compiles a host binary at `dist/akua`.
The initial release workflow builds a Linux x64 artifact; macOS and Windows
matrix targets should be added once the scaffold is validated on CI.

Release Please runs in manifest mode for the root Bun package. It uses
`release-please-config.json` and `.release-please-manifest.json` to prepare
release PRs, update `CHANGELOG.md`, keep the `src/bin/akua.ts`
`x-release-please-version` marker aligned with `akua --version`, create version
tags without a component prefix, and create GitHub releases after release PRs
merge. The config deliberately omits npm publishing and does not expand the
binary publishing surface; the existing tag-triggered release workflow remains
responsible for uploading the Linux x64 binary artifact.

## Testing Strategy

Current tests cover:

- CLI routing and usage validation for the scaffold commands;
- output mode detection;
- agent and JSON rendering;
- structured error payloads;
- OpenAPI fetch guard and document shape validation;
- public-only operation collection;
- Release Please config, manifest, token, and CLI version marker validation.

Current validation also runs `mise run generate:check` to catch generated
registry drift.

Next tests should add:

- golden command output by mode;
- mocked API calls for auth, workspace, list/get, and operation flows;
- destructive command refusal tests in CI/non-TTY/agent modes;
- packaging smoke test for `dist/akua --help`.

## Migration Boundary

This is not a compatibility migration. The old `cnap` CLI can remain available
through historical releases until product documentation points users at the new
`akua` binary. New code should not import or preserve old CNAP module paths,
config paths, env vars, token prefixes, release metadata, or Homebrew formulas.
