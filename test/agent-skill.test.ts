import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";

const SKILL_PATH = "skills/akua/SKILL.md";
const PACKAGE_PATH = "skills/akua/skill-package.json";
const SKILL_NAME = "akua";
const SOURCE_REPOSITORY = "https://github.com/akua-dev/cli";
const FRONTMATTER_FIELDS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]);

interface SkillPackage {
  schema_version: number;
  name: string;
  version: string;
  provenance: {
    repository: string;
    path: string;
    revision_source: string;
  };
  files: Array<{
    path: string;
    sha256: string;
  }>;
}

describe("canonical Akua agent skill", () => {
  test("is a valid, release-versioned Agent Skills artifact", () => {
    const skill = readFileSync(SKILL_PATH, "utf8");
    const skillPackage = readSkillPackage(PACKAGE_PATH);
    const rootPackage = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };

    expect(() => validateFrontmatter(SKILL_PATH, skill)).not.toThrow();
    expect(() => validateSkillPackage(skillPackage, skill, rootPackage.version)).not.toThrow();
  });

  test("directs authentication setup through the human without exposing tokens", () => {
    const skill = readFileSync(SKILL_PATH, "utf8");

    expect(skill).toContain(
      "Agents must never place authentication tokens in tool arguments, process argv, transcripts, or logs.",
    );
    expect(skill).toContain(
      "instruct the human to run `akua auth login --token <token>` privately and locally themselves",
    );
    expect(skill).toContain("agents may run `akua auth status --output agent`");
  });

  test("accepts standard optional frontmatter fields in any key order", () => {
    const reordered = skillWithFrontmatter(`allowed-tools: Bash(git:*) Read
metadata:
  author: akua-dev
  version: "1.0"
description: Use when working with Akua.
license: Apache-2.0
name: ${SKILL_NAME}
compatibility: Requires Bun 1.3.7 or newer`);

    expect(() => validateFrontmatter(SKILL_PATH, reordered)).not.toThrow();
  });

  test("rejects unknown frontmatter fields", () => {
    const unknown = skillWithFrontmatter(`name: ${SKILL_NAME}
description: Use when working with Akua.
version: 1.0.0`);

    expect(() => validateFrontmatter(SKILL_PATH, unknown)).toThrow("unknown frontmatter field: version");
  });

  test("rejects invalid optional frontmatter field values", () => {
    const invalidFields = [
      "license: []",
      "compatibility: 1",
      `compatibility: ${"x".repeat(501)}`,
      "metadata: []",
      "metadata:\n  version: 1",
      "allowed-tools: []",
    ];

    for (const field of invalidFields) {
      const invalid = skillWithFrontmatter(`name: ${SKILL_NAME}
description: Use when working with Akua.
${field}`);

      expect(() => validateFrontmatter(SKILL_PATH, invalid)).toThrow();
    }
  });

  test("rejects invalid descriptions", () => {
    const missing = skillWithFrontmatter(`name: ${SKILL_NAME}`);
    const blank = skillWithFrontmatter(`name: ${SKILL_NAME}
description: "   "`);

    expect(() => validateFrontmatter(SKILL_PATH, missing)).toThrow("description must be a non-empty string");
    expect(() => validateFrontmatter(SKILL_PATH, blank)).toThrow("description must be a non-empty string");
  });

  test("rejects invalid YAML frontmatter syntax", () => {
    const invalidYaml = `---\nname: ${SKILL_NAME}\ndescription: [unterminated\n---\n# Akua\n`;

    expect(() => validateFrontmatter(SKILL_PATH, invalidYaml)).toThrow();
  });

  test("rejects skill path and name drift", () => {
    const drifted = `---\nname: another-skill\ndescription: Use when working with Akua.\n---\n# Akua\n`;

    expect(() => validateFrontmatter(SKILL_PATH, drifted)).toThrow("must match its parent directory");
  });

  test("rejects task-shaped public skill identities", () => {
    const taskShapedPath = "skills/agent-skill-compliance-task/SKILL.md";
    const taskShaped = `---\nname: agent-skill-compliance-task\ndescription: Use when working with Akua.\n---\n# Akua\n`;

    expect(() => validateFrontmatter(taskShapedPath, taskShaped)).toThrow("must use the canonical Akua identity");
  });

  test("rejects stale version and provenance metadata", () => {
    const skill = validSkill();
    const staleVersion = { ...validSkillPackage(skill), version: "0.0.0" };
    const staleProvenance = {
      ...validSkillPackage(skill),
      provenance: { ...validSkillPackage(skill).provenance, repository: "https://github.com/akua-dev/skills" },
    };

    expect(() => validateSkillPackage(staleVersion, skill, "1.2.3")).toThrow("version must match");
    expect(() => validateSkillPackage(staleProvenance, skill, "1.2.3")).toThrow("provenance must identify");
  });

  test("rejects non-deterministic or stale package contents", () => {
    const skill = validSkill();
    const generatedAt = { ...validSkillPackage(skill), generated_at: new Date().toISOString() };
    const staleDigest = {
      ...validSkillPackage(skill),
      files: [{ path: "SKILL.md", sha256: "0".repeat(64) }],
    };

    expect(() => validateSkillPackage(generatedAt, skill, "1.2.3")).toThrow("package keys");
    expect(() => validateSkillPackage(staleDigest, skill, "1.2.3")).toThrow("deterministic SKILL.md digest");
  });

  test("release automation keeps skill package version metadata current", () => {
    const config = JSON.parse(readFileSync("release-please-config.json", "utf8")) as {
      packages?: Record<string, { "extra-files"?: unknown[] }>;
    };

    expect(config.packages?.["."]?.["extra-files"]).toContainEqual({
      type: "json",
      path: PACKAGE_PATH,
      jsonpath: "$.version",
    });
  });
});

