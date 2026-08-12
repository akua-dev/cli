import { describe, expect, test } from "bun:test";

import { encodeForm } from "../src/runtime/device-http";

describe("device authorization HTTP", () => {
  test("encodes form fields with application/x-www-form-urlencoded semantics", () => {
    expect(encodeForm({ client_id: "akua cli", scope: "platform/read+write" })).toBe(
      "client_id=akua+cli&scope=platform%2Fread%2Bwrite",
    );
  });
});
