import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { paperExtract } from "../src/stages/paperExtract.js";
import { link } from "../src/stages/link.js";
import { judgeStage } from "../src/stages/judge.js";
import { buildCoverage, toFormalizationYaml, toLatex, toMarkdown } from "../src/stages/report.js";
import { renderHtml } from "../src/report/html.js";
import { LlmJudge } from "../src/judge/llmJudge.js";
import { FixtureProvider } from "../src/providers/fixture.js";
import { DeclsFile, type LlmJudgeOutput } from "../src/schemas/index.js";
import type { CompleteRequest } from "../src/providers/types.js";

const fx = (p: string) => join(import.meta.dirname, "fixtures", p);
const decls = DeclsFile.parse(JSON.parse(readFileSync(fx("decls.json"), "utf8")));

/** Deterministic fake judge: decides by decl name, regardless of the claim. */
function responder(req: CompleteRequest<unknown>): LlmJudgeOutput {
  const id = /\[id: ([^\]]+)\]/.exec(req.user)![1]!;
  const names = [...req.user.matchAll(/^### (Paper\.\S+)$/gm)].map((m) => m[1]!).filter((n) => n !== "Paper.IsNice");
  const rel: Record<string, (claim: string) => LlmJudgeOutput["candidates"][number]> = {
    "Paper.fermat": (c) => c === "c-thm-1.1" ? r("Paper.fermat", "match") : r("Paper.fermat", "unrelated"),
    "Paper.add_zero": (c) => c === "c-lem-2.1" ? r("Paper.add_zero", "match") : r("Paper.add_zero", "unrelated"),
    "Paper.choose_dvd": (c) => c === "c-lem-3.4"
      ? { ...r("Paper.choose_dvd", "weaker"), differences: [{ kind: "added_hypothesis", lean: "h₃ : Odd p", paper: null, note: "p odd assumed" }] }
      : r("Paper.choose_dvd", "unrelated"),
    "Paper.odd_order_cyclic": (c) => c === "c-cor-3.3" ? r("Paper.odd_order_cyclic", "match")
      : c === "c-thm-3.2" ? { ...r("Paper.odd_order_cyclic", "matches_other_claim"), other_claim_id: "c-cor-3.3" } : r("Paper.odd_order_cyclic", "unrelated"),
    "Paper.even_add": (c) => c === "c-prop-1" ? r("Paper.even_add", "match") : r("Paper.even_add", "unrelated"),
  };
  return { candidates: names.map((n) => rel[n]!(id)) };
}
const r = (decl: string, relation: LlmJudgeOutput["candidates"][number]["relation"]) => ({ decl, relation, other_claim_id: null, differences: [], rationale: `${relation} by fixture` });

async function pipeline(opts: { offline?: boolean; cacheDir: string; judgments?: Record<string, never> }) {
  const claims = await paperExtract({ paperDir: fx("paper"), paperId: "local:paper", compile: "never", allowEstimated: true });
  const candidates = link({ claims, decls });
  const provider = opts.offline ? null : new FixtureProvider({ provider: "fixture", model: "m" }, responder);
  const judge = new LlmJudge(provider, { providerId: "fixture", model: "m", votes: 2, cacheDir: opts.cacheDir });
  const verdicts = await judgeStage({ claims, decls, candidates, judge, judgeInfo: { provider: "fixture", model: "m", votes: 2 } });
  const cov = buildCoverage({ claims, decls, candidates, verdicts, judgments: opts.judgments ?? {}, repo: decls.inputs.repo, commit: "abc123", now: "T" });
  return { claims, candidates, verdicts, cov };
}

describe("pipeline with fixture judge", () => {
  it("links docstrings as author declarations", async () => {
    const { candidates } = await pipeline({ cacheDir: mkdtempSync(join(tmpdir(), "ccm-")) });
    const by = Object.fromEntries(candidates.links.map((l) => [l.claim_id, l]));
    expect(by["c-thm-1.1"]).toMatchObject({ author_declared: ["Paper.fermat"], author_source: "docstring" });
    expect(by["c-lem-3.4"]!.author_declared).toEqual(["Paper.choose_dvd"]);
    expect(by["c-thm-3.2"]!.author_declared).toBeNull();
    expect(by["c-thm-3.2"]!.retrieved[0]!.decl).toBe("Paper.odd_order_cyclic"); // BM25: "odd order"
  });

  it("produces every structural status", async () => {
    const { cov } = await pipeline({ cacheDir: mkdtempSync(join(tmpdir(), "ccm-")) });
    const st = Object.fromEntries(cov.claims.map((c) => [c.claim_id, c.status]));
    expect(st).toEqual({
      "c-thm-1.1": "verified", "c-lem-2.1": "verified", "c-thm-3.2": "corollary_only",
      "c-cor-3.3": "verified", "c-lem-3.4": "weakened", "c-prop-1": "assumed",
    });
    const w = cov.claims.find((c) => c.claim_id === "c-lem-3.4")!;
    expect(w.evidence.lean[0]!.url).toBe("https://github.com/example/paper-lean/blob/abc123/Paper/Main.lean#L40");
    expect(w.evidence.differences[0]!.lean).toBe("h₃ : Odd p");
    expect(cov.summary).toMatchObject({ total: 6, verified: 3, weakened: 1, corollary_only: 1, assumed: 1 });
  });

  it("is deterministic given the cache, and offline reuses the cache", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "ccm-"));
    const a = await pipeline({ cacheDir });
    const b = await pipeline({ cacheDir, offline: true });
    expect(JSON.stringify(b.cov)).toBe(JSON.stringify(a.cov));
    expect(renderHtml(b.cov, { inlineKatex: false })).toBe(renderHtml(a.cov, { inlineKatex: false }));
  });

  it("offline with an empty cache → every LLM-dependent result needs review", async () => {
    const { cov } = await pipeline({ cacheDir: mkdtempSync(join(tmpdir(), "ccm-")), offline: true });
    const st = Object.fromEntries(cov.claims.map((c) => [c.claim_id, c.status]));
    // even_add is sorry-based but relation is unknown offline → not assumed (relation must be match/weaker)
    expect(Object.values(st).every((s) => s === "needs_review")).toBe(true);
  });

  it("applies human judgments and marks stale ones", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "ccm-"));
    const { cov: first } = await pipeline({ cacheDir });
    const sha = first.claims.find((c) => c.claim_id === "c-thm-3.2")!.claim_text_sha256;
    const { cov } = await pipeline({
      cacheDir,
      judgments: {
        "c-thm-3.2": { status: "missing", note: "main theorem absent", by: "rev", at: "2026-11-27", claim_text_sha256: sha },
        "c-lem-3.4": { status: "verified", note: "old", claim_text_sha256: "deadbeef" },
      } as never,
    });
    const by = Object.fromEntries(cov.claims.map((c) => [c.claim_id, c]));
    expect(by["c-thm-3.2"]).toMatchObject({ status: "missing", decided_by: "human", auto_status: "corollary_only" });
    expect(by["c-lem-3.4"]).toMatchObject({ status: "weakened", decided_by: "auto" });
    expect(by["c-lem-3.4"]!.human.stale).toBe(true);
  });

  it("exports appendix tables and formalization.yaml (preserving other keys)", async () => {
    const { cov } = await pipeline({ cacheDir: mkdtempSync(join(tmpdir(), "ccm-")) });
    const md = toMarkdown(cov);
    expect(md).toContain("| Lemma 3.4 | `Paper.choose_dvd` | weakened | p odd assumed |");
    expect(md).toContain("| Theorem 3.2 (main) | `Paper.odd_order_cyclic` | corollary only |");
    const tex = toLatex(cov);
    expect(tex).toContain("\\texttt{Paper.choose\\_dvd}");
    const y = YAML.parse(toFormalizationYaml(cov, decls, "title: My paper\nstatus:\n  build: ok\n"));
    expect(y.title).toBe("My paper");
    expect(y.status).toEqual({ build: "ok", sorry_count: 1, axioms: [] });
    expect(y.alignment.statements.map((s: { source: string }) => s.source)).toContain("Lemma 3.4");
    expect(y.alignment.statements.find((s: { source: string }) => s.source === "Lemma 3.4").status).toBe("weakened (automatic, ccm): p odd assumed");
  });

  it("renders a single-file HTML report with embedded data and KaTeX", async () => {
    const { cov } = await pipeline({ cacheDir: mkdtempSync(join(tmpdir(), "ccm-")) });
    const html = renderHtml(cov);
    expect(html).toContain('id="ccm-data"');
    expect(html).toContain("data:font/woff2;base64,");
    expect(html).not.toMatch(/<script[^>]+src=/);
  });
});

