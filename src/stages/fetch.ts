import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, resolve } from "node:path";
import { execa } from "execa";
import * as tar from "tar";
import { CcmError } from "../util/io.js";

export const ARXIV_RE = /^(?:arXiv:)?(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)$/i;

export async function fetchPaper(paper: string, dest: string, offline: boolean): Promise<string> {
  if (existsSync(paper) && statSync(paper).isDirectory()) {
    rmSync(dest, { recursive: true, force: true });
    cpSync(resolve(paper), dest, { recursive: true });
    return `local:${resolve(paper)}`;
  }
  const m = ARXIV_RE.exec(paper);
  if (!m) throw new CcmError(`--paper must be an arXiv ID or a local LaTeX directory: ${paper}`, 2);
  const id = m[1]!;
  if (existsSync(dest) && readdirSync(dest).some((f) => f.endsWith(".tex"))) return `arXiv:${id}`;
  if (offline) throw new CcmError("offline: paper source not in workdir", 3);
  const res = await fetch(`https://arxiv.org/e-print/${id}`, { headers: { "user-agent": "ccm/0.1 (claim-coverage-map)" } });
  if (!res.ok) throw new CcmError(`arXiv e-print download failed: HTTP ${res.status}`, 3);
  let buf = Buffer.from(await res.arrayBuffer());
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
  if (buf.subarray(0, 5).toString() === "%PDF-") throw new CcmError("arXiv provides only a PDF for this paper (LaTeX source required in MVP)", 3);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const isTar = buf.length > 262 && buf.subarray(257, 262).toString() === "ustar";
  if (isTar) {
    const tmp = join(dest, ".src.tar");
    writeFileSync(tmp, buf);
    await tar.x({ file: tmp, cwd: dest, strict: true, filter: (p) => !p.split("/").includes("..") && !p.startsWith("/") });
    rmSync(tmp);
  } else {
    writeFileSync(join(dest, "main.tex"), buf);
  }
  return `arXiv:${id}`;
}

export async function fetchRepo(repo: string, commit: string | undefined, dest: string, offline: boolean): Promise<{ dir: string; commit: string }> {
  const local = existsSync(repo);
  if (local && !existsSync(join(repo, ".git"))) {
    return { dir: resolve(repo), commit: commit ?? "unversioned" };
  }
  if (!existsSync(join(dest, ".git"))) {
    if (offline && !local) throw new CcmError("offline: repository not in workdir", 4);
    rmSync(dest, { recursive: true, force: true });
    await execa("git", ["clone", "--quiet", local ? resolve(repo) : repo, dest]);
  }
  if (commit) {
    try {
      await execa("git", ["-C", dest, "checkout", "--quiet", "--detach", commit]);
    } catch {
      if (offline) throw new CcmError(`commit ${commit} not available offline`, 4);
      await execa("git", ["-C", dest, "fetch", "--quiet", "origin", commit]);
      await execa("git", ["-C", dest, "checkout", "--quiet", "--detach", commit]);
    }
  }
  const { stdout } = await execa("git", ["-C", dest, "rev-parse", "HEAD"]);
  return { dir: dest, commit: stdout.trim() };
}
