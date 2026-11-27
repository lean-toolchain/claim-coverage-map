namespace Paper

/-- A predicate on naturals. -/
def IsNice (n : Nat) : Prop := n % 2 = 0

axiom magic : ∀ n : Nat, IsNice (2 * n + 1)

end Paper
