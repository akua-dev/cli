# Contributing to the Akua CLI

This file covers building, testing, and releasing this repository's source.
If you only want to use the `akua` executable, see [README.md](README.md)
instead.

## Prerequisites

[mise](https://mise.jdx.dev/) manages the pinned Bun toolchain:

```sh
mise install
bun install --frozen-lockfile
mise run check
mise run build:binary
./dist/akua --version
./dist/akua --help
./dist/akua commands --limit 1
```

`mise run check` runs the drift check, typecheck/build, and tests — the same
gate CI runs. Run it before opening a PR.

## Command generation

The command surface is generated from cnap's committed public OpenAPI document,
`docs/openapi-public.json` (produced in-graph by
`//packages/sdks/toolchain:generate_all` and drift-gated with the SDKs). There is
no weekly production fetch.

```sh
# From the cnap repository root:
bazel run //tools/cli:write_generated   # regenerate CLI .gen.ts from docs/openapi-public.json
bazel test //:sdk_generated_drift_test  # fail if committed generated output has drifted
# Or via mise from tools/cli/source:
mise run generate
mise run generate:check
```

Generation is deterministic and operationId-driven; only operations marked
`x-platform-visibility: PUBLIC` are included, and registry rows are sorted by
operationId. The generated outputs are `src/generated/commands.gen.ts`,
`src/generated/openapi-api.gen.ts`, and
`src/generated/public-operation-executor.gen.ts`. Never hand-edit generated
files; run `bazel run //tools/cli:write_generated` and commit the result.

See [docs/architecture.md](docs/architecture.md) for the full command
derivation rules, the API/auth/config model, output modes, exit codes, and
the rest of the CLI's design contract.

## Testing

```sh
bun test
```

`mise run check` (drift check, build, tests) is the required gate before
release changes; see [docs/architecture.md](docs/architecture.md#testing-strategy)
for what current test coverage includes.

## Release process

`mise run release:package` cross-compiles all five targets, creates archives
and checksums in `dist/release`, and verifies their manifest.
`mise run release:verify` re-verifies an already-packaged release directory.
`mise run release:smoke` extracts and runs the artifact for the current
supported host. CI repeats native smoke tests on every platform in the
release matrix (macOS arm64/x64, glibc Linux arm64/x64, Windows x64).

Release Please creates the version tag and GitHub Release. Its own workflow
then calls artifact publication directly, so publication does not depend on a
tag event that GitHub may suppress for job-token-created tags. Uploads do not
clobber existing assets. Only after downloading and re-verifying the published
assets does the workflow dispatch the Homebrew manifest URL. The
`HOMEBREW_TAP_TOKEN` secret must be a fine-grained credential scoped only to
the tap repository's dispatch permission; failures remain visible as release
job failures.

`akua-dev/homebrew-tap` owns the `akua` formula, formula tests, and the
reviewed formula-update PR. This repository requests a formula PR only after
every archive has passed a native install smoke test and all published assets
have passed post-upload verification; it never pushes formula commits itself.

`scripts/release.ts` is the source of truth for target IDs, Bun targets,
archive names, executable names, SHA-256 files, and release manifests.

## Repository-specific engineering rules

See [AGENTS.md](AGENTS.md) for durable, repository-wide engineering rules
(Effect v4 production code conventions, the release contract, ownership
boundaries, and the public API command contract) that apply to any change in
`src/` or `scripts/`.
