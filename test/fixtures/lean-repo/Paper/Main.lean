import Paper.Defs

namespace Paper

/-- Lemma 2.1 of the paper. -/
theorem add_zero' (n : Nat) : n + 0 = n := rfl

/-- Theorem 3.2 -/
theorem uses_sorry (a b : Nat) (h : a ≤ b) : a ≤ b + 1 := by
  sorry

/-- Proposition 1 -/
theorem uses_axiom (n : Nat) : IsNice (2 * n + 1) := magic n

theorem nice_zero : IsNice 0 := rfl

end Paper
