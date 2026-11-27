/**
 * Lightweight, deterministic LaTeX scanner for theorem-like environments.
 * Works on a flattened source (with \input/\include/\subfile expanded) where every
 * line remembers its origin file and line number.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import type { ClaimKind } from "../schemas/index.js";

export interface SrcLine {
  text: string;
  file: string; // relative to paper root
  line: number; // 1-based
}

/** Strip an unescaped % comment from a line. */
export function stripComment(s: string): string {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "%" && (i === 0 || s[i - 1] !== "\\")) return s.slice(0, i);
    if (s[i] === "\\" && s[i + 1] === "\\") i++;
  }
  return s;
}

export function findRootFile(dir: string): string {
  const files = listTex(dir);
  const roots = files.filter((f) => /\\documentclass/.test(stripAllComments(readFileSync(join(dir, f), "utf8"))));
  if (roots.length === 0) throw new Error(`no file with \\documentclass in ${dir}`);
  // prefer conventional names, then those containing \begin{document}
  const pref = ["main.tex", "paper.tex", "ms.tex"];
  roots.sort((a, b) => {
    const pa = pref.indexOf(a), pb = pref.indexOf(b);
    if (pa !== pb) return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb);
    const da = /\\begin\{document\}/.test(readFileSync(join(dir, a), "utf8")) ? 0 : 1;
    const db = /\\begin\{document\}/.test(readFileSync(join(dir, b), "utf8")) ? 0 : 1;
    return da - db || a.localeCompare(b);
  });
  return roots[0]!;
}

function stripAllComments(s: string) {
  return s.split("\n").map(stripComment).join("\n");
}

function listTex(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listTex(p, base));
    else if (e.name.endsWith(".tex")) out.push(relative(base, p));
  }
  return out.sort();
}

const INPUT_RE = /\\(input|include|subfile)\s*\{([^}]+)\}/g;

/** Flatten root file with includes; comments are stripped. */
export function flatten(rootDir: string, file: string, depth = 0, seen = new Set<string>()): SrcLine[] {
  if (depth > 20 || seen.has(file)) return [];
  seen.add(file);
  let path = join(rootDir, file);
  if (!existsSync(path) && existsSync(path + ".tex")) {
    path += ".tex";
    file += ".tex";
  }
  if (!existsSync(path)) return [];
  let text = readFileSync(path, "utf8");
  const isSub = depth > 0;
  // A \subfile'd document carries its own preamble: keep only the document body.
  if (isSub && /\\begin\{document\}/.test(text)) {
    const lines = text.split("\n");
    const b = lines.findIndex((l) => /\\begin\{document\}/.test(stripComment(l)));
    const e = lines.findIndex((l) => /\\end\{document\}/.test(stripComment(l)));
    text = lines.map((l, i) => (i <= b || (e >= 0 && i >= e) ? "" : l)).join("\n");
  }
  const out: SrcLine[] = [];
  text.split("\n").forEach((raw, i) => {
    const s = stripComment(raw);
    let last = 0;
    let m: RegExpExecArray | null;
    INPUT_RE.lastIndex = 0;
    let had = false;
    while ((m = INPUT_RE.exec(s))) {
      had = true;
      const before = s.slice(last, m.index);
      if (before.trim()) out.push({ text: before, file, line: i + 1 });
      const target = join(dirname(file), m[2]!.trim());
      out.push(...flatten(rootDir, target, depth + 1, seen));
      last = m.index + m[0].length;
    }
    const rest = had ? s.slice(last) : s;
    if (!had || rest.trim()) out.push({ text: rest, file, line: i + 1 });
  });
  seen.delete(file);
  return out;
}

// ---- theorem environment declarations ----

const KIND_NAMES: Record<ClaimKind, string[]> = {
  theorem: ["theorem", "satz", "théorème", "theoreme", "정리", "main theorem", "thm"],
  lemma: ["lemma", "lemme", "보조정리", "도움정리", "lem"],
  proposition: ["proposition", "명제", "prop"],
  corollary: ["corollary", "korollar", "folgerung", "corollaire", "따름정리", "cor"],
};

