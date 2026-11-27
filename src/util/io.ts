import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { z } from "zod";
import YAML from "yaml";

export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/** Deterministic JSON: stable key order as constructed, 2-space indent, trailing newline. */
export function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

export function readJson<T>(path: string, schema: z.ZodType<T>): T {
  return schema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function readYaml<T>(path: string, schema: z.ZodType<T>): T {
  return schema.parse(YAML.parse(readFileSync(path, "utf8")) ?? {});
}

export function writeText(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

export { existsSync };

export class CcmError extends Error {
  constructor(message: string, readonly exitCode: number) {
    super(message);
  }
}
