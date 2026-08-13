import { describe, expect, test } from "bun:test";
import { Effect, Layer, Stream } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { generatedCommandView } from "../src/commands/generated";
import { GeneratedCommandFailure } from "../src/commands/generated";
import { commandRegistry } from "../src/generated/commands.gen";
import * as Api from "../src/generated/openapi-api.gen";
import { generatedCommandError } from "../src/runtime/errors";
import { PublicApiClientLive } from "../src/runtime/public-api";
import {
  PublicInput,
  SecureConfig,
  SecureConfigFailure,
} from "../src/runtime/services";

describe("generated public commands", () => {
  test("workspaces.list sends the decoded query and bearer token", async () => {
    let received: Request | undefined;
    const result = await runGenerated(
      "workspaces.list",
      ["--input", "-"],
      '{"query":{"limit":2}}',
      (input, init) => {
        received = new Request(input, init);
        return Promise.resolve(
          Response.json({ data: [], has_more: false, next_cursor: null }),
        );
      },
    );

    expect(result.data).toEqual({
      data: [],
      has_more: false,
      next_cursor: null,
    });
    expect(received?.url).toBe("https://api.akua.dev/v1/workspaces?limit=2");
    expect(received?.method).toBe("GET");
    expect(received?.headers.get("authorization")).toBe("Bearer test-token");
  });

  test("machines.create sends exact headers and JSON body and decodes 202", async () => {
    let received: Request | undefined;
    const body = {
      cluster_id: "clu_123",
      instance_type: "cx23",
      compute_config_id: "ccfg_123",
    };
    const operation = machineOperation();
    const result = await runGenerated(
      "machines.create",
      ["--input", "-"],
      JSON.stringify({
        headers: {
          "akua-context": "ws_123",
          "idempotency-key": "quickstart-worker",
        },
        body,
      }),
      (input, init) => {
        received = new Request(input, init);
        return Promise.resolve(Response.json(operation, { status: 202 }));
      },
    );

    expect(result.data).toEqual(operation);
    expect(received?.url).toBe("https://api.akua.dev/v1/machines");
    expect(received?.method).toBe("POST");
    expect(received?.headers.get("akua-context")).toBe("ws_123");
    expect(received?.headers.get("idempotency-key")).toBe(
      "quickstart-worker",
    );
    expect(await received?.json()).toEqual(body);
  });

  test("rejects malformed and excess input before transport", async () => {
    let requests = 0;
    const transport = () => {
      requests += 1;
      return Promise.resolve(Response.json({}));
    };

    await expect(
      runGenerated(
        "machines.create",
        ["--input", "-"],
        '{"body":{"cluster_id":"clu_123","instance_type":"cx23","compute_config_id":"ccfg_123","secret":"sentinel"}}',
        transport,
      ),
    ).rejects.toMatchObject({ _tag: "GeneratedCommandFailure", reason: "input" });
    await expect(
      runGenerated(
        "machines.create",
        ["--input", "-"],
        '{"body":',
        transport,
      ),
    ).rejects.toMatchObject({ _tag: "GeneratedCommandFailure", reason: "input" });
    await expect(
      runGenerated(
        "agents.archive",
        ["--input", "-"],
        '{"path":{"id":"agt_123"},"query":{}}',
        transport,
      ),
    ).rejects.toMatchObject({ _tag: "GeneratedCommandFailure", reason: "input" });
    await expect(
      runGenerated(
        "agents.archive",
        ["--input", "-"],
        '{"path":{"id":"agt_123"},"headers":{}}',
        transport,
      ),
    ).rejects.toMatchObject({ _tag: "GeneratedCommandFailure", reason: "input" });
    expect(requests).toBe(0);
  });

  test("preserves a structured generated 409 without request values", async () => {
    const sentinel = "secret-input-sentinel";
    await expect(
      runGenerated(
        "machines.create",
        ["--input", "-"],
        JSON.stringify({
          body: {
            cluster_id: "clu_123",
            instance_type: "cx23",
            compute_config_id: "ccfg_123",
            name: sentinel,
          },
        }),
        () =>
          Promise.resolve(
            Response.json(
              {
                success: false,
                errors: [
                  { code: 7002, message: "Machine allocation conflicts." },
                ],
                result: {},
              },
              { status: 409 },
            ),
          ),
      ),
    ).rejects.toMatchObject({
      _tag: "GeneratedCommandFailure",
      reason: "api",
      status: 409,
      apiError: {
        success: false,
        errors: [{ code: 7002, message: "Machine allocation conflicts." }],
        result: {},
      },
    });

    try {
      await runGenerated(
        "machines.create",
        ["--input", "-"],
        JSON.stringify({
          body: {
            cluster_id: "clu_123",
            instance_type: "cx23",
            compute_config_id: "ccfg_123",
            name: sentinel,
          },
        }),
        () => Promise.reject(new Error("transport failed")),
      );
    } catch (failure) {
      expect(JSON.stringify(failure)).not.toContain(sentinel);
    }
  });

  test("offers.resolve executes anonymously without a bearer token", async () => {
    const execution = runAnonymousOffer({ env: {} });
    await expect(execution.result).rejects.toMatchObject({
      _tag: "GeneratedCommandFailure",
      reason: "api",
      status: 404,
    });
    expect(execution.request()?.headers.has("authorization")).toBe(false);
  });

  test("anonymous operations ignore environment credentials", async () => {
    const execution = runAnonymousOffer({
      env: { AKUA_API_TOKEN: "environment-token", HOME: "/users/test" },
    });
    await expect(execution.result).rejects.toMatchObject({
      reason: "api",
      status: 404,
    });

    expect(execution.request()?.headers.has("authorization")).toBe(false);
  });

  test("anonymous operations do not read stored credentials", async () => {
    let configReads = 0;
    const execution = runAnonymousOffer({
      env: { HOME: "/users/test" },
      readToken: () =>
        Effect.sync(() => {
          configReads += 1;
          return "stored-token";
        }),
    });
    await expect(execution.result).rejects.toMatchObject({
      reason: "api",
      status: 404,
    });

    expect(configReads).toBe(0);
    expect(execution.request()?.headers.has("authorization")).toBe(false);
  });

  test("anonymous operations do not read malformed credential config", async () => {
    let configReads = 0;
    const execution = runAnonymousOffer({
      env: { HOME: "/users/test" },
      readToken: () => {
        configReads += 1;
        return Effect.fail(
          new SecureConfigFailure({
            operation: "read",
            path: "/users/test/.config/akua/config.json",
            cause: "malformed JSON",
          }),
        );
      },
    });
    await expect(execution.result).rejects.toMatchObject({
      reason: "api",
      status: 404,
    });

    expect(configReads).toBe(0);
    expect(execution.request()?.headers.has("authorization")).toBe(false);
  });

  test("installs.getLogs exposes decoded SSE events as a stream", async () => {
    const result = await runGenerated(
      "installs.getLogs",
      ["--input", "-"],
      '{"path":{"id":"inst_123"},"query":{"follow":false}}',
      () =>
        Promise.resolve(
          new Response(
            "event: message\ndata: first line\n\nevent: end\ndata: {}\n\n",
            { headers: { "content-type": "text/event-stream" } },
          ),
        ),
    );
    const stream = result.stream;

    expect(Stream.isStream(stream)).toBe(true);
    if (!Stream.isStream(stream)) return;
    expect(await Effect.runPromise(Stream.runCollect(stream))).toEqual([
      { event: "message", data: "first line" },
      { event: "end", data: "{}" },
    ]);
  });

  test("classifies invalid success payloads as response contract failures", async () => {
    await expect(
      runGenerated("workspaces.list", [], "{}", () =>
        Promise.resolve(Response.json({ unexpected: true })),
      ),
    ).rejects.toMatchObject({
      _tag: "GeneratedCommandFailure",
      reason: "response",
      status: 200,
    });
  });

  test("keeps HTTP status separate from the structured API error", () => {
    const apiError: typeof Api.ApiErrorResponse.Type = {
      success: false,
      errors: [{ code: 7002, message: "Machine allocation conflicts." }],
      result: {},
    };
    const payload = generatedCommandError(
      new GeneratedCommandFailure({
        operationId: "machines.create",
        reason: "api",
        status: 409,
        apiError,
      }),
    ).toPayload();

    expect(payload.error).toMatchObject({
      status: 409,
      code: "AKUA_API_7002",
      response: apiError,
    });
  });
});

