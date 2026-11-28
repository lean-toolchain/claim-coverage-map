import { describe, expect, it } from "vitest";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execaSync } from "execa";
import { paperExtract } from "../src/stages/paperExtract.js";
import { parseAux, toPlain } from "../src/stages/latex.js";

const fx = (p: string) => join(import.meta.dirname, "fixtures", p);
const copy = (p: string) => { const d = mkdtempSync(join(tmpdir(), "ccm-")); cpSync(fx(p), d, { recursive: true }); return d; };

describe("paper-extract (estimated numbering)", () => {
  it("handles shared counters, within=section, \\input, starred envs and is_main", async () => {
    const r = await paperExtract({ paperDir: fx("paper"), paperId: "local", compile: "never", allowEstimated: true });
    expect(r.numbering).toBe("estimated");
    expect(r.claims.map((c) => [c.id, c.location.file, c.location.section, c.is_main])).toEqual([
      ["c-thm-1.1", "main.tex", "1", true],
      ["c-lem-2.1", "sections/prelim.tex", "2", false],
      ["c-thm-3.2", "main.tex", "3", true], // referenced from abstract
      ["c-cor-3.3", "main.tex", "3", false],
      ["c-lem-3.4", "main.tex", "3", false],
      ["c-prop-1", "main.tex", "3", false],
    ]);
    expect(r.claims[0]!.title).toBe("Main theorem");
    expect(r.claims[0]!.text_plain).toContain("$a^n + b^n = c^n$");
    expect(r.claims[1]!.location.line).toBe(2);
  });

  it("thmtools declarations, sibling counters and appendix letters", async () => {
    const r = await paperExtract({ paperDir: fx("thmtools"), paperId: "local", compile: "never", allowEstimated: true });
    expect(r.claims.map((c) => [c.kind, c.number])).toEqual([
      ["theorem", "1.1"], ["corollary", "1.2"], ["theorem", "2.1"], ["theorem", "A.1"],
    ]);
  });

  it("hints override main results", async () => {
    const r = await paperExtract({ paperDir: fx("paper"), paperId: "local", compile: "never", allowEstimated: true, hints: { main_results: ["Lemma 3.4"] } });
    expect(r.claims.filter((c) => c.is_main).map((c) => c.id)).toEqual(["c-lem-3.4"]);
  });

  it("parses .aux labels and hook records", () => {
    const a = parseAux("\\newlabel{thm:x}{{4.2}{7}{}{theorem.4.2}{}}\n\\ccmclaim{main}{12}{\\thesection.3}\n");
    expect(a.labels.get("thm:x")).toBe("4.2");
    expect(a.claims[0]).toEqual({ file: "main", line: 12, number: ".3" });
  });

  it("plain text keeps math and resolves refs", () => {
    expect(toPlain("By \\cref{a}, \\emph{every} $x^2\\ge 0$.\\label{q}", (l) => (l === "a" ? "2.1" : null))).toBe("By 2.1, every $x^2\\ge 0$.");
  });

  it("throws exit 3 when compilation is required but fails", async () => {
    const d = copy("paper");
    const old = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      await expect(paperExtract({ paperDir: d, paperId: "x", compile: "auto", allowEstimated: false })).rejects.toMatchObject({ exitCode: 3 });
    } finally { process.env.PATH = old; }
  });
});

let hasLatexmk = false;
try { execaSync("latexmk", ["-v"]); hasLatexmk = true; } catch { /* not installed */ }

describe.skipIf(!hasLatexmk)("paper-extract (real LaTeX compile)", () => {
  it("uses .aux numbering and agrees with the simulation", async () => {
    const d = copy("paper");
    const r = await paperExtract({ paperDir: d, paperId: "local", compile: "auto", allowEstimated: false });
    expect(r.numbering).toBe("aux");
    expect(r.claims.map((c) => c.id)).toEqual(["c-thm-1.1", "c-lem-2.1", "c-thm-3.2", "c-cor-3.3", "c-lem-3.4", "c-prop-1"]);
    expect(r.claims.every((c) => c.extraction === "certain")).toBe(true);
  }, 120_000);
});

describe("result references", () => {
  it("accepts descriptive forms used in formalization.yaml", async () => {
    const { matchesRef } = await import("../src/stages/paperExtract.js");
    const c = { id: "c-thm-1.2", kind: "theorem", number: "1.2", label: "thm:x" } as never;
    expect(matchesRef(c, "Theorem 1.2: for subdiagrams $D$")).toBe(true);
    expect(matchesRef(c, "Thm. 1.2 (main)")).toBe(true);
    expect(matchesRef(c, "Theorem 1.21")).toBe(false);
    expect(matchesRef(c, "Lemma 1.2")).toBe(false);
    expect(matchesRef(c, "Some paper title (Theorem 1.2, equation (8))")).toBe(true);
    expect(matchesRef(c, "Some paper title (Lemma 1.2)")).toBe(false);
  });
});
