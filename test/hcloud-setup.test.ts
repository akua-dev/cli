import { describe, expect, test } from "bun:test";

import { hcloudView, type HcloudCommandDependencies } from "../src/commands/hcloud";
import {
  HcloudSetupError,
  setupHcloud,
  type HcloudSetupDependencies,
  type SetupRequest,
} from "../src/runtime/hcloud-setup";
import { renderError } from "../src/runtime/render";

const TOKEN = new Uint8Array([115, 121, 110, 116, 104, 101, 116, 105, 99]);
const WORKSPACE = "ws_synthetic";

describe("generic HCloud setup", () => {
  test("paginates every inventory collection before creating generic resources", async () => {
    const fixture = makeFixture({ inventoryPages: 2 });

    await setupHcloud(input(), fixture.dependencies);

    for (const collection of fixture.inventoryCollections.filter((collection) => collection !== "images")) {
      expect(fixture.hcloudRequests.filter((request) => request.path === `/${collection}`)).toHaveLength(2);
    }
    expect(fixture.hcloudRequests.filter((request) => request.path === "/images")).toHaveLength(4);
    expect(fixture.cnapRequests.map((request) => request.path)).toContain("/v1/secrets");
    expect(fixture.cnapRequests.map((request) => request.path)).toContain("/v1/compute_configs");
  });

  test("rejects an invalid token before persistence", async () => {
    const fixture = makeFixture({ meStatus: 401 });

    await expect(setupHcloud(input(), fixture.dependencies)).rejects.toMatchObject({ code: "AKUA_HCLOUD_AUTH_REJECTED" });
    expect(fixture.cnapRequests).toHaveLength(0);
  });

  test("fails closed on unexpected inventory", async () => {
    const fixture = makeFixture({ inventory: { servers: [{ id: 1 }] } });

    await expect(setupHcloud(input(), fixture.dependencies)).rejects.toMatchObject({ code: "AKUA_HCLOUD_INVENTORY_NOT_EMPTY" });
    expect(fixture.cnapRequests).toHaveLength(0);
  });

  test("fails closed on unusable quota, catalog, or price", async () => {
    for (const failure of ["quota", "catalog", "price"] as const) {
      const fixture = makeFixture({ failure });
      await expect(setupHcloud(input(), fixture.dependencies)).rejects.toMatchObject({ code: "AKUA_HCLOUD_PREFLIGHT_REJECTED" });
      expect(fixture.cnapRequests).toHaveLength(0);
    }
  });

  test("does not retry an ambiguous HCloud transport outcome", async () => {
    const fixture = makeFixture({ throwHcloudPath: "/me" });

    await expect(setupHcloud(input(), fixture.dependencies)).rejects.toMatchObject({ code: "AKUA_HCLOUD_OUTCOME_UNKNOWN" });
    expect(fixture.hcloudRequests.filter((request) => request.path === "/me")).toHaveLength(1);
    expect(fixture.cnapRequests).toHaveLength(0);
  });

  test("keeps provider bytes out of request metadata and rendered failures", async () => {
    const marker = "hcloud-token-must-not-render";
    const fixture = makeFixture({ throwHcloudPath: "/me" });
    const error = await captureError(() => setupHcloud({ ...input(), providerToken: new TextEncoder().encode(marker) }, fixture.dependencies));

    expect(JSON.stringify(fixture.hcloudRequests)).not.toContain(marker);
    expect(renderError(error, "json")).not.toContain(marker);
  });

  test("reuses exact existing generic resources without mutation", async () => {
    const fixture = makeFixture({ existing: true });

    const result = await setupHcloud(input(), fixture.dependencies);

    expect(result).toEqual({ secret_id: "sec_existing", secret_version_id: "secver_initial", compute_config_id: "cfg_existing" });
    expect(fixture.cnapRequests.filter((request) => request.method !== "GET")).toHaveLength(0);
  });

  test("creates the compute config with the exact initial secret version", async () => {
    const fixture = makeFixture();

    const result = await setupHcloud(input(), fixture.dependencies);
    const createConfig = fixture.cnapRequests.find((request) => request.method === "POST" && request.path === "/v1/compute_configs");

    expect(result).toEqual({ secret_id: "sec_created", secret_version_id: "secver_initial", compute_config_id: "cfg_created" });
    expect(createConfig?.body).toMatchObject({
      credential_scope: { kind: "byom", secret_id: "sec_created", secret_version_id: "secver_initial" },
    });
  });

  test("compensates only invocation-owned state after a definite downstream rejection", async () => {
    const fixture = makeFixture({ configStatus: 400 });

    await expect(setupHcloud(input(), fixture.dependencies)).rejects.toMatchObject({ code: "AKUA_CNAP_REJECTED" });
    expect(fixture.cnapRequests.filter((request) => request.method === "DELETE").map((request) => request.path)).toEqual(["/v1/secrets/sec_created"]);

    const reused = makeFixture({ existing: true, configStatus: 400 });
    await expect(setupHcloud(input(), reused.dependencies)).resolves.toBeDefined();
    expect(reused.cnapRequests.filter((request) => request.method === "DELETE")).toHaveLength(0);
  });

  test("does not compensate after an ambiguous cnap outcome", async () => {
    const fixture = makeFixture({ throwCnapPath: "/v1/compute_configs" });

    await expect(setupHcloud(input(), fixture.dependencies)).rejects.toMatchObject({ code: "AKUA_CNAP_OUTCOME_UNKNOWN" });
    expect(fixture.cnapRequests.filter((request) => request.method === "DELETE")).toHaveLength(0);
  });

  test("uses the descriptor reader, protected caller auth, and fixed-safe errors", async () => {
    let cleared = false;
    const fixture = makeFixture();
    const dependencies: HcloudCommandDependencies = {
      readProtectedCallerToken: async () => "caller-auth-fixture",
      readSecureTokenFile: async () => TOKEN,
      setup: async (value) => {
        expect(value.providerToken).toBe(TOKEN);
        return setupHcloud(value, fixture.dependencies);
      },
      clearBytes: (bytes) => {
        cleared = bytes === TOKEN;
        bytes.fill(0);
      },
      createIdempotencyKey: (scope) => `stable-${scope}`,
    };

    const result = await hcloudView(["setup", "--workspace", WORKSPACE, "--token-file", "/synthetic/token"], {}, dependencies);

    expect(result.command).toBe("akua hcloud setup");
    expect(cleared).toBe(true);
    expect(Array.from(TOKEN)).toEqual(Array(TOKEN.byteLength).fill(0));
  });
});

