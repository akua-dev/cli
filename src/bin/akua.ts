#!/usr/bin/env bun
import { Effect, Exit, Ref, Runtime, Stream } from "effect";
import { NodeServices } from "@effect/platform-node";
import { CliOutput, Command } from "effect/unstable/cli";

import { makeAkuaCommand, shouldShowGroupHelp } from "../cli/command";
import { authView } from "../commands/auth";
import {
  generatedCommandView,
  GeneratedCommandFailure,
} from "../commands/generated";
import { buildHomeView } from "../commands/home";
import { commandRegistry } from "../generated/commands.gen";
import {
  generatedCommandError,
  packageCommandError,
} from "../runtime/errors";
import { detectOutputMode, type OutputMode } from "../runtime/mode";
import type { RenderEnvelope } from "../runtime/render";
import {
  CommandFailure,
  runCli,
  type CliFailure,
  UsageFailure,
} from "../runtime/effect-runtime";
import { CliLive } from "../runtime/services-live";
import { Console, PackageCli, type CliServices } from "../runtime/services";
import {
  PublicApiAuthenticationFailure,
  PublicApiClientLive,
} from "../runtime/public-api";

const VERSION = "0.10.0"; // x-release-please-version

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
      Effect.flatMap((mode) => {
        return stripGlobalFlags(argv).pipe(
          Effect.flatMap((stripped) => {
            if (stripped[0] === "pkg") {
              return Effect.gen(function* () {
                const pkg = yield* PackageCli;
                return yield* pkg.execute(packageCommandArgs(stripped, mode)).pipe(
                  Effect.catchTag("PackageCliFailure", () =>
                    runCli(
                      Effect.fail(
                        new CommandFailure({ error: packageCommandError() }),
                      ),
                      { mode },
                    ),
                  ),
                );
              });
            }
            if (usesStructuredRenderer(argv, mode)) {
              return runCli(route(argv, env), { mode });
            }

            return Effect.gen(function* () {
              const exitCode = yield* Ref.make(0);
              const command = makeAkuaCommand(() =>
                runCli(route(argv, env), { mode }).pipe(
                  Effect.tap((code) => Ref.set(exitCode, code)),
                  Effect.asVoid,
                ),
              );
              yield* Command.runWith(command, { version: VERSION })(
                commandInput(argv),
              ).pipe(
                Effect.catch(() => Ref.set(exitCode, 2)),
              );
              return yield* Ref.get(exitCode);
            }).pipe(
              Effect.provide(NodeServices.layer),
              Effect.provide(
                CliOutput.layer(CliOutput.defaultFormatter({ colors: false })),
              ),
            );
          }),
        );
      }),
      Effect.catch((failure) =>
        runCli(Effect.fail(failure), { mode: fallbackMode }),
      ),
    );
  });
}

function packageCommandArgs(
  argv: readonly string[],
  mode: OutputMode,
): readonly string[] {
  const args = argv.length === 1 ? ["--help"] : argv.slice(1);
  return mode === "agent" || mode === "json" ? [...args, "--json"] : args;
}

function usesStructuredRenderer(
  argv: readonly string[],
  mode: OutputMode,
): boolean {
  return mode !== "human" && argv.length > 0;
}

function commandInput(argv: readonly string[]): readonly string[] {
  if (argv.length === 0 || shouldShowGroupHelp(argv)) {
    return [...argv, "--help"];
  }
  return argv;
}

function route(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): Effect.Effect<RenderEnvelope<CliFailure>, CliFailure, CliServices> {
  return stripGlobalFlags(argv).pipe(
    Effect.flatMap((stripped) => routeCommand(stripped, env)),
  );
}

