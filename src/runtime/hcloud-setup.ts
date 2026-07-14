import { AkuaCliError } from "./errors";

const HCloudBaseUrl = "https://api.hetzner.cloud/v1";
const CnapBaseUrl = "https://api.akua.dev";
const SECRET_NAME = "hcloud";
const CONFIG_NAME = "hcloud-fsn1-cpx32";
const INITIAL_VERSION = 1;
const MAX_PAGES = 1000;

const inventoryRequests = [
  { collection: "servers", query: {} },
  { collection: "volumes", query: {} },
  { collection: "primary_ips", query: {} },
  { collection: "floating_ips", query: {} },
  { collection: "load_balancers", query: {} },
  { collection: "networks", query: {} },
  { collection: "firewalls", query: {} },
  { collection: "placement_groups", query: {} },
  { collection: "ssh_keys", query: {} },
  { collection: "certificates", query: {} },
  { collection: "images", query: { type: "snapshot" } },
  { collection: "images", query: { type: "backup" } },
] as const;

export interface SetupRequest {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Readonly<Record<string, string>>;
  headers?: Readonly<Record<string, string>>;
  body?: unknown;
}

interface SetupResponse {
  status: number;
  body: unknown;
}

export interface HcloudSetupDependencies {
  sendHcloud(request: SetupRequest, providerToken: Uint8Array): Promise<SetupResponse>;
  sendCnap(request: SetupRequest): Promise<SetupResponse>;
}

export interface HcloudSetupInput {
  workspace: string;
  callerToken: string;
  providerToken: Uint8Array;
  idempotencyKey: string;
}

export interface HcloudSetupResult {
  secret_id: string;
  secret_version_id: string;
  compute_config_id: string;
}

export class HcloudSetupError extends AkuaCliError {}

const productionDependencies: HcloudSetupDependencies = {
  sendHcloud: async (request, providerToken) => sendJson(HCloudBaseUrl, request, providerAuthorization(providerToken)),
  sendCnap: async (request) => sendJson(CnapBaseUrl, request),
};

export async function setupHcloud(
  input: HcloudSetupInput,
  dependencies: HcloudSetupDependencies = productionDependencies,
): Promise<HcloudSetupResult> {
  await validateHcloud(input.providerToken, dependencies);

  const cnap = cnapClient(input, dependencies);
  let secret: SecretReference;
  let secretOwned = false;
  try {
    const existingSecrets = await listAll(cnap, "/v1/secrets", { kind: "cloud_provider/hcloud", limit: "100" });
    const matchingSecrets = existingSecrets.filter(isMatchingSecret);
    if (matchingSecrets.length > 1) {
      throw rejected("The generic HCloud secret is ambiguous.");
    }
    if (matchingSecrets.length === 1) {
      secret = await resolveInitialVersion(matchingSecrets[0] as Record<string, unknown>, cnap);
    } else {
      const created = await createSecret(cnap, input.providerToken);
      secretOwned = true;
      secret = await resolveInitialVersion(created, cnap);
    }
  } catch (error) {
    throw normalizeCnapError(error);
  }

  try {
    const configs = await listAll(cnap, "/v1/compute_configs", { view: "full", limit: "100" });
    const namedConfigs = configs.filter((value) => isRecord(value) && value.name === CONFIG_NAME);
    if (namedConfigs.length > 1) {
      throw rejected("The generic HCloud compute config is ambiguous.");
    }
    if (namedConfigs.length === 1) {
      const config = namedConfigs[0] as Record<string, unknown>;
      if (!isMatchingConfig(config, secret)) {
        throw rejected("The existing HCloud compute config does not match this setup.");
      }
      return result(secret, requiredString(config, "id"));
    }

    const created = await createConfig(cnap, secret);
    return result(secret, requiredString(created, "id"));
  } catch (error) {
    const normalized = normalizeCnapError(error);
    if (secretOwned && normalized.code !== "AKUA_CNAP_OUTCOME_UNKNOWN") {
      await deleteOwned(cnap, secret).catch(() => undefined);
    }
    throw normalized;
  }
}

