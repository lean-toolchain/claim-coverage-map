import YAML from "yaml";
import {
  CoverageFile, type CandidatesFile, type ClaimsFile, type CoverageClaim, type DeclsFile, type JudgmentsFile, type Status, type VerdictsFile,
} from "../schemas/index.js";
import { sha256 } from "../util/io.js";
import { TOOL } from "../version.js";
import { decide } from "./decide.js";
import { claimDisplay } from "./paperExtract.js";

export interface ReportOptions {
  claims: ClaimsFile;
  decls: DeclsFile;
  candidates: CandidatesFile;
  verdicts: VerdictsFile;
  judgments: JudgmentsFile;
  repo: string;
  commit: string;
  noAutoVerified?: boolean;
  now?: string;
}

export function claimTextSha(text: string) {
  return sha256(text);
}

export function githubUrl(repo: string, commit: string, file: string, line: number): string | null {
  const m = /^(?:https?:\/\/|git@)github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(repo);
  return m ? `https://github.com/${m[1]}/${m[2]}/blob/${commit}/${file}#L${line}` : null;
}

export const STATUSES: Status[] = ["verified", "weakened", "corollary_only", "assumed", "missing", "needs_review"];

export function buildCoverage(o: ReportOptions): CoverageFile {
  const byName = new Map(o.decls.decls.map((d) => [d.name, d]));
  const linkBy = new Map(o.candidates.links.map((l) => [l.claim_id, l]));
  const verdictBy = new Map(o.verdicts.verdicts.map((v) => [v.claim_id, v]));
  const allVerdicts = new Map(o.verdicts.verdicts.map((v) => [v.claim_id, v.candidates]));
  const votes = o.verdicts.judge?.votes ?? 0;
  const ignored = new Set(o.candidates.ignored);
  const claimsInOrder = o.claims.claims.filter((c) => !ignored.has(c.id));

  const rows: CoverageClaim[] = claimsInOrder.map((c) => {
    const link = linkBy.get(c.id);
    const v = verdictBy.get(c.id);
    const authorDeclaredEmpty = !!link?.author_declared && link.author_declared.length === 0;
    let V = v?.candidates ?? [];
    if (link?.author_declared) V = V.filter((x) => link.author_declared!.includes(x.decl));
    const textSha = claimTextSha(c.text_tex);
    const j = o.judgments[c.id] ?? null;
    const stale = !!j && !!j.claim_text_sha256 && j.claim_text_sha256 !== textSha;
    const noVerdictYet = !v && !authorDeclaredEmpty && (link ? (link.author_declared ?? link.retrieved.map((r) => r.decl)).length > 0 : false);
    const d = decide({
      claim: c, claims: claimsInOrder, verdicts: V, authorDeclaredEmpty, authorDeclared: !!link?.author_declared,
      judgeError: v?.error ?? (noVerdictYet ? "not judged" : null),
      votes, allVerdicts, human: j && !stale ? j : null, noAutoVerified: !!o.noAutoVerified,
    });
    const accepted = V.filter((x) => x.relation === "match" || x.relation === "weaker");
    const shown = accepted.length ? accepted : d.corollary_of ? V.filter((x) => x.other_claim_id === d.corollary_of) : [];
    const shownDecls = shown.map((x) => byName.get(x.decl)).filter((x) => !!x);
    const rejected = V.filter((x) => !shown.includes(x)).map((x) => ({
      decl: x.decl,
      reason: `${x.relation}${x.other_claim_id ? ` (→ ${x.other_claim_id})` : ""}${x.agreement ? ` ${x.agreement}/${votes}` : ""}: ${x.rationale}`,
    }));
    // retrieved candidates never judged (author declaration present) are listed for reference
    return {
      claim_id: c.id, number: c.number, kind: c.kind, title: c.title, is_main: c.is_main, extraction: c.extraction,
      text_tex: c.text_tex,
      status: d.status, auto_status: d.auto_status, decided_by: d.decided_by, reason: d.reason,
      decls: shownDecls.map((x) => x.name),
      evidence: {
        paper: { file: c.location.file, line: c.location.line },
        lean: shownDecls.map((x) => ({
          decl: x.name, file: x.file, line: x.range.start.line, url: githubUrl(o.repo, o.commit, x.file, x.range.start.line),
          type_pp: x.type_pp, module: x.module,
        })),
        differences: shown.flatMap((x) => x.differences),
        rejected_candidates: rejected,
        axioms: [...new Set(shownDecls.flatMap((x) => x.nonstandard_axioms))].sort(),
        uses_sorry: shownDecls.some((x) => x.uses_sorry),
        corollary_of: d.corollary_of,
      },
      human: {
        status: j?.status ?? null, note: j?.note ?? null, by: j?.by ?? null, at: j?.at ?? null, stale,
      },
      claim_text_sha256: textSha,
    };
  });
  const summary = { total: rows.length, verified: 0, weakened: 0, corollary_only: 0, assumed: 0, missing: 0, needs_review: 0 };
  for (const r of rows) summary[r.status]++;
  return CoverageFile.parse({
    schema: "ccm/coverage@1",
    tool: TOOL,
    generated_at: o.now ?? new Date().toISOString(),
    inputs: { paper: o.claims.inputs.paper, repo: o.repo, commit: o.commit, toolchain: o.decls.inputs.toolchain, judge: o.verdicts.judge },
    usage: o.verdicts.usage,
    summary,
    claims: rows,
  });
}

