import { execa } from "execa";
import { ProviderError, type CompleteRequest, type CompleteResult, type LlmProvider, type ProviderConfig } from "./types.js";
import { schemaInstruction, withRateLimitRetry, withSchemaRetry } from "./structured.js";

export class ClaudeCodeProvider implements LlmProvider {
  readonly id = "claude-code";
  readonly capabilities = { nativeStructuredOutput: false, reportsUsage: true };
  private binary: string;
  constructor(cfg: ProviderConfig) {
    this.binary = cfg.binary ?? "claude";
  }
  async complete<T>(req: CompleteRequest<T>): Promise<CompleteResult<T>> {
    let usage: CompleteResult<T>["usage"];
    let model = req.model;
    let stop = "end_turn";
    const output = await withSchemaRetry(req.schema, async (extra) => {
      const run = async () => {
        const r = await execa(
          this.binary,
          ["-p", "--output-format", "json", "--model", req.model, "--append-system-prompt", req.system],
          { input: req.user + schemaInstruction(req.schema) + extra, reject: false, cancelSignal: req.signal, timeout: 900_000 },
        );
        const text = String(r.stdout);
        if (/usage limit|rate limit/i.test(text + r.stderr)) throw new ProviderError("rate_limit", "claude subscription limit reached");
        if (r.exitCode !== 0) throw new ProviderError("other", `claude exited ${r.exitCode}: ${String(r.stderr).slice(0, 500)}`);
        const env = JSON.parse(text) as { result?: string; is_error?: boolean; usage?: { input_tokens?: number; output_tokens?: number }; total_cost_usd?: number; modelUsage?: Record<string, unknown> };
        if (env.is_error) throw new ProviderError("other", String(env.result).slice(0, 500));
        if (env.usage) usage = { inputTokens: env.usage.input_tokens ?? 0, outputTokens: env.usage.output_tokens ?? 0, costUsd: env.total_cost_usd };
        if (env.modelUsage) model = Object.keys(env.modelUsage)[0] ?? model;
        stop = "end_turn";
        return env.result ?? "";
      };
      return withRateLimitRetry(run, (e) => e instanceof ProviderError && e.kind === "rate_limit", 30_000);
    });
    return { output, usage, raw: { model, stopReason: stop } };
  }
}
