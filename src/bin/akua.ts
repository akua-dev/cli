#!/usr/bin/env bun
import { buildHomeView } from "../commands/home";
import { commandRegistry } from "../generated/commands.gen";
import { AkuaCliError, commandNotImplemented, usageError } from "../runtime/errors";
import { detectOutputMode } from "../runtime/mode";
import { renderError, renderSuccess, type RenderEnvelope } from "../runtime/render";

const VERSION = "0.0.0";

export async function main(argv = process.argv.slice(2), env = process.env): Promise<number> {
  const mode = detectOutputMode({ argv, env, stdoutIsTTY: process.stdout.isTTY });
  try {
    const command = route(stripGlobalFlags(argv));
    process.stdout.write(renderSuccess(command, mode));
    return 0;
  } catch (error) {
    const cliError = error instanceof AkuaCliError ? error : usageError(error instanceof Error ? error.message : String(error));
    process.stdout.write(renderError(cliError, mode));
    return cliError.exitCode;
  }
}

function route(argv: readonly string[]): RenderEnvelope {
  if (argv.length === 0) {
    return buildHomeView();
  }

  if (argv.includes("--help") || argv.includes("-h")) {
    return helpView();
  }

  if (argv.includes("--version") || argv.includes("-v") || argv.includes("-V")) {
    return {
      command: "akua --version",
      observations: [VERSION],
      data: { version: VERSION },
    };
  }

  if (argv[0] === "commands") {
    return commandsView(argv.slice(1));
  }

  const unknownFlag = argv.find((arg) => arg.startsWith("-"));
  if (unknownFlag) {
    throw usageError(`Unknown flag: ${flagName(unknownFlag)}`);
  }

  const maybeGenerated = commandRegistry.find((definition) => definition.command === argv.join(" "));
  if (maybeGenerated) {
    throw commandNotImplemented(maybeGenerated.operation_id);
  }

  throw usageError(`Unknown command: ${argv.join(" ")}`);
}

function commandsView(argv: readonly string[]): RenderEnvelope {
  assertKnownFlags(argv, new Set(["--operation-id", "--resource", "--limit"]));
  const operationId = readFlag(argv, "--operation-id");
  const resource = readFlag(argv, "--resource");
  const limit = Number(readFlag(argv, "--limit") ?? "20");
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
    observations: [`${filtered.length} of ${commandRegistry.length} public operations shown.`],
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

function readFlag(argv: readonly string[], flag: string): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === flag) {
      return argv[index + 1];
    }
    if (value.startsWith(`${flag}=`)) {
      return value.slice(flag.length + 1);
    }
  }
  return undefined;
}

function assertKnownFlags(argv: readonly string[], knownFlags: ReadonlySet<string>): void {
  for (const value of argv) {
    if (!value.startsWith("-")) {
      continue;
    }
    const name = flagName(value);
    if (!knownFlags.has(name)) {
      throw usageError(`Unknown flag: ${name}`);
    }
  }
}

function flagName(value: string): string {
  return value.includes("=") ? value.slice(0, value.indexOf("=")) : value;
}

if (import.meta.main) {
  process.exit(await main());
}
