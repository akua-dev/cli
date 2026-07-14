import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { agentOsView, type AgentOsDependencies } from "../src/commands/agent-os";
import {
  HCloudProviderLoadError,
  type HCloudProviderLoadInput,
  submitHcloudProviderLoad,
  type HCloudProviderLoadRequest,
} from "../src/runtime/platform-client";
import { renderError, renderSuccess } from "../src/runtime/render";

const SYNTHETIC_TOKEN = new Uint8Array([115, 121, 110, 116, 104, 101, 116, 105, 99]);
const SYNTHETIC_ECHO = "synthetic-response-field";

describe("submitHcloudProviderLoad", () => {
  test("submits one fixed-route request with protected auth, explicit context, and relayed idempotency", async () => {
    const requests: HCloudProviderLoadRequest[] = [];
    let bodyHasProviderField = false;

    const result = await submitHcloudProviderLoad(
      {
        workspace: "ws_synthetic",
        callerToken: "caller-auth-fixture",
        providerToken: SYNTHETIC_TOKEN.slice(),
        idempotencyKey: "00000000-0000-4000-8000-000000000001",
      },
      {
        send: async (request) => {
          requests.push(request);
          bodyHasProviderField = new TextDecoder().decode(request.body).includes('"provider_token":"synthetic"');
          return successResponse();
        },
      },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.akua.dev/v1/agent_os/hcloud_provider_loads");
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.headers).toMatchObject({
      authorization: "Bearer caller-auth-fixture",
      "akua-context": "ws_synthetic",
      "idempotency-key": "00000000-0000-4000-8000-000000000001",
      "content-type": "application/json",
    });
    expect(bodyHasProviderField).toBe(true);
    expect(result).toEqual({
      workspace_id: "ws_synthetic",
      secret_id: "sec_synthetic",
      compute_config_id: "cfg_synthetic",
      inventory: { servers: 0, volumes: 0 },
      request_id: "req_synthetic",
    });
  });

  test("projects success through a strict response allowlist", async () => {
    const result = await submitHcloudProviderLoad(
      {
        workspace: "ws_synthetic",
        callerToken: "caller-auth-fixture",
        providerToken: SYNTHETIC_TOKEN.slice(),
        idempotencyKey: "00000000-0000-4000-8000-000000000002",
      },
      {
        send: async () => ({
          status: 200,
          body: {
            ...successResponse().body,
            echoed_provider_token: SYNTHETIC_ECHO,
            nested: { secret: SYNTHETIC_ECHO },
          },
        }),
      },
    );

    expect(JSON.stringify(result)).not.toContain(SYNTHETIC_ECHO);
    expect(result).not.toHaveProperty("echoed_provider_token");
    expect(result).not.toHaveProperty("nested");
  });

  test("clears provider and request byte buffers after a successful send", async () => {
    const providerToken = SYNTHETIC_TOKEN.slice();
    let submittedBody: Uint8Array | undefined;

    await submitHcloudProviderLoad(
      {
        workspace: "ws_synthetic",
        callerToken: "caller-auth-fixture",
        providerToken,
        idempotencyKey: "00000000-0000-4000-8000-000000000003",
      },
      {
        send: async (request) => {
          submittedBody = request.body;
          return successResponse();
        },
      },
    );

    expect([...providerToken].every((byte) => byte === 0)).toBe(true);
    expect([...(submittedBody ?? [])].every((byte) => byte === 0)).toBe(true);
  });

  test("makes no retry after an uncertain transport failure and clears buffers", async () => {
    const providerToken = SYNTHETIC_TOKEN.slice();
    let attempts = 0;

    await expect(
      submitHcloudProviderLoad(
        {
          workspace: "ws_synthetic",
          callerToken: "caller-auth-fixture",
          providerToken,
          idempotencyKey: "00000000-0000-4000-8000-000000000004",
        },
        {
          send: async () => {
            attempts += 1;
            throw new Error("synthetic transport interruption");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "AKUA_LOADER_SUBMISSION_UNKNOWN" });

    expect(attempts).toBe(1);
    expect([...providerToken].every((byte) => byte === 0)).toBe(true);
  });

  test("projects server failures to fixed safe fields", async () => {
    await expect(
      submitHcloudProviderLoad(
        {
          workspace: "ws_synthetic",
          callerToken: "caller-auth-fixture",
          providerToken: SYNTHETIC_TOKEN.slice(),
          idempotencyKey: "00000000-0000-4000-8000-000000000005",
        },
        {
          send: async () => ({
            status: 403,
            body: {
              error: {
                code: "SERVER_PRIVATE_CODE",
                message: SYNTHETIC_ECHO,
                request_id: "req_synthetic_denied",
                secret_id: "sec_synthetic",
              },
            },
          }),
        },
      ),
    ).rejects.toMatchObject({
      code: "AKUA_LOADER_SERVER_REJECTED",
      status: 403,
      requestId: "req_synthetic_denied",
    } satisfies Partial<HCloudProviderLoadError>);
  });
});

describe("agent-os load-hcloud-provider", () => {
  test("accepts only explicit workspace and absolute token-file flags without exposing rejected values", async () => {
    const dependencies = fakeCommandDependencies();
    const rejectedValue = "synthetic-argv-value";

    await expect(
      agentOsView(["load-hcloud-provider", "--workspace", "ws_synthetic", "--token", rejectedValue], {}, dependencies.dependencies),
    ).rejects.toMatchObject({ code: "AKUA_USAGE_ERROR" });
    await expect(
      agentOsView(["load-hcloud-provider", "--workspace", "ws_synthetic", "--token-file", "-"], {}, dependencies.dependencies),
    ).rejects.toMatchObject({ code: "AKUA_USAGE_ERROR" });
    await expect(agentOsView(["load-hcloud-provider", "--token-file", "/synthetic/provider"], {}, dependencies.dependencies)).rejects.toMatchObject({
      code: "AKUA_USAGE_ERROR",
    });

    const error = await captureError(() =>
      agentOsView(["load-hcloud-provider", "--workspace", "ws_synthetic", "--token", rejectedValue], {}, dependencies.dependencies),
    );
    expect(renderError(error, "json")).not.toContain(rejectedValue);
    expect(dependencies.fileReads).toBe(0);
    expect(dependencies.submissions).toBe(0);
  });

  test("rejects environment caller authentication before config, file, or network access", async () => {
    const dependencies = fakeCommandDependencies();

    await expect(
      agentOsView(commandArgs(), { AKUA_API_TOKEN: "synthetic-environment-auth" }, dependencies.dependencies),
    ).rejects.toMatchObject({ code: "AKUA_LOADER_ENV_AUTH_FORBIDDEN" });
    expect(dependencies.events).toEqual([]);
  });

  test("authenticates from protected config before reading the provider file and relays idempotency once", async () => {
    const dependencies = fakeCommandDependencies();

    const view = await agentOsView(commandArgs(), {}, dependencies.dependencies);

    expect(dependencies.events).toEqual(["auth", "file", "network"]);
    expect(dependencies.submissions).toBe(1);
    expect(dependencies.input?.workspace).toBe("ws_synthetic");
    expect(dependencies.input?.idempotencyKey).toMatch(/^[0-9a-f]{8}-/);
    expect(view.data).toEqual(successResponse().body);
    expect(renderSuccess(view, "json")).not.toContain(SYNTHETIC_ECHO);
  });

  test("clears the reader bytes and renders only fixed safe failures", async () => {
    const providerToken = new Uint8Array([112, 114, 111, 118, 105, 100, 101, 114, 45, 115, 101, 99, 114, 101, 116]);
    const providerMarker = "provider-secret";
    const dependencies = fakeCommandDependencies({
      readSecureTokenFile: async () => providerToken,
      submit: async () => {
        throw new HCloudProviderLoadError({
          type: "api_error",
          code: "AKUA_LOADER_SERVER_REJECTED",
          status: 403,
          requestId: "req_synthetic_denied",
          message: "The provider-load server rejected the request.",
        });
      },
    });

    const error = await captureError(() => agentOsView(commandArgs(), {}, dependencies.dependencies));

    expect([...providerToken].every((byte) => byte === 0)).toBe(true);
    expect(renderError(error, "json")).not.toContain(providerMarker);
    expect(error).toMatchObject({ code: "AKUA_LOADER_SERVER_REJECTED", status: 403 });
  });

  test("fails post-revocation against the fake HTTPS server without a retry or leaked prior result", async () => {
    const server = new FakeHttpsServer();
    const dependencies = fakeCommandDependencies({
      submit: async (input) => server.submit(input),
    });

    const first = await agentOsView(commandArgs(), {}, dependencies.dependencies);
    server.revoke();
    const error = await captureError(() => agentOsView(commandArgs(), {}, dependencies.dependencies));

    expect(first.data).toEqual(successResponse().body);
    expect(error).toMatchObject({ code: "AKUA_LOADER_SERVER_REJECTED", status: 403 });
    expect(server.requests).toEqual([
      { workspace: "ws_synthetic", tokenLength: SYNTHETIC_TOKEN.byteLength },
      { workspace: "ws_synthetic", tokenLength: SYNTHETIC_TOKEN.byteLength },
    ]);
  });

  test("contains no child-process or shell fallback implementation", async () => {
    const [commandSource, transportSource] = await Promise.all([
      readFile("src/commands/agent-os.ts", "utf8"),
      readFile("src/runtime/platform-client.ts", "utf8"),
    ]);

    for (const source of [commandSource, transportSource]) {
      expect(source).not.toContain("Bun.spawn");
      expect(source).not.toContain("node:child_process");
      expect(source).not.toContain("curl");
    }
  });
});

function successResponse() {
  return {
    status: 200,
    body: {
      workspace_id: "ws_synthetic",
      secret_id: "sec_synthetic",
      compute_config_id: "cfg_synthetic",
      inventory: { servers: 0, volumes: 0 },
      request_id: "req_synthetic",
    },
  };
}

function commandArgs(): string[] {
  return ["load-hcloud-provider", "--workspace", "ws_synthetic", "--token-file", "/synthetic/provider"];
}

function fakeCommandDependencies(overrides: Partial<AgentOsDependencies> = {}) {
  const events: string[] = [];
  let fileReads = 0;
  let submissions = 0;
  let input: HCloudProviderLoadInput | undefined;
  const dependencies: AgentOsDependencies = {
    readProtectedCallerToken: async () => {
      events.push("auth");
      return "caller-auth-fixture";
    },
    readSecureTokenFile: async () => {
      events.push("file");
      fileReads += 1;
      return SYNTHETIC_TOKEN.slice();
    },
    submit: async (submitted) => {
      events.push("network");
      submissions += 1;
      input = submitted;
      return successResponse().body;
    },
    createIdempotencyKey: () => "00000000-0000-4000-8000-000000000006",
    ...overrides,
  };
  return {
    dependencies,
    events,
    get fileReads() {
      return fileReads;
    },
    get submissions() {
      return submissions;
    },
    get input() {
      return input;
    },
  };
}

async function captureError(action: () => Promise<unknown>): Promise<HCloudProviderLoadError> {
  try {
    await action();
  } catch (error) {
    return error as HCloudProviderLoadError;
  }
  throw new Error("Expected the loader action to fail.");
}

class FakeHttpsServer {
  readonly requests: Array<{ workspace: string; tokenLength: number }> = [];
  #revoked = false;

  revoke(): void {
    this.#revoked = true;
  }

  async submit(input: HCloudProviderLoadInput) {
    this.requests.push({ workspace: input.workspace, tokenLength: input.providerToken.byteLength });
    if (this.#revoked) {
      throw new HCloudProviderLoadError({
        type: "api_error",
        code: "AKUA_LOADER_SERVER_REJECTED",
        status: 403,
        requestId: "req_synthetic_revoked",
        message: "The provider-load server rejected the request.",
      });
    }
    return successResponse().body;
  }
}
