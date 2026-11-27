import LeanExtract.Basic
open Lean Meta LeanExtract

structure Args where
  modules : Array Name := #[]
  package : String := ""
  root : System.FilePath := "."
  scope : String := "project"
  kinds : Array String := #["theorem"]
  out : Option System.FilePath := none
  repo : String := ""
  commit : String := ""

partial def parseArgs : List String → Args → Except String Args
  | [], a => .ok a
  | "--modules" :: v :: r, a => parseArgs r { a with modules := (v.splitOn ",").toArray.map String.toName }
  | "--package" :: v :: r, a => parseArgs r { a with package := v }
  | "--root" :: v :: r, a => parseArgs r { a with root := v }
  | "--scope" :: v :: r, a =>
      if v == "project" || v == "all" then parseArgs r { a with scope := v } else .error s!"bad --scope {v}"
  | "--kinds" :: v :: r, a => parseArgs r { a with kinds := (v.splitOn ",").toArray }
  | "--out" :: v :: r, a => parseArgs r { a with out := some v }
  | "--repo" :: v :: r, a => parseArgs r { a with repo := v }
  | "--commit" :: v :: r, a => parseArgs r { a with commit := v }
  | x :: _, _ => .error s!"unknown argument {x}"

/-- Root modules of the target: every `.lean` file under the package root that is not in `.lake`. -/
partial def projectModules (root : System.FilePath) : IO (Array Name) := do
  let mut out := #[]
  for p in ← root.walkDir (fun d => pure (d.fileName != some ".lake" && d.fileName != some ".git")) do
    if p.extension == some "lean" then
      let rel := (p.toString.drop (root.toString.length + 1))
      let fn := p.fileName.getD ""
      if fn != "lakefile.lean" && !rel.startsWith "." then
        out := out.push (String.toName ((rel.dropRight 5).replace "/" "."))
  return out.qsort (·.toString < ·.toString)

unsafe def main (argv : List String) : IO UInt32 := do
  let args ← match parseArgs argv {} with
    | .ok a => pure a
    | .error e => IO.eprintln s!"lean-extract: {e}"; return (2 : UInt32)
  enableInitializersExecution
  initSearchPath (← findSysroot)
  let mods ← if args.modules.isEmpty then projectModules args.root else pure args.modules
  if mods.isEmpty then IO.eprintln "lean-extract: no modules"; return (2 : UInt32)
  let topLevels := (mods.map fun m => m.getRoot).toList.eraseDups
  let isProject : Name → Bool := fun m => args.scope == "all" || topLevels.contains m.getRoot
  -- Extract from one environment.
  let extractFrom (env : Environment) : IO (Array DeclOut) := do
    let ctx : Core.Context := { fileName := "<lean-extract>", fileMap := default, maxHeartbeats := 0 }
    let st : Core.State := { env }
    let action : MetaM (Array DeclOut) := do
      let mut out := #[]
      for (n, ci) in env.constants.toList do
        if n.isInternalDetail || ci.isUnsafe then continue
        let some idx := env.getModuleIdxFor? n | continue
        if !isProject (env.header.moduleNames[idx.toNat]!) then continue
        if !args.kinds.contains (kindOf env ci) then continue
        if let some d ← (extractDecl env isProject args.root ci : MetaM _) then out := out.push d
      return out
    let (ds, _) ← (action.run' {} {}).toIO ctx st
    return ds
  -- Import all modules together. If they clash (e.g. a comparator-style problem/solution pair
  -- defining the same names), report the module list and exit 5: the caller then runs one
  -- process per module (Lean initializers cannot run twice in one process) and merges.
  let env ← try importModules (mods.map fun m => { module := m }) {} (trustLevel := 1024) (loadExts := true)
    catch e =>
      IO.eprintln s!"lean-extract: joint import failed: {e}"
      IO.eprintln s!"CCM_MODULES: {",".intercalate (mods.toList.map toString)}"
      return (5 : UInt32)
  let mut byName : Std.HashMap String DeclOut := {}
  for d in ← extractFrom env do byName := byName.insert d.name d
  let decls := byName.toArray.map (·.2) |>.qsort fun a b =>
    a.module < b.module || (a.module == b.module && (a.range.start.line < b.range.start.line ||
      (a.range.start.line == b.range.start.line && a.name < b.name)))
  let toolchain := Lean.versionString
  let mathlib ← do
    let mf := args.root / "lake-manifest.json"
    if ← mf.pathExists then
      match Json.parse (← IO.FS.readFile mf) with
      | .ok j =>
        let pkgs := (j.getObjValD "packages").getArr?.toOption.getD #[]
        pure <| pkgs.findSome? fun p =>
          if p.getObjValD "name" == Json.str "mathlib" then
            (p.getObjValAs? String "rev").toOption.map fun r => Json.mkObj [("commit", r)]
          else none
      | .error _ => pure none
    else pure none
  let out := Json.mkObj [
    ("schema", "lean-extract/decls@1"),
    ("tool", Json.mkObj [("name", "lean-extract"), ("version", "0.1.0")]),
    ("inputs", Json.mkObj [("toolchain", s!"leanprover/lean4:v{toolchain}"), ("repo", args.repo),
                           ("commit", args.commit), ("mathlib", mathlib.getD Json.null)]),
    ("decls", toJson decls)]
  let s := out.pretty 200
  match args.out with
  | some p => IO.FS.writeFile p (s ++ "\n")
  | none => IO.println s
  return 0
