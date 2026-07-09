export type OutputMode = "human" | "agent" | "json" | "quiet";

export interface OutputModeInput {
  argv: readonly string[];
  env: Record<string, string | undefined>;
  stdoutIsTTY?: boolean;
}

const AGENT_ENV_VARS = [
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
  if (argv.includes("--json")) {
    return "json";
  }
  if (argv.includes("--quiet") || argv.includes("-q")) {
    return "quiet";
  }

  const outputFlag = readFlagValue(argv, "--output") ?? readFlagValue(argv, "-o") ?? env.AKUA_OUTPUT;
  if (!outputFlag) {
    return undefined;
  }

  if (outputFlag === "toon") {
    return "agent";
  }

  if (outputFlag === "human" || outputFlag === "agent" || outputFlag === "json" || outputFlag === "quiet") {
    return outputFlag;
  }

  return undefined;
}

function readFlagValue(argv: readonly string[], flag: string): string | undefined {
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

function hasAnyEnv(env: Record<string, string | undefined>, names: readonly string[]): boolean {
  return names.some((name) => {
    const value = env[name];
    return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
  });
}
