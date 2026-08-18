import { describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";

const EFFECT_SKILL_PATH = "skills/effect-v4/SKILL.md";
const AGENTS_PATH = "AGENTS.md";

const BASELINE_PRESSURE_RESPONSE = `
I will add an async inspectDevice(): Promise<Device> command, await fetch(),
cast the payload as Device, use as const for the command definition, and await
Effect.runPromise() from the command handler so I can ship it in ten minutes.
`;

describe("Effect v4 CLI quality guidance", () => {
  test("shows that the pre-skill pressure response violates the policy", () => {
    expect(BASELINE_PRESSURE_RESPONSE).toMatch(/\basync\b/);
    expect(BASELINE_PRESSURE_RESPONSE).toMatch(/\bPromise\b/);
    expect(BASELINE_PRESSURE_RESPONSE).toMatch(/\bawait\b/);
    expect(BASELINE_PRESSURE_RESPONSE).toMatch(/\bfetch\b/);
    expect(BASELINE_PRESSURE_RESPONSE).toMatch(/\bas\b/);
    expect(BASELINE_PRESSURE_RESPONSE).toMatch(/\bas const\b/);
    expect(BASELINE_PRESSURE_RESPONSE).toMatch(/\brunPromise\b/);
  });

  test("requires a discoverable, auditable Effect v4 skill", () => {
    const skill = readFileSync(EFFECT_SKILL_PATH, "utf8");

    expect(skill).toMatch(/^---\nname: effect-v4\ndescription: Use when .*Effect v4.*CLI/m);
    for (const rule of [
      "effect@4.0.0-rc.109",
      "Effect services and layers",
      "Data.TaggedError",
      "TestClock",
      "test layers",
      "`Promise`",
      "`async`",
      "`await`",
      "`throw`",
      "`runPromise`",
      "`as`",
      "`as const`",
      "direct host I/O",
      "production `src/` and `scripts/`",
      "schema",
      "type guard",
      "`satisfies`",
      "binary terminal",
      "fiber",
      "## Red flags",
      "mise run check",
      "bun run test",
    ]) {
      expect(skill).toContain(rule);
    }
    expect(skill).toContain("do not use native `Promise`");
  });

  test("makes the Effect v4 skill and source scans mandatory for production CLI changes", () => {
    const agents = readFileSync(AGENTS_PATH, "utf8");

    expect(agents).toContain("effect-v4");
    expect(agents).toContain("production CLI");
    expect(agents).toContain("source scan");
    expect(agents).toContain("mise run check");
  });

  test("keeps generated public commands provider-neutral and Effect-only", () => {
    const agents = readFileSync(AGENTS_PATH, "utf8");
    const skill = readFileSync(EFFECT_SKILL_PATH, "utf8");

    for (const rule of [
      "`openapi/public.json` is the only source of truth",
      "provider-neutral",
      "generated path, query, header, and body",
      "fail on warnings, skipped public",
      "raw `throw`",
      "typed error channel",
      "Pure immutable data",
    ]) {
      expect(agents).toContain(rule);
    }

    expect(skill).toContain("raw `throw`");
    expect(skill).toContain("typed `Data.TaggedError`");
  });

  test("keeps Effect v4 as the only repository-local skill", () => {
    expect(existsSync(".agents/skills")).toBe(false);
    expect(existsSync(".superpowers")).toBe(false);
  });
});
