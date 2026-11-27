# ccm — Claim Coverage Map

**For every theorem in a paper, see how the accompanying Lean code actually covers it.**

Give `ccm` a paper (arXiv ID or LaTeX source) and a Lean repository at a fixed commit. It returns a table — in paper order — that assigns every Theorem, Lemma, Proposition and Corollary one of six statuses, each backed by evidence you can click through:

| Status | Meaning |
|---|---|
| `verified` | A Lean declaration states the same result, with no assumptions beyond Lean's standard axioms |
| `weakened` | Formalized, but with something lost — an extra hypothesis, a narrower domain, a weaker constant. The difference is always spelled out |
| `corollary_only` | Only a weaker consequence (e.g. Corollary 5.4) is formalized, not this result itself |
| `assumed` | The corresponding declaration depends on `sorry` or a non-standard `axiom` |
| `missing` | No Lean declaration corresponds; rejected candidates and the reasons are listed |
| `needs_review` | The tool is not confident — a human decides |

```
6 results: verified 3 · weakened 1 · corollary only 1 · assumed 1 · missing 0 · needs review 0
```

## The problem

"Formally verified in Lean" has become a common claim attached to papers — including large batches of AI-assisted formalizations. But Lean only guarantees one thing: *the stated Lean theorem follows from its hypotheses*. It says nothing about whether that Lean theorem is the theorem the paper claims.

That gap is real and common:

- In a review of a public collection of ~290 papers shipped with Lean code, roughly **13% of the Lean projects never even stated the paper's main theorem**. In one case the theorem presented as the headline result was actually the paper's Corollary 5.4.
- AI formalizers sometimes **silently change hypotheses** and prove a weaker statement than the paper's.
- Important lemmas are left as `sorry` or introduced as `axiom`, and nobody notices because the project still builds.

Tools that check compilation, kernel soundness, or "does this proof prove *this* statement" (e.g. `lake comparator`) cannot catch any of this — they take the *choice* of statement as given. Today the only way to catch it is for a reviewer to read the paper and the Lean code side by side, by hand, for hours.

## What ccm solves

ccm automates the paper ↔ Lean correspondence check, which is the step everything else trusts:

- **Catches the big, structural failures** — main theorem not formalized, only a corollary formalized, results resting on `sorry`/axioms. These need no deep semantic analysis, so they are detected reliably.
- **Covers the whole paper**, not just the results the authors chose to highlight.
- **Every verdict carries evidence**: the paper's line, the Lean declaration with file/line link, the exact added hypothesis highlighted, and rejected candidates with reasons.
- **Conservative by design**: two independent LLM judgments must agree, otherwise the result is `needs_review`. A wrong `verified` is treated as worse than no answer. `--no-auto-verified` turns automatic `verified` off entirely.
- **Mechanical facts are not left to the LLM**: `sorry` and axiom usage come straight from Lean's `collectAxioms`.
- **Human-in-the-loop**: reviewers record their own verdicts and notes in the HTML report; they survive re-runs, and are flagged stale if the paper text changes.

What ccm deliberately does **not** do: re-check compilation or proofs, prove that a Lean statement is mathematically equivalent to the paper's sentence, or generate/fix formalizations.

### Who it is for

- **Reviewers and editors** judging a "verified in Lean" submission: get the coverage picture in minutes instead of hours, and focus attention on the few `needs_review` rows.
- **Authors** before submission: find the forgotten `sorry`, export the table as a paper appendix or a `formalization.yaml` draft, and run it in CI with `--fail-on missing,assumed`.

## How you use it

The paper ↔ repository pairing is stable, so it lives in the repository once, and nothing has to be typed per run:

```yaml
# ccm.yaml at the root of the Lean repository
paper: arXiv:2609.08431      # or a LaTeX directory inside the repo
```

| When | Who | How |
|---|---|---|
| While formalizing | Author | Run `ccm` in the repo — no arguments. Uses the current checkout and records `HEAD`. Cached judgments make re-runs cheap |
| On every pull request | Author, collaborators | The **GitHub Action** comments the coverage table and what *changed* (e.g. `Lemma 4.4: verified → assumed`), optionally failing the check |
| At submission / release | Author | The same Action attaches `report.html`, appendix tables and `formalization.yaml` to the release — send reviewers one link |
| During review | Reviewer | `ccm 2609.08431` — the repository is found from the paper's links; the resolved commit is recorded |

### Run locally with your own subscription

No API key needed if you already use a coding-agent CLI:

```yaml
# ccm.yaml (or ~/.config/ccm/ccm.toml for all projects)
llm:
  provider: claude-code          # your logged-in Claude subscription
  model: claude-opus-5-5
```

Any other CLI that reads a prompt on stdin and prints the answer works through the `command` provider:

```yaml
llm:
  provider: command
  model: some-model
  command:
    argv: ["your-cli", "--model", "{model}"]
```

With an API key instead: `provider: anthropic-api` (reads `ANTHROPIC_API_KEY`) or `openai-compatible` (any OpenAI-style server, including local models).

### Run in CI

```yaml
# .github/workflows/ccm.yml
on: { push: { branches: [main] }, pull_request: {}, release: { types: [published] } }
permissions: { contents: write, pull-requests: write, actions: read }
jobs:
  coverage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: lean-toolchain/claim-coverage-map@v0
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          model: claude-opus-5-5
```

### Install

Requirements: Node.js 24, pnpm, [elan](https://github.com/leanprover/elan) (Lean), and `latexmk` (or Docker).

```sh
git clone <this repo> && cd claim-coverage-map
nvm install && nvm use
pnpm install && pnpm build && pnpm link --global   # provides `ccm`
```

Authors can make links explicit instead of inferred by writing the paper's number in a docstring:

```lean
/-- Theorem 3.1 of the paper. -/
theorem main_theorem ... := ...
```

## Documentation

- [docs/usage.md](docs/usage.md) — every command, option, configuration file, exit codes, and worked examples
- [docs/github-action.md](docs/github-action.md) — Action inputs, outputs, PR comments, releases, forks
- [docs/outputs.md](docs/outputs.md) — what each output file contains, with examples
- [docs/how-it-works.md](docs/how-it-works.md) — pipeline, matching, judging, and the exact status rules

## Development

```sh
pnpm typecheck && pnpm test     # add ~/.elan/bin to PATH to include the Lean integration test
pnpm schemas                    # regenerate JSON Schemas in schemas/
```

Layout: `src/stages/` (pipeline stages), `src/judge/` + `src/providers/` (LLM judging), `src/report/` (HTML), `lean-extract/` (Lean 4 extractor), `test/`.
