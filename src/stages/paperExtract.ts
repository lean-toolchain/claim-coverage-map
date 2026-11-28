import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { execa } from "execa";
import { ClaimsFile, type Claim, type ClaimKind, type Hints } from "../schemas/index.js";
import { CcmError, sha256 } from "../util/io.js";
import { TOOL } from "../version.js";
import { findRootFile, flatten, parseAux, parseEnvDecls, scan, toPlain, type EnvDecl } from "./latex.js";

const KIND_ABBR: Record<ClaimKind, string> = { theorem: "thm", lemma: "lem", proposition: "prop", corollary: "cor" };
export const KIND_DISPLAY: Record<ClaimKind, string> = {
  theorem: "Theorem", lemma: "Lemma", proposition: "Proposition", corollary: "Corollary",
};

export interface PaperExtractOptions {
  paperDir: string;
  paperId: string;
  hints?: Hints;
  /** "auto": try latexmk (local, then docker); "never": counter simulation only. */
  compile: "auto" | "never";
  allowEstimated: boolean;
  log?: (msg: string) => void;
}

/** ccmhook.sty: records the printed counter of every numbered theorem-like environment in the .aux. */
export function hookPackage(envs: string[]): string {
  const lines = [
    "\\NeedsTeXFormat{LaTeX2e}",
    "\\ProvidesPackage{ccmhook}[2026/11/27 claim-coverage-map numbering hook]",
    "\\makeatletter",
    "\\providecommand\\ccmclaim[3]{}",
    "\\AtBeginDocument{\\immediate\\write\\@auxout{\\string\\providecommand\\string\\ccmclaim[3]{}}}",
    "\\def\\ccm@rec#1{\\immediate\\write\\@auxout{\\string\\ccmclaim{\\jobname}{\\the\\inputlineno}{\\csname the#1\\endcsname}}}",
  ];
  for (const e of envs) lines.push(`\\AddToHook{env/${e}/after}{\\ccm@rec{${e}}}`);
  lines.push("\\makeatother");
  return lines.join("\n") + "\n";
}

