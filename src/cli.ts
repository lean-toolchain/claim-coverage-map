#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command, Option } from "commander";
import YAML from "yaml";
import { z } from "zod";
import {
  CandidatesFile, ClaimsFile, CoverageFile, DeclsFile, Hints, JudgmentsFile, VerdictsFile, Status,
} from "./schemas/index.js";
import { CcmError, readJson, readYaml, sha256, writeJson, writeText } from "./util/io.js";
import { TOOL } from "./version.js";
import { fetchPaper, fetchRepo } from "./stages/fetch.js";
import { paperExtract } from "./stages/paperExtract.js";
import { leanExtract } from "./stages/leanExtract.js";
import { link } from "./stages/link.js";
import { judgeStage } from "./stages/judge.js";
import { buildCoverage, toFormalizationYaml, toLatex, toMarkdown } from "./stages/report.js";
import { renderHtml } from "./report/html.js";
import { LlmJudge } from "./judge/llmJudge.js";
import { loadLlmSettings } from "./config.js";
import { createProvider } from "./providers/index.js";
import { ARXIV_RE } from "./stages/fetch.js";
import { discoverRepoUrls, gitHead, gitRemoteUrl, gitRoot, loadProjectConfig, pickRepo, resolvePaper } from "./project.js";
import { diffCoverage } from "./stages/diff.js";

const Meta = z.object({
  paper: z.string(), paperId: z.string(), repo: z.string(), repoDir: z.string(), commit: z.string(),
});
type Meta = z.infer<typeof Meta>;

interface Ctx { workdir: string; meta: () => Meta; p: (f: string) => string; log: (m: string) => void }

function ctx(workdir: string): Ctx {
  const w = resolve(workdir);
  return {
    workdir: w,
    p: (f) => join(w, f),
    meta: () => {
      const f = join(w, "meta.json");
      if (!existsSync(f)) throw new CcmError(`no ${f}; run 'ccm fetch' or 'ccm run' first`, 2);
      return readJson(f, Meta);
    },
    log: (m) => process.stderr.write(`ccm: ${m}\n`),
  };
}

/** Hints: --hints file wins; otherwise ccm.yaml (links/main_results/ignore) merged over hints.yaml. */
function loadHints(path?: string, repoDir?: string) {
  if (path) return readYaml(path, Hints);
  const legacy = repoDir && existsSync(join(repoDir, "hints.yaml")) ? readYaml(join(repoDir, "hints.yaml"), Hints) : {};
  const proj = repoDir ? loadProjectConfig(repoDir) : null;
  const merged = { ...legacy, ...(proj ? Hints.parse({ links: proj.links, main_results: proj.main_results, ignore: proj.ignore }) : {}) };
  for (const k of Object.keys(merged) as (keyof typeof merged)[]) if (merged[k] === undefined) delete merged[k];
  return Object.keys(merged).length ? merged : undefined;
}

interface FetchOpts { paper?: string; repo?: string; commit?: string; offline?: boolean }

/**
 * Resolve inputs with sensible defaults:
 * - inside a Lean repo: repo = this checkout (in place), commit = HEAD, paper = ccm.yaml / formalization.yaml / paper/
 * - reviewer: only a paper ID → repo discovered from the paper's links, commit = its HEAD (recorded)
 * - explicit --repo URL / --commit still work (cloned into the work directory)
 */
