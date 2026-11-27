# GitHub Action

The repository is itself a GitHub Action. In a Lean repository with a `ccm.yaml`:

```yaml
# .github/workflows/ccm.yml
name: Claim coverage
on:
  push:
    branches: [main]        # produces the baseline that PRs are compared with
  pull_request:
  release:
    types: [published]

permissions:
  contents: write           # release uploads
  pull-requests: write      # PR comments
  actions: read             # download the baseline artifact

jobs:
  coverage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: lean-toolchain/claim-coverage-map@v0
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          model: claude-opus-5-5
          fail-on: assumed
```

A copy is in [`../examples/ccm-workflow.yml`](../examples/ccm-workflow.yml).

## What it does

| Event | Result |
|---|---|
| any | Runs `ccm` on the checked-out commit, writes the coverage table to the job summary, uploads `ccm-coverage` artifact (`coverage.json`, `report.html`, appendix tables, `formalization.yaml`) |
| `push` to the default branch | That artifact becomes the baseline for later PRs |
| `pull_request` | Downloads the latest successful baseline from the base branch and posts **one** PR comment with the changes, updated on every push |
| `release` | Attaches `report.html`, `coverage.json`, `appendix.tex`, `appendix.md`, `formalization.yaml` to the release |

## Inputs

| Input | Default | Description |
|---|---|---|
| `paper` | from `ccm.yaml` | arXiv ID or LaTeX directory |
| `provider` | `anthropic-api` if a key is given, else `ccm.yaml` | `anthropic-api`, `openai-compatible`, `command` |
| `model` | from `ccm.yaml` | Model ID |
| `anthropic-api-key` | — | Key for `anthropic-api` |
| `openai-api-key` | — | Key for `openai-compatible` (as `OPENAI_API_KEY`) |
| `votes` | 2 | Independent judgments per theorem |
| `fail-on` | — | Fail the job when any result has these statuses, e.g. `missing,assumed` |
| `latex` | `apt` | `apt` installs TeX Live for exact numbers, `docker` uses a container, `none` estimates numbers |
| `comment` | `true` | Post/update the PR comment |
| `release-assets` | `true` | Upload reports on release events |
| `no-auto-verified` | `false` | Never emit automatic `verified` |
| `github-token` | `github.token` | Token for comments, artifacts, releases |

`claude-code` is a local provider (it needs a logged-in subscription CLI), so in CI the Action switches to `anthropic-api` when a key is provided, even if `ccm.yaml` says `claude-code`.

## Outputs

| Output | Description |
|---|---|
| `summary` | e.g. `23 results: verified 15 · weakened 2 · …` |
| `report` | Path to `report.html` |
| `exit-code` | `ccm` exit code (`1` = a `fail-on` status occurred) |

## Caching and cost

Lean build outputs and LLM answers (`.ccm-work/.cache/llm`) are cached with `actions/cache`. A theorem is only re-judged when its statement or its candidate Lean declarations change, so after the first run a typical PR costs a few judgments. Mathlib projects fetch prebuilt Mathlib with `lake exe cache get`.

## Pull requests from forks

GitHub does not expose secrets to workflows triggered by forks. The Action then runs offline: cached answers are reused and anything new is shown as *needs review*, with a note in the comment. It also cannot comment with a read-only token; the job summary still contains the table.