export function kindFromName(name: string): ClaimKind | null {
  const n = name.replace(/[{}\\]/g, "").trim().toLowerCase();
  for (const [k, names] of Object.entries(KIND_NAMES) as [ClaimKind, string[]][]) {
    if (names.includes(n)) return k;
  }
  // "Main Theorem", "Key Lemma", ...: use the last word
  const last = n.split(/\s+/).pop() ?? "";
  for (const [k, names] of Object.entries(KIND_NAMES) as [ClaimKind, string[]][]) {
    if (names.includes(last)) return k;
  }
  return null;
}

export interface EnvDecl {
  env: string;
  displayName: string;
  kind: ClaimKind | null; // null → not extracted (Definition, Remark, ...)
  counter: string | null; // null → unnumbered
  within: string | null; // e.g. "section"
}

/** Parse \newtheorem and \declaretheorem; also built-in names used by amsthm defaults. */
export function parseEnvDecls(lines: SrcLine[]): Map<string, EnvDecl> {
  const src = lines.map((l) => l.text).join("\n");
  const map = new Map<string, EnvDecl>();
  const nt = /\\newtheorem(\*?)\s*\{([^}]+)\}\s*(?:\[([^\]]+)\])?\s*\{([^}]*)\}\s*(?:\[([^\]]+)\])?/g;
  let m: RegExpExecArray | null;
  while ((m = nt.exec(src))) {
    const [, star, env, shared, name, within] = m;
    const parent = shared ? map.get(shared.trim()) : undefined;
    map.set(env!.trim(), {
      env: env!.trim(),
      displayName: name!,
      kind: kindFromName(name!),
      counter: star ? null : shared ? (parent?.counter ?? shared.trim()) : env!.trim(),
      within: star ? null : shared ? (parent?.within ?? null) : (within?.trim() ?? null),
    });
  }
  const dt = /\\declaretheorem\s*(?:\[([^\]]*)\])?\s*\{([^}]+)\}/g;
  while ((m = dt.exec(src))) {
    const opts = parseKeyVals(m[1] ?? "");
    for (const env of m[2]!.split(",").map((s) => s.trim())) {
      const name = opts.name ?? opts.title ?? env.charAt(0).toUpperCase() + env.slice(1);
      const sib = opts.sibling ?? opts.sharenumber ?? opts.sharecounter;
      const parent = sib ? map.get(sib) : undefined;
      const unnumbered = opts.numbered === "no";
      map.set(env, {
        env,
        displayName: name,
        kind: kindFromName(name),
        counter: unnumbered ? null : sib ? (parent?.counter ?? sib) : env,
        within: unnumbered ? null : sib ? (parent?.within ?? null) : (opts.numberwithin ?? opts.parent ?? null),
      });
    }
  }
  return map;
}

function parseKeyVals(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(",")) {
    const [k, ...v] = part.split("=");
    if (!k?.trim()) continue;
    out[k.trim()] = v.join("=").trim().replace(/^\{|\}$/g, "");
  }
  return out;
}

// ---- environment occurrences ----

export interface EnvOccurrence {
  decl: EnvDecl;
  starred: boolean;
  title: string | null;
  body: string;
  label: string | null;
  file: string;
  line: number;
  section: string | null; // printed section number at this point, e.g. "3" or "A"
  sectionIndex: number; // 0 before first section
  estimatedNumber: string | null;
  docIndex: number; // order of appearance among theorem-like environments
}

export interface ScanResult {
  occurrences: EnvOccurrence[];
  abstractRefs: string[]; // labels referenced in abstract
  introRefs: string[]; // labels referenced in section 1
  labelsToNumber: Map<string, string>; // estimated numbers via counter simulation
}