async function doFetch(c: Ctx, o: FetchOpts) {
  let repoDir: string | null = null, repoUrl: string, commit: string;
  // In place when --repo is a local path, or when no --repo is given and cwd is inside a Lean repo.
  let local: string | null = null;
  if (o.repo) local = existsSync(o.repo) ? resolve(o.repo) : null;
  else {
    const root = await gitRoot(process.cwd());
    if (root && existsSync(join(root, "lean-toolchain"))) local = root;
    else if (!root && existsSync(join(process.cwd(), "lean-toolchain"))) local = process.cwd();
  }
  const inPlaceRoot = local && !o.commit ? await gitRoot(local) : null;
  let paper = o.paper;
  if (inPlaceRoot || (local && !existsSync(join(local, ".git")) && !o.commit)) {
    repoDir = inPlaceRoot ?? local!;
    const head = await gitHead(repoDir);
    commit = head.dirty ? `${head.commit}+dirty` : head.commit;
    repoUrl = (await gitRemoteUrl(repoDir)) ?? repoDir;
    if (head.dirty) c.log("working tree has uncommitted changes; results are recorded as " + commit);
  } else if (o.repo) {
    const r = await fetchRepo(o.repo, o.commit, c.p("repo"), !!o.offline);
    repoDir = r.dir; repoUrl = o.repo; commit = r.commit;
  } else {
    repoUrl = ""; commit = "";
  }
  paper ??= repoDir ? resolvePaper(repoDir, loadProjectConfig(repoDir)) ?? undefined : undefined;
  if (!paper) throw new CcmError("no paper configured: add `paper:` to ccm.yaml (arXiv ID or LaTeX directory) or pass it as an argument", 2);
  const paperId = await fetchPaper(paper, c.p("paper"), !!o.offline);
  if (!repoDir) {
    const url = pickRepo(discoverRepoUrls(c.p("paper")));
    c.log(`repository found in paper: ${url}`);
    const r = await fetchRepo(url, undefined, c.p("repo"), !!o.offline);
    repoDir = r.dir; repoUrl = url; commit = r.commit;
  }
  writeJson(c.p("meta.json"), { paper, paperId, repo: repoUrl, repoDir, commit });
  c.log(`paper ${paperId} · repo ${repoUrl} @ ${commit}`);
}

async function doPaperExtract(c: Ctx, o: { hints?: string; allowEstimatedNumbering?: boolean; compile?: boolean }) {
  const m = c.meta();
  const claims = await paperExtract({
    paperDir: c.p("paper"), paperId: m.paperId, hints: loadHints(o.hints, m.repoDir),
    compile: o.compile === false ? "never" : "auto", allowEstimated: !!o.allowEstimatedNumbering, log: c.log,
  });
  writeJson(c.p("claims.json"), claims);
  c.log(`extracted ${claims.claims.length} results (numbering: ${claims.numbering})`);
}

async function doLeanExtract(c: Ctx, o: { decls?: string; modules?: string }) {
  const m = c.meta();
  if (o.decls) {
    const d = readJson(o.decls, DeclsFile);
    writeJson(c.p("decls.json"), d);
    return;
  }
  const existing = c.p("decls.json");
  if (existsSync(existing)) {
    const d = readJson(existing, DeclsFile);
    if (d.inputs.commit === m.commit && !m.commit.endsWith("+dirty")) { c.log("reusing decls.json (same commit)"); return; }
  }
  await leanExtract({ repoDir: m.repoDir, repoUrl: m.repo, commit: m.commit, workDir: c.workdir, out: existing, modules: o.modules?.split(","), log: c.log });
}

function doLink(c: Ctx, o: { hints?: string }) {
  const m = c.meta();
  const cands = link({
    claims: readJson(c.p("claims.json"), ClaimsFile), decls: readJson(c.p("decls.json"), DeclsFile),
    hints: loadHints(o.hints, m.repoDir), repoDir: m.repoDir,
  });
  writeJson(c.p("candidates.json"), cands);
}

async function doJudge(c: Ctx, o: { provider?: string; model?: string; votes?: string; effort?: string; offline?: boolean }) {
  const projLlm = loadProjectConfig(c.meta().repoDir)?.llm;
  const s = loadLlmSettings(process.cwd(), { provider: o.provider, model: o.model, votes: o.votes ? Number(o.votes) : undefined, effort: o.effort }, projLlm);
  if (!s.provider) {
    throw new CcmError(
      "no LLM provider configured. Pass --provider <claude-code|anthropic-api|openai-compatible|command> --model <id>,\n" +
        "or add to ccm.yaml (or ~/.config/ccm/ccm.toml):\n" +
        '  llm:\n    provider: claude-code      # your logged-in Claude subscription\n    model: claude-opus-5-5', 2);
  }
  const provider = o.offline ? null : createProvider({ ...s.provider, fixtureDir: s.provider.fixtureDir ?? join(c.workdir, "fixtures") });
  const judge = new LlmJudge(provider, {
    providerId: s.provider.provider, model: s.provider.model, votes: s.votes, effort: s.provider.effort, cacheDir: c.p(".cache/llm"),
  });
  const v = await judgeStage({
    claims: readJson(c.p("claims.json"), ClaimsFile), decls: readJson(c.p("decls.json"), DeclsFile),
    candidates: readJson(c.p("candidates.json"), CandidatesFile), judge,
    judgeInfo: { provider: s.provider.provider, model: s.provider.model, votes: s.votes }, maxConcurrency: s.maxConcurrency, log: c.log,
  });
  writeJson(c.p("verdicts.json"), v);
}

