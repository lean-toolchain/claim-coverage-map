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

/** Parse, and on failure retry exactly once with the error appended. */
export async function withSchemaRetry<T>(
  schema: z.ZodType<T>,
  ask: (extraUser: string) => Promise<string>,
): Promise<T> {
  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await ask(attempt === 0 ? "" : `\n\nYour previous answer was invalid: ${lastErr}\nAnswer again with valid JSON only.`);
    try {
      return schema.parse(extractJson(text));
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
