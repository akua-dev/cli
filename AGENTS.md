# Repository guidance

## Release contract

- `scripts/release.ts` is the source of truth for target IDs, Bun targets,
  archive names, executable names, SHA-256 files, and release manifests.
- Every target must produce a one-executable archive, adjacent `.sha256`, an
  entry in `checksums.txt`, and a native install smoke running `akua --version`,
  `akua --help`, and `akua commands --limit 1`.
- Keep the tested matrix aligned across the script and workflows: macOS
  arm64/x64, glibc Linux arm64/x64, and Windows x64. Use baseline Bun targets
  for Linux and Windows x64.
- Release assets are immutable. Never add clobber/force upload behavior; the tap
  handoff runs only after published assets are downloaded and re-verified.

## Ownership boundaries

- This CLI repository owns the canonical `akua` executable, release artifacts,
  and `skills/agent-skills-standard-following/SKILL.md` source.
- `akua-dev/skills` owns importing and syncing the source skill.
- `akua-dev/homebrew-tap` owns the `akua` formula, formula tests, and the reviewed
  formula-update PR. CLI automation sends only the verified release manifest
  contract.

## Validation

Run `mise run check` and `mise run generate:check` for every change. Release
changes also require the focused release/workflow tests and a current-host
compiled archive smoke through `mise run release:smoke`.

## Maintaining this file

Keep this file concise and durable. Add only repository-wide rules that are not
obvious from the code, and prefer pointers to authoritative files and commands
over duplicated implementation detail.
