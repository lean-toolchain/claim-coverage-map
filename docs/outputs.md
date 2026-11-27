# Outputs

Everything lands in the work directory (default `.ccm-work/`):

```
.ccm-work/
  meta.json          inputs of this run
  paper/  repo/      fetched sources
  claims.json        theorems found in the paper
  decls.json         Lean declarations
  candidates.json    candidate links per theorem
  verdicts.json      LLM verdicts
  judgments.yaml     reviewer verdicts (you keep this)
  .cache/llm/        cached LLM answers (makes re-runs free and reproducible)
  out/
    report.html      interactive report (single file, works offline, shareable)
    coverage.json    final machine-readable result
    appendix.tex     LaTeX table for a paper appendix
    appendix.md      Markdown table
    formalization.yaml
```

All JSON files carry `schema`, `tool` and `inputs` fields; JSON Schemas are in [`../schemas/`](../schemas/).

## report.html

A summary line, then one row per result in paper order (number, kind, main-result mark, status, Lean declaration). Expanding a row shows:

- **Why** — the rule that decided the status
- **Paper** statement (math rendered) next to the **Lean** statement, with any added hypothesis highlighted
- **Differences**, **Assumptions** (`sorry`, axioms), **Rejected candidates** with reasons
- **Human judgment**, and in judgment mode, a status picker and note field

The footer records commit, Lean toolchain, ccm version, judge model, token usage and generation time.

## coverage.json (`ccm/coverage@1`)

The final result, intended as input for other tools.

```jsonc
{
  "schema": "ccm/coverage@1",
  "inputs": { "paper": "arXiv:2609.08431", "repo": "https://github.com/someone/paper-lean",
              "commit": "4e22a6f…", "toolchain": "leanprover/lean4:v4.24.0",
              "judge": { "provider": "anthropic-api", "model": "claude-opus-5-5", "votes": 2, "prompt_version": "j1" } },
  "summary": { "total": 6, "verified": 3, "weakened": 1, "corollary_only": 1, "assumed": 1, "missing": 0, "needs_review": 0 },
  "claims": [
    {
      "claim_id": "c-lem-3.4", "number": "3.4", "kind": "lemma", "is_main": false,
      "status": "weakened", "auto_status": "weakened", "decided_by": "auto",
      "reason": "Paper.choose_dvd is weaker: p odd assumed",
      "decls": ["Paper.choose_dvd"],
      "evidence": {
        "paper": { "file": "main.tex", "line": 32 },
        "lean": [{ "decl": "Paper.choose_dvd", "file": "Paper/Main.lean", "line": 40,
                   "url": "https://github.com/someone/paper-lean/blob/4e22a6f…/Paper/Main.lean#L40",
                   "type_pp": "∀ (p k : ℕ), Nat.Prime p → 0 < k → k < p → Odd p → p ∣ Nat.choose p k" }],
        "differences": [{ "kind": "added_hypothesis", "lean": "h₃ : Odd p", "paper": null, "note": "p odd assumed" }],
        "rejected_candidates": [], "axioms": [], "uses_sorry": false, "corollary_of": null
      },
      "human": { "status": null, "note": null, "by": null, "at": null, "stale": false }
    }
  ]
}
```

- `decided_by`: `auto` (LLM + rules), `rule` (mechanical: sorry/axiom, or author said "not formalized"), `human`.
- `auto_status` is what the tool decided before any human judgment.

## appendix.md / appendix.tex

```markdown
| Result | Lean declaration | Status | Note |
|---|---|---|---|
| Theorem 1.1 (main) | `Paper.fermat` | verified |  |
| Lemma 2.1 | `Paper.add_zero` | verified |  |
| Theorem 3.2 (main) | `Paper.odd_order_cyclic` | corollary only | only via c-cor-3.3 |
| Corollary 3.3 | `Paper.odd_order_cyclic` | verified |  |
| Lemma 3.4 | `Paper.choose_dvd` | weakened | p odd assumed |
| Proposition 1 | `Paper.even_add` | assumed (sorry/axiom) | sorry |
```

The LaTeX version is a `tabular` with the same columns, status symbols and a legend.

## formalization.yaml

A fragment for the Palomar registry template. If the repository already has a `formalization.yaml`, only these keys are updated and everything else is preserved:

```yaml
status:
  sorry_count: 1
  axioms: []
alignment:
  statements:
    - source: Lemma 3.4
      lean: Paper.choose_dvd
      module: Paper.Main
      status: weakened
      note: p odd assumed
```

`missing` results are not listed here (they appear in the report and appendix). The `status` value mapping is provisional until validated against the official schema (`PALOMAR_STATUS` in `src/stages/report.ts`).

## Intermediate files

| File | Schema | Content |
|---|---|---|
| `claims.json` | `ccm/claims@1` | id (`c-thm-3.1`), kind, number, label, title, LaTeX and plain text, location, `is_main`, `extraction: certain\|uncertain`; `numbering: aux\|estimated` |
| `decls.json` | `lean-extract/decls@1` | per declaration: name, kind, module, file, range, docstring, pretty-printed type, binders, conclusion, axioms, `uses_sorry`, `nonstandard_axioms`, project constants used |
| `candidates.json` | `ccm/candidates@1` | per theorem: author-declared links and their source, top-8 search results with scores |
| `verdicts.json` | `ccm/verdicts@1` | per candidate: `relation` (`match`, `weaker`, `matches_other_claim`, `unrelated`, `uncertain`), differences, agreement count, rationale, `assumed` flag |