function validateFrontmatter(path: string, source: string): void {
  const match = source.match(/^---\n([\s\S]*?)\n---\n([\s\S]+)$/);
  if (!match) {
    throw new Error("SKILL.md must contain YAML frontmatter followed by Markdown");
  }

  const parsed: unknown = Bun.YAML.parse(match[1]);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("frontmatter must be a YAML mapping");
  }

  const fields = parsed as Record<string, unknown>;
  const unknownFields = Object.keys(fields).filter((field) => !FRONTMATTER_FIELDS.has(field));
  if (unknownFields.length > 0) {
    throw new Error(`unknown frontmatter field: ${unknownFields.join(", ")}`);
  }

  const name = fields.name;
  const description = fields.description;
  if (typeof name !== "string" || !name) {
    throw new Error("skill name must be a non-empty string");
  }
  if (typeof description !== "string" || !description.trim()) {
    throw new Error("skill description must be a non-empty string");
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    throw new Error("skill name must follow the Agent Skills naming rules");
  }
  if (name !== basename(dirname(path))) {
    throw new Error("skill name must match its parent directory");
  }
  if (name !== SKILL_NAME) {
    throw new Error("skill name must use the canonical Akua identity");
  }
  if (description.length > 1024) {
    throw new Error("skill description must not exceed 1024 characters");
  }

  validateOptionalString(fields, "license");
  validateOptionalString(fields, "allowed-tools");

  const compatibility = validateOptionalString(fields, "compatibility");
  if (compatibility !== undefined && (compatibility.length === 0 || compatibility.length > 500)) {
    throw new Error("skill compatibility must contain 1-500 characters");
  }

  const metadata = fields.metadata;
  if (metadata !== undefined) {
    if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
      throw new Error("skill metadata must be a string-to-string mapping");
    }
    if (Object.values(metadata).some((value) => typeof value !== "string")) {
      throw new Error("skill metadata must be a string-to-string mapping");
    }
  }
}

function validateOptionalString(fields: Record<string, unknown>, field: string): string | undefined {
  const value = fields[field];
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`skill ${field} must be a string`);
  }
  return value;
}

function validateSkillPackage(skillPackage: SkillPackage, skill: string, rootVersion: string): void {
  if (Object.keys(skillPackage).join(",") !== "schema_version,name,version,provenance,files") {
    throw new Error("package keys must be stable and exclude generated timestamps");
  }
  if (skillPackage.schema_version !== 1 || skillPackage.name !== SKILL_NAME) {
    throw new Error("package schema and name must identify the canonical skill");
  }
  if (skillPackage.version !== rootVersion) {
    throw new Error("skill package version must match the CLI release version");
  }
  if (
    JSON.stringify(skillPackage.provenance) !==
    JSON.stringify({ repository: SOURCE_REPOSITORY, path: SKILL_PATH, revision_source: "git" })
  ) {
    throw new Error("package provenance must identify the CLI-owned source and containing git revision");
  }

  const expectedFiles = [{ path: "SKILL.md", sha256: sha256(skill) }];
  if (JSON.stringify(skillPackage.files) !== JSON.stringify(expectedFiles)) {
    throw new Error("package files must contain the deterministic SKILL.md digest");
  }
}

function readSkillPackage(path: string): SkillPackage {
  return JSON.parse(readFileSync(path, "utf8")) as SkillPackage;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validSkill(): string {
  return skillWithFrontmatter(`name: ${SKILL_NAME}\ndescription: Use when working with Akua.`);
}

function skillWithFrontmatter(frontmatter: string): string {
  return `---\n${frontmatter}\n---\n# Akua\n`;
}

function validSkillPackage(skill: string): SkillPackage {
  return {
    schema_version: 1,
    name: SKILL_NAME,
    version: "1.2.3",
    provenance: {
      repository: SOURCE_REPOSITORY,
      path: SKILL_PATH,
      revision_source: "git",
    },
    files: [{ path: "SKILL.md", sha256: sha256(skill) }],
  };
}
