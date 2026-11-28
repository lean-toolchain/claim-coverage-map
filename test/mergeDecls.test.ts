import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mergeDecls } from "../src/stages/leanExtract.js";
import { DeclsFile } from "../src/schemas/index.js";

const base = DeclsFile.parse(JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "decls.json"), "utf8")));
const d = (name: string, module: string, sorry: boolean) => ({ ...base.decls[0]!, name, module, uses_sorry: sorry });

describe("mergeDecls (problem/solution modules)", () => {
  it("prefers the sorry-free declaration for duplicate names and keeps the rest", () => {
    const problem = { ...base, decls: [d("main", "P.problem", true), d("only_problem", "P.problem", true)] };
    const solution = { ...base, decls: [d("main", "P.solution", false), d("helper", "P.solution", false)] };
    const m = mergeDecls([problem, solution]);
    expect(m.decls.map((x) => [x.name, x.module, x.uses_sorry])).toEqual([
      ["only_problem", "P.problem", true], ["helper", "P.solution", false], ["main", "P.solution", false],
    ]);
    expect(mergeDecls([solution, problem]).decls.find((x) => x.name === "main")!.uses_sorry).toBe(false);
  });

  it("keeps different proved statements that share a name, qualified by module", () => {
    const h2 = { ...base, decls: [{ ...d("main", "H2.solution", false), type_pp: "A" }] };
    const lem = { ...base, decls: [{ ...d("main", "Lem41.solution", false), type_pp: "B" }, { ...d("main", "Lem41.problem", true), type_pp: "B" }] };
    const same = { ...base, decls: [{ ...d("main", "H2.copy", false), type_pp: "A" }] };
    expect(mergeDecls([h2, lem, same]).decls.map((x) => x.name).sort()).toEqual(["main@H2.solution", "main@Lem41.solution"]);
  });
});
