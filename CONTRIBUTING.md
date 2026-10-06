# Contributing to the Akua CLI

This file covers building, testing, and releasing this repository's source.
If you only want to use the `akua` executable, see [README.md](README.md)
instead.

**Canonical writable history is cnap.** This tree is prepared for the public Josh projection
of `tools/cli/source` (`viewId: cli`). Contribute via reviewed PRs on
`akua-dev/cnap`. Direct pushes to `akua-dev/cli` main are not the release path.
The SemVer for a public release is `tools/cli/source/package.json` `version`,
bumped in that cnap PR; the public `v<version>` tag is created later by the
outbound App at an admitted projected commit (not by release-please, not as a
cnap project tag).

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

`mise run check` typechecks, builds, and tests this standalone checkout.
Public API changes also require the canonical cnap Bazel drift gate below.

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
bun run test
```

`mise run check` (build and tests) is the required gate before
release changes; see [docs/architecture.md](docs/architecture.md#testing-strategy)
for what current test coverage includes.

## Release process

Bump `package.json` `version`, the binary version, and release metadata in a
reviewed cnap PR when CLI changes need a release. This reviewed version bump
is intentional; the Main pipeline does not invent a new version for unrelated
changes. Legacy Release Please metadata remains only as version metadata.

Bazel produces the five compiled archives and the thirteen immutable release
assets under `//tools/cli:cli_release_archive`. Linux and available macOS hosts
exercise the compiled cloud CLI and `pkg init` → `check` → `render` → `inspect`.
Windows is cross-built and packaged without requiring native execution.

The successful canonical Main pipeline projects the fixed public source tree,
scans its full Git history, and hands public-only inputs to a dedicated writer.
That writer fast-forwards public main, creates the immutable `v<version>` tag,
and publishes the exact stamped Bazel assets. It downloads and re-verifies all
published assets before sending the verified manifest through Access Proxy to
`akua-dev/homebrew-tap`. No vendor token is mounted in the build or writer.
Public CI provides read-only advisory build and install checks.

`akua-dev/homebrew-tap` owns the `akua` formula, formula tests, and the reviewed
formula-update PR. The publisher dispatches the verified manifest contract; the
tap reviews and tests its generated formula change.

`mise run release:package` remains a local packaging tool.
`mise run release:verify` re-verifies the files in `dist/release`.
`CLI_RELEASE_ARCHIVE_SHA256=<expected-sha256> mise run release:smoke` verifies,
extracts, and executes the current host archive. Supply its digest from the
verified manifest; a missing, malformed, or mismatched digest fails before
extraction. `scripts/release.ts` defines the target IDs, archive names, checksums,
and manifest contract consumed by the authoritative Bazel archive targets.

## Repository-specific engineering rules

See [AGENTS.md](AGENTS.md) for durable, repository-wide engineering rules
(Effect v4 production code conventions, the release contract, ownership
boundaries, and the public API command contract) that apply to any change in
`src/` or `scripts/`.
