import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Clock, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";

import { runCli } from "../src/runtime/effect-runtime";
import {
  Browser,
  Console,
  Http,
  Process,
  SecureConfig,
} from "../src/runtime/services";

describe("Effect CLI runtime", () => {
  test("requires a resolved output mode at the render boundary", () => {
    const runtime = readFileSync("src/runtime/effect-runtime.ts", "utf8");

    expect(runtime).not.toContain("OutputMode | (() => OutputMode)");
    expect(runtime).not.toContain("function rendererMode");
  });

  test("runs an Effect command through the central render boundary", async () => {
    const stdout: string[] = [];
    const exitCode = await Effect.runPromise(
      Effect.provide(
        runCli(
          Effect.succeed({
            command: "akua test",
            observations: ["Effect runtime active."],
            data: { runtime: "effect-v4" },
          }),
          { mode: "json" },
        ),
        Layer.succeed(Console, {
          stdoutIsTTY: false,
          writeStderr: () => Effect.void,
          writeStdout: (value) => Effect.sync(() => stdout.push(value)),
        }),
      ),
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      status: "ok",
      command: "akua test",
      data: { runtime: "effect-v4" },
    });
  });

  test("uses service tags and TestClock layers without host dependencies", async () => {
    const services = Layer.mergeAll(
      Layer.succeed(Http, { postJson: () => Effect.die("not used") }),
      Layer.succeed(Browser, { launch: () => Effect.void }),
      Layer.succeed(Process, { awaitSignal: Effect.never }),
      Layer.succeed(Console, {
        stdoutIsTTY: false,
        writeStderr: () => Effect.void,
        writeStdout: () => Effect.void,
      }),
      Layer.succeed(SecureConfig, {
        readToken: () => Effect.succeed(undefined),
        saveToken: () => Effect.void,
        removeToken: () => Effect.succeed(false),
      }),
      TestClock.layer(),
    );
    const program = Effect.gen(function* () {
      yield* Http;
      yield* Browser;
      yield* Process;
      yield* Console;
      yield* SecureConfig;
      return yield* Clock.currentTimeMillis;
    });

    expect(await Effect.runPromise(Effect.provide(program, services))).toBe(0);
  });
});