async function validateHcloud(providerToken: Uint8Array, dependencies: HcloudSetupDependencies): Promise<void> {
  try {
    const me = await dependencies.sendHcloud({ method: "GET", path: "/me" }, providerToken);
    if (me.status === 401 || me.status === 403) {
      throw new HcloudSetupError({ type: "authentication_error", code: "AKUA_HCLOUD_AUTH_REJECTED", message: "HCloud rejected the provider credential.", exitCode: 3 });
    }
    requireHcloudSuccess(me);
    if (!isRecord(me.body) || !isRecord(me.body.customer)) {
      throw preflightRejected();
    }
    for (const request of inventoryRequests) {
      await requireEmptyInventory(request.collection, request.query, providerToken, dependencies);
    }
    await requireQuota(providerToken, dependencies);
    await requireCatalogAndPrice(providerToken, dependencies);
  } catch (error) {
    if (error instanceof HcloudSetupError) {
      throw error;
    }
    throw new HcloudSetupError({ type: "transport_error", code: "AKUA_HCLOUD_OUTCOME_UNKNOWN", message: "The HCloud preflight outcome is unknown and was not retried.", exitCode: 1 });
  }
}

async function requireEmptyInventory(
  collection: string,
  query: Readonly<Record<string, string>>,
  providerToken: Uint8Array,
  dependencies: HcloudSetupDependencies,
): Promise<void> {
  let page = 1;
  for (let count = 0; count < MAX_PAGES; count += 1) {
    const response = await dependencies.sendHcloud({ method: "GET", path: `/${collection}`, query: { ...query, page: String(page), per_page: "50" } }, providerToken);
    requireHcloudSuccess(response);
    if (!isRecord(response.body) || !Array.isArray(response.body[collection])) {
      throw preflightRejected();
    }
    if (response.body[collection].length > 0) {
      throw new HcloudSetupError({ type: "validation_error", code: "AKUA_HCLOUD_INVENTORY_NOT_EMPTY", message: "HCloud inventory must be empty before setup.", exitCode: 2 });
    }
    const next = nextPage(response.body, page);
    if (next === null) return;
    page = next;
  }
  throw preflightRejected();
}

async function requireQuota(providerToken: Uint8Array, dependencies: HcloudSetupDependencies): Promise<void> {
  const response = await dependencies.sendHcloud({ method: "GET", path: "/limits" }, providerToken);
  requireHcloudSuccess(response);
  const limits = isRecord(response.body) ? response.body.limits : undefined;
  if (!Array.isArray(limits)) throw preflightRejected();
  const servers = limits.filter((value) => isRecord(value) && value.name === "server");
  if (servers.length !== 1 || !isRecord(servers[0]) || !hasCapacity(servers[0])) throw preflightRejected();
}

async function requireCatalogAndPrice(providerToken: Uint8Array, dependencies: HcloudSetupDependencies): Promise<void> {
  const [locations, serverTypes, pricing] = await Promise.all([
    dependencies.sendHcloud({ method: "GET", path: "/locations", query: { name: "fsn1" } }, providerToken),
    dependencies.sendHcloud({ method: "GET", path: "/server_types", query: { name: "CPX32" } }, providerToken),
    dependencies.sendHcloud({ method: "GET", path: "/pricing" }, providerToken),
  ]);
  requireHcloudSuccess(locations);
  requireHcloudSuccess(serverTypes);
  requireHcloudSuccess(pricing);
  if (!hasSingleLocation(locations.body) || !hasFsn1Cpx32(serverTypes.body) || !hasFsn1Price(pricing.body)) throw preflightRejected();
}

function cnapClient(input: HcloudSetupInput, dependencies: HcloudSetupDependencies) {
  const headers = { authorization: `Bearer ${input.callerToken}`, "akua-context": input.workspace };
  return {
    list: async (path: string, query: Readonly<Record<string, string>>) => dependencies.sendCnap({ method: "GET", path, query, headers }),
    create: async (path: string, body: unknown, scope: string) => dependencies.sendCnap({ method: "POST", path, headers: { ...headers, "idempotency-key": `${input.idempotencyKey}-${scope}`, "content-type": "application/json" }, body }),
    delete: async (path: string, etag: string, scope: string) => dependencies.sendCnap({ method: "DELETE", path, headers: { ...headers, "if-match": etag, "idempotency-key": `${input.idempotencyKey}-${scope}` } }),
  };
}

type CnapClient = ReturnType<typeof cnapClient>;