function routeCommand(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): Effect.Effect<RenderEnvelope<CliFailure>, CliFailure, CliServices> {
  if (argv.length === 0) return Effect.succeed(buildHomeView());

  if (argv[0] === "commands" && hasHelpFlag(argv.slice(1))) {
    return Effect.succeed(commandsHelpView());
  }

  if (argv[0] === "auth" && hasHelpFlag(argv.slice(1))) {
    return Effect.succeed(authHelpView(argv.slice(1)));
  }

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

  const maybeGenerated = commandRegistry.find(
    (definition) =>
      definition.command === argv.slice(0, 2).join(" "),
  );
  if (maybeGenerated) {
    return generatedCommandView(maybeGenerated, argv.slice(2)).pipe(
      Effect.provide(PublicApiClientLive(env, maybeGenerated.requires_auth)),
      Effect.map(
        (envelope): RenderEnvelope<CliFailure> => ({
          ...envelope,
          stream: envelope.stream?.pipe(
            Stream.mapError(generatedCliFailure),
          ),
        }),
      ),
      Effect.mapError((failure) =>
        generatedCliFailure(
          failure instanceof GeneratedCommandFailure
            ? failure
            : new GeneratedCommandFailure({
                operationId: maybeGenerated.operation_id,
                reason:
                  failure instanceof PublicApiAuthenticationFailure
                    ? "auth"
                    : "transport",
              }),
        ),
      ),
    );
  }

  const unknownFlag = argv.find((arg) => arg.startsWith("-"));
  if (unknownFlag) {
    return invalidCommandsUsage(`Unknown flag: ${flagName(unknownFlag)}`);
  }

  return Effect.fail(
    new UsageFailure({ message: `Unknown command: ${argv.join(" ")}` }),
  );
}

function generatedCliFailure(failure: GeneratedCommandFailure): CommandFailure {
  return new CommandFailure({ error: generatedCommandError(failure) });
}

function helpView(): RenderEnvelope {
  return {
    command: "akua --help",
    observations: [
      "Usage: akua [--output human|agent|json|quiet] <command>",
      "Commands:",
      "  akua                  Show compact home view",
      "  akua auth login       Sign in with a browser/device flow",
      "  akua auth status      Show local authentication status",
      "  akua auth logout      Remove the saved local API token",
      "  akua commands         List generated public OpenAPI command registry",
      "  akua pkg --help       Build, render, publish, and inspect Packages",
      "  akua <resource> <action> [--input -|<file>]",
      "                         Execute a generated public API operation",
      "  akua --help           Show help",
      "  akua --version        Show version",
    ],
    next_steps: [
      { command: "akua commands" },
      { command: "akua commands --json" },
      { command: "akua pkg --help" },
    ],
  };
}

function commandsHelpView(): RenderEnvelope {
  return {
    command: "akua commands --help",
    observations: [
      "Usage: akua commands [filters]",
      "List generated public OpenAPI operations before executing one.",
      "Filters:",
      "  --operation-id <id>  Show one operation by its OpenAPI operation ID",
      "  --resource <name>    Show operations for one resource",
      "  --limit <n>          Limit the number of displayed operations (default: 20)",
    ],
    next_steps: [
      { command: "akua commands --resource workspaces" },
      { command: "akua commands --operation-id workspaces.list" },
    ],
  };
}

function authHelpView(argv: readonly string[]): RenderEnvelope {
  const subcommand = argv.find((value) => !value.startsWith("-"));
  if (subcommand === "login") {
    return {
      command: "akua auth login --help",
      observations: [
        "Usage: akua auth login [--no-browser] [--token <token>]",
        "Sign in with a browser/device flow and save only the resulting access token.",
        "  --no-browser      Do not open the verification URL automatically",
        "  --token <token>   Save an explicit API token for noninteractive automation",
      ],
      next_steps: [{ command: "akua auth login" }],
    };
  }

  return {
    command: "akua auth --help",
    observations: [
      "Usage: akua auth <login|status|logout>",
      "  login   Sign in with a browser/device flow",
      "  status  Show the active credential source",
      "  logout  Remove the stored credential",
    ],
    next_steps: [{ command: "akua auth login" }],
  };
}

function hasHelpFlag(argv: readonly string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
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
