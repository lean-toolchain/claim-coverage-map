import { describe, expect, it } from "vitest";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execaSync } from "execa";
import { leanExtract } from "../../src/stages/leanExtract.js";

let hasLake = false;
try { execaSync("elan", ["--version"]); hasLake = true; } catch { /* not installed */ }

describe.skipIf(!hasLake)("lean-extract on a fixture repository", () => {
  it("extracts theorems with axioms, sorry and docstrings", async () => {
    const w = mkdtempSync(join(tmpdir(), "ccm-lean-"));
    const repo = join(w, "repo");
    cpSync(join(import.meta.dirname, "..", "fixtures", "lean-repo"), repo, { recursive: true });
    const d = await leanExtract({ repoDir: repo, repoUrl: "https://github.com/o/r", commit: "c0ffee", workDir: w, out: join(w, "decls.json") });
    const by = new Map(d.decls.map((x) => [x.name, x]));
    expect(d.decls.filter((x) => x.kind === "theorem").map((x) => x.name)).toEqual(["Paper.add_zero'", "Paper.uses_sorry", "Paper.uses_axiom", "Paper.nice_zero"]);
    // definitions and axioms are extracted too, so the judge can read what custom constants mean
    expect(by.get("Paper.IsNice")).toMatchObject({ kind: "def", type_pp: "Nat → Prop" });
    expect(by.get("Paper.IsNice")!.source).toContain("def IsNice");
    expect(by.get("Paper.magic")!.kind).toBe("axiom");
    // notation is pretty-printed (environment extensions loaded)
    expect(by.get("Paper.uses_sorry")!.type_pp).toContain("a ≤ b");
    expect(by.get("Paper.add_zero'")).toMatchObject({ docstring: "Lemma 2.1 of the paper. ", file: "Paper/Main.lean", uses_sorry: false, nonstandard_axioms: [] });
    expect(by.get("Paper.uses_sorry")!.uses_sorry).toBe(true);
    expect(by.get("Paper.uses_axiom")!.nonstandard_axioms).toEqual(["Paper.magic"]);
    expect(by.get("Paper.uses_axiom")!.custom_constants).toEqual(["Paper.IsNice"]);
    expect(by.get("Paper.uses_sorry")!.binders.map((b) => [b.name, b.is_prop])).toEqual([["a", false], ["b", false], ["h", true]]);
    expect(d.inputs.toolchain).toMatch(/^leanprover\/lean4:v4\./);
  }, 600_000);
});
