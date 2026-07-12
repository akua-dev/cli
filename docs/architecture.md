# Akua Cloud CLI Architecture

Status: greenfield scaffold with local auth/config MVP.

## Decisions And Non-Goals

- Binary: `akua`.
- Runtime: Bun and TypeScript.
- Repository: standalone open-source `akua-dev/cli`.
- Packaging: Bun self-contained executable via `bun build --compile`.
- API source of truth: `https://api.akua.dev/v1/openapi.json`.
- First release: local auth/config plus public API commands only.
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
src/commands/auth.ts             local auth/config command implementation
src/runtime/                     output, errors, exit codes, command contracts
src/generated/commands.gen.ts    generated public command registry
.github/workflows/update-openapi.yml
                                 idempotent public OpenAPI update automation
.github/workflows/release-please.yml
                                 release PR, tag, and GitHub release automation
.github/workflows/release.yml    reusable binary publication and tap handoff
release-please-config.json       Release Please manifest-mode config
.release-please-manifest.json    Release Please root package version manifest
docs/architecture.md             this spec
test/                            Bun tests for scaffold and auth/config contracts
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
fetches the snapshot, regenerates the registry, and then fails if tracked or
untracked files outside `openapi/public.json` and
`src/generated/commands.gen.ts` changed. It is idempotent when those files match
the repository: unchanged runs report a no-op and do not run `mise run check` or
open/update a pull request. Changed runs execute `mise run check` and open or
update a pull request containing only the snapshot and generated registry.

## API, Auth, And Config Model

Default API base URL:

```text
https://api.akua.dev/v1
```

Authentication:

- bearer tokens use `Authorization: Bearer sk_akua_...`;
- `AKUA_API_TOKEN` is the primary noninteractive credential env var;
- `AKUA_API_TOKEN` takes precedence over stored credentials;
- broad tokens select workspace/scope with the `Akua-Context` header;
- workspace-owned tokens may imply workspace context.

Configuration should live under the Akua namespace:

```text
~/.config/akua/config.json
```

The implemented config file is JSON. The local auth MVP stores a `token` string
there while preserving unrelated keys. Writes create `~/.config/akua` with
user-only `0700` permissions and `config.json` with user-only `0600`
permissions.

Recommended config precedence:

1. command flags such as `--api-url`, `--workspace`, and `--profile`;
2. environment variables;
3. profile config;
4. built-in production defaults.

The first implemented local auth/config slice is:

```sh
akua auth login --token <token>  # save a token in ~/.config/akua/config.json
akua auth status                 # show whether auth comes from env, config, or none
akua auth logout                 # remove only the stored config token
```

`auth login` requires `HOME` so it can locate the config file. `auth status`
honors `AKUA_API_TOKEN` even when `HOME` is unset, and otherwise reads the
stored token. `auth logout` leaves `AKUA_API_TOKEN` untouched and reports env
auth as still active when that variable is set. Browser/device login remains out
of scope.

## Output And UX Modes

The default output mode is adaptive:

- `human`: interactive TTY without automation or coding-agent signals;
- `agent`: `AGENT` names/flags, known coding-agent env vars, CI env vars, or
  non-TTY stdout;
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

The implemented command surface is intentionally small:

```sh
akua                                      # registry status home view
akua auth login --token <token>           # save a local API token
akua auth status                          # show effective auth source
akua auth logout                          # remove the saved local API token
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

The first release API command surface is generated only from public operations.
Internal, admin, preview, trusted-partner, and private operations must be absent
from generated commands and docs unless a separate build target is deliberately
added later.

Recommended MVP order:

1. local `auth` and token config commands (implemented);
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

`scripts/release.ts` owns the release matrix and packaging contract. The
published targets are:

- `bun-darwin-arm64` and `bun-darwin-x64`;
- `bun-linux-arm64` and `bun-linux-x64-baseline` (glibc);
- `bun-windows-x64-baseline`.

Each Unix `.tar.gz` contains only executable `akua` with mode `0755`; the
Windows `.zip` contains only `akua.exe`. Stable names have the form
`akua-v<version>-<os>-<arch>.<archive>`. Every archive has an adjacent
`.sha256`, appears in `checksums.txt`, and is described in the release manifest.
The generated Homebrew manifest maps the four macOS/Linux formula selectors to
exact release URLs and SHA-256 digests.

`mise run build:binary` remains the fast host-only developer build. `mise run
release:package` cross-compiles and verifies the whole release directory, while
`mise run release:smoke` extracts and executes the current host archive. CI
builds the candidate once, then macOS arm64/x64, Linux arm64/x64, and Windows x64
hosted runners execute `akua --version`, `akua --help`, and `akua commands
--limit 1` from their extracted archive.

Release Please runs in manifest mode for the root Bun package. It uses
`release-please-config.json` and `.release-please-manifest.json` to prepare
release PRs, update package metadata and `CHANGELOG.md`, keep the
`src/bin/akua.ts` `x-release-please-version` marker aligned with
`akua --version`, create `v*` version tags without a component prefix, and
create GitHub releases after release PRs merge. Release Please calls the
reusable artifact workflow from its `release_created` output; publication does
not rely on a tag event, because GitHub suppresses workflow events created with
the job token.

The artifact workflow validates tag/version equality, runs the full checks,
packages and native-smokes every target, then uploads without clobbering. It
downloads the published assets and re-verifies names, contents, sizes, and
checksums. Only then does it dispatch the Homebrew manifest URL to
`akua-dev/homebrew-tap`. The tap owns formula validation and its reviewed PR;
this repository never pushes formula commits. `HOMEBREW_TAP_TOKEN` must be a
fine-grained token scoped only to the tap repository capability required for
repository dispatch. Publication or dispatch failures stay visible in the
release workflow. Package metadata remains for development and versioning; no
package-registry publication is configured.

## Testing Strategy

Current tests cover:

- CLI routing and usage validation for the scaffold commands;
- local auth login/status/logout behavior, env credential precedence, config
  preservation, malformed config handling, and user-only config permissions;
- output mode detection;
- agent and JSON rendering;
- structured error payloads;
- OpenAPI fetch guard and document shape validation;
- public-only, deterministic operationId collection;
- Release Please config, manifest, token, and CLI version marker validation;
- release target naming, archive contents/modes, manifests, checksums, and
  tamper rejection;
- native install-smoke and workflow ordering/permission contracts;
- public install/auth/output/codegen documentation and source-skill ownership.

Current validation also runs `mise run generate:check` to catch generated
registry drift.

Future execution slices should add:

- golden command output by mode;
- mocked API calls for workspace, list/get, and operation flows;
- destructive command refusal tests in CI/non-TTY/agent modes;
- API-backed generated command integration tests.

## Migration Boundary

This is not a compatibility migration. The old `cnap` CLI can remain available
through historical releases until product documentation points users at the new
`akua` binary. New code should not import or preserve old CNAP module paths,
config paths, env vars, token prefixes, release metadata, or Homebrew formulas.
