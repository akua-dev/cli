import { usageError } from "./errors";

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

const EXPLICIT_OUTPUT_MODES = ["human", "agent", "json", "quiet"] as const;

export function detectOutputMode(input: OutputModeInput): OutputMode {
  const explicit = readExplicitMode(input.argv, input.env);
  if (explicit) {
    return explicit;
  }

  if (hasAnyEnv(input.env, AGENT_ENV_VARS) || hasAnyEnv(input.env, AUTOMATION_ENV_VARS)) {
    return "agent";
  }

  if (input.stdoutIsTTY === false) {
    return "agent";
  }

  return "human";
}

export function isAutomationMode(mode: OutputMode): boolean {
  return mode === "agent" || mode === "json" || mode === "quiet";
}

function readExplicitMode(argv: readonly string[], env: Record<string, string | undefined>): OutputMode | undefined {
  const outputFlag = readOutputFlag(argv);
  const envMode = readEnvOutputMode(env);

  if (argv.includes("--json")) {
    return "json";
  }
  if (argv.includes("--quiet") || argv.includes("-q")) {
    return "quiet";
  }

  return outputFlag ?? envMode;
}

function readOutputFlag(argv: readonly string[]): OutputMode | undefined {
  let mode: OutputMode | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--output" || value === "-o") {
      const raw = argv[index + 1];
      if (raw === undefined || raw === "" || raw.startsWith("-")) {
        throw usageError(`Missing value for ${value}. Expected one of: ${EXPLICIT_OUTPUT_MODES.join(", ")}.`);
      }
      mode = parseOutputMode(raw);
      index += 1;
      continue;
    }
    if (value.startsWith("--output=") || value.startsWith("-o=")) {
      const [flag, raw] = splitFlagAssignment(value);
      if (raw === "") {
        throw usageError(`Missing value for ${flag}. Expected one of: ${EXPLICIT_OUTPUT_MODES.join(", ")}.`);
      }
      mode = parseOutputMode(raw);
    }
  }
  return mode;
}

function readEnvOutputMode(env: Record<string, string | undefined>): OutputMode | undefined {
  if (env.AKUA_OUTPUT === undefined) {
    return undefined;
  }
  if (env.AKUA_OUTPUT === "") {
    throw usageError(`Invalid AKUA_OUTPUT value: . Expected one of: ${EXPLICIT_OUTPUT_MODES.join(", ")}.`);
  }
  return parseOutputMode(env.AKUA_OUTPUT, "AKUA_OUTPUT");
}

function parseOutputMode(value: string, source = "--output"): OutputMode {
  if (EXPLICIT_OUTPUT_MODES.includes(value as OutputMode)) {
    return value as OutputMode;
  }
  throw usageError(`Invalid ${source} value: ${value}. Expected one of: ${EXPLICIT_OUTPUT_MODES.join(", ")}.`);
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
