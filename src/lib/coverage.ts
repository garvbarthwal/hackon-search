/**
 * v3.5 Coverage Validator.
 *
 *   coverage = fulfilled_required_essentials / total_required_essentials
 *
 * Only requirements with priority='required' count toward coverage. 'recommended',
 * 'optional', and 'substitutable' priorities don't fail the cart if missing.
 *
 * Rules per spec:
 *   coverage >= 0.90 → pass (run substitution for any remaining gaps)
 *   coverage  < 0.90 → ask user (caller's responsibility — we just report)
 */
import type { Requirement } from "./planner.js";
import type { ResolvedRequirement } from "./resolver.js";

export const COVERAGE_THRESHOLD = 0.9;

export type CoverageReport = {
  totalEssentials: number;
  fulfilledEssentials: number;
  coverage: number;
  unfulfilled: Requirement[];
  /** Requirements that COULD be substituted (priority='substitutable' or non-hard items). */
  substitutionCandidates: Requirement[];
  status: "pass" | "needs_substitution" | "needs_user_input";
};

const HARD_TO_SUBSTITUTE = /diaper|formula|baby food|incontinence/i;

export function computeCoverage(resolved: ResolvedRequirement[]): CoverageReport {
  const required = resolved.filter((r) => r.requirement.priority === "required");
  const total = required.length;
  const fulfilled = required.filter((r) => r.candidates.length > 0).length;

  const unfulfilled = required.filter((r) => r.candidates.length === 0).map((r) => r.requirement);

  const substitutionCandidates = unfulfilled.filter(
    (r) => r.priority === "substitutable" || !HARD_TO_SUBSTITUTE.test(r.name),
  );

  // Also surface 'substitutable' priority items that DID resolve — caller may still want subs.
  const explicitlySubstitutable = resolved
    .filter((r) => r.requirement.priority === "substitutable" && r.candidates.length === 0)
    .map((r) => r.requirement);
  for (const s of explicitlySubstitutable) {
    if (!substitutionCandidates.find((c) => c.name === s.name)) substitutionCandidates.push(s);
  }

  const coverage = total === 0 ? 1 : fulfilled / total;

  let status: CoverageReport["status"];
  if (coverage >= COVERAGE_THRESHOLD) {
    status = unfulfilled.length === 0 ? "pass" : "needs_substitution";
  } else {
    // Below threshold — caller should ask the user.
    status = "needs_user_input";
  }

  return {
    totalEssentials: total,
    fulfilledEssentials: fulfilled,
    coverage,
    unfulfilled,
    substitutionCandidates,
    status,
  };
}
