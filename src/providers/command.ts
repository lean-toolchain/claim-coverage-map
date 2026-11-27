import { execa } from "execa";
import { ProviderError, type CompleteRequest, type CompleteResult, type LlmProvider, type ProviderConfig } from "./types.js";
import { schemaInstruction, withRateLimitRetry, withSchemaRetry } from "./structured.js";

/**
 * Any local CLI (e.g. a subscription-based coding agent) that reads a prompt on stdin
 * and writes the answer to stdout. `{model}` in argv is replaced by the configured model.
 */
export class CommandProvider implements LlmProvider {
  readonly id = "command";
  readonly capabilities = { nativeStructuredOutput: false, reportsUsage: false };
  private argv: string[];
  constructor(cfg: ProviderConfig) {
    if (!cfg.argv?.length) throw new Error('provider "command" needs argv, e.g. [llm.command] argv = ["mycli", "--model", "{model}"]');
    this.argv = cfg.argv;
  }
  async complete<T>(req: CompleteRequest<T>): Promise<CompleteResult<T>> {
    const [bin, ...args] = this.argv.map((a) => a.replaceAll("{model}", req.model));
    const output = await withSchemaRetry(req.schema, async (extra) =>
      withRateLimitRetry(async () => {
        const r = await execa(bin!, args, {
          input: `${req.system}\n\n${req.user}${schemaInstruction(req.schema)}${extra}`,
          reject: false, cancelSignal: req.signal, timeout: 1_800_000,
        });
        const all = `${r.stdout}\n${r.stderr}`;
        if (/rate limit|usage limit|quota/i.test(all) && r.exitCode !== 0) throw new ProviderError("rate_limit", all.slice(0, 300));
        if (r.timedOut) throw new ProviderError("other", `${bin} did not answer within 30 minutes (timed out)`);
        if (r.exitCode !== 0) throw new ProviderError("other", `${bin} exited ${r.exitCode}: ${String(r.stderr).slice(0, 500)}`);
        return String(r.stdout);
      }, (e) => e instanceof ProviderError && e.kind === "rate_limit", 30_000),
    );
    return { output, raw: { model: req.model, stopReason: "end_turn" } };
  }
}
