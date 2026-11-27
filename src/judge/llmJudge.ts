import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LlmJudgeOutput, type CandidateVerdict, type Claim, type DeclInfo, type Relation } from "../schemas/index.js";
import { sha256 } from "../util/io.js";
import type { Effort, LlmProvider } from "../providers/types.js";
import { PROMPT_VERSION, SYSTEM_PROMPT, buildUserPrompt, type JudgeContext } from "./prompt.js";

export interface Judge {
  readonly name: string;
  judge(claim: Claim, candidates: DeclInfo[], context: JudgeContext): Promise<CandidateVerdict[]>;
}

export interface UsageTotals { inputTokens: number; outputTokens: number; costUsd: number | null; known: boolean }

export class OfflineCacheMiss extends Error {}

export function isAssumed(d: DeclInfo): boolean {
  return d.uses_sorry || d.nonstandard_axioms.length > 0;
}

export class LlmJudge implements Judge {
  readonly name = "llm";
  usage: UsageTotals = { inputTokens: 0, outputTokens: 0, costUsd: null, known: false };
  constructor(
    private provider: LlmProvider | null, // null when offline
    private opts: { providerId: string; model: string; votes: number; effort?: Effort; cacheDir: string },
  ) {}

  cacheKey(input: string, round: number) {
    return sha256(JSON.stringify([this.opts.providerId, this.opts.model, PROMPT_VERSION, input, round]));
  }

  private async vote(claim: Claim, cands: DeclInfo[], ctx: JudgeContext, round: number): Promise<LlmJudgeOutput> {
    const r = round % cands.length;
    const rotated = [...cands.slice(r), ...cands.slice(0, r)];
    const user = buildUserPrompt(claim, rotated, ctx);
    const key = this.cacheKey(SYSTEM_PROMPT + "\n\n" + user, round);
    const path = join(this.opts.cacheDir, `${key}.json`);
    if (existsSync(path)) return LlmJudgeOutput.parse(JSON.parse(readFileSync(path, "utf8")));
    if (!this.provider) throw new OfflineCacheMiss("offline and no cached judgment");
    const res = await this.provider.complete({
      model: this.opts.model, system: SYSTEM_PROMPT, user, schema: LlmJudgeOutput, effort: this.opts.effort, cacheKey: key,
    });
    if (res.usage) {
      this.usage.known = true;
      this.usage.inputTokens += res.usage.inputTokens;
      this.usage.outputTokens += res.usage.outputTokens;
      if (res.usage.costUsd != null) this.usage.costUsd = (this.usage.costUsd ?? 0) + res.usage.costUsd;
    }
    mkdirSync(this.opts.cacheDir, { recursive: true });
    writeFileSync(path, JSON.stringify(res.output, null, 2) + "\n");
    return res.output;
  }

  async judge(claim: Claim, cands: DeclInfo[], ctx: JudgeContext): Promise<CandidateVerdict[]> {
    if (cands.length === 0) return [];
    const rounds: LlmJudgeOutput[] = [];
    for (let v = 0; v < this.opts.votes; v++) rounds.push(await this.vote(claim, cands, ctx, v));
    return aggregate(cands, rounds);
  }
}

/** Combine independent votes per candidate. Non-unanimous → relation "uncertain". */
export function aggregate(cands: DeclInfo[], rounds: LlmJudgeOutput[]): CandidateVerdict[] {
  return cands.map((d) => {
    const votes = rounds.map((r) => {
      const v = r.candidates.find((c) => c.decl === d.name);
      if (!v) return null;
      // A "weaker" verdict without differences violates the contract → treat as uncertain.
      if (v.relation === "weaker" && v.differences.length === 0) return { ...v, relation: "uncertain" as Relation };
      if (v.relation === "matches_other_claim" && !v.other_claim_id) return { ...v, relation: "uncertain" as Relation };
      return v;
    });
    const counts = new Map<Relation, number>();
    for (const v of votes) {
      const rel = v?.relation ?? "uncertain";
      counts.set(rel, (counts.get(rel) ?? 0) + 1);
    }
    const order: Relation[] = ["uncertain", "unrelated", "matches_other_claim", "weaker", "match"];
    let best: Relation = "uncertain", bestN = 0;
    for (const rel of order) {
      const n = counts.get(rel) ?? 0;
      if (n > bestN) { best = rel; bestN = n; }
    }
    const unanimous = bestN === rounds.length;
    const rep = votes.find((v) => v?.relation === best) ?? null;
    const sameOther = new Set(votes.filter((v) => v?.relation === best).map((v) => v?.other_claim_id ?? null)).size <= 1;
    const relation: Relation = unanimous && sameOther ? best : "uncertain";
    return {
      decl: d.name,
      relation,
      other_claim_id: relation === "matches_other_claim" ? (rep?.other_claim_id ?? null) : null,
      differences: relation === "weaker" || relation === "uncertain" ? (rep?.differences ?? []) : [],
      agreement: bestN,
      rationale: (unanimous ? "" : `votes split: ${[...counts].map(([r, n]) => `${r}×${n}`).join(", ")}. `) + (rep?.rationale ?? "no verdict returned"),
      assumed: isAssumed(d),
    };
  });
}
