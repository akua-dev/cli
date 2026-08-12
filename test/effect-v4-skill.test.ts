import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const EFFECT_SKILL_PATH = "skills/effect-v4/SKILL.md";
const AGENTS_PATH = "AGENTS.md";
const REQUIRED_DEVELOPMENT_SKILLS = [
  "test-driven-development",
  "systematic-debugging",
  "simplify",
  "verification-before-completion",
  "writing-skills",
] as const;

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
      "effect@4.0.0-beta.106",
      "Effect services and layers",
      "Data.TaggedError",
      "TestClock",
      "test layers",
      "`Promise`",
      "`async`",
      "`await`",
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
      "bun test",
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

  test("keeps the required development skills and their referenced source material local", () => {
    for (const skill of REQUIRED_DEVELOPMENT_SKILLS) {
      expect(readFileSync(`.agents/skills/${skill}/SKILL.md`, "utf8")).not.toBe("");
    }

    for (const sourceDocument of [
      ".agents/skills/test-driven-development/testing-anti-patterns.md",
      ".agents/skills/systematic-debugging/root-cause-tracing.md",
      ".agents/skills/systematic-debugging/defense-in-depth.md",
      ".agents/skills/systematic-debugging/condition-based-waiting.md",
      ".agents/skills/systematic-debugging/condition-based-waiting-example.ts",
      ".agents/skills/writing-skills/anthropic-best-practices.md",
      ".agents/skills/writing-skills/graphviz-conventions.dot",
      ".agents/skills/writing-skills/persuasion-principles.md",
      ".agents/skills/writing-skills/render-graphs.js",
      ".agents/skills/writing-skills/testing-skills-with-subagents.md",
    ]) {
      expect(readFileSync(sourceDocument, "utf8")).not.toBe("");
    }
  });
});