/** Read balanced {...} or [...] group starting at s[i] (which must be the opener). */
export function readGroup(s: string, i: number, open = "{", close = "}"): [string, number] | null {
  if (s[i] !== open) return null;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") { j++; continue; }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return [s.slice(i + 1, j), j + 1];
  }
  return null;
}

export function scan(lines: SrcLine[], decls: Map<string, EnvDecl>): ScanResult {
  // Build one string with an offset → line map.
  const offsets: number[] = [];
  let src = "";
  for (const l of lines) {
    offsets.push(src.length);
    src += l.text + "\n";
  }
  const lineAt = (off: number): SrcLine => {
    let lo = 0, hi = offsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid]! <= off) lo = mid; else hi = mid - 1;
    }
    return lines[lo]!;
  };
  const docStart = src.search(/\\begin\{document\}/);
  const start = docStart >= 0 ? docStart : 0;

  const counters = new Map<string, number>();
  const occurrences: EnvOccurrence[] = [];
  const labelsToNumber = new Map<string, string>();
  const abstractRefs: string[] = [];
  const introRefs: string[] = [];
  let secNum = 0;
  let appendix = false;
  let sectionLabel: string | null = null;
  let docIndex = 0;

  const tokenRe = /\\(section|appendix|begin|ref|cref|Cref|autoref|eqref)\b(\*?)/g;
  tokenRe.lastIndex = start;
  let inAbstract = false;
  let m: RegExpExecArray | null;
  const abstractRange = (() => {
    const a = src.indexOf("\\begin{abstract}", 0);
    const b = src.indexOf("\\end{abstract}", a);
    return a >= 0 && b > a ? [a, b] : null;
  })();
  while ((m = tokenRe.exec(src))) {
    const cmd = m[1]!;
    const pos = m.index;
    inAbstract = !!abstractRange && pos > abstractRange[0]! && pos < abstractRange[1]!;
    if (cmd === "appendix") {
      appendix = true;
      secNum = 0;
      continue;
    }
    if (cmd === "section") {
      if (m[2] === "*") continue;
      secNum++;
      sectionLabel = appendix ? String.fromCharCode(64 + secNum) : String(secNum);
      for (const [k, d] of [...decls.values()].map((d) => [d.counter, d] as const)) {
        if (k && d.within === "section") counters.set(k, 0);
      }
      continue;
    }
    if (["ref", "cref", "Cref", "autoref", "eqref"].includes(cmd)) {
      let j = pos + m[0].length;
      while (src[j] === " ") j++;
      const g = readGroup(src, j);
      if (g) {
        for (const lab of g[0].split(",").map((s) => s.trim())) {
          if (inAbstract) abstractRefs.push(lab);
          else if (sectionLabel === "1" && !appendix) introRefs.push(lab);
        }
      }
      continue;
    }
    // \begin{env}
    let j = pos + m[0].length;
    const g = readGroup(src, j);
    if (!g) continue;
    const name = g[0].trim();
    j = g[1];
    const starredEnv = name.endsWith("*");
    const decl = decls.get(name) ?? (starredEnv ? decls.get(name.slice(0, -1)) : undefined);
    if (!decl) continue;
    // optional title
    let k = j;
    while (src[k] === " " || src[k] === "\n") k++;
    let title: string | null = null;
    if (src[k] === "[") {
      const t = readGroup(src, k, "[", "]");
      if (t) { title = t[0].trim(); j = t[1]; }
    }
    // find matching \end{name} (allow nesting of same env)
    const endTok = `\\end{${name}}`;
    const beginTok = `\\begin{${name}}`;
    let depth = 1, p = j, endPos = -1;
    while (depth > 0) {
      const nb = src.indexOf(beginTok, p), ne = src.indexOf(endTok, p);
      if (ne < 0) break;
      if (nb >= 0 && nb < ne) { depth++; p = nb + beginTok.length; }
      else { depth--; p = ne + endTok.length; if (depth === 0) endPos = ne; }
    }
    if (endPos < 0) continue;
    const body = src.slice(j, endPos);
    const labelM = /\\label\s*\{([^}]+)\}/.exec(body);
    const label = labelM ? labelM[1]!.trim() : null;
    const numbered = !starredEnv && decl.counter !== null;
    let estimatedNumber: string | null = null;
    if (numbered) {
      const c = (counters.get(decl.counter!) ?? 0) + 1;
      counters.set(decl.counter!, c);
      const counterDecl = decls.get(decl.counter!) ?? decl;
      const within = decl.within ?? counterDecl.within;
      estimatedNumber = within === "section" && sectionLabel ? `${sectionLabel}.${c}` : String(c);
      if (label) labelsToNumber.set(label, estimatedNumber);
    }
    const at = lineAt(pos);
    if (decl.kind) {
      occurrences.push({
        decl,
        starred: !numbered,
        title,
        body: body.replace(/^\s*\n/, "").replace(/\s+$/, ""),
        label,
        file: at.file,
        line: at.line,
        section: sectionLabel,
        sectionIndex: secNum + (appendix ? 1000 : 0),
        estimatedNumber,
        docIndex: docIndex++,
      });
    }
    // continue scanning *inside* the body as well (nested refs), so do not jump
  }
  return { occurrences, abstractRefs, introRefs, labelsToNumber };
}

