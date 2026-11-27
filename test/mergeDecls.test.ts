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
});
