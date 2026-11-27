import type { Claim, DeclInfo } from "../schemas/index.js";
import { claimDisplay } from "../stages/paperExtract.js";

export const PROMPT_VERSION = "j1";

export interface JudgeContext {
  otherClaims: { id: string; number: string | null; kind: Claim["kind"]; text_plain: string }[];
  /** constant name → definition source (≤ 80 lines each) */
  customConstants: Record<string, string>;
}

export const SYSTEM_PROMPT = `You audit whether Lean 4 declarations formalize a theorem from a mathematics paper.
For EACH candidate Lean declaration decide exactly one relation:
- "match": hypotheses and conclusion faithfully say what the paper statement says (notation may differ).
- "weaker": it formalizes this paper statement but proves strictly less (extra hypotheses, narrowed domain, weaker constants, weaker conclusion). You MUST list every difference in "differences"; put the exact Lean hypothesis text in "lean" when one is added.
- "matches_other_claim": it is better described as a DIFFERENT result of the same paper; give that result's id in "other_claim_id".
- "unrelated": it does not formalize this statement.
- "uncertain": you are not confident. If in doubt, answer "uncertain". A wrong "match" is far worse than "uncertain".
Do not judge proofs, only statements. Definitions of custom constants are provided; read them, since a misleading definition can make a statement vacuous or different.
Return one entry per candidate, using the exact declaration name in "decl". Keep "rationale" to 1-3 sentences.`;

export function buildUserPrompt(claim: Claim, candidates: DeclInfo[], ctx: JudgeContext): string {
  const parts: string[] = [];
  parts.push(`## Paper statement: ${claimDisplay(claim)}${claim.title ? ` (${claim.title})` : ""} [id: ${claim.id}]`);
  parts.push(claim.text_tex);
  parts.push(`\n## Other results of the paper (for "matches_other_claim")`);
  for (const o of ctx.otherClaims) parts.push(`- [${o.id}] ${claimDisplay(o)}: ${o.text_plain.slice(0, 400)}`);
  parts.push(`\n## Candidate Lean declarations`);
  for (const d of candidates) {
    parts.push(`### ${d.name}`);
    parts.push("```lean\n" + `theorem ${d.name} : ${d.type_pp}` + "\n```");
    if (d.binders.length) {
      parts.push("Binders:\n" + d.binders.map((b) => `- (${b.name} : ${b.type_pp})${b.is_prop ? " [hypothesis]" : ""} ${b.info !== "default" ? `[${b.info}]` : ""}`).join("\n"));
      parts.push(`Conclusion: ${d.conclusion_pp}`);
    }
    if (d.docstring) parts.push(`Docstring: ${d.docstring}`);
  }
  const consts = Object.entries(ctx.customConstants);
  if (consts.length) {
    parts.push(`\n## Definitions of project-local constants used above`);
    for (const [n, src] of consts) parts.push(`### ${n}\n\`\`\`lean\n${src}\n\`\`\``);
  }
  return parts.join("\n");
}
