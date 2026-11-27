import { z } from "zod";

export const Tool = z.object({ name: z.string(), version: z.string() });

export const ClaimKind = z.enum(["theorem", "lemma", "proposition", "corollary"]);
export type ClaimKind = z.infer<typeof ClaimKind>;

export const Claim = z.object({
  id: z.string(),
  kind: ClaimKind,
  number: z.string().nullable(),
  label: z.string().nullable(),
  title: z.string().nullable(),
  text_tex: z.string(),
  text_plain: z.string(),
  location: z.object({ file: z.string(), line: z.number().int(), section: z.string().nullable() }),
  is_main: z.boolean(),
  extraction: z.enum(["certain", "uncertain"]),
});
export type Claim = z.infer<typeof Claim>;

export const ClaimsFile = z.object({
  schema: z.literal("ccm/claims@1"),
  tool: Tool,
  inputs: z.object({ paper: z.string(), source_sha256: z.string() }),
  numbering: z.enum(["aux", "estimated"]),
  claims: z.array(Claim),
});
export type ClaimsFile = z.infer<typeof ClaimsFile>;

export const Binder = z.object({
  name: z.string(),
  type_pp: z.string(),
  info: z.string(),
  is_prop: z.boolean(),
});

export const DeclInfo = z.object({
  name: z.string(),
  kind: z.enum(["theorem", "def", "axiom", "opaque", "inductive", "structure", "instance"]),
  module: z.string(),
  file: z.string(),
  range: z.object({
    start: z.object({ line: z.number().int(), col: z.number().int() }),
    end: z.object({ line: z.number().int(), col: z.number().int() }),
  }),
  docstring: z.string().nullable(),
  type_pp: z.string(),
  binders: z.array(Binder),
  conclusion_pp: z.string(),
  axioms: z.array(z.string()),
  uses_sorry: z.boolean(),
  nonstandard_axioms: z.array(z.string()),
  custom_constants: z.array(z.string()),
  /** Source text of the definition (for custom constants given to the judge). Optional extension. */
  source: z.string().nullable().optional(),
});
export type DeclInfo = z.infer<typeof DeclInfo>;

export const DeclsFile = z.object({
  schema: z.literal("lean-extract/decls@1"),
  tool: Tool,
  inputs: z.object({
    toolchain: z.string(),
    repo: z.string(),
    commit: z.string(),
    mathlib: z.object({ commit: z.string() }).nullable(),
  }),
  decls: z.array(DeclInfo),
});
export type DeclsFile = z.infer<typeof DeclsFile>;

export const AuthorSource = z.enum(["hints", "blueprint", "formalization-yaml", "docstring"]);

export const Link = z.object({
  claim_id: z.string(),
  author_declared: z.array(z.string()).nullable(),
  author_source: AuthorSource.nullable(),
  retrieved: z.array(z.object({ decl: z.string(), score: z.number() })),
});
export type Link = z.infer<typeof Link>;

export const CandidatesFile = z.object({
  schema: z.literal("ccm/candidates@1"),
  tool: Tool,
  ignored: z.array(z.string()).default([]),
  links: z.array(Link),
});
export type CandidatesFile = z.infer<typeof CandidatesFile>;

export const Relation = z.enum(["match", "weaker", "matches_other_claim", "unrelated", "uncertain"]);
export type Relation = z.infer<typeof Relation>;

export const DifferenceKind = z.enum([
  "added_hypothesis",
  "narrowed_domain",
  "weakened_constant",
  "weakened_conclusion",
  "other",
]);

export const Difference = z.object({
  kind: DifferenceKind,
  lean: z.string().nullable(),
  paper: z.string().nullable(),
  note: z.string(),
});
export type Difference = z.infer<typeof Difference>;

/** What a single LLM vote returns for one candidate. */
export const LlmCandidateVerdict = z.object({
  decl: z.string(),
  relation: Relation,
  other_claim_id: z.string().nullable(),
  differences: z.array(Difference),
  rationale: z.string(),
});
export const LlmJudgeOutput = z.object({ candidates: z.array(LlmCandidateVerdict) });
export type LlmJudgeOutput = z.infer<typeof LlmJudgeOutput>;

