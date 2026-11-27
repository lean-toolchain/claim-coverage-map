import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { execa } from "execa";
import YAML from "yaml";
import { z } from "zod";
import { Hints } from "./schemas/index.js";
import { CcmError } from "./util/io.js";

/** ccm.yaml at the repository root: the stable paper ↔ repo pairing plus author hints. */
export const ProjectConfig = Hints.extend({
  paper: z.string().optional(), // arXiv ID or directory relative to the repo root
  modules: z.array(z.string()).optional(),
  llm: z.record(z.string(), z.unknown()).optional(), // same keys as ccm.toml [llm]
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;

export async function gitRoot(dir: string): Promise<string | null> {
  const r = await execa("git", ["-C", dir, "rev-parse", "--show-toplevel"], { reject: false });
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

export async function gitHead(dir: string): Promise<{ commit: string; dirty: boolean }> {
  const h = await execa("git", ["-C", dir, "rev-parse", "HEAD"], { reject: false });
  if (h.exitCode !== 0) return { commit: "unversioned", dirty: true };
  const s = await execa("git", ["-C", dir, "status", "--porcelain", "--untracked-files=no"]);
  return { commit: h.stdout.trim(), dirty: s.stdout.trim().length > 0 };
}

export async function gitRemoteUrl(dir: string): Promise<string | null> {
  const r = await execa("git", ["-C", dir, "remote", "get-url", "origin"], { reject: false });
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

export function loadProjectConfig(repoDir: string): ProjectConfig | null {
  for (const f of ["ccm.yaml", "ccm.yml"]) {
    const p = join(repoDir, f);
    if (existsSync(p)) return ProjectConfig.parse(YAML.parse(readFileSync(p, "utf8")) ?? {});
  }
  return null;
}

/** Paper from ccm.yaml, else formalization.yaml's arXiv reference, else a conventional LaTeX dir. */
export function resolvePaper(repoDir: string, cfg: ProjectConfig | null): string | null {
  if (cfg?.paper) {
    const local = resolve(repoDir, cfg.paper);
    return existsSync(local) ? local : cfg.paper;
  }
  const fy = join(repoDir, "formalization.yaml");
  if (existsSync(fy)) {
    const m = /(?:arxiv\.org\/(?:abs|pdf)\/|arXiv:)(\d{4}\.\d{4,5}(?:v\d+)?)/i.exec(readFileSync(fy, "utf8"));
    if (m) return m[1]!;
  }
  for (const d of ["paper", "tex", "latex"]) {
    const p = join(repoDir, d);
    if (existsSync(p) && readdirSync(p).some((f) => f.endsWith(".tex"))) return p;
  }
  return null;
}

/** Reviewer mode: find the formalization repository linked from the paper source. */
export function discoverRepoUrls(paperDir: string): string[] {
  const urls = new Set<string>();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(tex|bbl|md)$/.test(e.name)) {
        for (const m of readFileSync(p, "utf8").matchAll(/https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?=[\s}/#)\]%,]|$)/g)) {
          urls.add(`https://github.com/${m[1]}/${m[2]}`);
        }
      }
    }
  };
  walk(paperDir);
  return [...urls].sort();
}

export function pickRepo(urls: string[]): string {
  if (urls.length === 1) return urls[0]!;
  const lean = urls.filter((u) => /lean|formal/i.test(u));
  if (lean.length === 1) return lean[0]!;
  throw new CcmError(
    urls.length === 0
      ? "no repository link found in the paper; pass --repo <url>"
      : `several repository links found in the paper; pass --repo with one of:\n  ${urls.join("\n  ")}`, 2);
}
