# Usage

## Commands at a glance

```
ccm [paper]        # the default: run everything with inputs resolved automatically
ccm run            # same, with --paper as an option
ccm fetch          # get paper source + repository into the work directory
ccm paper-extract  # list the paper's theorems          → claims.json
ccm lean-extract   # list the Lean declarations         → decls.json
ccm link           # candidate Lean declarations/claim  → candidates.json
ccm judge          # LLM verdicts per candidate         → verdicts.json
ccm report         # apply status rules, write outputs  → out/
ccm judge-merge    # import reviewer verdicts from the HTML report
ccm export         # print/write one output format
ccm diff           # compare two coverage.json files (used for PR comments)
```

## How inputs are resolved

| Input | Resolution order |
|---|---|
| Repository | `--repo` → the git repository containing the current directory (if it has `lean-toolchain`) → a GitHub link found in the paper source |
| Commit | `--commit` → `HEAD` of that repository. Uncommitted changes are recorded as `<sha>+dirty` |
| Paper | positional argument / `--paper` → `paper:` in `ccm.yaml` → arXiv link in `formalization.yaml` → a `paper/`, `tex/` or `latex/` directory with `.tex` files |
| LLM | CLI flags → `llm:` in `ccm.yaml` → `ccm.toml` (current directory, then `~/.config/ccm/`) |

So the common cases are:

```sh
ccm                                  # inside a Lean repo with ccm.yaml
ccm 2609.08431                       # reviewer: repo discovered from the paper
ccm 2609.08431 --repo https://github.com/o/r --commit 4e22a6f   # fully explicit
```

When a local repository is used it is analyzed in place (not copied); remote repositories are cloned into the work directory.

All commands share `--workdir <dir>` (default `.ccm-work`). Each stage reads only the files earlier stages wrote, so any stage can be re-run alone — e.g. edit `hints.yaml`, then `ccm link && ccm judge && ccm report`.

## `ccm` / `ccm run`

```
ccm [paper] [options]
ccm run [--paper <arXiv ID | dir>] [options]
```

| Option | Description |
|---|---|
| `[paper]` / `--paper` | arXiv ID (`2609.08431`, `2609.08431v2`, `arXiv:…`) — the LaTeX source is downloaded — or a local LaTeX directory. Default: see resolution above |
| `--repo <url\|path>` | Lean repository (git URL or local path). Must build with `lake build`. Default: see resolution above |
| `--commit <sha>` | Commit to analyze (default `HEAD`). Recorded in every output |
| `--workdir <dir>` | Work directory (default `.ccm-work`) |
| `--hints <file>` | Author hints file (see below). Default: `hints.yaml` at the repo root if present |
| `--provider <id>` | LLM provider: `claude-code`, `command`, `anthropic-api`, `openai-compatible`, `fixture` |
| `--model <id>` | Model passed verbatim to the provider, e.g. `claude-opus-5-5` |
| `--votes <n>` | Independent judgments per theorem, 1–3 (default 2). With 1, nothing is auto-`verified` |
| `--effort <level>` | `low`…`max`, if the provider supports it |
| `--offline` | No network. Uncached LLM judgments become `needs_review` |
| `--decls <file>` | Use an existing `decls.json` instead of building the repo |
| `--modules <A,B>` | Lean root modules to load (default: all project modules) |
| `--no-compile` | Skip LaTeX compilation; theorem numbers are estimated by simulating counters |
| `--allow-estimated-numbering` | Continue with estimated numbers if compilation fails (otherwise exit 3) |
| `--no-auto-verified` | Never emit an automatic `verified`; such rows become `needs_review` |
| `--fail-on <statuses>` | Exit 1 if any result has one of these statuses, e.g. `missing,assumed` |
| `--no-author-links` | Blind mode: ignore author declarations (hints, blueprint, `formalization.yaml`, docstrings) — what an independent reviewer would see |

### Example

```sh
$ cd paper-lean && ccm
ccm: paper arXiv:2609.08431 · repo https://github.com/someone/paper-lean @ 4e22a6f…
ccm: extracted 6 results (numbering: aux)
ccm: 6 results: verified 3 · weakened 1 · corollary only 1 · assumed 1 · missing 0 · needs review 0
ccm: report: /home/me/.ccm-work/out/report.html
```

For CI, use the bundled GitHub Action: see [github-action.md](github-action.md).

## Stage commands

| Command | Options |
|---|---|
| `ccm fetch` | `--paper`, `--repo`, `--commit`, `--offline` (same resolution as `ccm`) |
| `ccm paper-extract` | `--hints`, `--no-compile`, `--allow-estimated-numbering` |
| `ccm lean-extract` | `--decls <file>`, `--modules <A,B>` |
| `ccm link` | `--hints` |
| `ccm judge` | `--provider`, `--model`, `--votes`, `--effort`, `--offline` |
| `ccm report` | `--no-auto-verified`, `--fail-on` |

## Reviewer workflow

1. Open `out/report.html`, tick **Judgment mode**.
2. Expand a row, choose a status (or *confirm automatic*), write a note. Drafts are kept in the browser.
3. Click **Download judgments.json**.
4. Merge and regenerate:

