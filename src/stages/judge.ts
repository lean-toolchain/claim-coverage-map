import { VerdictsFile, type CandidatesFile, type ClaimsFile, type DeclInfo, type DeclsFile, type Verdict } from "../schemas/index.js";
import { TOOL } from "../version.js";
import { LlmJudge, isAssumed, type Judge } from "../judge/llmJudge.js";
import { PROMPT_VERSION, type JudgeContext } from "../judge/prompt.js";

export interface JudgeStageOptions {
  claims: ClaimsFile;
  decls: DeclsFile;
  candidates: CandidatesFile;
  judge: Judge;
  judgeInfo: { provider: string; model: string; votes: number } | null;
  maxConcurrency?: number;
  log?: (m: string) => void;
}

export function candidatesToJudge(link: CandidatesFile["links"][number]): string[] {
  if (link.author_declared) return link.author_declared;
  return link.retrieved.map((r) => r.decl);
}

export function buildContext(claimId: string, claims: ClaimsFile, cands: DeclInfo[], byName: Map<string, DeclInfo>): JudgeContext {
  const customConstants: Record<string, string> = {};
  for (const n of [...new Set(cands.flatMap((c) => c.custom_constants))].sort()) {
    const d = byName.get(n);
    customConstants[n] = d?.source ? d.source.split("\n").slice(0, 80).join("\n") : d ? `${d.kind} ${d.name} : ${d.type_pp}` : "(definition unavailable)";
  }
  return {
    otherClaims: claims.claims.filter((c) => c.id !== claimId).map((c) => ({ id: c.id, number: c.number, kind: c.kind, text_plain: c.text_plain })),
    customConstants,
  };
}

async function pool<T, R>(items: T[], n: number, f: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, n) }, async () => {
    while (i < items.length) { const j = i++; out[j] = await f(items[j]!); }
  }));
  return out;
}

export async function judgeStage(opts: JudgeStageOptions): Promise<VerdictsFile> {
  const byName = new Map(opts.decls.decls.map((d) => [d.name, d]));
  const claimById = new Map(opts.claims.claims.map((c) => [c.id, c]));
  const verdicts: Verdict[] = await pool(opts.candidates.links, opts.maxConcurrency ?? 4, async (link): Promise<Verdict> => {
    const claim = claimById.get(link.claim_id)!;
    const names = candidatesToJudge(link);
    const found = names.map((n) => byName.get(n)).filter((d): d is DeclInfo => !!d);
    const missingNames = names.filter((n) => !byName.has(n));
    const notFound = missingNames.map((n) => ({
      decl: n, relation: "uncertain" as const, other_claim_id: null, differences: [], agreement: 0,
      rationale: "declared by the author but not found among extracted Lean declarations", assumed: false,
    }));
    try {
      const judged = await opts.judge.judge(claim, found, buildContext(claim.id, opts.claims, found, byName));
      return { claim_id: claim.id, candidates: [...judged, ...notFound], error: null };
    } catch (e) {
      opts.log?.(`judge failed for ${claim.id}: ${(e as Error).message}`);
      // keep mechanical facts even when the LLM fails
      const mech = found.map((d) => ({
        decl: d.name, relation: "uncertain" as const, other_claim_id: null, differences: [], agreement: 0,
        rationale: "not judged", assumed: isAssumed(d),
      }));
      return { claim_id: claim.id, candidates: [...mech, ...notFound], error: `${(e as Error).constructor.name}: ${(e as Error).message}` };
    }
  });
  const usage = opts.judge instanceof LlmJudge && opts.judge.usage.known
    ? { inputTokens: opts.judge.usage.inputTokens, outputTokens: opts.judge.usage.outputTokens, costUsd: opts.judge.usage.costUsd }
    : null;
  return VerdictsFile.parse({
    schema: "ccm/verdicts@1",
    tool: TOOL,
    judge: opts.judgeInfo ? { ...opts.judgeInfo, prompt_version: PROMPT_VERSION } : null,
    usage,
    verdicts,
  });
}