function input() {
  return { workspace: WORKSPACE, callerToken: "caller-auth-fixture", providerToken: TOKEN.slice(), idempotencyKey: "stable-setup" };
}

function makeFixture(options: {
  inventoryPages?: number;
  inventory?: Record<string, unknown[]>;
  meStatus?: number;
  failure?: "quota" | "catalog" | "price";
  throwHcloudPath?: string;
  throwCnapPath?: string;
  existing?: boolean;
  configStatus?: number;
} = {}) {
  const hcloudRequests: SetupRequest[] = [];
  const cnapRequests: SetupRequest[] = [];
  const inventoryCollections = ["servers", "volumes", "primary_ips", "floating_ips", "load_balancers", "networks", "firewalls", "placement_groups", "ssh_keys", "certificates", "images"];
  const dependencies: HcloudSetupDependencies = {
    sendHcloud: async (request) => {
      hcloudRequests.push(request);
      if (request.path === options.throwHcloudPath) throw new Error("synthetic transport");
      if (request.path === "/me") return { status: options.meStatus ?? 200, body: { customer: { id: 1 } } };
      const collection = request.path.slice(1);
      if (inventoryCollections.includes(collection)) {
        const page = Number(request.query?.page ?? "1");
        const last = options.inventoryPages ?? 1;
        return { status: 200, body: { [collection]: options.inventory?.[collection] ?? [], meta: { pagination: { page, last_page: last, next_page: page < last ? page + 1 : null } } } };
      }
      if (request.path === "/limits") return { status: 200, body: options.failure === "quota" ? { limits: [] } : { limits: [{ name: "server", limit: 2, used: 0 }] } };
      if (request.path === "/locations") return { status: 200, body: options.failure === "catalog" ? { locations: [] } : { locations: [{ name: "fsn1", status: "online" }] } };
      if (request.path === "/server_types") return { status: 200, body: options.failure === "catalog" ? { server_types: [] } : { server_types: [{ name: "cpx32", locations: [{ name: "fsn1" }] }] } };
      if (request.path === "/pricing") {
        return options.failure === "price"
          ? { status: 200, body: { pricing: { currency: "EUR", prices: [] } } }
          : { status: 200, body: { pricing: { currency: "EUR", prices: [{ location: "fsn1", price: { gross: { amount: "10.00" } } }] } } };
      }
      throw new Error(`unexpected HCloud request ${request.path}`);
    },
    sendCnap: async (request) => {
      cnapRequests.push(request);
      if (request.path === options.throwCnapPath) throw new Error("synthetic transport");
      if (request.method === "GET" && request.path === "/v1/secrets") return { status: 200, body: page(options.existing ? [secret()] : []) };
      if (request.method === "GET" && request.path === "/v1/secrets/sec_created/versions") return { status: 200, body: page([version("sec_created")]) };
      if (request.method === "GET" && request.path === "/v1/secrets/sec_existing/versions") return { status: 200, body: page([version("sec_existing")]) };
      if (request.method === "GET" && request.path === "/v1/compute_configs") return { status: 200, body: page(options.existing ? [config()] : []) };
      if (request.method === "POST" && request.path === "/v1/secrets") return { status: 201, body: secret("sec_created") };
      if (request.method === "POST" && request.path === "/v1/compute_configs") return { status: options.configStatus ?? 201, body: options.configStatus ? { error: { request_id: "req_rejected" } } : config("cfg_created", "sec_created") };
      if (request.method === "DELETE") return { status: 200, body: {} };
      throw new Error(`unexpected cnap request ${request.path}`);
    },
  };
  return { dependencies, hcloudRequests, cnapRequests, inventoryCollections };
}

function page(data: unknown[]) { return { data, has_more: false, next_cursor: null }; }
function secret(id = "sec_existing") { return { id, name: "hcloud", kind: "cloud_provider/hcloud", state: "active", etag: "secret-etag" }; }
function version(secretId: string) { return { id: "secver_initial", secret_id: secretId, version_number: 1, state: "enabled" }; }
function config(id = "cfg_existing", secretId = "sec_existing") { return { id, name: "hcloud-fsn1-cpx32", provider: "hcloud", provider_config: { region: "fsn1", image: "ubuntu-24.04", machine_type_filter: "CPX32" }, credential_scope: { kind: "byom", secret_id: secretId, secret_version_id: "secver_initial" }, etag: "config-etag" }; }

async function captureError(action: () => Promise<unknown>): Promise<HcloudSetupError> {
  try { await action(); } catch (error) { return error as HcloudSetupError; }
  throw new Error("Expected setup to fail.");
}
