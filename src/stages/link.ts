import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { CandidatesFile, type ClaimsFile, type DeclsFile, type Hints, type Link } from "../schemas/index.js";
import { TOOL } from "../version.js";
import { Bm25 } from "./bm25.js";
import { matchesRef, normalizeKindWord } from "./paperExtract.js";
import type { Claim } from "../schemas/index.js";

export const DOCSTRING_RE = /\b(Theorem|Lemma|Proposition|Corollary|Thm\.?|Lem\.?|Prop\.?|Cor\.?)\s*~?([0-9]+(?:\.[0-9]+)*[a-z]?)\b/g;

export interface LinkOptions {
  claims: ClaimsFile;
  decls: DeclsFile;
  hints?: Hints;
  repoDir?: string; // for blueprint and formalization.yaml
  k?: number;
}

type AuthorMap = Map<string, string[]>; // claim id → decl names

function refToClaim(claims: Claim[], ref: string): Claim | undefined {
  return claims.find((c) => matchesRef(c, ref));
}

function fromHints(claims: Claim[], hints?: Hints): AuthorMap {
  const m: AuthorMap = new Map();
  for (const [ref, decls] of Object.entries(hints?.links ?? {})) {
    const c = refToClaim(claims, ref);
    if (c) m.set(c.id, [...decls].sort());
  }
  return m;
}

function walk(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[])
    .map(String)
    .filter((f) => f.endsWith(ext) && !f.split(/[\\/]/).some((p) => p.startsWith(".") || p === "node_modules"))
    .sort()
    .map((f) => join(dir, f));
}

/** blueprint: environments in blueprint/src/*.tex with \lean{A, B}; linked when the env label equals
 * a paper label or the env title/body names a paper result ("Theorem 3.1"). */
function fromBlueprint(claims: Claim[], repoDir?: string): AuthorMap {
  const m: AuthorMap = new Map();
  if (!repoDir) return m;
  for (const f of walk(join(repoDir, "blueprint"), ".tex")) {
    const src = readFileSync(f, "utf8");
    const envRe = /\\begin\{(\w+)\}(\[[^\]]*\])?([\s\S]*?)\\end\{\1\}/g;
    let e: RegExpExecArray | null;
    while ((e = envRe.exec(src))) {
      const body = (e[2] ?? "") + e[3]!;
      const lean = /\\lean\{([^}]*)\}/.exec(body);
      if (!lean) continue;
      const names = lean[1]!.split(",").map((s) => s.trim()).filter(Boolean);
      const label = /\\label\{([^}]+)\}/.exec(body)?.[1];
      let target = label ? claims.find((c) => c.label === label) : undefined;
      if (!target) {
        for (const r of body.matchAll(new RegExp(DOCSTRING_RE.source, "g"))) {
          target = claims.find((c) => c.number === r[2] && c.kind === normalizeKindWord(r[1]!));
          if (target) break;
        }
      }
      if (target) m.set(target.id, [...new Set([...(m.get(target.id) ?? []), ...names])].sort());
    }
  }
  return m;
}

function fromFormalizationYaml(claims: Claim[], repoDir?: string): AuthorMap {
  const m: AuthorMap = new Map();
  if (!repoDir) return m;
  const p = join(repoDir, "formalization.yaml");
  if (!existsSync(p)) return m;
  const doc = YAML.parse(readFileSync(p, "utf8")) as { alignment?: { statements?: { source?: string; lean?: string }[] } };
  for (const s of doc?.alignment?.statements ?? []) {
    if (!s.source || !s.lean) continue;
    const c = refToClaim(claims, s.source);
    if (c) m.set(c.id, [...new Set([...(m.get(c.id) ?? []), s.lean])].sort());
  }
  return m;
}

function fromDocstrings(claims: Claim[], decls: DeclsFile): AuthorMap {
  const m: AuthorMap = new Map();
  for (const d of decls.decls) {
    if (!d.docstring || d.kind !== "theorem") continue;
    for (const r of d.docstring.matchAll(new RegExp(DOCSTRING_RE.source, "g"))) {
      const kind = normalizeKindWord(r[1]!);
      const c = claims.find((c) => c.kind === kind && c.number === r[2]);
      if (c) m.set(c.id, [...new Set([...(m.get(c.id) ?? []), d.name])].sort());
    }
  }
  return m;
}

export function declSearchText(d: DeclsFile["decls"][number]): string {
  const nameWords = d.name.split(".").join(" ");
  const idents = (d.type_pp.match(/[A-Za-z_][A-Za-z0-9_.']*/g) ?? []).join(" ");
  return `${nameWords} ${d.docstring ?? ""} ${idents}`;
}

export function link(opts: LinkOptions): CandidatesFile {
  const { claims, decls } = opts;
  const k = opts.k ?? 8;
  const ignored = claims.claims.filter((c) => (opts.hints?.ignore ?? []).some((r) => matchesRef(c, r))).map((c) => c.id);
  const sources: [Link["author_source"], AuthorMap][] = [
    ["hints", fromHints(claims.claims, opts.hints)],
    ["blueprint", fromBlueprint(claims.claims, opts.repoDir)],
    ["formalization-yaml", fromFormalizationYaml(claims.claims, opts.repoDir)],
    ["docstring", fromDocstrings(claims.claims, decls)],
  ];
  const pool = decls.decls.filter((d) => d.kind === "theorem");
  const bm = new Bm25(pool.map(declSearchText));
  const links: Link[] = claims.claims
    .filter((c) => !ignored.includes(c.id))
    .map((c) => {
      let author: string[] | null = null;
      let source: Link["author_source"] = null;
      for (const [s, map] of sources) {
        const v = map.get(c.id);
        if (v) { author = v; source = s; break; }
      }
      const retrieved = bm
        .topK(`${c.title ?? ""} ${c.text_plain}`, k)
        .map((h) => ({ decl: pool[h.index]!.name, score: Math.round(h.score * 1000) / 1000 }));
      return { claim_id: c.id, author_declared: author, author_source: source, retrieved };
    });
  return CandidatesFile.parse({ schema: "ccm/candidates@1", tool: TOOL, ignored, links });
}
