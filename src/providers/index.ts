import type { LlmProvider, ProviderConfig } from "./types.js";
import { AnthropicApiProvider } from "./anthropicApi.js";
import { ClaudeCodeProvider } from "./claudeCode.js";
import { OpenAiCompatibleProvider } from "./openaiCompatible.js";
import { FixtureProvider } from "./fixture.js";
import { CommandProvider } from "./command.js";

export const PROVIDERS: Record<string, (cfg: ProviderConfig) => LlmProvider> = {
  "anthropic-api": (c) => new AnthropicApiProvider(c),
  "claude-code": (c) => new ClaudeCodeProvider(c),
  "openai-compatible": (c) => new OpenAiCompatibleProvider(c),
  fixture: (c) => new FixtureProvider(c),
  command: (c) => new CommandProvider(c),
};

export function createProvider(cfg: ProviderConfig): LlmProvider {
  const f = PROVIDERS[cfg.provider];
  if (!f) throw new Error(`unknown provider "${cfg.provider}" (known: ${Object.keys(PROVIDERS).join(", ")})`);
  return f(cfg);
}
export * from "./types.js";
