import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverRepoUrls, loadProjectConfig, pickRepo, resolvePaper } from "../src/project.js";
import { diffCoverage, COMMENT_MARKER } from "../src/stages/diff.js";
import type { CoverageFile } from "../src/schemas/index.js";

const tmp = () => mkdtempSync(join(tmpdir(), "ccm-p-"));

describe("project config", () => {
  it("reads paper and hints from ccm.yaml", () => {
    const d = tmp();
    writeFileSync(join(d, "ccm.yaml"), 'paper: arXiv:2609.08431\nlinks:\n  "Lemma 4.4": []\nllm:\n  provider: claude-code\n  model: m\n');
    const cfg = loadProjectConfig(d)!;
    expect(cfg.links).toEqual({ "Lemma 4.4": [] });
    expect(resolvePaper(d, cfg)).toBe("arXiv:2609.08431");
  });
  it("falls back to formalization.yaml and then paper/", () => {
    const d = tmp();
    writeFileSync(join(d, "formalization.yaml"), "paper:\n  url: https://arxiv.org/abs/2501.01234v3\n");
    expect(resolvePaper(d, null)).toBe("2501.01234v3");
    const e = tmp();
    mkdirSync(join(e, "paper"));
    writeFileSync(join(e, "paper", "main.tex"), "x");
    expect(resolvePaper(e, null)).toBe(join(e, "paper"));
    expect(resolvePaper(tmp(), null)).toBeNull();
  });
  it("discovers the formalization repository from the paper", () => {
    const d = tmp();
    writeFileSync(join(d, "main.tex"), "Code: \\url{https://github.com/alice/flt-lean}. See also https://github.com/bob/tools.git, and \\href{https://github.com/alice/flt-lean/tree/main}{here}.");
    const urls = discoverRepoUrls(d);
    expect(urls).toEqual(["https://github.com/alice/flt-lean", "https://github.com/bob/tools"]);
    expect(pickRepo(urls)).toBe("https://github.com/alice/flt-lean");
    expect(() => pickRepo([])).toThrow(/--repo/);
  });
});

const cov = (rows: [string, string, boolean][]): CoverageFile => ({
  schema: "ccm/coverage@1", tool: { name: "ccm", version: "0.1.0" }, generated_at: "T",
  inputs: { paper: "p", repo: "r", commit: "abcdef1234567890", toolchain: "t", judge: null }, usage: null,
  summary: Object.assign({ total: rows.length, verified: 0, weakened: 0, corollary_only: 0, assumed: 0, missing: 0, needs_review: 0 },
    rows.reduce((a, [, s]) => ({ ...a, [s]: ((a as Record<string, number>)[s] ?? 0) + 1 }), {})),
  claims: rows.map(([n, status, main]) => ({
    claim_id: `c-thm-${n}`, number: n, kind: "theorem", title: null, is_main: main, extraction: "certain", text_tex: "",
    status, auto_status: status, decided_by: "auto", reason: `because ${status}`, decls: [],
    evidence: { paper: { file: "m", line: 1 }, lean: [], differences: [], rejected_candidates: [], axioms: [], uses_sorry: false, corollary_of: null },
    human: { status: null, note: null, by: null, at: null, stale: false }, claim_text_sha256: "x",
  })),
}) as CoverageFile;

describe("coverage diff (PR comments)", () => {
  it("lists regressions first and reports summary deltas", () => {
    const base = cov([["1", "verified", true], ["2", "missing", false], ["3", "verified", false]]);
    const head = cov([["1", "assumed", true], ["2", "verified", false], ["4", "missing", false]]);
    const d = diffCoverage(base, head);
    expect(d.changes.map((c) => [c.claim_id, c.kind])).toEqual([
      ["c-thm-1", "regression"], ["c-thm-3", "removed"], ["c-thm-4", "added"], ["c-thm-2", "improvement"],
    ]);
    expect(d.markdown.startsWith(COMMENT_MARKER)).toBe(true);
    expect(d.markdown).toContain("verified 1 (-1)");
    expect(d.markdown).toContain("| 🔻 | Theorem 1 **(main)** | verified | assumed (sorry/axiom) |");
    expect(d.markdown).toContain("**Main results not verified:** Theorem 1");
  });
  it("without a baseline shows the current state", () => {
    const d = diffCoverage(null, cov([["1", "verified", true]]));
    expect(d.changes).toEqual([]);
    expect(d.markdown).toContain("No baseline coverage");
  });
});
