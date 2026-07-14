import { describe, expect, test } from "bun:test";

import {
  HCloudProviderLoadError,
  submitHcloudProviderLoad,
  type HCloudProviderLoadRequest,
} from "../src/runtime/platform-client";

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
