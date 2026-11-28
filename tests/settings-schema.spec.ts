import { describe, expect, it } from "vitest";
import { INSTANCE_CONFIG_SCHEMA, parseConfig } from "../src/config.js";
import { BASE_CONFIG } from "./fixtures.js";
import { validateLikeHost } from "./host-validator.js";

describe("settings schema as the host validates it", () => {
  it("accepts a config whose access token is a secret binding", () => {
    const result = validateLikeHost({ ...BASE_CONFIG }, INSTANCE_CONFIG_SCHEMA);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("accepts a config without an access token", () => {
    const { tokenSecretRef: _omitted, ...config } = BASE_CONFIG;
    expect(validateLikeHost(config, INSTANCE_CONFIG_SCHEMA).valid).toBe(true);
  });

  it("the worker still receives and accepts the binding object", () => {
    const result = parseConfig(BASE_CONFIG);
    expect(result.ok && result.config.tokenSecretRef).toEqual(BASE_CONFIG.tokenSecretRef);
  });

  it("declares every secret-ref field as a string", () => {
    const offenders: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (!node || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      if (record.format === "secret-ref" && record.type !== "string") offenders.push(path || "/");
      for (const [key, child] of Object.entries(record)) walk(child, `${path}/${key}`);
    };
    walk(INSTANCE_CONFIG_SCHEMA, "");
    expect(offenders).toEqual([]);
  });
});