async function listAll(client: CnapClient, path: string, initialQuery: Readonly<Record<string, string>>): Promise<unknown[]> {
  const results: unknown[] = [];
  let cursor: string | undefined;
  for (let count = 0; count < MAX_PAGES; count += 1) {
    const response = await client.list(path, cursor === undefined ? initialQuery : { ...initialQuery, cursor });
    requireCnapStatus(response, 200);
    if (!isRecord(response.body) || !Array.isArray(response.body.data) || typeof response.body.has_more !== "boolean" || (response.body.next_cursor !== null && typeof response.body.next_cursor !== "string")) {
      throw rejected("cnap returned an incomplete paginated response.");
    }
    results.push(...response.body.data);
    if (!response.body.has_more) {
      if (response.body.next_cursor !== null) throw rejected("cnap returned an ambiguous paginated response.");
      return results;
    }
    if (typeof response.body.next_cursor !== "string" || response.body.next_cursor === "") throw rejected("cnap returned an incomplete paginated response.");
    cursor = response.body.next_cursor;
  }
  throw rejected("cnap pagination exceeded its safety bound.");
}

async function createSecret(client: CnapClient, providerToken: Uint8Array): Promise<Record<string, unknown>> {
  const response = await client.create("/v1/secrets", { name: SECRET_NAME, kind: "cloud_provider/hcloud", value: new TextDecoder().decode(providerToken) }, "secret");
  requireCnapStatus(response, 201);
  if (!isRecord(response.body) || !isMatchingSecret(response.body)) throw rejected("cnap returned an invalid HCloud secret.");
  return response.body;
}

async function resolveInitialVersion(secret: Record<string, unknown>, client: CnapClient): Promise<SecretReference> {
  const id = requiredString(secret, "id");
  const versions = await listAll(client, `/v1/secrets/${encodeURIComponent(id)}/versions`, { limit: "100" });
  const initial = versions.filter((value) => isRecord(value) && value.secret_id === id && value.version_number === INITIAL_VERSION && value.state === "enabled");
  if (initial.length !== 1 || !isRecord(initial[0])) throw rejected("The HCloud secret has no unambiguous initial version.");
  return { id, versionId: requiredString(initial[0], "id"), etag: requiredString(secret, "etag") };
}

async function createConfig(client: CnapClient, secret: SecretReference): Promise<Record<string, unknown>> {
  const response = await client.create("/v1/compute_configs", {
    name: CONFIG_NAME,
    provider: "hcloud",
    provider_config: { region: "fsn1", image: "ubuntu-24.04", machine_type_filter: "CPX32" },
    credential_scope: { kind: "byom", secret_id: secret.id, secret_version_id: secret.versionId },
  }, "compute-config");
  requireCnapStatus(response, 201);
  if (!isRecord(response.body) || !isMatchingConfig(response.body, secret)) throw rejected("cnap returned an invalid HCloud compute config.");
  return response.body;
}

async function deleteOwned(client: CnapClient, secret: SecretReference): Promise<void> {
  const response = await client.delete(`/v1/secrets/${encodeURIComponent(secret.id)}`, secret.etag, "compensate-secret");
  requireCnapStatus(response, 200);
}

function requireHcloudSuccess(response: SetupResponse): void {
  if (response.status < 200 || response.status >= 300) throw preflightRejected();
}

function requireCnapStatus(response: SetupResponse, expected: number): void {
  if (response.status === expected) return;
  if (response.status >= 500) throw outcomeUnknown();
  throw rejected("cnap rejected the generic HCloud setup request.", response.status);
}

function nextPage(body: Record<string, unknown>, requested: number): number | null {
  const pagination = isRecord(body.meta) && isRecord(body.meta.pagination) ? body.meta.pagination : undefined;
  const lastPage = pagination?.last_page;
  const nextPage = pagination?.next_page;
  if (!pagination || pagination.page !== requested || typeof lastPage !== "number" || !Number.isInteger(lastPage) || (nextPage !== null && (typeof nextPage !== "number" || !Number.isInteger(nextPage)))) throw preflightRejected();
  if (lastPage < requested) throw preflightRejected();
  if (requested === lastPage) return nextPage === null ? null : failPreflight();
  return nextPage === requested + 1 ? nextPage : failPreflight();
}

function hasCapacity(limit: Record<string, unknown>): boolean {
  return typeof limit.limit === "number" && Number.isFinite(limit.limit) && typeof limit.used === "number" && Number.isFinite(limit.used) && limit.limit > limit.used;
}

