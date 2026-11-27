import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
  // build the target's default targets, then the extractor
  r = await execa("lake", ["build"], { cwd: o.repoDir, reject: false, all: true });
  if (r.exitCode !== 0) throw new CcmError(`target build failed:\n${r.all}`, 4);
  r = await run(["build", "lean-extract"]);
  if (r.exitCode !== 0) throw new CcmError(`lean-extract does not build on this toolchain (exit 3 semantics):\n${r.all}`, 3);
  const args = ["exe", "lean-extract", "--package", pkg, "--root", resolve(o.repoDir), "--repo", o.repoUrl, "--commit", o.commit, "--out", resolve(o.out)];
  if (o.modules?.length) args.push("--modules", o.modules.join(","));
  r = await run(args);
  if (r.exitCode !== 0) throw new CcmError(`lean-extract failed (exit ${r.exitCode}):\n${r.all}`, r.exitCode === 3 ? 3 : 4);
  return DeclsFile.parse(JSON.parse(readFileSync(o.out, "utf8")));
}
