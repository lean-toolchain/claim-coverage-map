import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ProviderError, type CompleteRequest, type CompleteResult, type LlmProvider, type ProviderConfig } from "./types.js";

/** Test provider: reads `<fixtureDir>/<cacheKey>.json`, or a responder function. */
export class FixtureProvider implements LlmProvider {
  readonly id = "fixture";
  readonly capabilities = { nativeStructuredOutput: true, reportsUsage: false };
  constructor(private cfg: ProviderConfig, private responder?: (req: CompleteRequest<unknown>) => unknown) {}
  async complete<T>(req: CompleteRequest<T>): Promise<CompleteResult<T>> {
    let value: unknown;
    if (this.responder) value = this.responder(req as CompleteRequest<unknown>);
    else {
      const p = join(this.cfg.fixtureDir ?? "fixtures", `${req.cacheKey}.json`);
      if (!existsSync(p)) throw new ProviderError("other", `fixture not found: ${p}`);
      value = JSON.parse(readFileSync(p, "utf8"));
    }
    if (value instanceof Error) throw value;
    return { output: req.schema.parse(value), raw: { model: req.model, stopReason: "fixture" } };
  }
}