function hasSingleLocation(body: unknown): boolean {
  if (!isRecord(body) || !Array.isArray(body.locations) || body.locations.length !== 1 || !isRecord(body.locations[0])) return false;
  const location = body.locations[0];
  return location.name === "fsn1" && (location.status === "online" || location.status === "running");
}

function hasFsn1Cpx32(body: unknown): boolean {
  if (!isRecord(body) || !Array.isArray(body.server_types) || body.server_types.length !== 1 || !isRecord(body.server_types[0])) return false;
  const serverType = body.server_types[0];
  return typeof serverType.name === "string" && serverType.name.toLowerCase() === "cpx32" && Array.isArray(serverType.locations) && serverType.locations.some((location) => location === "fsn1" || (isRecord(location) && location.name === "fsn1"));
}

function hasFsn1Price(body: unknown): boolean {
  if (!isRecord(body) || !isRecord(body.pricing) || body.pricing.currency !== "EUR" || !Array.isArray(body.pricing.prices)) return false;
  return body.pricing.prices.some((entry) => isRecord(entry) && typeof entry.location === "string" && entry.location.startsWith("fsn1") && isRecord(entry.price) && isRecord(entry.price.gross) && typeof entry.price.gross.amount === "string" && Number.isFinite(Number(entry.price.gross.amount)) && Number(entry.price.gross.amount) > 0);
}

function isMatchingSecret(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.name === SECRET_NAME && value.kind === "cloud_provider/hcloud" && value.state === "active" && typeof value.id === "string" && typeof value.etag === "string";
}

function isMatchingConfig(value: Record<string, unknown>, secret: SecretReference): boolean {
  const config = isRecord(value.provider_config) ? value.provider_config : undefined;
  const credential = isRecord(value.credential_scope) ? value.credential_scope : undefined;
  return value.name === CONFIG_NAME && value.provider === "hcloud" && isRecord(config) && config.region === "fsn1" && config.image === "ubuntu-24.04" && config.machine_type_filter === "CPX32" && isRecord(credential) && credential.kind === "byom" && credential.secret_id === secret.id && credential.secret_version_id === secret.versionId && typeof value.id === "string";
}

interface SecretReference { id: string; versionId: string; etag: string; }

function result(secret: SecretReference, computeConfigId: string): HcloudSetupResult {
  return { secret_id: secret.id, secret_version_id: secret.versionId, compute_config_id: computeConfigId };
}

function requiredString(value: Record<string, unknown>, field: string): string {
  if (typeof value[field] !== "string" || value[field] === "") throw rejected("cnap returned an incomplete resource.");
  return value[field];
}

function rejected(message: string, status?: number): HcloudSetupError {
  return new HcloudSetupError({ type: "api_error", code: "AKUA_CNAP_REJECTED", message, status, exitCode: status === 401 || status === 403 ? 3 : 1 });
}

function preflightRejected(): HcloudSetupError {
  return new HcloudSetupError({ type: "validation_error", code: "AKUA_HCLOUD_PREFLIGHT_REJECTED", message: "HCloud preflight did not produce a complete safe result.", exitCode: 2 });
}

function failPreflight(): never { throw preflightRejected(); }

function outcomeUnknown(): HcloudSetupError {
  return new HcloudSetupError({ type: "transport_error", code: "AKUA_CNAP_OUTCOME_UNKNOWN", message: "The cnap setup outcome is unknown and was not retried.", exitCode: 1 });
}

function normalizeCnapError(error: unknown): HcloudSetupError {
  if (error instanceof HcloudSetupError) return error;
  return outcomeUnknown();
}

function providerAuthorization(providerToken: Uint8Array): string {
  return `Bearer ${new TextDecoder().decode(providerToken)}`;
}

async function sendJson(baseUrl: string, request: SetupRequest, authorization?: string): Promise<SetupResponse> {
  const url = new URL(request.path, baseUrl);
  for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, value);
  const response = await fetch(url, { method: request.method, headers: { ...(authorization === undefined ? {} : { authorization }), ...request.headers }, ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) });
  const text = await response.text();
  if (text.length > 16_384) throw new Error("response too large");
  return { status: response.status, body: text === "" ? {} : JSON.parse(text) };
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