interface RunGeneratedOptions {
  readonly env?: Record<string, string | undefined>;
  readonly readToken?: () => Effect.Effect<
    string | undefined,
    SecureConfigFailure
  >;
}

function runGenerated(
  operationId: string,
  argv: readonly string[],
  input: string,
  fetch: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
  options: RunGeneratedOptions = {},
) {
  const definition = commandRegistry.find(
    (candidate) => candidate.operation_id === operationId,
  );
  if (definition === undefined) {
    return Promise.reject(new Error(`Missing ${operationId}`));
  }
  const services = Layer.mergeAll(
    Layer.succeed(PublicInput, { read: () => Effect.succeed(input) }),
    Layer.succeed(SecureConfig, {
      readToken: options.readToken ?? (() => Effect.succeed(undefined)),
      saveToken: () => Effect.void,
      removeToken: () => Effect.succeed(false),
    }),
    FetchHttpClient.layer,
  );
  return Effect.runPromise(
    generatedCommandView(definition, argv).pipe(
      Effect.provide(
        PublicApiClientLive(
          options.env ?? { AKUA_API_TOKEN: "test-token" },
          definition.requires_auth,
        ),
      ),
      Effect.provide(services),
      Effect.provideService(
        FetchHttpClient.Fetch,
        Object.assign(fetch, { preconnect: () => undefined }),
      ),
    ),
  );
}

function runAnonymousOffer(options: RunGeneratedOptions) {
  let received: Request | undefined;
  return {
    request: () => received,
    result: runGenerated(
      "offers.resolve",
      ["--input", "-"],
      '{"query":{"short_hash":"offer123"}}',
      (input, init) => {
        received = new Request(input, init);
        return Promise.resolve(
          Response.json(
            {
              success: false,
              errors: [{ code: 7002, message: "Offer not found." }],
              result: {},
            },
            { status: 404 },
          ),
        );
      },
      options,
    ),
  };
}

function machineOperation() {
  return {
    id: "op_123",
    operation_id: "op_123",
    workspace_id: "ws_123",
    organization_id: null,
    owner_type: "machine",
    owner_id: "mch_123",
    parent_operation_id: null,
    state: "RUNNING",
    done: false,
    html_url: "https://akua.dev/machines/mch_123",
    metadata: {
      type: "machine.create",
      workspace_id: "ws_123",
      cluster_id: "clu_123",
      compute_config_id: "ccfg_123",
      instance_type: "cx23",
      managed: true,
      request_fingerprint: "fingerprint",
    },
    response: null,
    error: null,
    last_error: null,
    started_at: 1,
    completed_at: null,
  };
}