function loadJudgments(c: Ctx) {
  const p = c.p("judgments.yaml");
  return existsSync(p) ? readYaml(p, JudgmentsFile) : {};
}

function doReport(c: Ctx, o: { noAutoVerified?: boolean; deterministicTime?: string }) {
  const m = c.meta();
  const decls = readJson(c.p("decls.json"), DeclsFile);
  const cov = buildCoverage({
    claims: readJson(c.p("claims.json"), ClaimsFile), decls, candidates: readJson(c.p("candidates.json"), CandidatesFile),
    verdicts: readJson(c.p("verdicts.json"), VerdictsFile), judgments: loadJudgments(c),
    repo: m.repo, commit: m.commit, noAutoVerified: o.noAutoVerified, now: o.deterministicTime ?? process.env.CCM_NOW,
  });
  writeJson(c.p("out/coverage.json"), cov);
  writeText(c.p("out/report.html"), renderHtml(cov));
  writeText(c.p("out/appendix.tex"), toLatex(cov));
  writeText(c.p("out/appendix.md"), toMarkdown(cov));
  const existingYaml = join(m.repoDir, "formalization.yaml");
  writeText(c.p("out/formalization.yaml"), toFormalizationYaml(cov, decls, existsSync(existingYaml) ? readFileSync(existingYaml, "utf8") : undefined));
  const s = cov.summary;
  c.log(`${s.total} results: verified ${s.verified} · weakened ${s.weakened} · corollary only ${s.corollary_only} · assumed ${s.assumed} · missing ${s.missing} · needs review ${s.needs_review}`);
  c.log(`report: ${c.p("out/report.html")}`);
  return cov;
}

function failOn(cov: CoverageFile, spec?: string): number {
  if (!spec) return 0;
  const want = spec.split(",").map((x) => Status.parse(x.trim()));
  return cov.claims.some((c) => want.includes(c.status)) ? 1 : 0;
}

const program = new Command("ccm").version(TOOL.version).description("Claim Coverage Map: how each paper theorem is covered in Lean");
const wd = () => new Option("--workdir <dir>", "work directory").default(".ccm-work");
const llmOpts = (cmd: Command) =>
  cmd.option("--provider <id>").option("--model <id>").option("--votes <n>").option("--effort <level>").option("--offline", "no network; uncached judgments become needs_review");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RunOpts = FetchOpts & { [k: string]: any };
async function doRun(o: RunOpts) {
  const c = ctx(o.workdir);
  await doFetch(c, o);
  await doPaperExtract(c, { ...o, allowEstimatedNumbering: o.allowEstimatedNumbering || o.compile === false });
  await doLeanExtract(c, { decls: o.decls, modules: o.modules ?? loadProjectConfig(c.meta().repoDir)?.modules?.join(",") });
  doLink(c, { hints: o.hints });
  await doJudge(c, o);
  const cov = doReport(c, { noAutoVerified: o.autoVerified === false });
  process.exitCode = failOn(cov, o.failOn);
}
const runOptions = (cmd: Command) => llmOpts(
  cmd.option("--repo <git URL | path>", "default: the git repository containing the current directory")
    .option("--commit <sha>", "default: HEAD of the repository (recorded in every output)")
    .addOption(wd()).option("--hints <hints.yaml>").option("--decls <decls.json>", "use a pre-extracted lean-extract output")
    .option("--modules <M1,M2>").option("--allow-estimated-numbering").option("--no-compile", "skip LaTeX compilation (estimated numbering)")
    .option("--no-auto-verified", "never emit automatic 'verified'").option("--fail-on <statuses>"),
);

