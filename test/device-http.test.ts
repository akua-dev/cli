import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { Http, HttpFailure } from "../src/runtime/services";
import { HttpLive } from "../src/runtime/services-live";

describe("device authorization HTTP", () => {
  test("uses Effect's FetchHttpClient to encode JSON requests", async () => {
    let received: Request | undefined;
    const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      received = new Request(input, init);
      return Promise.resolve(Response.json({ access_token: "token" }));
    };
    const program = Effect.gen(function* () {
      const http = yield* Http;
      return yield* http.postJson({
        url: "https://api.example.test/device/token",
        body: {
          client_id: "akua cli",
          scope: "platform/read+write",
        },
      });
    });

    const response = await Effect.runPromise(
      program.pipe(
        Effect.provide(HttpLive),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      ),
    );

    expect(response).toEqual({ status: 200, body: { access_token: "token" } });
    expect(received?.headers.get("content-type")).toContain("application/json");
    expect(await received?.json()).toEqual({
      client_id: "akua cli",
      scope: "platform/read+write",
    });
  });

  test("maps invalid and oversized response bodies to HttpFailure", async () => {
    const invalidJson = (input: RequestInfo | URL, init?: RequestInit) => {
      return Promise.resolve(
        new Response("not json", {
          headers: { "content-type": "application/json" },
        }),
      );
    };
    const oversized = (input: RequestInfo | URL, init?: RequestInit) => {
      return Promise.resolve(
        new Response("x".repeat(16_385), {
          headers: { "content-type": "application/json" },
        }),
      );
    };
    const request = Effect.gen(function* () {
      const http = yield* Http;
      return yield* http.postJson({
        url: "https://api.example.test/device/token",
        body: {},
      });
    });

    const invalidResult = await Effect.runPromiseExit(
      request.pipe(
        Effect.provide(HttpLive),
        Effect.provideService(FetchHttpClient.Fetch, invalidJson),
      ),
    );
    const oversizedResult = await Effect.runPromiseExit(
      request.pipe(
        Effect.provide(HttpLive),
        Effect.provideService(FetchHttpClient.Fetch, oversized),
      ),
    );

    expect(hasHttpFailure(invalidResult)).toBe(true);
    expect(hasHttpFailure(oversizedResult)).toBe(true);
  });
});

function hasHttpFailure(exit: Exit.Exit<unknown, unknown>): boolean {
  if (!Exit.isFailure(exit)) return false;
  const failure = Cause.findErrorOption(exit.cause);
  return failure._tag === "Some" && failure.value instanceof HttpFailure;
}
