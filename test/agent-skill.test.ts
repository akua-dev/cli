import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";

const SKILL_PATH = "skills/agent-skills-standard-following/SKILL.md";
const PACKAGE_PATH = "skills/agent-skills-standard-following/skill-package.json";
const SKILL_NAME = "agent-skills-standard-following";
const SOURCE_REPOSITORY = "https://github.com/akua-dev/cli";

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

  test("rejects malformed or non-standard frontmatter", () => {
    const malformed = `---\nname: ${SKILL_NAME}\ndescription:\nversion: 1.0.0\n---\n# Akua\n`;

    expect(() => validateFrontmatter(SKILL_PATH, malformed)).toThrow("frontmatter keys");
  });

  test("rejects skill path and name drift", () => {
    const drifted = `---\nname: another-skill\ndescription: Use when working with Akua.\n---\n# Akua\n`;

    expect(() => validateFrontmatter(SKILL_PATH, drifted)).toThrow("must match its parent directory");
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

  const entries = match[1].split("\n").map((line) => {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      throw new Error("frontmatter must contain scalar key-value pairs");
    }
    return [line.slice(0, separator), line.slice(separator + 1).trim()] as const;
  });
  const fields = Object.fromEntries(entries);

  if (entries.map(([key]) => key).join(",") !== "name,description" || !fields.name || !fields.description) {
    throw new Error("frontmatter keys must be exactly name and description");
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fields.name) || fields.name.length > 64) {
    throw new Error("skill name must follow the Agent Skills naming rules");
  }
  if (fields.name !== basename(dirname(path))) {
    throw new Error("skill name must match its parent directory");
  }
  if (fields.description.length > 1024) {
    throw new Error("skill description must not exceed 1024 characters");
  }
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
  return `---\nname: ${SKILL_NAME}\ndescription: Use when working with Akua.\n---\n# Akua\n`;
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
