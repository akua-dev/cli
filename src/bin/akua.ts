#!/usr/bin/env bun
import { Effect, Exit, Runtime } from "effect";

import { authView } from "../commands/auth";
import { buildHomeView } from "../commands/home";
import { commandRegistry } from "../generated/commands.gen";
import { commandNotImplemented } from "../runtime/errors";
import { detectOutputMode, type OutputMode } from "../runtime/mode";
import type { RenderEnvelope } from "../runtime/render";
import {
  CommandFailure,
  runCli,
  type CliFailure,
  UsageFailure,
} from "../runtime/effect-runtime";
import { CliLive } from "../runtime/services-live";
import { Console, type CliServices } from "../runtime/services";

const VERSION = "0.9.0"; // x-release-please-version

export function main(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): Effect.Effect<number, never, CliServices> {
  return mainEffect(argv, env);
}

if (import.meta.main) {
  const runMain = Runtime.makeRunMain(({ fiber, teardown }) => {
    fiber.addObserver((exit) => {
      if (Exit.isSuccess(exit)) {
        process.exitCode = typeof exit.value === "number" ? exit.value : 1;
        return;
      }
      teardown(exit, (code) => {
        process.exitCode = code;
      });
    });
  });
  runMain(Effect.provide(main(process.argv.slice(2), process.env), CliLive));
}

function mainEffect(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): Effect.Effect<number, never, CliServices> {
  const fallbackMode = fallbackErrorMode(argv);
  return Effect.gen(function* () {
    const console = yield* Console;
    return yield* detectOutputMode({
      argv,
      env,
      stdoutIsTTY: console.stdoutIsTTY,
    }).pipe(
      Effect.flatMap((mode) => runCli(route(argv, env), { mode })),
      Effect.catch((failure) =>
        runCli(Effect.fail(failure), { mode: fallbackMode }),
      ),
    );
  });
}

function route(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): Effect.Effect<RenderEnvelope, CliFailure, CliServices> {
  return stripGlobalFlags(argv).pipe(
    Effect.flatMap((stripped) => routeCommand(stripped, env)),
  );
}

function routeCommand(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): Effect.Effect<RenderEnvelope, CliFailure, CliServices> {
  if (argv.length === 0) return Effect.succeed(buildHomeView());

  if (argv.includes("--help") || argv.includes("-h")) {
    return Effect.succeed(helpView());
  }

  if (
    argv.includes("--version") ||
    argv.includes("-v") ||
    argv.includes("-V")
  ) {
    return Effect.succeed({
      command: "akua --version",
      observations: [VERSION],
      data: { version: VERSION },
    });
  }

  if (argv[0] === "commands") {
    return commandsView(argv.slice(1));
  }

  if (argv[0] === "auth") {
    return authView(argv.slice(1), env);
  }

  const unknownFlag = argv.find((arg) => arg.startsWith("-"));
  if (unknownFlag) {
    return invalidCommandsUsage(`Unknown flag: ${flagName(unknownFlag)}`);
  }

  const maybeGenerated = commandRegistry.find(
    (definition) => definition.command === argv.join(" "),
  );
  if (maybeGenerated) {
    return Effect.fail(
      new CommandFailure({
        error: commandNotImplemented(maybeGenerated.operation_id),
      }),
    );
  }

  return Effect.fail(
    new UsageFailure({ message: `Unknown command: ${argv.join(" ")}` }),
  );
}

function helpView(): RenderEnvelope {
  return {
    command: "akua --help",
    observations: [
      "Usage: akua [--output human|agent|json|quiet] <command>",
      "Commands:",
      "  akua                  Show compact home view",
      "  akua auth login       Save a local API token",
      "  akua auth status      Show local authentication status",
      "  akua auth logout      Remove the saved local API token",
      "  akua commands         List generated public OpenAPI command registry",
      "  akua --help           Show help",
      "  akua --version        Show version",
    ],
    next_steps: [
      { command: "akua commands" },
      { command: "akua commands --json" },
    ],
  };
}

