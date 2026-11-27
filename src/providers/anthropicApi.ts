import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { ProviderError, SchemaError, type CompleteRequest, type CompleteResult, type LlmProvider, type ProviderConfig } from "./types.js";
import { withRateLimitRetry } from "./structured.js";

export class AnthropicApiProvider implements LlmProvider {
  readonly id = "anthropic-api";
  readonly capabilities = { nativeStructuredOutput: true, reportsUsage: true };
  private client: Anthropic;
  constructor(_cfg: ProviderConfig) {
    this.client = new Anthropic();
  }
  async complete<T>(req: CompleteRequest<T>): Promise<CompleteResult<T>> {
    const call = async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const params: any = {
          model: req.model,
          max_tokens: 16000,
          system: req.system,
          messages: [{ role: "user", content: req.user }],
          thinking: { type: "adaptive" },
          output_config: { format: zodOutputFormat(req.schema as never), ...(req.effort ? { effort: req.effort } : {}) },
        };
        return await this.client.messages.parse(params, { signal: req.signal });
      } catch (e) {
        if (e instanceof Anthropic.RateLimitError) throw new ProviderError("rate_limit", e.message);
        if (e instanceof Anthropic.APIConnectionError) throw new ProviderError("network", e.message);
        if (e instanceof Anthropic.APIError) throw new ProviderError("other", e.message);
        throw e;
      }
    };
    const msg = await withRateLimitRetry(call, (e) => e instanceof ProviderError && e.kind === "rate_limit");
    if (msg.stop_reason === "refusal") throw new ProviderError("refusal", "model refused");
    const parsed = (msg as unknown as { parsed_output?: unknown }).parsed_output;
    if (parsed == null) throw new SchemaError(`no parsed output (stop_reason=${msg.stop_reason})`);
    return {
      output: req.schema.parse(parsed),
      usage: { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens },
      raw: { model: msg.model, stopReason: String(msg.stop_reason) },
    };
  }
}
