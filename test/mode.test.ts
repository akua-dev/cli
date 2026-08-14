import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { detectOutputMode } from "../src/runtime/mode";

describe("detectOutputMode", () => {
  test("prefers explicit json flag", () => {
    expect(
      expectMode({
        argv: ["--json"],
        env: { CODEX_SANDBOX: "1" },
        stdoutIsTTY: true,
      }),
    ).toBe("json");
  });

  test("detects known coding agent environments", () => {
    for (const name of [
      "CODEX_SANDBOX",
      "CLAUDECODE",
      "CURSOR_AGENT",
      "AIDER",
      "DEVIN",
      "OPENCODE",
      "AMP",
      "CODY_AGENT",
      "REPLIT_AGENT",
      "WINDSURF_AGENT",
    ]) {
      expect(
        expectMode({
          argv: [],
          env: { [name]: "1" },
          stdoutIsTTY: true,
        }),
      ).toBe("agent");
    }
  });

  test("detects universal agent environment flag", () => {
    expect(
      expectMode({
        argv: [],
        env: { AGENT: "true" },
        stdoutIsTTY: true,
      }),
    ).toBe("agent");
  });

  test("detects universal agent environment name", () => {
    expect(
      expectMode({
        argv: [],
        env: { AGENT: "codex" },
        stdoutIsTTY: true,
      }),
    ).toBe("agent");
  });

  test("ignores false universal agent values", () => {
    for (const value of ["", "0", "false", "FALSE"]) {
      expect(
        expectMode({
          argv: [],
          env: { AGENT: value },
          stdoutIsTTY: true,
        }),
      ).toBe("human");
    }
  });

  test("detects CI and non-tty automation", () => {
    expect(
      expectMode({
        argv: [],
        env: { CI: "true" },
        stdoutIsTTY: true,
      }),
    ).toBe("agent");
    expect(expectMode({ argv: [], env: {}, stdoutIsTTY: false })).toBe(
      "agent",
    );
  });

  test("treats an unknown TTY state as non-interactive", () => {
    // Node/Bun report isTTY as undefined (not false) for piped stdout, so
    // undefined must select structured output for piped consumers.
    expect(expectMode({ argv: [], env: {}, stdoutIsTTY: undefined })).toBe(
      "agent",
    );
    expect(expectMode({ argv: [], env: {} })).toBe("agent");
  });

  test("uses human output for interactive sessions without automation signals", () => {
    expect(expectMode({ argv: [], env: {}, stdoutIsTTY: true })).toBe("human");
  });

  test("rejects undocumented output aliases", () => {
    expectModeFailure(
      { argv: ["--output", "toon"], env: {}, stdoutIsTTY: true },
      "Invalid --output value: toon",
    );
    expectModeFailure(
      { argv: [], env: { AKUA_OUTPUT: "toon" }, stdoutIsTTY: true },
      "Invalid AKUA_OUTPUT value: toon",
    );
  });
});

function expectMode(
  input: Parameters<typeof detectOutputMode>[0],
) {
  return Effect.runSync(detectOutputMode(input));
}

function expectModeFailure(
  input: Parameters<typeof detectOutputMode>[0],
  message: string,
) {
  expect(Effect.runSync(Effect.flip(detectOutputMode(input))).message).toContain(
    message,
  );
}
