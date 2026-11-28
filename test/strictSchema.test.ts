import { describe, expect, it } from "vitest";
import { z } from "zod";
import { dropNulls, dropOptionalNulls, toStrictJsonSchema, withSchemaRetry } from "../src/providers/structured.js";

describe("OpenAI strict schema", () => {
  const S = z.object({ relation: z.enum(["match", "weaker"]), other: z.string().optional(), items: z.array(z.object({ a: z.number(), b: z.string().nullable() })) });
  it("closes objects and makes optional fields required-but-nullable", () => {
    const j = toStrictJsonSchema(S) as any;
    expect(j.additionalProperties).toBe(false);
    expect(j.required.sort()).toEqual(["items", "other", "relation"]);
    expect(j.properties.other.anyOf[1]).toEqual({ type: "null" });
    expect(j.properties.items.items.additionalProperties).toBe(false);
    expect(j.$schema).toBeUndefined();
  });
  it("accepts strict answers with null for optional fields", async () => {
    const out = await withSchemaRetry(S, async () => JSON.stringify({ relation: "match", other: null, items: [{ a: 1, b: null }] }));
    expect(out.relation).toBe("match");
    expect(dropNulls({ x: null, y: [{ z: null, w: 1 }] })).toEqual({ y: [{ w: 1 }] });
  });
});
