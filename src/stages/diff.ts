import type { CoverageClaim, CoverageFile, Status } from "../schemas/index.js";
import { claimDisplay } from "./paperExtract.js";
import { STATUSES, STATUS_LABEL, toMarkdown } from "./report.js";

/** Higher is better; used to classify a change as improvement or regression. */
const RANK: Record<Status, number> = { verified: 5, weakened: 4, corollary_only: 3, needs_review: 2, assumed: 1, missing: 0 };

export interface Change {
  claim_id: string;
  result: string;
  is_main: boolean;
  before: Status | null; // null → new result in the paper
  after: Status | null; // null → result removed from the paper
  kind: "regression" | "improvement" | "changed" | "added" | "removed";
  note: string;
}

export const COMMENT_MARKER = "<!-- ccm-coverage -->";

export function diffCoverage(base: CoverageFile | null, head: CoverageFile): { changes: Change[]; markdown: string } {
  const before = new Map((base?.claims ?? []).map((c) => [c.claim_id, c]));
  const after = new Map(head.claims.map((c) => [c.claim_id, c]));
  const changes: Change[] = [];
  for (const c of head.claims) {
    const b = before.get(c.claim_id);
    if (!b) { if (base) changes.push(mk(c, null, c.status, "added")); continue; }
    if (b.status === c.status) continue;
    const kind = RANK[c.status] < RANK[b.status] ? "regression" : RANK[c.status] > RANK[b.status] ? "improvement" : "changed";
    changes.push(mk(c, b.status, c.status, kind));
  }
  for (const b of base?.claims ?? []) if (!after.has(b.claim_id)) changes.push(mk(b, b.status, null, "removed"));
  const order = { regression: 0, removed: 1, added: 2, changed: 3, improvement: 4 };
  changes.sort((x, y) => order[x.kind] - order[y.kind] || Number(y.is_main) - Number(x.is_main));
  return { changes, markdown: render(base, head, changes) };
}

function mk(c: CoverageClaim, before: Status | null, after: Status | null, kind: Change["kind"]): Change {
  return { claim_id: c.claim_id, result: claimDisplay(c), is_main: c.is_main, before, after, kind, note: c.reason };
}

const lbl = (s: Status | null) => (s ? STATUS_LABEL[s] : "—");
const ICON: Record<Change["kind"], string> = { regression: "🔻", improvement: "🔺", changed: "↔", added: "➕", removed: "➖" };

function render(base: CoverageFile | null, head: CoverageFile, changes: Change[]): string {
  const s = head.summary;
  const out = [COMMENT_MARKER, "## Claim coverage", ""];
  const delta = (k: Status) => {
    if (!base) return "";
    const d = s[k] - base.summary[k];
    return d ? ` (${d > 0 ? "+" : ""}${d})` : "";
  };
  out.push(`**${s.total} results:** ` + STATUSES.map((k) => `${STATUS_LABEL[k]} ${s[k]}${delta(k)}`).join(" · "), "");
  const mainGaps = head.claims.filter((c) => c.is_main && c.status !== "verified");
  if (mainGaps.length) {
    out.push("**Main results not verified:** " + mainGaps.map((c) => `${claimDisplay(c)} (${STATUS_LABEL[c.status]})`).join(", "), "");
  }
  if (!base) out.push("_No baseline coverage found for the base branch; showing the current state only._", "");
  else if (!changes.length) out.push("No coverage changes compared with the base branch.", "");
  else {
    out.push("| | Result | Before | After | Why |", "|---|---|---|---|---|");
    for (const c of changes) {
      out.push(`| ${ICON[c.kind]} | ${c.result}${c.is_main ? " **(main)**" : ""} | ${lbl(c.before)} | ${lbl(c.after)} | ${c.note.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 200)} |`);
    }
    out.push("");
  }
  out.push("<details><summary>Full table</summary>", "", toMarkdown(head), "</details>", "");
  const j = head.inputs.judge;
  out.push(`<sub>ccm ${head.tool.version} · ${head.inputs.commit.slice(0, 12)} · judge ${j ? `${j.provider}/${j.model}` : "none"}</sub>`);
  return out.join("\n") + "\n";
}
