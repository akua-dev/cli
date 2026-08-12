import { describe, expect, test } from "bun:test";
import { Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";

import { authView } from "../src/commands/auth";
import {
  ConfigFailure,
  DeviceCancelledFailure,
  DeviceRequestFailure,
  runCli,
  UsageFailure,
} from "../src/runtime/effect-runtime";
import {
  Browser,
  Console,
  Http,
  Process,
  SecureConfig,
} from "../src/runtime/services";
import type { RenderEnvelope } from "../src/runtime/render";

describe("Effect auth command", () => {
  test("runs the device flow through injected services and TestClock", async () => {
    const requests: string[] = [];
    const launched: string[] = [];
    const stderr: string[] = [];
    const saved: Array<{ path: string; token: string }> = [];
    let tokenRequests = 0;
    const services = Layer.mergeAll(
      Layer.succeed(Http, {
        postForm: ({ url }) =>
          Effect.sync(() => {
            requests.push(url);
            if (url.endsWith("/device/code")) {
              return {
                status: 200,
                body: {
                  device_code: "device-code",
                  user_code: "ABCD-EFGH",
                  verification_uri: "https://example.test/device",
                  expires_in: 60,
                  interval: 2,
                },
              };
            }
            tokenRequests += 1;
            return tokenRequests === 1
              ? { status: 400, body: { error: "authorization_pending" } }
              : { status: 200, body: { access_token: "access-token" } };
          }),
      }),
      Layer.succeed(Browser, {
        launch: (url) => Effect.sync(() => launched.push(url)),
      }),
      Layer.succeed(Process, { awaitSignal: Effect.never }),
      Layer.succeed(Console, {
        stdoutIsTTY: false,
        writeStderr: (value) => Effect.sync(() => stderr.push(value)),
        writeStdout: () => Effect.void,
      }),
      Layer.succeed(SecureConfig, {
        readToken: () => Effect.succeed(undefined),
        saveToken: (path, token) =>
          Effect.sync(() => saved.push({ path, token })),
        removeToken: () => Effect.succeed(false),
      }),
      TestClock.layer(),
    );
    const program = Effect.gen(function* () {
      const fiber = yield* authView(["login"], { HOME: "/test-home" }).pipe(
        Effect.forkChild,
      );
      yield* TestClock.adjust("2 seconds");
      return yield* Fiber.join(fiber);
    });

    const envelope = await Effect.runPromise(
      Effect.provide(program, services) as Effect.Effect<RenderEnvelope>,
    );

    expect(requests).toEqual([
      "https://akua.dev/api/auth/device/code",
      "https://akua.dev/api/auth/device/token",
      "https://akua.dev/api/auth/device/token",
    ]);
    expect(launched).toEqual(["https://example.test/device"]);
    expect(stderr).toEqual([
      "Open https://example.test/device\nEnter code: ABCD-EFGH\n",
    ]);
    expect(saved).toEqual([
      { path: "/test-home/.config/akua/config.json", token: "access-token" },
    ]);
    expect(envelope.data).toMatchObject({
      authenticated: true,
      source: "config",
    });
  });

  test("maps tagged failures to distinct rendered error envelopes", async () => {
    const render = async (
      failure:
        | UsageFailure
        | ConfigFailure
        | DeviceRequestFailure
        | DeviceCancelledFailure,
    ) => {
      const stdout: string[] = [];
      const exitCode = await Effect.runPromise(
        Effect.provide(
          runCli(Effect.fail(failure), { mode: "json" }),
          Layer.succeed(Console, {
            stdoutIsTTY: false,
            writeStderr: () => Effect.void,
            writeStdout: (value) => Effect.sync(() => stdout.push(value)),
          }),
        ),
      );
      return { exitCode, payload: JSON.parse(stdout.join("")) };
    };

    await expect(
      render(new UsageFailure({ message: "Bad command." })),
    ).resolves.toMatchObject({
      exitCode: 2,
      payload: { error: { type: "usage_error", code: "AKUA_USAGE_ERROR" } },
    });
    await expect(
      render(
        new ConfigFailure({
          operation: "read",
          path: "/config",
          cause: new Error("denied"),
        }),
      ),
    ).resolves.toMatchObject({
      exitCode: 1,
      payload: { error: { type: "runtime_error", code: "AKUA_CONFIG_ERROR" } },
    });
    await expect(render(new DeviceRequestFailure())).resolves.toMatchObject({
      exitCode: 3,
      payload: {
        error: {
          type: "authentication_error",
          code: "AKUA_DEVICE_REQUEST_FAILED",
        },
      },
    });
    await expect(render(new DeviceCancelledFailure())).resolves.toMatchObject({
      exitCode: 1,
      payload: {
        error: { type: "runtime_error", code: "AKUA_DEVICE_CANCELLED" },
      },
    });
  });
});
