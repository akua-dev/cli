#!/usr/bin/env bun
import { authView } from "../commands/auth";
import { agentOsView } from "../commands/agent-os";
import { buildHomeView } from "../commands/home";
import { commandRegistry } from "../generated/commands.gen";
import { AkuaCliError, commandNotImplemented, usageError } from "../runtime/errors";
import { detectOutputMode, type OutputMode } from "../runtime/mode";
import { renderError, renderSuccess, type RenderEnvelope } from "../runtime/render";

const VERSION = "0.8.0"; // x-release-please-version

export async function main(argv = process.argv.slice(2), env = process.env): Promise<number> {
  let mode: OutputMode = fallbackErrorMode(argv);
  try {
    mode = detectOutputMode({ argv, env, stdoutIsTTY: process.stdout.isTTY });
    const command = await route(stripGlobalFlags(argv), env);
    process.stdout.write(renderSuccess(command, mode));
    return 0;
  } catch (error) {
    const cliError = error instanceof AkuaCliError ? error : usageError(error instanceof Error ? error.message : String(error));
    process.stdout.write(renderError(cliError, mode));
    return cliError.exitCode;
  }
}

async function route(argv: readonly string[], env: Record<string, string | undefined>): Promise<RenderEnvelope> {
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

  if (argv[0] === "auth") {
    return authView(argv.slice(1), env);
  }

  if (argv[0] === "agent-os") {
    return agentOsView(argv.slice(1), env);
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
    if (next === undefined || (next.startsWith("-") && !(flag === "--limit" && /^-\d/.test(next)))) {
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
    throw usageError(`Invalid value for ${flag}: ${value}. Expected a positive integer.`);
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

if (import.meta.main) {
  process.exit(await main());
}
