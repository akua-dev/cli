import { Effect } from "effect";

import { UsageFailure } from "./effect-runtime";

export type OutputMode = "human" | "agent" | "json" | "quiet";

export interface OutputModeInput {
  argv: readonly string[];
  env: Record<string, string | undefined>;
  stdoutIsTTY?: boolean;
}

const AGENT_ENV_VARS = [
  "AGENT",
  "CODEX_SANDBOX",
  "CODEX_CLI",
  "OPENAI_CODEX",
  "CLAUDECODE",
  "CLAUDE_CODE",
  "CURSOR_AGENT",
  "AIDER",
  "DEVIN",
  "OPENCODE",
  "AMP",
  "CODY_AGENT",
  "REPLIT_AGENT",
  "WINDSURF_AGENT",
];

const AUTOMATION_ENV_VARS = [
  "CI",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "BUILDKITE",
  "CIRCLECI",
  "JENKINS_URL",
  "TEAMCITY_VERSION",
  "TF_BUILD",
];

const EXPLICIT_OUTPUT_MODES: readonly OutputMode[] = [
  "human",
  "agent",
  "json",
  "quiet",
];

export function detectOutputMode(
  input: OutputModeInput,
): Effect.Effect<OutputMode, UsageFailure> {
  return readExplicitMode(input.argv, input.env).pipe(
    Effect.map((explicit) => {
      if (explicit !== undefined) {
        return explicit;
      }
      if (
        hasAnyEnv(input.env, AGENT_ENV_VARS) ||
        hasAnyEnv(input.env, AUTOMATION_ENV_VARS)
      ) {
        return "agent";
      }
      // Node/Bun report isTTY as undefined (not false) for piped stdout, so
      // anything short of a confirmed TTY selects structured output.
      if (input.stdoutIsTTY !== true) {
        return "agent";
      }
      return "human";
    }),
  );
}

export function isAutomationMode(mode: OutputMode): boolean {
  return mode === "agent" || mode === "json" || mode === "quiet";
}

function readExplicitMode(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): Effect.Effect<OutputMode | undefined, UsageFailure> {
  return readOutputFlag(argv).pipe(
    Effect.flatMap((outputFlag) =>
      readEnvOutputMode(env).pipe(
        Effect.map((envMode) => {
          if (argv.includes("--json")) {
            return "json";
          }
          if (argv.includes("--quiet") || argv.includes("-q")) {
            return "quiet";
          }

          return outputFlag ?? envMode;
        }),
      ),
    ),
  );
}

function readOutputFlag(
  argv: readonly string[],
): Effect.Effect<OutputMode | undefined, UsageFailure> {
  return Effect.gen(function* () {
    let mode: OutputMode | undefined;
    for (let index = 0; index < argv.length; index += 1) {
      const value = argv[index];
      if (value === "--output" || value === "-o") {
        const raw = argv[index + 1];
        if (raw === undefined || raw === "" || raw.startsWith("-")) {
          return yield* invalidMode(
            `Missing value for ${value}. Expected one of: ${EXPLICIT_OUTPUT_MODES.join(", ")}.`,
          );
        }
        mode = yield* parseOutputMode(raw);
        index += 1;
        continue;
      }
      if (value.startsWith("--output=") || value.startsWith("-o=")) {
        const [flag, raw] = splitFlagAssignment(value);
        if (raw === "") {
          return yield* invalidMode(
            `Missing value for ${flag}. Expected one of: ${EXPLICIT_OUTPUT_MODES.join(", ")}.`,
          );
        }
        mode = yield* parseOutputMode(raw);
      }
    }
    return mode;
  });
}

function readEnvOutputMode(
  env: Record<string, string | undefined>,
): Effect.Effect<OutputMode | undefined, UsageFailure> {
  if (env.AKUA_OUTPUT === undefined) {
    return Effect.succeed(undefined);
  }
  if (env.AKUA_OUTPUT === "") {
    return invalidMode(
      `Invalid AKUA_OUTPUT value: . Expected one of: ${EXPLICIT_OUTPUT_MODES.join(", ")}.`,
    );
  }
  return parseOutputMode(env.AKUA_OUTPUT, "AKUA_OUTPUT");
}

function parseOutputMode(
  value: string,
  source = "--output",
): Effect.Effect<OutputMode, UsageFailure> {
  if (isOutputMode(value)) {
    return Effect.succeed(value);
  }
  return invalidMode(
    `Invalid ${source} value: ${value}. Expected one of: ${EXPLICIT_OUTPUT_MODES.join(", ")}.`,
  );
}

function isOutputMode(value: string): value is OutputMode {
  return EXPLICIT_OUTPUT_MODES.some((mode) => mode === value);
}

function splitFlagAssignment(value: string): [string, string] {
  const separator = value.indexOf("=");
  return [value.slice(0, separator), value.slice(separator + 1)];
}

function hasAnyEnv(env: Record<string, string | undefined>, names: readonly string[]): boolean {
  return names.some((name) => {
    const value = env[name];
    return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
  });
}

function invalidMode(
  message: string,
): Effect.Effect<never, UsageFailure> {
  return Effect.fail(new UsageFailure({ message }));
}