async function tryCompile(dir: string, root: string, envs: EnvDecl[], log: (m: string) => void): Promise<string | null> {
  // Hook records `\the<counter>` → use the counter macro name for each env.
  const sty = hookPackage([...new Set(envs.map((e) => e.env))]).replace(
    /\\AddToHook\{env\/([^/]+)\/after\}\{\\ccm@rec\{[^}]+\}\}/g,
    (_m, env: string) => `\\AddToHook{env/${env}/after}{\\ccm@rec{${envs.find((x) => x.env === env)?.counter ?? env}}}`,
  );
  writeFileSync(join(dir, "ccmhook.sty"), sty);
  const job = basename(root, ".tex");
  const args = ["-pdf", "-interaction=nonstopmode", "-halt-on-error", "-f", `-jobname=${job}`, `-usepretex=\\RequirePackage{ccmhook}`, root];
  const attempts: [string, string[]][] = [["latexmk", args]];
  const image = process.env.CCM_TEXLIVE_IMAGE ?? "texlive/texlive:latest";
  attempts.push(["docker", ["run", "--rm", "-v", `${dir}:/work`, "-w", "/work", image, "latexmk", ...args]]);
  for (const [cmd, a] of attempts) {
    if (cmd === "docker") log(`trying TeX Live container ${image} (may pull the image)`);
    try {
      await execa(cmd, a, { cwd: dir, timeout: 600_000 });
      const aux = join(dir, `${job}.aux`);
      if (existsSync(aux)) return readFileSync(aux, "utf8");
    } catch (e) {
      log(`latex compile via ${cmd} failed: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  return null;
}

export async function paperExtract(opts: PaperExtractOptions): Promise<ClaimsFile> {
  const log = opts.log ?? (() => {});
  const root = findRootFile(opts.paperDir);
  const lines = flatten(opts.paperDir, root);
  const decls = parseEnvDecls(lines);
  const scanned = scan(lines, decls);
  const numberedEnvs = [...decls.values()].filter((d) => d.counter);

  const sourceHash = sha256(
    readdirSync(opts.paperDir, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".tex"))
      .sort()
      .map((f) => f + "\0" + readFileSync(join(opts.paperDir, f), "utf8"))
      .join("\0"),
  );

  let auxText: string | null = null;
  if (opts.compile === "auto") auxText = await tryCompile(opts.paperDir, root, numberedEnvs, log);
  else {
    const existing = join(opts.paperDir, basename(root, ".tex") + ".aux");
    if (existsSync(existing)) auxText = readFileSync(existing, "utf8");
  }
  if (!auxText && opts.compile === "auto" && !opts.allowEstimated) {
    throw new CcmError("LaTeX compilation failed (use --allow-estimated-numbering to continue with estimated numbers)", 3);
  }
  const aux = auxText ? parseAux(auxText) : null;
  const numbering: "aux" | "estimated" = aux ? "aux" : "estimated";

  // Numbered occurrences in document order align with hook records in document order.
  const numberedOcc = scanned.occurrences.filter((o) => !o.starred);
  const hookNumbers = aux && aux.claims.length > 0 ? aux.claims : null;
  // The hook sees every numbered theorem-like env including Definition etc.; ours only extracted kinds.
  // Re-scan with all numbered decls to align indices.
  const allDecls = new Map([...decls].map(([k, d]) => [k, { ...d, kind: d.kind ?? ("theorem" as ClaimKind) }]));
  const allNumbered = scan(lines, allDecls).occurrences.filter((o) => !o.starred);
  const hookByDocKey = new Map<string, string>();
  if (hookNumbers && hookNumbers.length === allNumbered.length) {
    allNumbered.forEach((o, i) => hookByDocKey.set(`${o.file}:${o.line}`, hookNumbers[i]!.number));
  } else if (hookNumbers) {
    log(`ccmhook recorded ${hookNumbers.length} environments, scanner found ${allNumbered.length}; using labels only`);
  }

  const labelNumber = (label: string): string | null =>
    aux?.labels.get(label) ?? scanned.labelsToNumber.get(label) ?? null;

  const claims: Claim[] = [];
  const usedIds = new Set<string>();
  for (const o of scanned.occurrences) {
    const kind = o.decl.kind!;
    let number: string | null = null;
    let uncertain = false;
    if (!o.starred) {
      number =
        (o.label && aux?.labels.get(o.label)) || hookByDocKey.get(`${o.file}:${o.line}`) || (aux ? null : o.estimatedNumber);
      if (!number) {
        number = o.estimatedNumber;
        uncertain = true;
      }
    } else {
      continue; // MVP: unnumbered environments are not extracted
    }
    const text_tex = o.body;
    let id = number ? `c-${KIND_ABBR[kind]}-${number}` : `c-anon-${sha256(text_tex).slice(0, 8)}`;
    while (usedIds.has(id)) id += "'";
    usedIds.add(id);
    claims.push({
      id,
      kind,
      number,
      label: o.label,
      title: o.title,
      text_tex,
      text_plain: toPlain(text_tex, labelNumber),
      location: { file: o.file, line: o.line, section: o.section },
      is_main: false,
      extraction: uncertain ? "uncertain" : "certain",
      context_tex: o.contextBefore || null,
    });
  }
  void numberedOcc;

  // is_main
  const hintMain = opts.hints?.main_results;
  if (hintMain && hintMain.length) {
    for (const c of claims) c.is_main = hintMain.some((h) => matchesRef(c, h));
  } else {
    const refs = new Set([...scanned.abstractRefs, ...scanned.introRefs]);
    for (const c of claims) c.is_main = c.location.section === "1" || (!!c.label && refs.has(c.label));
    if (!claims.some((c) => c.is_main)) for (const c of claims) c.is_main = c.kind === "theorem";
  }

  return ClaimsFile.parse({
    schema: "ccm/claims@1",
    tool: TOOL,
    inputs: { paper: opts.paperId, source_sha256: sourceHash },
    numbering,
    claims,
  });
}

/** Match a claim against a reference like "thm:main", "Theorem 1.2", or "c-thm-1.2". */
export function matchesRef(c: Claim, ref: string): boolean {
  const r = ref.trim();
  if (r === c.id || (c.label && r === c.label)) return true;
  // "Theorem 1.2", "Thm. 1.2", and descriptive forms like "Theorem 1.2: for subdiagrams ..." / "Theorem 1.2 (Main)"
  // also "Paper title (Theorem 1.2, equation (8))" as used in formalization.yaml: first kind word + number anywhere
  if (!c.number) return false;
  for (const m of r.matchAll(/(?:^|[\s(\[,;])([A-Za-z]+)\.?\s*~?([0-9A-Z]+(?:\.[0-9]+)*[a-z]?)(?=$|[\s:,;().—–-])/g)) {
    const k = normalizeKindWord(m[1]!);
    if (k) return m[2] === c.number && k === c.kind;
  }
  return false;
}

export function normalizeKindWord(w: string): ClaimKind | null {
  const s = w.toLowerCase().replace(/\.$/, "");
  if (["theorem", "thm"].includes(s)) return "theorem";
  if (["lemma", "lem"].includes(s)) return "lemma";
  if (["proposition", "prop"].includes(s)) return "proposition";
  if (["corollary", "cor"].includes(s)) return "corollary";
  return null;
}

export function claimDisplay(c: { kind: ClaimKind; number: string | null }): string {
  return `${KIND_DISPLAY[c.kind]} ${c.number ?? "(unnumbered)"}`;
}
