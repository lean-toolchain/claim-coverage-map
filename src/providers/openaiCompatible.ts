import { z } from "zod";
import { ProviderError, type CompleteRequest, type CompleteResult, type LlmProvider, type ProviderConfig } from "./types.js";
import { schemaInstruction, withRateLimitRetry, withSchemaRetry } from "./structured.js";

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id = "openai-compatible";
  readonly capabilities = { nativeStructuredOutput: false, reportsUsage: true };
  constructor(private cfg: ProviderConfig) {}
  async complete<T>(req: CompleteRequest<T>): Promise<CompleteResult<T>> {
    const base = (this.cfg.base_url ?? "http://localhost:8000/v1").replace(/\/$/, "");
    const key = process.env[this.cfg.api_key_env ?? "OPENAI_API_KEY"];
    let usage: CompleteResult<T>["usage"];
    let model = req.model, stop = "stop";
    const output = await withSchemaRetry(req.schema, async (extra) => {
      const run = async () => {
        let res: Response;
        try {
          res = await fetch(`${base}/chat/completions`, {
            method: "POST",
            signal: req.signal,
            headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
            body: JSON.stringify({
              model: req.model,
              messages: [
                { role: "system", content: req.system },
                { role: "user", content: req.user + schemaInstruction(req.schema) + extra },
              ],
              response_format: { type: "json_schema", json_schema: { name: "output", schema: z.toJSONSchema(req.schema) } },
            }),
          });
        } catch (e) {
          throw new ProviderError("network", (e as Error).message);
        }
        if (res.status === 429) throw new ProviderError("rate_limit", "HTTP 429");
        if (!res.ok) throw new ProviderError("other", `HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
        const j = (await res.json()) as { model?: string; choices: { message: { content: string; refusal?: string }; finish_reason: string }[]; usage?: { prompt_tokens: number; completion_tokens: number } };
        const ch = j.choices[0];
        if (!ch) throw new ProviderError("other", "no choices");
        if (ch.message.refusal) throw new ProviderError("refusal", ch.message.refusal);
        if (j.usage) usage = { inputTokens: j.usage.prompt_tokens, outputTokens: j.usage.completion_tokens };
        model = j.model ?? model;
        stop = ch.finish_reason;
        return ch.message.content;
      };
      return withRateLimitRetry(run, (e) => e instanceof ProviderError && e.kind === "rate_limit");
    });
    return { output, usage, raw: { model, stopReason: stop } };
  }
}