// ---------- exports ----------

export const STATUS_LABEL: Record<Status, string> = {
  verified: "verified", weakened: "weakened", corollary_only: "corollary only", assumed: "assumed (sorry/axiom)",
  missing: "missing", needs_review: "needs review",
};
const STATUS_SYMBOL: Record<Status, string> = {
  verified: "\\checkmark", weakened: "$\\sim$", corollary_only: "$\\subset$", assumed: "$\\dagger$", missing: "$\\times$", needs_review: "?",
};

function note(r: CoverageClaim): string {
  if (r.status === "weakened") return r.evidence.differences.map((d) => d.note).join("; ");
  if (r.status === "assumed") return [r.evidence.uses_sorry ? "sorry" : "", ...r.evidence.axioms].filter(Boolean).join(", ");
  if (r.status === "corollary_only") return `only via ${r.evidence.corollary_of}`;
  return r.human.note ?? "";
}

const texEsc = (s: string) => s.replace(/\\/g, "\\textbackslash{}").replace(/([&%$#_{}])/g, "\\$1").replace(/~/g, "\\textasciitilde{}").replace(/\^/g, "\\textasciicircum{}");
const mdEsc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function toLatex(cov: CoverageFile): string {
  const lines = [
    "% Generated by ccm " + TOOL.version + " from " + cov.inputs.repo + "@" + cov.inputs.commit,
    "\\begin{tabular}{llll}",
    "\\hline",
    "Result & Lean declaration & Status & Note \\\\",
    "\\hline",
  ];
  for (const r of cov.claims) {
    const decl = r.decls.length ? r.decls.map((d) => `\\texttt{${texEsc(d)}}`).join(", ") : "---";
    lines.push(`${texEsc(claimDisplay(r))}${r.is_main ? "$^{*}$" : ""} & ${decl} & ${STATUS_SYMBOL[r.status]} ${texEsc(STATUS_LABEL[r.status])} & ${texEsc(note(r))} \\\\`);
  }
  lines.push("\\hline", "\\end{tabular}", "",
    "% Legend: " + STATUSES.map((s) => `${STATUS_SYMBOL[s]} ${STATUS_LABEL[s]}`).join(", ") + "; $^{*}$ main result");
  return lines.join("\n") + "\n";
}

export function toMarkdown(cov: CoverageFile): string {
  const lines = ["| Result | Lean declaration | Status | Note |", "|---|---|---|---|"];
  for (const r of cov.claims) {
    const decl = r.decls.length ? r.decls.map((d) => "`" + d + "`").join(", ") : "—";
    lines.push(`| ${claimDisplay(r)}${r.is_main ? " (main)" : ""} | ${decl} | ${STATUS_LABEL[r.status]} | ${mdEsc(note(r))} |`);
  }
  return lines.join("\n") + "\n";
}

/** formalization.yaml v0.4 uses free-text `status`; ccm writes its verdict and the reason. */
export function palomarStatus(c: CoverageClaim): string {
  const by = c.decided_by === "human" ? "confirmed by reviewer" : c.decided_by === "rule" ? "mechanical check" : "automatic, ccm";
  const n = note(c);
  return `${STATUS_LABEL[c.status]} (${by})${n ? `: ${n}` : ""}`;
}

export function toFormalizationYaml(cov: CoverageFile, decls: DeclsFile, existing?: string): string {
  const byName = new Map(decls.decls.map((d) => [d.name, d]));
  const used = [...new Set(cov.claims.flatMap((c) => c.decls))].sort();
  const sorryCount = used.filter((n) => byName.get(n)?.uses_sorry).length;
  const axioms = [...new Set(used.flatMap((n) => byName.get(n)?.nonstandard_axioms ?? []))].sort();
  const statements = cov.claims
    .filter((c) => c.status !== "missing")
    .flatMap((c) => c.decls.map((n) => ({
      source: claimDisplay(c), lean: n.replace(/@.*$/, ""), module: byName.get(n)?.module ?? "",
      status: palomarStatus(c),
    })));
  const doc = existing ? YAML.parseDocument(existing) : new YAML.Document({});
  doc.setIn(["status", "sorry_count"], sorryCount);
  doc.setIn(["status", "axioms"], axioms);
  doc.setIn(["alignment", "statements"], statements);
  return doc.toString();
}
