import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { DeclsFile } from "../schemas/index.js";
import { CcmError } from "../util/io.js";

/** Location of the bundled Lean package (lean-extract/). */
export function leanExtractPackageDir(): string {
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(d, "lean-extract", "lakefile.toml"))) return join(d, "lean-extract");
    d = dirname(d);
  }
  throw new CcmError("bundled lean-extract package not found", 4);
}

function readLakePackageName(repoDir: string): string {
  const toml = join(repoDir, "lakefile.toml");
  if (existsSync(toml)) {
    const m = /^name\s*=\s*"([^"]+)"/m.exec(readFileSync(toml, "utf8"));
    if (m) return m[1]!;
  }
  const lean = join(repoDir, "lakefile.lean");
  if (existsSync(lean)) {
    const m = /^package\s+«?([\w-]+)»?/m.exec(readFileSync(lean, "utf8"));
    if (m) return m[1]!;
  }
  throw new CcmError("cannot determine Lake package name of target repository", 4);
}

/** All `lean_lib` names, including ones outside defaultTargets (e.g. a Solution library). */
export function readLeanLibs(repoDir: string): string[] {
  const libs: string[] = [];
  const toml = join(repoDir, "lakefile.toml");
  if (existsSync(toml)) {
    for (const sec of readFileSync(toml, "utf8").split(/^(?=\[)/m)) {
      if (!sec.startsWith("[[lean_lib]]")) continue;
      const m = /^name\s*=\s*"([^"]+)"/m.exec(sec);
      if (m) libs.push(m[1]!);
    }
  }
  const lean = join(repoDir, "lakefile.lean");
  if (existsSync(lean)) {
    for (const m of readFileSync(lean, "utf8").matchAll(/^\s*lean_lib\s+«?([\w.-]+)»?/gm)) libs.push(m[1]!);
  }
  return [...new Set(libs)];
}

/** Project modules (by file) that have no .olean after the default build. */
export function unbuiltModules(repoDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".lean") && !(dir === repoDir && e.name === "lakefile.lean")) {
        const stem = relative(repoDir, p).slice(0, -5);
        if (!/^[\w/\\]+$/.test(stem)) continue; // module names lake cannot address
        if (!existsSync(join(repoDir, ".lake", "build", "lib", "lean", `${stem}.olean`))) out.push(stem.split(sep).join("."));
      }
    }
  };
  walk(repoDir);
  return out.sort();
}

