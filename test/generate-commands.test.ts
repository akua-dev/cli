import { describe, expect, test } from "bun:test";

import { collectPublicCommands } from "../scripts/generate-commands";

describe("collectPublicCommands", () => {
  test("includes public operations and excludes non-public operations", () => {
    const commands = collectPublicCommands({
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
    });

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      operation_id: "workspaces.list",
      command: "workspaces list",
      visibility: "PUBLIC",
      requires_auth: true,
    });
  });

  test("sorts generated commands deterministically by operationId", () => {
    const commands = collectPublicCommands({
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
    });

    expect(commands.map((command) => command.operation_id)).toEqual(["agents.list", "zebras.list"]);
  });
});
