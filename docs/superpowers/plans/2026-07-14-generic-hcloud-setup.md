# Generic HCloud Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the removed provider-loader with a secret-safe generic HCloud setup command.

**Architecture:** A command owns protected local inputs and delegates to an in-process HCloud preflight plus a generic cnap resource client. Both transports are injected in tests; production uses fixed HTTPS URLs and never retries an uncertain request.

**Tech Stack:** Bun, TypeScript, Bun test, cnap public OpenAPI endpoints.

## Global Constraints

- The only hand-written public command is `akua hcloud setup --workspace <ws_id> --token-file <absolute-path>`.
- Provider bytes are read only by `readSecureTokenFile`, never logged or passed to children, and cleared after use.
- Persistence uses only `/v1/secrets` and `/v1/compute_configs`, each with deterministic idempotency keys.
- Preflight never creates provider resources; uncertain outcomes are not retried or compensated.

---

### Task 1: Replace product-specific routing and documentation

**Files:**
- Delete: the released product-specific command, transport, and test files
- Modify: `src/bin/akua.ts`, `test/cli.test.ts`, `docs/architecture.md`

- [ ] Write a failing help/routing test for `akua hcloud setup` and absence of the removed command.
- [ ] Run `bun test test/cli.test.ts` and confirm the new assertion fails.
- [ ] Route the new command and replace documentation with its generic contract.
- [ ] Run `bun test test/cli.test.ts` and confirm it passes.

### Task 2: Add HCloud preflight and generic cnap setup tests

**Files:**
- Create: `test/hcloud-setup.test.ts`
- Create: `src/commands/hcloud.ts`, `src/runtime/hcloud-setup.ts`

- [ ] Write synthetic transport tests for pagination, invalid auth, inventory, quota/catalog/price rejection, no uncertain retry, version continuity, reuse, success, and ownership-safe compensation.
- [ ] Run `bun test test/hcloud-setup.test.ts` and confirm it fails because the command is absent.
- [ ] Implement the smallest injected transport interfaces and fixed-route production clients that satisfy the tests.
- [ ] Run `bun test test/hcloud-setup.test.ts` and confirm it passes.

### Task 3: Verify generated and release surfaces

**Files:**
- Modify: `docs/architecture.md`, `AGENTS.md` only if durable repository guidance changes

- [ ] Confirm no product-specific route or naming remains in source, tests, or docs.
- [ ] Run `mise run check`, `mise run generate:check`, focused release/workflow tests, and `mise run release:smoke`.
- [ ] Commit the implementation, integrate current `origin/main`, and re-run the same verification.
