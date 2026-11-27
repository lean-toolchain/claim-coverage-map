import Lean
open Lean Meta

namespace LeanExtract

structure Pos where
  line : Nat
  col : Nat
  deriving ToJson

structure Range where
  start : Pos
  «end» : Pos
  deriving ToJson

structure BinderOut where
  name : String
  type_pp : String
  info : String
  is_prop : Bool
  deriving ToJson

structure DeclOut where
  name : String
  kind : String
  module : String
  file : String
  range : Range
  docstring : Option String
  type_pp : String
  binders : Array BinderOut
  conclusion_pp : String
  axioms : Array String
  uses_sorry : Bool
  nonstandard_axioms : Array String
  custom_constants : Array String
  source : Option String
  deriving ToJson

def standardAxioms : List Name := [``propext, ``Classical.choice, ``Quot.sound]

def kindOf (env : Environment) (ci : ConstantInfo) : String :=
  match ci with
  | .thmInfo _ => "theorem"
  | .axiomInfo _ => "axiom"
  | .opaqueInfo _ => "opaque"
  | .inductInfo _ => if isStructure env ci.name then "structure" else "inductive"
  | .defnInfo _ => if (instanceExtension.getState env).instanceNames.contains ci.name then "instance" else "def"
  | _ => "def"

def binderInfoStr : BinderInfo → String
  | .default => "default"
  | .implicit => "implicit"
  | .strictImplicit => "strict_implicit"
  | .instImplicit => "inst_implicit"

def ppE (e : Expr) : MetaM String := do
  return toString (← withOptions (fun o => o.setBool `pp.unicode.fun true) (ppExpr e))

/-- Constants directly referenced by `e` that belong to the target package's modules. -/
def customConstants (env : Environment) (isProject : Name → Bool) (e : Expr) : Array String :=
  let cs := e.getUsedConstants
  let out := cs.filter fun c =>
    match env.getModuleIdxFor? c with
    | some idx => isProject (env.header.moduleNames[idx.toNat]!)
    | none => false
  (out.map toString).qsort (· < ·) |>.toList.eraseDups.toArray

def extractDecl (env : Environment) (isProject : Name → Bool) (root : System.FilePath)
    (ci : ConstantInfo) : MetaM (Option DeclOut) := do
  let some modIdx := env.getModuleIdxFor? ci.name | return none
  let modName := env.header.moduleNames[modIdx.toNat]!
  let some ranges ← findDeclarationRanges? ci.name | return none
  let r := ranges.range
  let file := (modName.toString.replace "." "/") ++ ".lean"
  let doc ← findDocString? env ci.name
  let typePP ← ppE ci.type
  let (binders, concl) ← forallTelescope ci.type fun xs body => do
    let bs ← xs.mapM fun x => do
      let ld ← x.fvarId!.getDecl
      let ty ← inferType x
      return { name := ld.userName.toString, type_pp := (← ppE ld.type),
               info := binderInfoStr ld.binderInfo, is_prop := (← isProp ty) : BinderOut }
    return (bs, ← ppE body)
  let axs ← collectAxioms ci.name
  let axStrs := (axs.map toString).qsort (· < ·)
  let nonstd := (axs.filter fun a => !standardAxioms.contains a && a != ``sorryAx).map toString
  let source ← do
    let path := root / file
    if ← path.pathExists then
      let lines := (← IO.FS.readFile path).splitOn "\n"
      let s := r.pos.line - 1
      let e := min r.endPos.line (s + 80)
      pure (some ("\n".intercalate ((lines.drop s).take (e - s))))
    else pure none
  return some {
    name := ci.name.toString, kind := kindOf env ci, module := modName.toString, file,
    range := { start := ⟨r.pos.line, r.pos.column⟩, «end» := ⟨r.endPos.line, r.endPos.column⟩ },
    docstring := doc, type_pp := typePP, binders, conclusion_pp := concl,
    axioms := axStrs, uses_sorry := axs.contains ``sorryAx,
    nonstandard_axioms := nonstd.qsort (· < ·),
    -- for definitions, also the constants their bodies use (so a judge can unfold them)
    custom_constants := customConstants env isProject
      (match ci with
       | .defnInfo d => mkApp ci.type d.value
       | _ => ci.type) |>.filter (· != ci.name.toString), source }

end LeanExtract
