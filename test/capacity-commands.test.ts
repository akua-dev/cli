import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { readPublicApiToken } from "../src/commands/auth";
import { capacityView, type CapacityDependencies } from "../src/commands/capacity";
import { PublicApiClient, type ApiFetch } from "../src/runtime/public-api-client";

const TOKEN = "sentinel-public-api-token";
const CLUSTER = "clu_j572abc123def456j572abc123def456";
const WORKSPACE = "ws_j572abc123def456j572abc123def456";
const CONFIG = "j572abc123def456j572abc123def456";

describe("capacity command overlays", () => {
  test("clusters get binds the canonical path and exact workspace header", async () => {
    const fixture = apiFixture({
      id: CLUSTER,
      html_url: `https://akua.dev/clusters/${CLUSTER}`,
      name: "production",
      workspace_id: WORKSPACE,
      state: "active",
      provider: "managed_kaas",
      reconciling: false,
      created_at: 1,
      updated_at: 2,
      etag: "3",
    });
    const result = await capacityView(["clusters", "get", "--id", CLUSTER, "--workspace", WORKSPACE], {}, deps(fixture.fetch));

    expect(result.data).toMatchObject({ id: CLUSTER, workspace_id: WORKSPACE });
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]).toMatchObject({
      url: `https://api.akua.dev/v1/clusters/${CLUSTER}`,
      method: "GET",
      headers: { authorization: `Bearer ${TOKEN}`, "akua-context": WORKSPACE },
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  test("compute config and machine lists force full view and preserve ownership", async () => {
    const configs = apiFixture({
      data: [{ id: CONFIG, name: "hcloud-fsn1", provider: "hcloud", provider_config: { provider: "hcloud", region: "fsn1", image: "ubuntu", machine_type_filter: null }, secret_id: null, created_at: 1 }],
      has_more: false,
      next_cursor: null,
    });
    const configResult = await capacityView(["compute-configs", "list", "--view", "full", "--workspace", WORKSPACE], {}, deps(configs.fetch));
    expect(configResult.data).toMatchObject({ data: [{ id: CONFIG }] });
    expect(configs.requests[0].url).toBe("https://api.akua.dev/v1/compute_configs?view=full");

    const machines = apiFixture({ data: [], has_more: false, next_cursor: null });
    await capacityView(["machines", "list", "--cluster-id", CLUSTER, "--view", "full", "--workspace", WORKSPACE], {}, deps(machines.fetch));
    expect(machines.requests[0].url).toBe(`https://api.akua.dev/v1/machines?cluster_id=${CLUSTER}&view=full`);
  });

  test("instance types bind the explicit config name and return full comparison fields", async () => {
    const fixture = apiFixture([{ name: "cpx31", arch: "amd64", cpu: 4, memory_mib: 8192, storage_mib: 163840, price_per_hour: 0.0208, available: true, zone: "fsn1", capacity_type: "on-demand" }]);
    const configName = "hcloud fsn1/prod";
    const result = await capacityView(["compute", "list-instance-types", "--config", configName], {}, deps(fixture.fetch));
    expect(result.data).toEqual([{ name: "cpx31", arch: "amd64", cpu: 4, memory_mib: 8192, storage_mib: 163840, price_per_hour: 0.0208, available: true, zone: "fsn1", capacity_type: "on-demand" }]);
    expect(fixture.requests[0].url).toBe("https://api.akua.dev/v1/compute/instance_types?config=hcloud%20fsn1%2Fprod");
  });

  test("machine create submits the canonical closed request exactly once", async () => {
    const fixture = apiFixture({ operation_id: "op_create_123" }, 202);
    const result = await capacityView([
      "machines", "create",
      "--cluster-id", CLUSTER,
      "--compute-config-id", CONFIG,
      "--instance-type", "cpx31",
      "--idempotency-key", "captain-stable-key",
      "--workspace", WORKSPACE,
      "--yes",
    ], {}, deps(fixture.fetch));

    expect(result.data).toEqual({ operation_id: "op_create_123", idempotency_key: "captain-stable-key" });
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]).toEqual({
      url: "https://api.akua.dev/v1/machines",
      method: "POST",
      headers: {
        "akua-context": WORKSPACE,
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "idempotency-key": "captain-stable-key",
      },
      body: JSON.stringify({ cluster_id: CLUSTER, compute_config_id: CONFIG, instance_type: "cpx31" }),
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  test("ambiguous machine-create transport outcome is not retried and preserves same-key guidance", async () => {
    let attempts = 0;
    const fetch: ApiFetch = async () => {
      attempts += 1;
      throw new Error(`socket closed with ${TOKEN}`);
    };
    const error = await capacityView([
      "machines", "create",
      "--cluster-id", CLUSTER,
      "--compute-config-id", CONFIG,
      "--instance-type", "cpx31",
      "--idempotency-key", "captain-stable-key",
      "--yes",
    ], {}, deps(fetch)).catch((value) => value);

    expect(attempts).toBe(1);
    expect(error).toMatchObject({
      code: "AKUA_MACHINE_CREATE_OUTCOME_UNKNOWN",
      message: expect.stringContaining("unknown"),
      nextSteps: [{
        command: expect.stringContaining("<same-key>"),
        description: expect.stringContaining("exact caller-supplied idempotency key"),
      }],
    });
    expect(JSON.stringify(error.toPayload())).not.toContain(TOKEN);
  });

  test("invalid IDs, unknown flags, and create without yes fail before auth or fetch", async () => {
    let authCalls = 0;
    let fetchCalls = 0;
    const dependencies: CapacityDependencies = {
      readToken: async () => { authCalls += 1; return TOKEN; },
      fetch: async () => { fetchCalls += 1; throw new Error("must not fetch"); },
    };
    for (const argv of [
      ["clusters", "get", "--id", "clu_j572abc123def456"],
      ["machines", "list", "--cluster-id", CLUSTER, "--bogus"],
      ["machines", "create", "--cluster-id", CLUSTER, "--compute-config-id", CONFIG, "--instance-type", "cpx31", "--idempotency-key", "captain-key"],
    ]) {
      await expect(capacityView(argv, {}, dependencies)).rejects.toMatchObject({ exitCode: 2 });
    }
    expect(authCalls).toBe(0);
    expect(fetchCalls).toBe(0);
  });

  test("public auth prefers the ephemeral environment token over protected config", async () => {
    const home = await mkdtemp(join(process.cwd(), ".tmp-capacity-auth-"));
    try {
      const configDir = join(home, ".config", "akua");
      await mkdir(configDir, { recursive: true, mode: 0o700 });
      await writeFile(join(configDir, "config.json"), JSON.stringify({ token: "stored-token" }), { mode: 0o600 });

      await expect(readPublicApiToken({ HOME: home })).resolves.toBe("stored-token");
      await expect(readPublicApiToken({ HOME: home, AKUA_API_TOKEN: TOKEN })).resolves.toBe(TOKEN);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("transport failures and CLI validation never expose the token sentinel", async () => {
    const failingFetch: ApiFetch = async () => {
      throw new Error(`transport included ${TOKEN}`);
    };
    const error = await capacityView(["clusters", "get", "--id", CLUSTER], {}, deps(failingFetch)).catch((value) => value);
    expect(String(error)).not.toContain(TOKEN);

    const cli = await runAkua(["clusters", "get", "--id", "not-a-cluster", "--json"], {
      AKUA_API_TOKEN: TOKEN,
    });
    expect(cli.exitCode).toBe(2);
    expect(cli.stdout).toContain("canonical clu_ ID");
    expect(`${cli.stdout}${cli.stderr}`).not.toContain(TOKEN);
    expect(cli.stdout).not.toContain("AKUA_COMMAND_NOT_IMPLEMENTED");
  });

  test("CLI help distinguishes the executable capacity overlays", async () => {
    const cli = await runAkua(["--help", "--json"]);
    expect(cli.exitCode).toBe(0);
    expect(cli.stdout).toContain("akua clusters get");
    expect(cli.stdout).toContain("akua compute-configs list --view full");
    expect(cli.stdout).toContain("akua compute list-instance-types");
    expect(cli.stdout).toContain("akua machines list");
  });
});

interface CapturedRequest { url: string; method: string; headers: Record<string, string>; body?: string }

function apiFixture(body: unknown, status = 200) {
  const requests: CapturedRequest[] = [];
  const fetch: ApiFetch = async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? "GET", headers: Object.fromEntries(new Headers(init?.headers).entries()), body: typeof init?.body === "string" ? init.body : undefined });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { fetch, requests };
}

function deps(fetch: ApiFetch): CapacityDependencies {
  return { readToken: async () => TOKEN, fetch };
}

async function runAkua(args: readonly string[], env: Record<string, string> = {}) {
  const childEnv = { ...process.env, ...env };
  delete childEnv.AKUA_OUTPUT;
  if (!("AKUA_API_TOKEN" in env)) {
    delete childEnv.AKUA_API_TOKEN;
  }
  const proc = Bun.spawn({
    cmd: ["bun", "src/bin/akua.ts", ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}
