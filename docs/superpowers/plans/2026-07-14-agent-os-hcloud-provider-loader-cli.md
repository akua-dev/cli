# Agent OS HCloud Provider Loader CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the one compiled `akua agent-os load-hcloud-provider` command that reads one protected local provider file once and relays it with a workspace-bound issuer attestation and optional predeclared anchor fingerprint to the dedicated cnap transaction without exposing or retaining token contents.

**Architecture:** A command parser validates only the two required flags and obtains normal caller authentication from protected local config. A Unix descriptor reader performs the file security checks and returns a single mutable byte buffer. A fixed-route HTTPS client builds the request in-process, sends precisely once with an idempotency key, clears the buffer, and projects the response through a fixed non-secret allowlist. The cnap server remains the owner of validation, persistence, inventory, rollback, and revocation.

**Tech Stack:** Bun 1.3, TypeScript, Node-compatible `fs` descriptor APIs, Bun test, built-in `fetch` HTTPS transport, synthetic fixtures only.

## Global Constraints

- The only added non-generated command is `akua agent-os load-hcloud-provider --workspace <exact-name-or-ws_id> --token-file <absolute-path> --project-identity-attestation <issuer-attestation> [--project-anchor-ssh-key-fingerprint <provider-returned-SHA256-fingerprint>]`.
- Held production request contract: `POST https://api.akua.dev/v1/agent_os/hcloud_provider_loads`, `Authorization` from protected config only, `Akua-Context: <workspace>`, generated `Idempotency-Key`, and JSON body with `provider_token`, verbatim non-secret `project_identity_attestation`, and optional predeclared `project_anchor_ssh_key_fingerprint`. cnap must verify the attestation binds the exact workspace and one-shot request; no-anchor requires fully empty inventory. Never derive either identity input from the token; do not add a project-anchor name unless cnap #540's released contract requires it. Preserve allowlisted `secret_version_id` and `transaction_id` for pre-spend continuity checks.
- No provider secret may enter argv, stdin, environment, profile, browser, shell child, curl, config, cache, log, stdout, stderr, error message, crash report, or test report.
- Reject `AKUA_API_TOKEN` and all provider-token/environment/API-base override inputs for this command; do not retry a request after a transport outcome is uncertain.
- The reader must require absolute, own-UID regular `0600` files, use `O_NOFOLLOW | O_CLOEXEC`, compare `lstat` and `fstat` dev/inode/uid/mode, read one bounded descriptor once, and close before networking.
- Clear every mutable token/request byte buffer in `finally`; no JavaScript runtime can prove physical heap zeroisation.
- Output may contain only the allowlisted server result or a fixed failure code, status, request ID, and opaque resource IDs.
- [cnap #540](https://github.com/akua-dev/cnap/issues/540) is a hard merge and Phase-A dependency. Do not open a CLI PR, publish, tag, deploy, merge, or create a release until its HCloud project-identity security gate resolves and its released route contract exactly matches this client. Coordinate the first CLI-owned release as `0.9.0`, separate from PR #21's distribution scope.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/runtime/secure-token-file.ts` | Secure Unix metadata/open/read/close primitive and buffer clear helper. |
| `src/runtime/platform-client.ts` | Fixed-route, one-attempt HTTPS request and allowlisted response projection. |
| `src/commands/agent-os.ts` | Flag parser, auth ordering, request orchestration, and safe command envelope. |
| `src/commands/auth.ts` | Expose a protected-config-only caller credential reader without changing auth command precedence. |
| `src/bin/akua.ts` | Route and help entry for the single command. |
| `test/secure-token-file.test.ts` | Synthetic descriptor, mode, owner, one-read, and swap tests. |
| `test/agent-os-loader.test.ts` | Fake HTTPS transport, no-retention, ordering, idempotency, allowlist, revocation, and no-retry tests. |
| `test/cli.test.ts` | Entrypoint routing and public help regression coverage. |
| `docs/architecture.md` | CLI ownership, endpoint, release handoff, and security boundary. |

### Task 1: Secure descriptor reader

**Files:** Create `src/runtime/secure-token-file.ts`; create `test/secure-token-file.test.ts`.

**Interfaces:** Produce `readSecureTokenFile(path, dependencies?): Promise<Uint8Array>` and `clearBytes(bytes): void`. Dependencies expose `lstat`, `open`, `fstat`, and one descriptor `read` only to make substitution/read-count tests deterministic.

- [x] **Step 1: Write failing secure-reader tests** for a synthetic `0600` regular file, rejected relative/symlink/directory/FIFO/device/wrong-owner/wrong-mode/empty/oversize files, exactly one descriptor read, close-before-return, and a hook that swaps a path between `lstat` and `open`.
- [x] **Step 2: Run `bun test test/secure-token-file.test.ts`** and confirm failures name the missing module/functions rather than fixture setup.
- [x] **Step 3: Implement the minimal reader** with absolute-path validation; `lstat`; numeric `O_RDONLY | O_NOFOLLOW | O_CLOEXEC`; `fstat` identity/mode/UID checks; exactly one bounded `read`; `finally` close; and fixed `AkuaCliError` codes/messages that never interpolate the supplied path.
- [x] **Step 4: Re-run `bun test test/secure-token-file.test.ts`** and confirm all focused cases pass.
- [x] **Step 5: Commit the reader and its tests** with a focused conventional commit.

### Task 2: Fixed transport and response projection

**Files:** Create `src/runtime/platform-client.ts`; create `test/agent-os-loader.test.ts`.

**Interfaces:** Produce `submitHcloudProviderLoad({ workspace, callerToken, providerToken, idempotencyKey }, dependencies?): Promise<LoaderResult>`. The request is one POST to the fixed route; dependency injection may replace transport for a local fake HTTPS server, never expose a CLI option.

- [x] **Step 1: Write failing transport tests** using synthetic sentinels and a fake HTTPS server/transport: fixed method/path/headers/body shape, one submission, idempotency-key relay, response field allowlist, server fixed-error projection, no retry after a thrown/ambiguous submission, and byte clearing after both success and failure.
- [x] **Step 2: Run `bun test test/agent-os-loader.test.ts`** and confirm the expected module/function failures.
- [x] **Step 3: Implement the minimal client** with a fixed HTTPS URL, manual byte-oriented JSON quoting, one `fetch` invocation, no debug/body logging, `finally` buffer overwrites, and strict success/failure schema projection that discards unknown server fields.
- [x] **Step 4: Re-run `bun test test/agent-os-loader.test.ts`** and confirm the focused transport suite passes.
- [x] **Step 5: Commit the transport and focused tests** with a focused conventional commit.

### Task 3: Command, protected auth, and routing

**Files:** Modify `src/commands/auth.ts`, `src/commands/agent-os.ts`, `src/bin/akua.ts`, `test/agent-os-loader.test.ts`, and `test/cli.test.ts`.

**Interfaces:** `agentOsView(argv, env, dependencies?): Promise<RenderEnvelope>` accepts only the exact command flags. `readProtectedCallerToken(env)` returns the locally stored caller token or a fixed auth error and never reads `AKUA_API_TOKEN` for this command.

- [x] **Step 1: Write failing command tests** for required explicit workspace/token file, safe rejection of token/stdin/positionals/env/profile/API URL flags, config-only auth, auth-before-file/network ordering, file-before-network ordering, no child-process calls, stdout/stderr/error sentinel absence, fixed exit codes, success allowlist, and a fake-server revoke then post-revoke failure.
- [x] **Step 2: Run `bun test test/agent-os-loader.test.ts test/cli.test.ts`** and confirm failures are caused by the absent command behavior.
- [x] **Step 3: Implement the minimal orchestration**: parse only the two flags, reject environment auth, read protected config auth before opening the provider file, create one UUID idempotency key, read/close token file, call fixed transport once, and emit only the projected result through the existing renderer.
- [x] **Step 4: Re-run `bun test test/agent-os-loader.test.ts test/cli.test.ts`** and confirm all loader and routing tests pass.
- [x] **Step 5: Commit the command/routing slice** with a focused conventional commit.

### Task 4: Contract documentation and full verification

**Files:** Modify `docs/architecture.md`; this plan; optionally `AGENTS.md` only if the repository lacks durable command/testing guidance.

- [x] **Step 1: Write failing documentation/contract assertions** where practical (route absence from generated registry; command appears in help; no deprecated provider-input path appears in the architecture document).
- [x] **Step 2: Run the focused assertions** and observe the expected red condition before any production behavior they cover.
- [x] **Step 3: Update architecture documentation** with the exact non-secret route, thin-client/server ownership, safe file contract, no-retention constraints, cnap-first release ordering, PR #21 boundary, and `0.9.0` coordination.
- [x] **Step 4: Run `mise run check` and `mise run build:binary`**; inspect the compiled help and the full test output for failures or sentinel leakage.
- [x] **Step 5: Commit remaining documentation and run `git diff --check`, `git status --short`, and the full validation commands** before reporting completion.

## Self-Review

- [x] Coverage: Tasks 1–3 cover every local CLI requirement: exact flags, protected config authentication, one bounded secure read, fixed single HTTPS submission, buffer clear, output projection, ordering, idempotency, no retry, revocation, and synthetic-only security regression tests. Task 4 covers architecture/release boundaries and whole-repo validation.
- [x] Dependency: [cnap #540](https://github.com/akua-dev/cnap/issues/540) is the canonical server task. Its HCloud project-identity security gate and exact released route contract are mandatory before any CLI PR, merge, release, or Phase-A invocation.
- [x] Placeholder scan: no `TODO`, `TBD`, “implement later,” or undefined interface names remain.
- [x] Consistency: `readSecureTokenFile` produces the mutable bytes consumed by `submitHcloudProviderLoad`; `agentOsView` is the only caller and clears/handles failure before rendering.
