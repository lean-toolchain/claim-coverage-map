import type { CandidateVerdict, Claim } from "../src/schemas/index.js";

export function claim(id: string, kind: Claim["kind"], number: string, line: number): Claim {
  return {
    id, kind, number, label: null, title: null, text_tex: `text of ${id}`, text_plain: `text of ${id}`,
    location: { file: "main.tex", line, section: "1" }, is_main: false, extraction: "certain",
  };
}

export function v(decl: string, relation: CandidateVerdict["relation"], extra: Partial<CandidateVerdict> = {}): CandidateVerdict {
  return {
    decl, relation, other_claim_id: null,
    differences: relation === "weaker" ? [{ kind: "added_hypothesis", lean: "h₃ : Odd n", paper: null, note: "extra oddness" }] : [],
    agreement: 2, rationale: "r", assumed: false, ...extra,
  };
}