function stripGlobalFlags(
  argv: readonly string[],
): Effect.Effect<string[], never> {
  const stripped: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--json" || value === "--quiet" || value === "-q") {
      continue;
    }
    if (value === "--output" || value === "-o") {
      index += 1;
      continue;
    }
    if (value.startsWith("--output=") || value.startsWith("-o=")) {
      continue;
    }
    stripped.push(value);
  }
  return Effect.succeed(stripped);
}

interface CommandsFilters {
  operationId?: string;
  resource?: string;
  limit: number;
}

function parseCommandsFlags(
  argv: readonly string[],
): Effect.Effect<CommandsFilters, UsageFailure> {
  return Effect.gen(function* () {
    const knownFlags = new Set(["--operation-id", "--resource", "--limit"]);
    let operationId: string | undefined;
    let resource: string | undefined;
    let limit = 20;

    for (let index = 0; index < argv.length; index += 1) {
      const value = argv[index];
      if (!value.startsWith("-")) {
        return yield* invalidCommandsUsage(
          `Unexpected argument for commands: ${value}`,
        );
      }

      const name = flagName(value);
      if (!knownFlags.has(name)) {
        return yield* invalidCommandsUsage(`Unknown flag: ${name}`);
      }

      const raw = readFlagValue(argv, index, name);
      if (raw.value === undefined || raw.value === "") {
        return yield* invalidCommandsUsage(`Missing value for ${name}.`);
      }
      if (raw.consumedNext) {
        index += 1;
      }

      if (name === "--operation-id") {
        operationId = raw.value;
      } else if (name === "--resource") {
        resource = raw.value;
      } else {
        limit = yield* parsePositiveInteger(raw.value, name);
      }
    }

    return { operationId, resource, limit };
  });
}

function readFlagValue(
  argv: readonly string[],
  index: number,
  flag: string,
): { value: string | undefined; consumedNext: boolean } {
  const value = argv[index];
  if (value === flag) {
    const next = argv[index + 1];
    if (
      next === undefined ||
      (next.startsWith("-") && !(flag === "--limit" && /^-\d/.test(next)))
    ) {
      return { value: undefined, consumedNext: false };
    }
    return { value: next, consumedNext: true };
  }

  return { value: value.slice(flag.length + 1), consumedNext: false };
}

function flagName(value: string): string {
  return value.includes("=") ? value.slice(0, value.indexOf("=")) : value;
}

function parsePositiveInteger(
  value: string,
  flag: string,
): Effect.Effect<number, UsageFailure> {
  if (!/^[1-9]\d*$/.test(value)) {
    return invalidCommandsUsage(
      `Invalid value for ${flag}: ${value}. Expected a positive integer.`,
    );
  }
  return Effect.succeed(Number(value));
}

function fallbackErrorMode(argv: readonly string[]): OutputMode {
  if (argv.includes("--json")) {
    return "json";
  }
  if (argv.includes("--quiet") || argv.includes("-q")) {
    return "quiet";
  }
  return "human";
}

function commandsView(
  argv: readonly string[],
): Effect.Effect<RenderEnvelope, UsageFailure> {
  return parseCommandsFlags(argv).pipe(
    Effect.map(({ operationId, resource, limit }) => {
      const filtered = commandRegistry
        .filter((command) => !operationId || command.operation_id === operationId)
        .filter((command) => !resource || command.resource === resource)
        .slice(0, Number.isFinite(limit) && limit > 0 ? limit : 20)
        .map((command) => ({
          operation_id: command.operation_id,
          command: command.command,
          method: command.method,
          path: command.path,
          summary: command.summary,
        }));

      return {
        command: "akua commands",
        observations: [
          `${filtered.length} of ${commandRegistry.length} public operations shown.`,
        ],
        data: filtered,
        next_steps: [
          { command: "akua commands --resource workspaces" },
          { command: "akua commands --operation-id <operation_id>" },
        ],
      };
    }),
  );
}

function invalidCommandsUsage(
  message: string,
): Effect.Effect<never, UsageFailure> {
  return Effect.fail(new UsageFailure({ message }));
}