```sh
ccm judge-merge ~/Downloads/judgments.json
ccm report
```

Judgments are stored in `.ccm-work/judgments.yaml` (keep it under version control):

```yaml
c-thm-3.2:
  status: missing
  note: Lean only proves the simple-group case.
  by: reviewer-1
  at: "2026-11-27"
  claim_text_sha256: 04f1156c…
```

If the paper's statement text later changes, the judgment is shown as **stale** and not applied.

## `ccm export`

```
ccm export --format latex|markdown|formalization-yaml|json [--out <path>]
```

Prints to stdout unless `--out` is given. Requires a prior `ccm report`. See [outputs.md](outputs.md) for examples.

## `ccm diff`

```
ccm diff <base coverage.json | -> <head coverage.json> [--format markdown|json] [--out <path>]
```

Lists results whose status changed — regressions first, then removed, added, and improved results — plus summary deltas and main results that are not verified. The Markdown form is exactly the PR comment the Action posts:

```markdown
## Claim coverage

**6 results:** verified 2 (-1) · weakened 1 · corollary only 1 · assumed (sorry/axiom) 2 (+1) · missing 0 · needs review 0

**Main results not verified:** Theorem 3.2 (corollary only)

| | Result | Before | After | Why |
|---|---|---|---|---|
| 🔻 | Lemma 4.4 | verified | assumed (sorry/axiom) | Paper.key_lemma relies on sorry or a non-standard axiom |
```

## Project file `ccm.yaml`

Put it at the root of the Lean repository. All keys are optional.

```yaml
paper: arXiv:2609.08431        # or a LaTeX directory in the repo
modules: [Foo]                 # Lean root modules to load
main_results: ["Theorem 1.1"]  # override main-result detection (labels or numbers)
links:
  "Theorem 3.1": ["Foo.main_theorem"]
  "Lemma 4.4": []              # explicitly not formalized → missing
ignore: ["Proposition 2.3"]
llm:                           # same keys as [llm] in ccm.toml
  provider: claude-code
  model: claude-opus-5-5
```

## LLM providers

| Provider | Use when | Settings |
|---|---|---|
| `claude-code` | Local, with your Claude subscription (`claude` CLI logged in) | `binary` (default `claude`) |
| `command` | Local, with any other CLI that reads the prompt on stdin and prints the answer | `argv` — `{model}` is replaced by the model |
| `anthropic-api` | API key (local or CI) | `ANTHROPIC_API_KEY` or other SDK credentials |
| `openai-compatible` | OpenAI-style servers, local models | `base_url`, `api_key_env` |
| `fixture` | Tests | reads canned answers |

Providers without native structured output get the JSON Schema in the prompt; invalid answers are retried once with the error, then the result becomes `needs_review`. Rate limits are retried with backoff.

## Configuration file `ccm.toml`

Looked up in the current directory, then `~/.config/ccm/ccm.toml`. Command-line flags take precedence.

```toml
[llm]
provider = "anthropic-api"     # anthropic-api | claude-code | openai-compatible | fixture
model = "claude-opus-5-5"
votes = 2
max_concurrency = 4
effort = "high"

[llm.claude-code]              # uses your logged-in `claude` CLI subscription
binary = "claude"

[llm.command]                  # any CLI: prompt on stdin, answer on stdout
argv = ["your-cli", "--model", "{model}"]

[llm.openai-compatible]        # local or third-party servers
base_url = "http://localhost:8000/v1"   # default: $OPENAI_BASE_URL, else https://api.openai.com/v1
api_key_env = "OPENAI_API_KEY"
```

There is no default provider: if none is configured and judging is needed, ccm exits with code 2 and prints this template. `anthropic-api` reads credentials the standard SDK way (`ANTHROPIC_API_KEY`, etc.).

## Author hints `hints.yaml` (legacy)

The same keys can live in `ccm.yaml`; a separate `hints.yaml` (or `--hints <file>`) is still read.

```yaml
main_results: ["thm:main", "Theorem 1.2"]   # override which results are "main" (labels or numbers)
links:
  "Theorem 3.1": ["Foo.main_theorem"]       # explicit correspondence
  "Lemma 4.4": []                           # explicitly "not formalized" → missing
ignore: ["Proposition 2.3"]                 # e.g. results cited from other papers
```

Author-declared links are taken from, in priority order: `hints.yaml` > blueprint `\lean{…}` > an existing `formalization.yaml` > Lean docstrings mentioning `Theorem 3.1`, `Lem. 2.4`, etc. When a theorem has author-declared links, only those are judged.

## Environment variables

| Variable | Effect |
|---|---|
| `CCM_TEXLIVE_IMAGE` | Docker image used when local `latexmk` fails (default `texlive/texlive:latest`; pin a tag) |
| `CCM_NOW` | Fixed timestamp for reproducible output |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Report generated |
| 1 | Report generated, and a `--fail-on` status occurred |
| 2 | Usage or configuration error |
| 3 | Paper source unavailable or LaTeX compilation failed |
| 4 | Lean repository failed to build / extract |
