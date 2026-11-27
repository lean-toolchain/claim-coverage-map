# How it works

```
paper ─▶ paper-extract ─▶ claims.json ─┐
                                       ├─▶ link ─▶ candidates.json ─▶ judge ─▶ verdicts.json ─┐
repo  ─▶ lean-extract  ─▶ decls.json ──┘                                                     ├─▶ report
                     author hints ─┘                               judgments.yaml (human) ───┘
```

Every stage except `judge` is deterministic. `judge` is made reproducible by caching each LLM answer under a key of (provider, model, prompt version, input, round): with the cache present, two runs produce byte-identical output.

## 1. Finding the paper's theorems

- The file containing `\documentclass` is the root; `\input`, `\include` and `\subfile` are expanded.
- `\newtheorem` (including shared counters and `[section]` numbering) and thmtools `\declaretheorem` are parsed to know which environments are theorems, lemmas, propositions or corollaries (English, German, French and Korean names). Definitions, remarks, examples and conjectures are skipped.
- **Numbers are the real printed ones.** ccm compiles the paper with a tiny injected package that writes each theorem's printed number into the `.aux` file, and also reads `\label` numbers. If compilation is impossible, numbers are estimated by simulating LaTeX counters (`numbering: "estimated"`).
- **Main results**: from `hints.yaml` if given; otherwise results in Section 1 or referenced from the abstract/introduction; otherwise every Theorem.

## 2. Reading the Lean side

`lean-extract/` is a Lean 4 program. It creates a temporary Lake workspace that requires the target repository unchanged, builds it with the repository's own toolchain, imports its modules, and for each declaration records the pretty-printed statement, hypotheses, conclusion, docstring, source range, and — via Lean's `collectAxioms` — whether it depends on `sorry` or any axiom beyond `propext`, `Classical.choice`, `Quot.sound`.

## 3. Finding candidates

- **Author-declared links** (hints, blueprint, `formalization.yaml`, docstrings) are used when present.
- Otherwise a BM25 search over declaration names (split into words), docstrings and identifiers returns the top 8 Lean theorems for each paper statement.

## 4. Judging

For each theorem, the LLM sees the paper statement, every candidate's Lean statement and hypotheses, definitions of project-local constants used, and the list of the paper's other results. For each candidate it answers `match`, `weaker` (must list the differences), `matches_other_claim` (with which one), `unrelated`, or `uncertain`, under a schema-enforced output.

This is done **twice independently**, with candidate order rotated. If the two answers disagree, the relation becomes `uncertain`.

## 5. Status rules

For each theorem, the first matching row wins:

| # | Condition | Status |
|---|---|---|
| 0 | A valid (non-stale) human judgment exists | that status (`human`) |
| 1 | Author explicitly declared "not formalized" | `missing` (`rule`) |
| 2 | A candidate judged `match`/`weaker` uses `sorry` or a non-standard axiom | `assumed` (`rule`) |
| 3 | A candidate unanimously `match` | `verified` |
| 4 | A candidate unanimously `weaker` | `weakened` |
| 5 | All candidates are unanimously `unrelated`/`matches_other_claim`, and one corresponds to a later result or a corollary | `corollary_only` |
| 6 | No candidates, or all unanimously `unrelated` | `missing` |
| 7 | Anything else (disagreement, uncertainty, LLM failure) | `needs_review` |

Rows 3–6 require unanimous agreement with at least 2 votes. `--no-auto-verified` turns row 3 into `needs_review`.