export const CandidateVerdict = LlmCandidateVerdict.extend({
  agreement: z.number().int(),
  assumed: z.boolean(),
});
export type CandidateVerdict = z.infer<typeof CandidateVerdict>;

export const JudgeInfo = z.object({
  provider: z.string(),
  model: z.string(),
  votes: z.number().int(),
  prompt_version: z.string(),
});
export type JudgeInfo = z.infer<typeof JudgeInfo>;

export const Usage = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number().nullable(),
});

export const Verdict = z.object({
  claim_id: z.string(),
  candidates: z.array(CandidateVerdict),
  error: z.string().nullable(),
});
export type Verdict = z.infer<typeof Verdict>;

export const VerdictsFile = z.object({
  schema: z.literal("ccm/verdicts@1"),
  tool: Tool,
  judge: JudgeInfo.nullable(),
  usage: Usage.nullable(),
  verdicts: z.array(Verdict),
});
export type VerdictsFile = z.infer<typeof VerdictsFile>;

export const Status = z.enum(["verified", "weakened", "corollary_only", "assumed", "missing", "needs_review"]);
export type Status = z.infer<typeof Status>;

export const Judgment = z.object({
  status: z.union([Status, z.literal("confirm")]),
  note: z.string().nullable().optional(),
  by: z.string().nullable().optional(),
  at: z.string().nullable().optional(),
  claim_text_sha256: z.string().nullable().optional(),
});
export type Judgment = z.infer<typeof Judgment>;
export const JudgmentsFile = z.record(z.string(), Judgment);
export type JudgmentsFile = z.infer<typeof JudgmentsFile>;

export const CoverageClaim = z.object({
  claim_id: z.string(),
  number: z.string().nullable(),
  kind: ClaimKind,
  title: z.string().nullable(),
  is_main: z.boolean(),
  extraction: z.enum(["certain", "uncertain"]),
  text_tex: z.string(),
  status: Status,
  auto_status: Status,
  decided_by: z.enum(["auto", "human", "rule"]),
  reason: z.string(),
  decls: z.array(z.string()),
  evidence: z.object({
    paper: z.object({ file: z.string(), line: z.number() }),
    lean: z.array(
      z.object({
        decl: z.string(),
        file: z.string(),
        line: z.number(),
        url: z.string().nullable(),
        type_pp: z.string(),
        module: z.string(),
      }),
    ),
    differences: z.array(Difference),
    rejected_candidates: z.array(z.object({ decl: z.string(), reason: z.string() })),
    axioms: z.array(z.string()),
    uses_sorry: z.boolean(),
    corollary_of: z.string().nullable(),
  }),
  human: z.object({
    status: z.union([Status, z.literal("confirm")]).nullable(),
    note: z.string().nullable(),
    by: z.string().nullable(),
    at: z.string().nullable(),
    stale: z.boolean(),
  }),
  claim_text_sha256: z.string(),
});
export type CoverageClaim = z.infer<typeof CoverageClaim>;

export const CoverageFile = z.object({
  schema: z.literal("ccm/coverage@1"),
  tool: Tool,
  generated_at: z.string(),
  inputs: z.object({
    paper: z.string(),
    repo: z.string(),
    commit: z.string(),
    toolchain: z.string(),
    judge: JudgeInfo.nullable(),
  }),
  usage: Usage.nullable(),
  summary: z.object({
    total: z.number(),
    verified: z.number(),
    weakened: z.number(),
    corollary_only: z.number(),
    assumed: z.number(),
    missing: z.number(),
    needs_review: z.number(),
  }),
  claims: z.array(CoverageClaim),
});
export type CoverageFile = z.infer<typeof CoverageFile>;

export const Hints = z.object({
  main_results: z.array(z.string()).optional(),
  links: z.record(z.string(), z.array(z.string())).optional(),
  ignore: z.array(z.string()).optional(),
});
export type Hints = z.infer<typeof Hints>;

export const ALL_SCHEMAS = {
  "ccm-claims": ClaimsFile,
  "lean-extract-decls": DeclsFile,
  "ccm-candidates": CandidatesFile,
  "ccm-verdicts": VerdictsFile,
  "ccm-coverage": CoverageFile,
  "ccm-judgments": JudgmentsFile,
  "ccm-hints": Hints,
} as const;
