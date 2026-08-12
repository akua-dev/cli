import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { Http, HttpFailure } from "../src/runtime/services";
import { HttpLive } from "../src/runtime/services-live";

describe("device authorization HTTP", () => {
  test("uses Effect's FetchHttpClient to encode form requests", async () => {
    let received: Request | undefined;
    const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      received = new Request(input, init);
      return Promise.resolve(Response.json({ access_token: "token" }));
    };
    const program = Effect.gen(function* () {
      const http = yield* Http;
      return yield* http.postForm({
        url: "https://api.example.test/device/token",
        fields: {
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
    expect(received?.headers.get("content-type")).toContain(
      "application/x-www-form-urlencoded",
    );
    expect(await received?.text()).toBe(
      "client_id=akua+cli&scope=platform%2Fread%2Bwrite",
    );
  });

  test("preserves status and byte bodies through the Effect HTTP adapter", async () => {
    let received: Request | undefined;
    const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      received = new Request(input, init);
      return Promise.resolve(Response.json({ accepted: true }, { status: 202 }));
    };
    const program = Effect.gen(function* () {
      const http = yield* Http;
      const postBytes = http.postBytes;
      if (postBytes === undefined) return yield* Effect.die("postBytes missing");
      return yield* postBytes({
        url: "https://api.example.test/provider",
        method: "POST",
        headers: { authorization: "Bearer caller", "content-type": "application/json" },
        body: new TextEncoder().encode('{"provider":"token"}'),
      });
    });

    const response = await Effect.runPromise(
      program.pipe(
        Effect.provide(HttpLive),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      ),
    );

    expect(response).toEqual({ status: 202, body: { accepted: true } });
    expect(received?.headers.get("authorization")).toBe("Bearer caller");
    expect(received?.headers.get("content-type")).toContain("application/json");
    expect(await received?.text()).toBe('{"provider":"token"}');
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
      return yield* http.postForm({
        url: "https://api.example.test/device/token",
        fields: {},
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
