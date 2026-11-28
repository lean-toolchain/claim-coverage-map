import { z } from "zod";
import { SchemaError } from "./types.js";

/** For providers without native structured output: embed JSON Schema in the prompt. */
export function schemaInstruction(schema: z.ZodType): string {
  return (
    "\n\nRespond with a single JSON object and nothing else. It must validate against this JSON Schema:\n" +
    JSON.stringify(z.toJSONSchema(schema))
  );
}

export function extractJson(text: string): unknown {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fence ? fence[1]! : text;
  const a = body.indexOf("{"), b = body.lastIndexOf("}");
  if (a < 0 || b < a) throw new SchemaError("no JSON object in response");
  return JSON.parse(body.slice(a, b + 1));
}

/**
 * JSON Schema in the form OpenAI strict structured outputs require: every object closed
 * (additionalProperties: false) with all properties required; optional ones become nullable.
 */
export function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const walk = (n: unknown): unknown => {
    if (Array.isArray(n)) return n.map(walk);
    if (!n || typeof n !== "object") return n;
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(n)) if (k !== "$schema" && k !== "default") o[k] = walk(v);
    if (o.type === "object" && o.properties && typeof o.properties === "object") {
      const props = o.properties as Record<string, unknown>;
      const req = new Set((o.required as string[] | undefined) ?? []);
      for (const k of Object.keys(props)) if (!req.has(k)) props[k] = { anyOf: [props[k], { type: "null" }] };
      o.required = Object.keys(props);
      o.additionalProperties = false;
    }
    return o;
  };
  return walk(z.toJSONSchema(schema)) as Record<string, unknown>;
}

/** Remove null-valued object keys (strict mode sends null for optional fields). */
export function dropNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(dropNulls);
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, dropNulls(x)]));
}

/** Remove null values only where the original schema made the key optional. */
export function dropOptionalNulls(v: unknown, js: unknown): unknown {
  const s = (js ?? {}) as Record<string, any>;
  if (Array.isArray(v)) return v.map((x) => dropOptionalNulls(x, s.items));
  if (!v || typeof v !== "object") return v;
  const props = (s.properties ?? {}) as Record<string, unknown>;
  const req = new Set<string>(s.required ?? []);
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (x === null && !req.has(k)) continue;
    out[k] = dropOptionalNulls(x, props[k] ?? (Array.isArray(s.anyOf) ? s.anyOf.find((a: any) => a?.properties?.[k]) : undefined));
  }
  return out;
}

/** Parse, and on failure retry exactly once with the error appended. */
export async function withSchemaRetry<T>(
  schema: z.ZodType<T>,
  ask: (extraUser: string) => Promise<string>,
): Promise<T> {
  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await ask(attempt === 0 ? "" : `\n\nYour previous answer was invalid: ${lastErr}\nAnswer again with valid JSON only.`);
    try {
      const raw = extractJson(text);
      const r = schema.safeParse(raw);
      return r.success ? r.data : schema.parse(dropOptionalNulls(raw, z.toJSONSchema(schema)));
    } catch (e) {
      lastErr = (e as Error).message.slice(0, 2000);
    }
  }
  throw new SchemaError(`schema validation failed twice: ${lastErr}`);
}

export async function withRateLimitRetry<T>(fn: () => Promise<T>, isRateLimit: (e: unknown) => boolean, baseMs = 2000): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= 3 || !isRateLimit(e)) throw e;
      await new Promise((r) => setTimeout(r, baseMs * 2 ** i));
    }
  }
}
