import { describe, expect, test } from "bun:test";

type JsonObject = Record<string, any>;

const spec = (await Bun.file(new URL("../openapi/public.json", import.meta.url)).json()) as JsonObject;

describe("capacity overlay OpenAPI contracts", () => {
  test("reviewed read overlays retain their exact operations and bindings", () => {
    expect(operation("/v1/clusters/{id}", "get")).toMatchObject({
      operationId: "clusters.get",
      "x-platform-visibility": "PUBLIC",
      parameters: [
        { name: "id", in: "path", required: true },
        { name: "akua-context", in: "header", required: false },
      ],
    });
    const configs = operation("/v1/compute_configs", "get");
    expect(configs.operationId).toBe("computeConfigs.list");
    expect(bindings(configs)).toEqual([
      ["cursor", "query", false],
      ["limit", "query", false],
      ["view", "query", false],
      ["akua-context", "header", false],
    ]);
    expect(configs.parameters[2].schema.enum).toEqual(["basic", "full"]);

    const instanceTypes = operation("/v1/compute/instance_types", "get");
    expect(instanceTypes.operationId).toBe("compute.listInstanceTypes");
    expect(bindings(instanceTypes)).toEqual([["config", "query", false]]);

    const machines = operation("/v1/machines", "get");
    expect(machines.operationId).toBe("machines.list");
    expect(bindings(machines)).toEqual([
      ["cursor", "query", false],
      ["limit", "query", false],
      ["cluster_id", "query", false],
      ["state", "query", false],
      ["view", "query", false],
      ["akua-context", "header", false],
    ]);
    expect(machines.parameters[4].schema.enum).toEqual(["basic", "full"]);
  });

  test("machine creation remains the canonical closed idempotent contract", () => {
    const create = operation("/v1/machines", "post");
    expect(create).toMatchObject({
      operationId: "machines.create",
      "x-platform-visibility": "PUBLIC",
    });
    expect(bindings(create)).toEqual([
      ["akua-context", "header", false],
      ["idempotency-key", "header", false],
    ]);
    expect(create.responses["202"].content["application/json"].schema.$ref).toBe(
      "#/components/schemas/OperationEnvelope",
    );

    const body = create.requestBody.content["application/json"].schema;
    expect(body).toMatchObject({
      type: "object",
      required: ["cluster_id", "instance_type", "compute_config_id"],
      additionalProperties: false,
    });
    expect(Object.keys(body.properties).sort()).toEqual([
      "cluster_id",
      "compute_config_id",
      "instance_type",
      "name",
      "node_claim",
    ]);
  });
});

function operation(path: string, method: string): JsonObject {
  const value = spec.paths?.[path]?.[method];
  expect(value).toBeDefined();
  return value as JsonObject;
}

function bindings(value: JsonObject): Array<[string, string, boolean]> {
  return value.parameters.map((parameter: JsonObject) => [parameter.name, parameter.in, parameter.required]);
}
