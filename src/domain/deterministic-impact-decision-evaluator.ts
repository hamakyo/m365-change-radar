import {
  DeterministicImpactDecisionSchema,
  type DeterministicImpactDecision,
} from './deterministic-impact-decision.js';
import {
  RiskPolicyEvaluationResultSchema,
  type RiskPolicyEvaluationResult,
} from './risk-policy.js';
import {
  TenantApplicabilityResultSchema,
  type TenantApplicabilityResult,
} from './tenant-applicability.js';

/**
 * Select the one deterministic impact decision allowed by the two complete
 * evaluation records. The inputs are parsed before any field is inspected,
 * and neither input is mutated.
 */
export function createDeterministicImpactDecision(
  riskEvaluation: RiskPolicyEvaluationResult,
  tenantApplicability: TenantApplicabilityResult,
): DeterministicImpactDecision {
  const parsedRiskEvaluation =
    RiskPolicyEvaluationResultSchema.parse(riskEvaluation);
  const parsedTenantApplicability =
    TenantApplicabilityResultSchema.parse(tenantApplicability);

  if (parsedRiskEvaluation.finalStateFloor !== null) {
    return DeterministicImpactDecisionSchema.parse({
      kind: 'GUARDRAIL_FLOOR',
      riskEvaluation: parsedRiskEvaluation,
      tenantApplicability: parsedTenantApplicability,
      stateFloor: parsedRiskEvaluation.finalStateFloor,
      reason: `Risk policy establishes a ${parsedRiskEvaluation.finalStateFloor} floor.`,
    });
  }

  if (parsedTenantApplicability.status === 'APPLICABLE') {
    return DeterministicImpactDecisionSchema.parse({
      kind: 'CLASSIFICATION_REQUIRED',
      riskEvaluation: parsedRiskEvaluation,
      tenantApplicability: parsedTenantApplicability,
      stateFloor: null,
      reason:
        'Tenant applicability is APPLICABLE and no risk policy floor is established.',
    });
  }

  return DeterministicImpactDecisionSchema.parse({
    kind: 'DETERMINISTIC_FINAL',
    riskEvaluation: parsedRiskEvaluation,
    tenantApplicability: parsedTenantApplicability,
    stateFloor: null,
    state: parsedTenantApplicability.status,
    reason: `Tenant applicability is ${parsedTenantApplicability.status} and no risk policy floor is established.`,
  });
}
