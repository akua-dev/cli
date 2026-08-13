import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { Command } from "effect/unstable/cli";

import {
  collectPublicCommands,
  generateCommandsCommand,
} from "../scripts/generate-commands";
import { ScriptFiles } from "../scripts/runtime/services";
import { cliTestLayer } from "./cli-test-layer";

describe("collectPublicCommands", () => {
  test("parses --check and fails when the generated registry is stale", async () => {
    let reads = 0;
    const services = Layer.mergeAll(
      cliTestLayer,
      Layer.succeed(ScriptFiles, {
        readText: () =>
          Effect.sync(() => {
            reads += 1;
            return reads === 1 ? JSON.stringify({ paths: {} }) : "out of date";
          }),
        writeText: () => Effect.void,
      }),
    );

    await expect(
      Effect.runPromise(
        Command.runWith(generateCommandsCommand, { version: "test" })([
          "--check",
        ]).pipe(Effect.provide(services)),
      ),
    ).rejects.toThrow("src/generated/commands.gen.ts is out of date");
  });

  test("includes public operations and excludes non-public operations", () => {
    const commands = Effect.runSync(
      collectPublicCommands({
        paths: {
          "/v1/workspaces": {
            get: {
              "x-platform-visibility": "PUBLIC",
              operationId: "workspaces.list",
              tags: ["Workspaces"],
              summary: "List workspaces",
              security: [{ BearerAuth: [] }],
              parameters: [{ name: "limit", in: "query", required: false }],
            },
          },
          "/v1/admin/users": {
            get: {
              "x-platform-visibility": "ADMIN",
              operationId: "adminAccess.listUsers",
            },
          },
        },
      }),
    );

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      operation_id: "workspaces.list",
      command: "workspaces list",
      visibility: "PUBLIC",
      requires_auth: true,
    });
  });

  test("inherits root security when operation security is absent", () => {
    const commands = Effect.runSync(
      collectPublicCommands({
        security: [{ BearerAuth: [] }],
        paths: {
          "/v1/workspaces": {
            get: {
              "x-platform-visibility": "PUBLIC",
              operationId: "workspaces.list",
            },
          },
        },
      }),
    );

    expect(commands[0]?.requires_auth).toBe(true);
  });

  test("uses operation security instead of root security", () => {
    const commands = Effect.runSync(
      collectPublicCommands({
        security: [],
        paths: {
          "/v1/workspaces": {
            get: {
              "x-platform-visibility": "PUBLIC",
              operationId: "workspaces.list",
              security: [{ BearerAuth: [] }],
            },
          },
        },
      }),
    );

    expect(commands[0]?.requires_auth).toBe(true);
  });

  test("treats explicit empty operation security as anonymous", () => {
    const commands = Effect.runSync(
      collectPublicCommands({
        security: [{ BearerAuth: [] }],
        paths: {
          "/v1/offers/resolve": {
            get: {
              "x-platform-visibility": "PUBLIC",
              operationId: "offers.resolve",
              security: [],
            },
          },
        },
      }),
    );

    expect(commands[0]?.requires_auth).toBe(false);
  });

  test("treats an anonymous root security alternative as anonymous", () => {
    const commands = Effect.runSync(
      collectPublicCommands({
        security: [{ BearerAuth: [] }, {}],
        paths: {
          "/v1/offers/resolve": {
            get: {
              "x-platform-visibility": "PUBLIC",
              operationId: "offers.resolve",
            },
          },
        },
      }),
    );

    expect(commands[0]?.requires_auth).toBe(false);
  });

  test("treats an anonymous operation security alternative as anonymous", () => {
    const commands = Effect.runSync(
      collectPublicCommands({
        security: [{ BearerAuth: [] }],
        paths: {
          "/v1/offers/resolve": {
            get: {
              "x-platform-visibility": "PUBLIC",
              operationId: "offers.resolve",
              security: [{ BearerAuth: [] }, {}],
            },
          },
        },
      }),
    );

    expect(commands[0]?.requires_auth).toBe(false);
  });

  test("sorts generated commands deterministically by operationId", () => {
    const commands = Effect.runSync(
      collectPublicCommands({
        paths: {
          "/z": {
            get: {
              "x-platform-visibility": "PUBLIC",
              operationId: "zebras.list",
            },
          },
          "/a": {
            get: {
              "x-platform-visibility": "PUBLIC",
              operationId: "agents.list",
            },
          },
        },
      }),
    );

    expect(commands.map((command) => command.operation_id)).toEqual([
      "agents.list",
      "zebras.list",
    ]);
  });
});