/** Parse \newlabel{lab}{{3.1}{page}...} and \ccmclaim{file}{line}{number} from .aux contents. */
export function parseAux(aux: string): { labels: Map<string, string>; claims: { file: string; line: number; number: string }[] } {
  const labels = new Map<string, string>();
  const claims: { file: string; line: number; number: string }[] = [];
  for (const line of aux.split("\n")) {
    let m = /^\\newlabel\{([^}]+)\}\{\{([^}]*)\}/.exec(line);
    if (m) labels.set(m[1]!, cleanNumber(m[2]!));
    m = /^\\ccmclaim\{([^}]*)\}\{(\d+)\}\{(.*)\}\s*$/.exec(line);
    if (m) claims.push({ file: m[1]!, line: Number(m[2]), number: cleanNumber(m[3]!) });
  }
  return { labels, claims };
}

function cleanNumber(s: string) {
  return s.replace(/\\[a-zA-Z@]+\s*/g, "").replace(/[{}]/g, "").trim();
}

/** Plain-text conversion that keeps math verbatim. */
export function toPlain(tex: string, refNumber: (label: string) => string | null): string {
  const math: string[] = [];
  let s = tex.replace(/\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$|\\begin\{(equation|align|gather|multline)\*?\}([\s\S]*?)\\end\{\3\*?\}/g, (_m, a, b, _e, c) => {
    math.push(`$${(a ?? b ?? c ?? "").trim()}$`);
    return `\u0000${math.length - 1}\u0000`;
  });
  s = s.replace(/(?<!\\)\$([^$]+)\$/g, (m) => {
    math.push(m);
    return `\u0000${math.length - 1}\u0000`;
  });
  s = s
    .replace(/\\label\s*\{[^}]*\}/g, "")
    .replace(/\\(?:c|C|auto)?ref\s*\{([^}]*)\}/g, (_m, l: string) =>
      l.split(",").map((x) => refNumber(x.trim()) ?? "??").join(", "))
    .replace(/\\cite[pt]?\s*(?:\[[^\]]*\])?\s*\{[^}]*\}/g, "[cite]")
    .replace(/\\begin\{(itemize|enumerate|description)\}|\\end\{(itemize|enumerate|description)\}/g, "")
    .replace(/\\item\s*(?:\[([^\]]*)\])?/g, (_m, l) => (l ? `\n(${l}) ` : "\n• "))
    .replace(/\\(?:emph|textbf|textit|textrm|textsf|texttt|text|mbox|underline)\s*\{([^}]*)\}/g, "$1")
    .replace(/\\[a-zA-Z]+\*?/g, " ")
    .replace(/[{}]/g, "")
    .replace(/~/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => math[Number(i)]!).replace(/\s+/g, " ").trim();
}