describe("second judging pass", () => {
  it("feeds declarations pointed at a claim back into its candidates", async () => {
    const { crossClaimPointers } = await import("../src/stages/judge.js");
    const p = crossClaimPointers([
      { claim_id: "a", error: null, candidates: [{ decl: "D1", relation: "matches_other_claim", other_claim_id: "b", differences: [], agreement: 2, rationale: "", assumed: false }] },
      { claim_id: "c", error: null, candidates: [{ decl: "D2", relation: "matches_other_claim", other_claim_id: "b", differences: [], agreement: 2, rationale: "", assumed: false }] },
    ]);
    expect(p.get("b")).toEqual(["D1", "D2"]);
  });
});

describe("blind mode", () => {
  it("ignores docstring declarations when noAuthorLinks is set", async () => {
    const claims = await paperExtract({ paperDir: fx("paper"), paperId: "p", compile: "never", allowEstimated: true });
    const l = link({ claims, decls, noAuthorLinks: true });
    expect(l.links.every((x) => x.author_declared === null)).toBe(true);
    expect(l.links.find((x) => x.claim_id === "c-thm-1.1")!.retrieved.map((r) => r.decl)).toContain("Paper.fermat");
  });
});

describe("math vocabulary in search", () => {
  it("connects O(...) in the paper with isBigO / =O[...] in Lean", async () => {
    const { mathWords } = await import("../src/stages/link.js");
    expect(mathWords("D(X) = cX + O(X/\\sqrt{\\log X})")).toContain("bigo");
    expect(mathWords("(fun x => f x) =O[atTop] g")).toContain("bigo");
    expect(mathWords("irregularPrimes_isBigO")).toContain("bigo");
    expect(mathWords("Filter.Tendsto f atTop (nhds c)")).toContain("tendsto");
    expect(mathWords("plain words only")).toBe("");
  });
});