/** Best effort: `lake build +M` for modules in some lean_lib; direct `lean -o` for the rest. */
async function buildModules(repoDir: string, mods: string[]): Promise<void> {
  let todo = [...mods];
  const loose: string[] = [];
  // lake rejects the whole build when one target is an unknown module; drop those and retry
  for (let i = 0; i < 20 && todo.length; i++) {
    const r = await execa("lake", ["build", ...todo.map((m) => `+${m}`)], { cwd: repoDir, reject: false, all: true });
    const unknown = [...String(r.all).matchAll(/unknown module `([^`]+)`/g)].map((m) => m[1]!);
    if (!unknown.length) break;
    loose.push(...unknown);
    todo = todo.filter((m) => !unknown.includes(m));
  }
  // files outside every lean_lib: compile in dependency order by repeating until no progress
  let pending = loose.filter((m) => unbuiltModules(repoDir).includes(m));
  for (let progress = true; progress && pending.length; ) {
    progress = false;
    for (const m of pending) {
      const rel = m.split(".").join(sep);
      const olean = join(repoDir, ".lake", "build", "lib", "lean", `${rel}.olean`);
      mkdirSync(dirname(olean), { recursive: true });
      const r = await execa("lake", ["env", "lean", "-o", olean, `${rel}.lean`], { cwd: repoDir, reject: false });
      if (r.exitCode === 0 && existsSync(olean)) progress = true;
    }
    pending = pending.filter((m) => unbuiltModules(repoDir).includes(m));
  }
}

export interface LeanExtractOptions {
  repoDir: string;
  repoUrl: string;
  commit: string;
  workDir: string; // temporary workspace lives here
  modules?: string[];
  out: string;
  log?: (m: string) => void;
}

/** lean-extract.md: temp Lake workspace requiring the target (path) and lean-extract, then run. */
export async function leanExtract(o: LeanExtractOptions): Promise<DeclsFile> {
  const ws = join(o.workDir, "lean-ws");
  mkdirSync(ws, { recursive: true });
  const tc = join(o.repoDir, "lean-toolchain");
  if (!existsSync(tc)) throw new CcmError("target repository has no lean-toolchain", 4);
  copyFileSync(tc, join(ws, "lean-toolchain"));
  const pkg = readLakePackageName(o.repoDir);
  writeFileSync(
    join(ws, "lakefile.toml"),
    `name = "ccm_ws"\n\n[[require]]\nname = "${pkg}"\npath = ${JSON.stringify(resolve(o.repoDir))}\n\n[[require]]\nname = "lean_extract"\npath = ${JSON.stringify(leanExtractPackageDir())}\n`,
  );
  const run = async (args: string[]) => {
    const r = await execa("lake", args, { cwd: ws, reject: false, all: true });
    return r;
  };
  let r = await run(["update"]);
  if (r.exitCode !== 0) throw new CcmError(`lake update failed:\n${r.all}`, 4);
  // Mathlib projects: fetch prebuilt .olean files instead of compiling Mathlib (target and workspace)
  const usesMathlib = (dir: string) => existsSync(join(dir, "lake-manifest.json")) && /"name":\s*"mathlib"/.test(readFileSync(join(dir, "lake-manifest.json"), "utf8"));
  if (usesMathlib(o.repoDir)) {
    o.log?.("fetching Mathlib build cache");
    await execa("lake", ["exe", "cache", "get"], { cwd: o.repoDir, reject: false });
    await execa("lake", ["exe", "cache", "get"], { cwd: ws, reject: false });
  }
  // build the target's default targets, then the extractor
  o.log?.("building the Lean repository (lake build)");
  r = await execa("lake", ["build"], { cwd: o.repoDir, reject: false, all: true });
  if (r.exitCode !== 0) throw new CcmError(`target build failed:\n${r.all}`, 4);
  // Main theorems often live outside defaultTargets (Challenge/Solution libraries, solution files
  // nothing imports). Build every lean_lib, then any remaining module, best effort.
  const libs = readLeanLibs(o.repoDir);
  if (libs.length) await execa("lake", ["build", ...libs], { cwd: o.repoDir, reject: false });
  const rest = unbuiltModules(o.repoDir);
  if (rest.length) {
    o.log?.(`building ${rest.length} module(s) outside the default targets`);
    await buildModules(o.repoDir, rest);
    const failed = unbuiltModules(o.repoDir);
    if (failed.length) o.log?.(`warning: ${failed.length} module(s) did not build and are skipped: ${failed.slice(0, 10).join(", ")}`);
  }
  r = await run(["build", "lean-extract"]);
  if (r.exitCode !== 0) throw new CcmError(`lean-extract does not build on this toolchain (exit 3 semantics):\n${r.all}`, 3);
  // all kinds: theorems are link candidates; definitions give the judge the meaning of custom constants
  const args = ["exe", "lean-extract", "--package", pkg, "--kinds", "theorem,def,axiom,opaque,inductive,structure,instance", "--root", resolve(o.repoDir), "--repo", o.repoUrl, "--commit", o.commit, "--out", resolve(o.out)];
  if (o.modules?.length) args.push("--modules", o.modules.join(","));
  r = await run(args);
  if (r.exitCode === 5) {
    // modules cannot be imported together: extract each in its own process and merge
    const mods = /CCM_MODULES: (.*)/.exec(String(r.all))?.[1]?.split(",").filter(Boolean) ?? [];
    o.log?.(`modules clash when imported together; extracting ${mods.length} modules separately`);
    const parts: DeclsFile[] = [];
    for (const m of mods) {
      const part = `${o.out}.${m}.json`;
      const base = args.filter((_, i) => args[i - 1] !== "--out" && args[i] !== "--out" && args[i - 1] !== "--modules" && args[i] !== "--modules");
      const pr = await run([...base, "--modules", m, "--out", resolve(part)]);
      if (pr.exitCode !== 0) throw new CcmError(`lean-extract failed for module ${m} (exit ${pr.exitCode}):\n${pr.all}`, 4);
      parts.push(DeclsFile.parse(JSON.parse(readFileSync(part, "utf8"))));
    }
    const merged = mergeDecls(parts);
    writeFileSync(o.out, JSON.stringify(merged, null, 2) + "\n");
    return merged;
  }
  if (r.exitCode !== 0) throw new CcmError(`lean-extract failed (exit ${r.exitCode}):\n${r.all}`, r.exitCode === 3 ? 3 : 4);
  return DeclsFile.parse(JSON.parse(readFileSync(o.out, "utf8")));
}

/** Merge per-module extractions; for duplicate names prefer the declaration that does not use sorry. */
export function mergeDecls(parts: DeclsFile[]): DeclsFile {
  // Per-module runs exist because modules clash on names: a problem file and its solution, or
  // separate solutions that reuse a name (`main` in two directories). Prefer sorry-free versions,
  // treat identical statements as one declaration, and keep genuinely different ones apart as
  // `name@Module` so neither is lost.
  const groups = new Map<string, DeclsFile["decls"]>();
  for (const p of parts) for (const d of p.decls) {
    const g = groups.get(d.name) ?? [];
    if (!g.some((x) => x.module === d.module && x.range.start.line === d.range.start.line)) g.push(d);
    groups.set(d.name, g);
  }
  const decls: DeclsFile["decls"] = [];
  for (const [name, g] of groups) {
    const proved = g.filter((d) => !d.uses_sorry);
    const pool = proved.length ? proved : g;
    const distinct: DeclsFile["decls"] = [];
    for (const d of pool) if (!distinct.some((x) => x.type_pp === d.type_pp)) distinct.push(d);
    if (distinct.length === 1) decls.push(distinct[0]!);
    else for (const d of distinct) decls.push({ ...d, name: `${name}@${d.module}` });
  }
  decls.sort((a, b) => a.module.localeCompare(b.module) || a.range.start.line - b.range.start.line || a.name.localeCompare(b.name));
  return { ...parts[0]!, decls };
}
