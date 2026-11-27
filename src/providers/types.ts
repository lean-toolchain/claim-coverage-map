import type { z } from "zod";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface CompleteRequest<T> {
  model: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  effort?: Effort;
  signal?: AbortSignal;
  /** Stable cache key for this request (used by the fixture provider). */
  cacheKey?: string;
}

export interface CompleteResult<T> {
  output: T;
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
  raw: { model: string; stopReason: string };
}

export interface LlmProvider {
  readonly id: string;
  readonly capabilities: { nativeStructuredOutput: boolean; reportsUsage: boolean };
  complete<T>(req: CompleteRequest<T>): Promise<CompleteResult<T>>;
}

export class ProviderError extends Error {
  constructor(readonly kind: "refusal" | "rate_limit" | "network" | "other", message: string) {
    super(message);
  }
}
export class SchemaError extends Error {}

export interface ProviderConfig {
  provider: string;
  model: string;
  effort?: Effort;
  fallbacks?: string;
  binary?: string;
  base_url?: string;
  api_key_env?: string;
  fixtureDir?: string;
  argv?: string[];
}
