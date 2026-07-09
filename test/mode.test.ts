import { describe, expect, test } from "bun:test";

import { detectOutputMode } from "../src/runtime/mode";

describe("detectOutputMode", () => {
  test("prefers explicit json flag", () => {
    expect(detectOutputMode({ argv: ["--json"], env: { CODEX_SANDBOX: "1" }, stdoutIsTTY: true })).toBe("json");
  });

  test("detects known coding agent environments", () => {
    expect(detectOutputMode({ argv: [], env: { CODEX_SANDBOX: "1" }, stdoutIsTTY: true })).toBe("agent");
  });

  test("detects CI and non-tty automation", () => {
    expect(detectOutputMode({ argv: [], env: { CI: "true" }, stdoutIsTTY: true })).toBe("agent");
    expect(detectOutputMode({ argv: [], env: {}, stdoutIsTTY: false })).toBe("agent");
  });

  test("uses human output for interactive sessions without automation signals", () => {
    expect(detectOutputMode({ argv: [], env: {}, stdoutIsTTY: true })).toBe("human");
  });
});
