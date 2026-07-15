# Generic HCloud Setup Design

## Goal

Replace the released product-specific provider loader with `akua hcloud setup`,
a local, no-provisioning flow that validates an HCloud account and creates (or
reuses) generic cnap secret and compute-config resources.

## Command and data flow

`akua hcloud setup --workspace <ws_id> --token-file <absolute-path>` accepts no
provider token value, stdin, environment token, base-URL override, or shell
fallback. Protected local Akua auth is read before the hardened descriptor
reader returns a single mutable token buffer. The buffer is used only by
in-process HCloud and cnap transports and is cleared in a `finally` block.

The HCloud preflight uses one attempt per request: `/me`, every paginated
user-resource inventory collection, `/limits`, and the `fsn1`, `CPX32`, and
price catalog inputs. Missing, duplicated, malformed, unexpected, or failed
responses stop before cnap persistence. No preflight operation provisions or
spends.

After preflight, the cnap client lists paginated HCloud secrets and compute
configs. It reuses only one exact matching resource. A missing secret is
created as `cloud_provider/hcloud` with a deterministic per-workspace
idempotency key, then its complete version list is inspected to retain exactly
version 1's ID. A missing config is created with `credential_scope` set to
`byom`, the exact secret ID, and that exact version ID. Both resources use the
same stable setup names and deterministic resource-specific idempotency keys.

## Failure handling

No uncertain transport outcome is retried or compensated. A definite downstream
client rejection after a newly confirmed secret create causes best-effort delete
of only that invocation-owned secret, guarded by its returned ETag. A newly
confirmed config is similarly deleted before its invocation-owned secret. The
flow never changes or deletes a pre-existing or reused resource.

## Testing

Synthetic transports exercise HCloud pagination, invalid token, unexpected
inventory, quota/catalog/price rejection, no retry after an uncertain outcome,
exact version continuity, reuse, successful generic setup, and compensation
ownership. Source-level tests ensure the removed route and product naming do
not remain in CLI source, tests, or architecture documentation.
