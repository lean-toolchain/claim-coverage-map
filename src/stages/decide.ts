import type { CandidateVerdict, Claim, Judgment, Status } from "../schemas/index.js";

export interface DecideInput {
  claim: Claim;
  claims: Claim[];
  /** Verdicts for this claim (author-declared only when present). null → nothing judged yet. */
  verdicts: CandidateVerdict[];
  authorDeclaredEmpty: boolean;
  /** The author declared the correspondence: pointers from other claims do not override it. */
  authorDeclared?: boolean;
  judgeError: string | null;
  votes: number;
  /** Verdicts of every claim, for the corollary rule (row 5). */
  allVerdicts: Map<string, CandidateVerdict[]>;
  human: Judgment | null; // already validated (not stale)
  noAutoVerified: boolean;
}

export interface Decision {
  status: Status;
  auto_status: Status;
  decided_by: "auto" | "human" | "rule";
  reason: string;
  corollary_of: string | null;
}

/** algorithm.md §4: first matching row wins. */
export function decideAuto(i: Omit<DecideInput, "human">): Omit<Decision, "auto_status"> {
  const V = i.verdicts;
  const full = (v: CandidateVerdict) => i.votes >= 2 && v.agreement === i.votes && v.relation !== "uncertain";
  if (i.authorDeclaredEmpty) return { status: "missing", decided_by: "rule", reason: "author declared: not formalized", corollary_of: null };
  const assumed = V.filter((v) => (v.relation === "match" || v.relation === "weaker") && v.assumed);
  if (assumed.length) {
    return { status: "assumed", decided_by: "rule", reason: `${assumed.map((v) => v.decl).join(", ")} relies on sorry or a non-standard axiom`, corollary_of: null };
  }
  if (i.judgeError) return { status: "needs_review", decided_by: "auto", reason: `judge failed: ${i.judgeError}`, corollary_of: null };
  const match = V.find((v) => v.relation === "match" && full(v) && !v.assumed);
  if (match) {
    if (i.noAutoVerified) return { status: "needs_review", decided_by: "auto", reason: `auto 'verified' disabled; candidate ${match.decl} judged a match`, corollary_of: null };
    return { status: "verified", decided_by: "auto", reason: `${match.decl} matches (${match.agreement}/${i.votes} votes)`, corollary_of: null };
  }
  const weaker = V.find((v) => v.relation === "weaker" && full(v));
  if (weaker) return { status: "weakened", decided_by: "auto", reason: `${weaker.decl} is weaker: ${weaker.differences.map((d) => d.note).join("; ")}`, corollary_of: null };

  const anyUncertain = V.some((v) => !full(v));
  if (V.length > 0 && !anyUncertain && V.every((v) => v.relation === "matches_other_claim" || v.relation === "unrelated")) {
    const cor = findCorollary(i);
    if (cor) return { status: "corollary_only", decided_by: "auto", reason: `only formalized via ${cor.label}: ${cor.decl}`, corollary_of: cor.claimId };
  }
  // Conservatism: never call a claim missing while another claim's verdict points a declaration at it.
  const pointedAt = [...i.allVerdicts].flatMap(([cid, vs]) => cid === i.claim.id ? [] : vs.filter((v) => v.relation === "matches_other_claim" && v.other_claim_id === i.claim.id).map((v) => v.decl));
  if (!i.authorDeclared && pointedAt.length && !V.some((v) => pointedAt.includes(v.decl))) {
    return { status: "needs_review", decided_by: "auto", reason: `other results' judgments point ${[...new Set(pointedAt)].join(", ")} at this result, but it was not judged here`, corollary_of: null };
  }
  if (V.length === 0) return { status: "missing", decided_by: "auto", reason: "no candidate Lean declaration", corollary_of: null };
  if (!anyUncertain && V.every((v) => v.relation === "unrelated")) {
    return { status: "missing", decided_by: "auto", reason: "all candidates rejected as unrelated", corollary_of: null };
  }
  const others = [...new Set(V.filter((v) => v.relation === "matches_other_claim" && v.other_claim_id).map((v) => v.other_claim_id!))];
  const uncertainDecls = V.filter((v) => !full(v)).map((v) => v.decl);
  const reason = anyUncertain
    ? `judges were not unanimous or not confident about ${uncertainDecls.join(", ")}`
    : others.length
      ? `candidates correspond to other results (${others.join(", ")}), none to this one; not formalized directly?`
      : "no rule applied";
  return { status: "needs_review", decided_by: "auto", reason, corollary_of: null };
}

function findCorollary(i: Omit<DecideInput, "human">): { claimId: string; decl: string; label: string } | null {
  const c = i.claim;
  const idx = i.claims.findIndex((x) => x.id === c.id);
  for (const v of i.verdicts) {
    if (v.relation !== "matches_other_claim" || !v.other_claim_id) continue;
    const dIdx = i.claims.findIndex((x) => x.id === v.other_claim_id);
    const d = i.claims[dIdx];
    if (!d || d.id === c.id) continue;
    const isCorollaryOfC = d.kind === "corollary" || dIdx > idx;
    if (!isCorollaryOfC) continue;
    // the decl must itself match/weaker-correspond to d (in d's verdicts), or d has no verdict for it
    const dv = i.allVerdicts.get(d.id)?.find((x) => x.decl === v.decl);
    if (dv && dv.relation !== "match" && dv.relation !== "weaker") continue;
    return { claimId: d.id, decl: v.decl, label: `${d.kind} ${d.number ?? d.id}` };
  }
  return null;
}

export function decide(i: DecideInput): Decision {
  const auto = decideAuto(i);
  if (i.human) {
    const st = i.human.status === "confirm" ? auto.status : i.human.status;
    return { ...auto, status: st, auto_status: auto.status, decided_by: "human", reason: i.human.note ?? `human: ${i.human.status}` };
  }
  return { ...auto, auto_status: auto.status };
}
