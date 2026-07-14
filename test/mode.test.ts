import { describe, expect, test } from "bun:test";

import { detectOutputMode } from "../src/runtime/mode";

describe("detectOutputMode", () => {
  test("prefers explicit json flag", () => {
    expect(detectOutputMode({ argv: ["--json"], env: { CODEX_SANDBOX: "1" }, stdoutIsTTY: true })).toBe("json");
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
      expect(detectOutputMode({ argv: [], env: { [name]: "1" }, stdoutIsTTY: true })).toBe("agent");
    }
  });

  test("detects universal agent environment flag", () => {
    expect(detectOutputMode({ argv: [], env: { AGENT: "true" }, stdoutIsTTY: true })).toBe("agent");
  });

  test("detects universal agent environment name", () => {
    expect(detectOutputMode({ argv: [], env: { AGENT: "codex" }, stdoutIsTTY: true })).toBe("agent");
  });

  test("ignores false universal agent values", () => {
    for (const value of ["", "0", "false", "FALSE"]) {
      expect(detectOutputMode({ argv: [], env: { AGENT: value }, stdoutIsTTY: true })).toBe("human");
    }
  });

  test("detects CI and non-tty automation", () => {
    expect(detectOutputMode({ argv: [], env: { CI: "true" }, stdoutIsTTY: true })).toBe("agent");
    expect(detectOutputMode({ argv: [], env: {}, stdoutIsTTY: false })).toBe("agent");
  });

  test("uses human output for interactive sessions without automation signals", () => {
    expect(detectOutputMode({ argv: [], env: {}, stdoutIsTTY: true })).toBe("human");
  });

  test("rejects undocumented output aliases", () => {
    expect(() => detectOutputMode({ argv: ["--output", "toon"], env: {}, stdoutIsTTY: true })).toThrow(
      "Invalid --output value: toon",
    );
    expect(() => detectOutputMode({ argv: [], env: { AKUA_OUTPUT: "toon" }, stdoutIsTTY: true })).toThrow(
      "Invalid AKUA_OUTPUT value: toon",
    );
  });
});
