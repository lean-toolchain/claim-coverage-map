import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";
import type { ProviderConfig, Effort } from "./providers/types.js";

const TomlConfig = z.object({
  llm: z
    .object({
      provider: z.string().optional(),
      model: z.string().optional(),
      votes: z.number().int().min(1).max(3).optional(),
      max_concurrency: z.number().int().min(1).optional(),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    })
    .catchall(z.unknown())
    .optional(),
});

export interface LlmSettings {
  provider: ProviderConfig | null;
  votes: number;
  maxConcurrency: number;
}

export function loadLlmSettings(cwd: string, flags: { provider?: string; model?: string; votes?: number; effort?: string }, projectLlm?: Record<string, unknown>): LlmSettings {
  const paths = [join(cwd, "ccm.toml"), join(homedir(), ".config", "ccm", "ccm.toml")];
  const file = paths.find((p) => existsSync(p));
  const cfg = file ? TomlConfig.parse(parse(readFileSync(file, "utf8"))) : {};
  const llm = { ...(cfg.llm ?? {}), ...(projectLlm ? TomlConfig.parse({ llm: projectLlm }).llm : {}) } as NonNullable<z.infer<typeof TomlConfig>["llm"]>;
  const provider = flags.provider ?? llm.provider;
  const model = flags.model ?? llm.model;
  const section = (provider && (llm[provider] as Record<string, unknown> | undefined)) || {};
  return {
    provider: provider && model
      ? { ...(section as Partial<ProviderConfig>), provider, model, effort: (flags.effort ?? llm.effort) as Effort | undefined }
      : null,
    votes: flags.votes ?? llm.votes ?? 2,
    maxConcurrency: llm.max_concurrency ?? 4,
  };
}