// `ccm` / `ccm <paper>`: the default command
runOptions(program.argument("[paper]", "arXiv ID or LaTeX directory (default: from ccm.yaml)"))
  .action(async (paper: string | undefined, o: RunOpts) => doRun({ ...o, paper }));
runOptions(program.command("run").option("--paper <arXiv ID | dir>")).action(async (o: RunOpts) => doRun(o));

program.command("diff").argument("<base coverage.json>", "use - when there is no baseline").argument("<head coverage.json>")
  .option("--format <fmt>", "markdown | json", "markdown").option("--out <path>")
  .action((a: string, b: string, o) => {
    const base = a !== "-" && existsSync(a) && readFileSync(a, "utf8").trim() ? readJson(a, CoverageFile) : null;
    const d = diffCoverage(base, readJson(b, CoverageFile));
    const text = o.format === "json" ? JSON.stringify(d.changes, null, 2) + "\n" : d.markdown;
    if (o.out) writeText(o.out, text); else process.stdout.write(text);
  });

program.command("fetch").option("--paper <id|dir>").option("--repo <url|path>").option("--commit <sha>").option("--offline").addOption(wd())
  .action(async (o) => doFetch(ctx(o.workdir), o));
program.command("paper-extract").addOption(wd()).option("--hints <file>").option("--allow-estimated-numbering").option("--no-compile")
  .action(async (o) => doPaperExtract(ctx(o.workdir), { ...o, allowEstimatedNumbering: o.allowEstimatedNumbering || o.compile === false }));
program.command("lean-extract").addOption(wd()).option("--decls <file>").option("--modules <M1,M2>")
  .action(async (o) => doLeanExtract(ctx(o.workdir), o));
program.command("link").addOption(wd()).option("--hints <file>").action((o) => doLink(ctx(o.workdir), o));
llmOpts(program.command("judge").addOption(wd())).action(async (o) => doJudge(ctx(o.workdir), o));
program.command("report").addOption(wd()).option("--no-auto-verified").option("--fail-on <statuses>")
  .action((o) => { const cov = doReport(ctx(o.workdir), { noAutoVerified: o.autoVerified === false }); process.exitCode = failOn(cov, o.failOn); });

program.command("judge-merge").argument("<judgments.json>").addOption(wd()).action((file: string, o) => {
  const c = ctx(o.workdir);
  const incoming = JudgmentsFile.parse(JSON.parse(readFileSync(file, "utf8")));
  const current = loadJudgments(c);
  const merged = { ...current, ...incoming };
  const sorted = Object.fromEntries(Object.keys(merged).sort().map((k) => [k, merged[k]]));
  writeText(c.p("judgments.yaml"), YAML.stringify(sorted));
  c.log(`merged ${Object.keys(incoming).length} judgment(s) into ${c.p("judgments.yaml")}; run 'ccm report' to apply`);
});

program.command("export").addOption(wd())
  .addOption(new Option("--format <fmt>").choices(["latex", "markdown", "formalization-yaml", "json"]).makeOptionMandatory())
  .option("--out <path>").action((o) => {
    const c = ctx(o.workdir);
    const cov = readJson(c.p("out/coverage.json"), CoverageFile);
    const m = c.meta();
    const existing = join(m.repoDir, "formalization.yaml");
    const text =
      o.format === "latex" ? toLatex(cov)
      : o.format === "markdown" ? toMarkdown(cov)
      : o.format === "json" ? JSON.stringify(cov, null, 2) + "\n"
      : toFormalizationYaml(cov, readJson(c.p("decls.json"), DeclsFile), existsSync(existing) ? readFileSync(existing, "utf8") : undefined);
    if (o.out) writeText(o.out, text); else process.stdout.write(text);
  });

program.exitOverride((err) => { process.exit(err.exitCode === 0 ? 0 : 2); });
program.parseAsync().catch((e: unknown) => {
  if (e instanceof CcmError) { process.stderr.write(`ccm: ${e.message}\n`); process.exit(e.exitCode); }
  if (e instanceof z.ZodError) { process.stderr.write(`ccm: invalid input: ${e.message}\n`); process.exit(2); }
  process.stderr.write(`ccm: ${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
void sha256;
