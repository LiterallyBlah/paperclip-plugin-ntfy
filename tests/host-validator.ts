/**
 * Test copy of the host's plugin settings validation.
 *
 * Before the host runs the `instanceConfigSchema`, it replaces every
 * `format: "secret-ref"` value that is a `{ type: "secret_ref", secretId }`
 * binding with its secret id string. A secret-ref field must therefore be
 * declared `type: "string"`, even though the worker receives the binding.
 */
import AjvModule from "ajv";
import addFormatsModule from "ajv-formats";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bindingSecretId(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.type !== "secret_ref") return null;
  return typeof record.secretId === "string" && UUID_PATTERN.test(record.secretId) ? record.secretId : null;
}

export function secretRefsAsIds(value: unknown, schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return value;
  const node = schema as Record<string, unknown>;

  if (node.format === "secret-ref") {
    const secretId = bindingSecretId(value);
    if (secretId !== null) return secretId;
  }

  let result = value;
  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const branches = node[keyword];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) result = secretRefsAsIds(result, branch);
  }

  if (Array.isArray(result)) {
    const items = node.items;
    if (items && typeof items === "object") {
      const itemSchemaAt = (index: number) => (Array.isArray(items) ? items[index] : items);
      result = result.map((item, index) => secretRefsAsIds(item, itemSchemaAt(index)));
    }
    return result;
  }

  const properties = node.properties;
  if (result && typeof result === "object" && properties && typeof properties === "object") {
    const record = { ...(result as Record<string, unknown>) };
    for (const [key, propertySchema] of Object.entries(properties as Record<string, unknown>)) {
      if (key in record) record[key] = secretRefsAsIds(record[key], propertySchema);
    }
    result = record;
  }
  return result;
}

export function validateLikeHost(
  config: Record<string, unknown>,
  schema: object,
): { valid: boolean; errors: string[] } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Ajv = (AjvModule as any).default ?? AjvModule;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const addFormats = (addFormatsModule as any).default ?? addFormatsModule;
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  ajv.addFormat("secret-ref", { validate: () => true });
  const validate = ajv.compile(schema);
  const valid = validate(secretRefsAsIds(config, schema)) as boolean;
  const errors = (validate.errors ?? []).map(
    (err: { instancePath?: string; message?: string }) => `${err.instancePath || "/"} ${err.message ?? "invalid"}`,
  );
  return { valid, errors };
}
