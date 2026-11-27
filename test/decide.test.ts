import { describe, expect, it } from "vitest";
import { decide } from "../src/stages/decide.js";
import { aggregate } from "../src/judge/llmJudge.js";
import { claim, v } from "./helpers.js";
import type { CandidateVerdict, DeclInfo } from "../src/schemas/index.js";

const thm = claim("c-thm-1", "theorem", "1", 10);
const cor = claim("c-cor-2", "corollary", "2", 20);
const claims = [thm, cor];
const base: Omit<Parameters<typeof decide>[0], "verdicts"> = { claim: thm, claims, authorDeclaredEmpty: false, judgeError: null, votes: 2, allVerdicts: new Map<string, CandidateVerdict[]>(), human: null, noAutoVerified: false };
const run = (verdicts: CandidateVerdict[], extra: Partial<typeof base> = {}) => decide({ ...base, verdicts, ...extra });

describe("status decision table (algorithm.md §4)", () => {
  it("row 0: valid human judgment wins; 'confirm' keeps the automatic status", () => {
    expect(run([v("A", "match")], { human: { status: "missing", note: "no" } } as never)).toMatchObject({ status: "missing", decided_by: "human", auto_status: "verified" });
    expect(run([v("A", "match")], { human: { status: "confirm" } } as never)).toMatchObject({ status: "verified", decided_by: "human" });
  });
  it("row 1: author-declared empty list → missing by rule", () => {
    expect(run([], { authorDeclaredEmpty: true })).toMatchObject({ status: "missing", decided_by: "rule" });
  });
  it("row 2: match/weaker + assumed → assumed by rule (even before verified)", () => {
    expect(run([v("A", "match", { assumed: true })])).toMatchObject({ status: "assumed", decided_by: "rule" });
    expect(run([v("A", "weaker", { assumed: true })])).toMatchObject({ status: "assumed" });
    expect(run([v("A", "unrelated", { assumed: true })]).status).toBe("missing");
  });
  it("row 3: unanimous match → verified (auto)", () => {
    expect(run([v("A", "match"), v("B", "unrelated")])).toMatchObject({ status: "verified", decided_by: "auto" });
  });
  it("row 3 with --no-auto-verified → needs_review", () => {
    expect(run([v("A", "match")], { noAutoVerified: true }).status).toBe("needs_review");
  });
  it("row 4: unanimous weaker → weakened with differences in reason", () => {
    const d = run([v("A", "weaker")]);
    expect(d.status).toBe("weakened");
    expect(d.reason).toContain("extra oddness");
  });
  it("row 5: candidates match a later/corollary claim → corollary_only", () => {
    const allVerdicts = new Map([["c-cor-2", [v("A", "match")]]]);
    const d = run([v("A", "matches_other_claim", { other_claim_id: "c-cor-2" })], { allVerdicts });
    expect(d).toMatchObject({ status: "corollary_only", corollary_of: "c-cor-2" });
  });
  it("row 5 does not apply when the other claim is an earlier non-corollary", () => {
    const d = decide({ ...base, claim: cor, verdicts: [v("A", "matches_other_claim", { other_claim_id: "c-thm-1" })] });
    expect(d.status).toBe("needs_review");
  });
  it("row 6: no candidates or all unrelated → missing", () => {
    expect(run([]).status).toBe("missing");
    expect(run([v("A", "unrelated"), v("B", "unrelated")]).status).toBe("missing");
  });
  it("row 7: any uncertainty → needs_review (conservatism)", () => {
    expect(run([v("A", "match", { agreement: 1 })]).status).toBe("needs_review");
    expect(run([v("A", "uncertain")]).status).toBe("needs_review");
    expect(run([v("A", "unrelated"), v("B", "uncertain")]).status).toBe("needs_review");
  });
  it("votes = 1 never auto-verifies", () => {
    expect(run([v("A", "match", { agreement: 1 })], { votes: 1 }).status).toBe("needs_review");
  });
  it("judge errors → needs_review", () => {
    expect(run([], { judgeError: "SchemaError: x" }).status).toBe("needs_review");
  });
});

describe("vote aggregation", () => {
  const d = { name: "A", uses_sorry: false, nonstandard_axioms: [] } as unknown as DeclInfo;
  const out = (relation: string, extra = {}) => ({ candidates: [{ decl: "A", relation, other_claim_id: null, differences: [], rationale: "x", ...extra }] }) as never;
  it("unanimous keeps the relation", () => {
    expect(aggregate([d], [out("match"), out("match")])[0]).toMatchObject({ relation: "match", agreement: 2 });
  });
  it("split votes become uncertain", () => {
    expect(aggregate([d], [out("match"), out("weaker", { differences: [{ kind: "other", lean: null, paper: null, note: "n" }] })])[0]!.relation).toBe("uncertain");
  });
  it("weaker without differences is treated as uncertain", () => {
    expect(aggregate([d], [out("weaker"), out("weaker")])[0]!.relation).toBe("uncertain");
  });
  it("missing candidate in a vote counts as uncertain", () => {
    expect(aggregate([d], [out("match"), { candidates: [] } as never])[0]!.relation).toBe("uncertain");
  });
});
