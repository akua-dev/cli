#!/usr/bin/env bun
import { Effect, Exit, Runtime } from "effect";

import { authView } from "../commands/auth";
import { agentOsView } from "../commands/agent-os";
import { buildHomeView } from "../commands/home";
import { commandRegistry } from "../generated/commands.gen";
import {
  AkuaCliError,
  commandNotImplemented,
  usageError,
} from "../runtime/errors";
import { detectOutputMode, type OutputMode } from "../runtime/mode";
import type { RenderEnvelope } from "../runtime/render";
import {
  CommandFailure,
  runCli,
  type CliFailure,
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
  let mode = fallbackErrorMode(argv);
  return Effect.gen(function* () {
    const console = yield* Console;
    const command = Effect.try({
      try: () => {
        mode = detectOutputMode({
          argv,
          env,
          stdoutIsTTY: console.stdoutIsTTY,
        });
      },
      catch: (error) => new CommandFailure({ error: toCliError(error) }),
    }).pipe(Effect.andThen(route(argv, env)));
    return yield* runCli(command, { mode: () => mode });
  });
}

function route(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): Effect.Effect<RenderEnvelope, CliFailure, CliServices> {
  return Effect.try({
    try: () => stripGlobalFlags(argv),
    catch: (error) => new CommandFailure({ error: toCliError(error) }),
  }).pipe(Effect.flatMap((stripped) => routeCommand(stripped, env)));
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
    return Effect.try({
      try: () => commandsView(argv.slice(1)),
      catch: (error) => new CommandFailure({ error: toCliError(error) }),
    });
  }

  if (argv[0] === "auth") {
    return authView(argv.slice(1), env);
  }

  if (argv[0] === "agent-os") {
    return agentOsView(argv.slice(1), env).pipe(
      Effect.mapError((error) => new CommandFailure({ error })),
    );
  }

  const unknownFlag = argv.find((arg) => arg.startsWith("-"));
  if (unknownFlag) {
    return Effect.fail(
      new CommandFailure({
        error: usageError(`Unknown flag: ${flagName(unknownFlag)}`),
      }),
    );
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
    new CommandFailure({
      error: usageError(`Unknown command: ${argv.join(" ")}`),
    }),
  );
}

function toCliError(error: unknown): AkuaCliError {
  return error instanceof AkuaCliError
    ? error
    : usageError(error instanceof Error ? error.message : String(error));
}

function commandsView(argv: readonly string[]): RenderEnvelope {
  const { operationId, resource, limit } = parseCommandsFlags(argv);
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
      "  akua agent-os load-hcloud-provider --workspace <exact-name-or-ws_id> --token-file <absolute-path> [--expected-ssh-key-fingerprint <fingerprint> [--expected-ssh-key-name <name>]]",
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

function stripGlobalFlags(argv: readonly string[]): string[] {
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
  return stripped;
}

interface CommandsFilters {
  operationId?: string;
  resource?: string;
  limit: number;
}

function parseCommandsFlags(argv: readonly string[]): CommandsFilters {
  const knownFlags = new Set(["--operation-id", "--resource", "--limit"]);
  let operationId: string | undefined;
  let resource: string | undefined;
  let limit = 20;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("-")) {
      throw usageError(`Unexpected argument for commands: ${value}`);
    }

    const name = flagName(value);
    if (!knownFlags.has(name)) {
      throw usageError(`Unknown flag: ${name}`);
    }

    const raw = readFlagValue(argv, index, name);
    if (raw.value === undefined || raw.value === "") {
      throw usageError(`Missing value for ${name}.`);
    }
    if (raw.consumedNext) {
      index += 1;
    }

    if (name === "--operation-id") {
      operationId = raw.value;
    } else if (name === "--resource") {
      resource = raw.value;
    } else {
      limit = parsePositiveInteger(raw.value, name);
    }
  }

  return { operationId, resource, limit };
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

function parsePositiveInteger(value: string, flag: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw usageError(
      `Invalid value for ${flag}: ${value}. Expected a positive integer.`,
    );
  }
  return Number(value);
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
