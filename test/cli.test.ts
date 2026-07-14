import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { authView, readProtectedCallerToken } from "../src/commands/auth";
import { renderSuccess } from "../src/runtime/render";

describe("akua entrypoint", () => {
  test("fails loudly on unknown flags", async () => {
    const { stdout, exitCode } = await runAkua(["commands", "--bogus", "--output", "json"]);
    expect(exitCode).toBe(2);
    expect(JSON.parse(stdout)).toMatchObject({
      error: {
        type: "usage_error",
        code: "AKUA_USAGE_ERROR",
        message: "Unknown flag: --bogus",
      },
    });
  });

  test("documents generic HCloud setup without exposing a credential input", async () => {
    const { stdout, exitCode } = await runAkua(["--help", "--json"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("akua hcloud setup");
    expect(stdout).toContain("--token-file");
    expect(stdout).not.toContain("load-hcloud-provider");
    expect(stdout).not.toContain("--token <");
  });

  test("fails invalid explicit output modes before routing", async () => {
    const { stdout, exitCode } = await runAkua(["--output", "yaml", "--version"]);
    expect(exitCode).toBe(2);
    expect(stdout).toContain("Invalid --output value: yaml");
  });

  test("rejects undocumented toon output mode", async () => {
    const flag = await runAkua(["--output", "toon", "--version"]);
    expect(flag.exitCode).toBe(2);
    expect(flag.stdout).toContain("Invalid --output value: toon");

    const env = await runAkua(["--version"], { AKUA_OUTPUT: "toon" });
    expect(env.exitCode).toBe(2);
    expect(env.stdout).toContain("Invalid AKUA_OUTPUT value: toon");
  });

  test("fails missing explicit output mode values before routing", async () => {
    const { stdout, exitCode } = await runAkua(["--output", "--version"]);
    expect(exitCode).toBe(2);
    expect(stdout).toContain("Missing value for --output");
  });

  test("fails invalid AKUA_OUTPUT values before routing", async () => {
    const { stdout, exitCode } = await runAkua(["--version"], { AKUA_OUTPUT: "yaml" });
    expect(exitCode).toBe(2);
    expect(stdout).toContain("Invalid AKUA_OUTPUT value: yaml");
  });

  test("requires commands filter values", async () => {
    const { stdout, exitCode } = await runAkua(["commands", "--operation-id", "--json"]);
    expect(exitCode).toBe(2);
    expect(JSON.parse(stdout)).toMatchObject({
      error: {
        type: "usage_error",
        code: "AKUA_USAGE_ERROR",
        message: "Missing value for --operation-id.",
      },
    });
  });

  test("requires resource filter values", async () => {
    const { stdout, exitCode } = await runAkua(["commands", "--resource=", "--json"]);
    expect(exitCode).toBe(2);
    expect(JSON.parse(stdout)).toMatchObject({
      error: {
        message: "Missing value for --resource.",
      },
    });
  });

  test("requires positive integer command limits", async () => {
    const invalid = await runAkua(["commands", "--limit", "banana", "--json"]);
    expect(invalid.exitCode).toBe(2);
    expect(JSON.parse(invalid.stdout)).toMatchObject({
      error: {
        message: "Invalid value for --limit: banana. Expected a positive integer.",
      },
    });

    const zero = await runAkua(["commands", "--limit=0", "--json"]);
    expect(zero.exitCode).toBe(2);
    expect(JSON.parse(zero.stdout)).toMatchObject({
      error: {
        message: "Invalid value for --limit: 0. Expected a positive integer.",
      },
    });
  });

  test("rejects unexpected commands positional arguments", async () => {
    const resource = await runAkua(["commands", "workspaces", "--json"]);
    expect(resource.exitCode).toBe(2);
    expect(JSON.parse(resource.stdout)).toMatchObject({
      error: {
        type: "usage_error",
        code: "AKUA_USAGE_ERROR",
        message: "Unexpected argument for commands: workspaces",
      },
    });

    const extra = await runAkua(["commands", "--limit", "5", "extra", "--json"]);
    expect(extra.exitCode).toBe(2);
    expect(JSON.parse(extra.stdout)).toMatchObject({
      error: {
        message: "Unexpected argument for commands: extra",
      },
    });
  });

  test("auth login stores a token with user-only permissions", async () => {
    const home = await makeTempHome();
    try {
      const token = "sk_akua_test_login";
      const { stdout, exitCode } = await runAkua(["auth", "login", "--token", token, "--json"], { HOME: home });
      const payload = JSON.parse(stdout);
      const configPath = join(home, ".config", "akua", "config.json");

      expect(exitCode).toBe(0);
      expect(stdout).not.toContain(token);
      expect(payload).toMatchObject({
        status: "ok",
        command: "akua auth login",
        data: {
          authenticated: true,
          source: "config",
          config_path: configPath,
        },
      });
      expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({ token });
      expect((await stat(join(home, ".config", "akua"))).mode & 0o777).toBe(0o700);
      expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("auth login replaces an existing protected config file", async () => {
    const home = await makeTempHome();
    try {
      const configPath = join(home, ".config", "akua", "config.json");
      await runAkua(["auth", "login", "--token", "sk_akua_old", "--quiet"], { HOME: home });
      await chmod(configPath, 0o444);

      const { stdout, exitCode } = await runAkua(["auth", "login", "--token", "sk_akua_new", "--json"], { HOME: home });

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({
        status: "ok",
        command: "akua auth login",
      });
      expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({ token: "sk_akua_new" });
      expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("auth login preserves unrelated config keys", async () => {
    const home = await makeTempHome();
    try {
      const configDir = join(home, ".config", "akua");
      const configPath = join(configDir, "config.json");
      await mkdir(configDir, { recursive: true });
      await writeFile(
        configPath,
        `${JSON.stringify({ profile: "dev", endpoint: "https://api.example.test", token: "sk_akua_old" }, null, 2)}\n`,
      );

      const { exitCode } = await runAkua(["auth", "login", "--token", "sk_akua_new", "--json"], { HOME: home });

      expect(exitCode).toBe(0);
      expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
        profile: "dev",
        endpoint: "https://api.example.test",
        token: "sk_akua_new",
      });
      expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("auth status gives AKUA_API_TOKEN precedence over stored tokens", async () => {
    const home = await makeTempHome();
    try {
      await runAkua(["auth", "login", "--token", "sk_akua_stored", "--quiet"], { HOME: home });
      const { stdout, exitCode } = await runAkua(["auth", "status", "--json"], {
        HOME: home,
        AKUA_API_TOKEN: "sk_akua_env",
      });

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({
        status: "ok",
        command: "akua auth status",
        observations: ["Authenticated with AKUA_API_TOKEN."],
        data: {
          authenticated: true,
          source: "env",
        },
      });
      expect(stdout).not.toContain("sk_akua_env");
      expect(stdout).not.toContain("sk_akua_stored");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("auth status honors AKUA_API_TOKEN without HOME", async () => {
    for (const home of [undefined, ""]) {
      const envelope = await authView(["status"], {
        HOME: home,
        AKUA_API_TOKEN: "sk_akua_env",
      });
      const stdout = renderSuccess(envelope, "json");
      const payload = JSON.parse(stdout);

      expect(payload).toMatchObject({
        status: "ok",
        command: "akua auth status",
        observations: ["Authenticated with AKUA_API_TOKEN."],
        data: {
          authenticated: true,
          source: "env",
        },
      });
      expect(payload.data).not.toHaveProperty("config_path");
      expect(stdout).not.toContain("sk_akua_env");
    }
  });

  test("auth logout removes stored token without clearing AKUA_API_TOKEN", async () => {
    const home = await makeTempHome();
    try {
      await runAkua(["auth", "login", "--token", "sk_akua_stored", "--quiet"], { HOME: home });
      const { stdout, exitCode } = await runAkua(["auth", "logout", "--json"], {
        HOME: home,
        AKUA_API_TOKEN: "sk_akua_env",
      });
      const status = await runAkua(["auth", "status", "--json"], { HOME: home });

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({
        observations: ["Stored authentication token removed. AKUA_API_TOKEN is still active."],
        data: {
          authenticated: true,
          source: "env",
        },
      });
      expect(JSON.parse(status.stdout)).toMatchObject({
        data: {
          authenticated: false,
          source: "none",
        },
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("auth logout removes only the stored token", async () => {
    const home = await makeTempHome();
    try {
      const configDir = join(home, ".config", "akua");
      const configPath = join(configDir, "config.json");
      await mkdir(configDir, { recursive: true });
      await writeFile(
        configPath,
        `${JSON.stringify({ profile: "dev", endpoint: "https://api.example.test", token: "sk_akua_stored" }, null, 2)}\n`,
      );

      const { stdout, exitCode } = await runAkua(["auth", "logout", "--json"], { HOME: home });
      const status = await runAkua(["auth", "status", "--json"], { HOME: home });

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({
        observations: ["Stored authentication token removed."],
        data: {
          authenticated: false,
          source: "none",
        },
      });
      expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
        profile: "dev",
        endpoint: "https://api.example.test",
      });
      expect(JSON.parse(status.stdout)).toMatchObject({
        data: {
          authenticated: false,
          source: "none",
        },
      });
      expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("auth status reports malformed config as a runtime error", async () => {
    const home = await makeTempHome();
    try {
      const configPath = join(home, ".config", "akua", "config.json");
      await runAkua(["auth", "login", "--token", "sk_akua_stored", "--quiet"], { HOME: home });
      await writeFile(configPath, "{not json\n");

      const { stdout, exitCode } = await runAkua(["auth", "status", "--json"], { HOME: home });

      expect(exitCode).toBe(1);
      expect(JSON.parse(stdout)).toMatchObject({
        error: {
          type: "runtime_error",
          code: "AKUA_CONFIG_ERROR",
        },
      });
      expect(stdout).toContain("Failed to read Akua config");
      expect(stdout).not.toContain("akua --help");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("auth logout removes malformed stored config", async () => {
    const home = await makeTempHome();
    try {
      const configPath = join(home, ".config", "akua", "config.json");
      await runAkua(["auth", "login", "--token", "sk_akua_stored", "--quiet"], { HOME: home });
      await writeFile(configPath, "{not json\n");

      const { stdout, exitCode } = await runAkua(["auth", "logout", "--json"], { HOME: home });
      const status = await runAkua(["auth", "status", "--json"], { HOME: home });

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({
        observations: ["Stored authentication token removed."],
        data: {
          authenticated: false,
          source: "none",
        },
      });
      expect(JSON.parse(status.stdout)).toMatchObject({
        data: {
          authenticated: false,
          source: "none",
        },
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("auth login requires an explicit token flag", async () => {
    const home = await makeTempHome();
    try {
      const missingFlag = await runAkua(["auth", "login", "--json"], { HOME: home });
      expect(missingFlag.exitCode).toBe(2);
      expect(JSON.parse(missingFlag.stdout)).toMatchObject({
        error: {
          message: "Missing required --token flag.",
        },
      });

      const missingValue = await runAkua(["auth", "login", "--token", "--json"], { HOME: home });
      expect(missingValue.exitCode).toBe(2);
      expect(JSON.parse(missingValue.stdout)).toMatchObject({
        error: {
          message: "Missing value for --token.",
        },
      });

      const tokenLikePositional = "sk_akua_secret_positional";
      const positional = await runAkua(["auth", "login", tokenLikePositional, "--json"], { HOME: home });
      expect(positional.exitCode).toBe(2);
      expect(JSON.parse(positional.stdout)).toMatchObject({
        error: {
          message: "Unexpected argument for auth login.",
        },
      });
      expect(positional.stdout).not.toContain(tokenLikePositional);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("auth positional usage errors do not echo token-like values", async () => {
    const home = await makeTempHome();
    try {
      const tokenLikeValue = "sk_akua_secret_positional";
      const unknownSubcommand = await runAkua(["auth", tokenLikeValue, "--json"], { HOME: home });
      expect(unknownSubcommand.exitCode).toBe(2);
      expect(JSON.parse(unknownSubcommand.stdout)).toMatchObject({
        error: {
          message: "Unknown auth subcommand.",
        },
      });
      expect(unknownSubcommand.stdout).not.toContain(tokenLikeValue);

      const statusExtra = await runAkua(["auth", "status", tokenLikeValue, "--json"], { HOME: home });
      expect(statusExtra.exitCode).toBe(2);
      expect(JSON.parse(statusExtra.stdout)).toMatchObject({
        error: {
          message: "Unexpected argument for auth status.",
        },
      });
      expect(statusExtra.stdout).not.toContain(tokenLikeValue);

      const logoutExtra = await runAkua(["auth", "logout", tokenLikeValue, "--json"], { HOME: home });
      expect(logoutExtra.exitCode).toBe(2);
      expect(JSON.parse(logoutExtra.stdout)).toMatchObject({
        error: {
          message: "Unexpected argument for auth logout.",
        },
      });
      expect(logoutExtra.stdout).not.toContain(tokenLikeValue);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("HCloud setup caller authentication reads only the protected local config", async () => {
    const home = await makeTempHome();
    try {
      const configDir = join(home, ".config", "akua");
      const configPath = join(configDir, "config.json");
      await mkdir(configDir, { recursive: true, mode: 0o700 });
      await writeFile(configPath, JSON.stringify({ token: "caller-auth-fixture" }), { mode: 0o600 });
      await chmod(configDir, 0o700);
      await chmod(configPath, 0o600);

      await expect(readProtectedCallerToken({ HOME: home })).resolves.toBe("caller-auth-fixture");
      await expect(readProtectedCallerToken({ HOME: home, AKUA_API_TOKEN: "environment-auth-fixture" })).rejects.toMatchObject({
        code: "AKUA_HCLOUD_ENV_AUTH_FORBIDDEN",
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

async function runAkua(args: readonly string[], env: Record<string, string> = {}) {
  const childEnv = { ...process.env, ...env };
  if (!("AKUA_OUTPUT" in env)) {
    delete childEnv.AKUA_OUTPUT;
  }
  if (!("AKUA_API_TOKEN" in env)) {
    delete childEnv.AKUA_API_TOKEN;
  }

  const proc = Bun.spawn({
    cmd: ["bun", "src/bin/akua.ts", ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv,
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function makeTempHome(): Promise<string> {
  return mkdtemp(join(process.cwd(), ".tmp-akua-home-"));
}
