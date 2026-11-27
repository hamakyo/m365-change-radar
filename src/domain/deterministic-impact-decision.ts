import { z } from 'zod';

import {
  RiskPolicyEvaluationResultSchema,
  RiskStateFloorSchema,
} from './risk-policy.js';
import { TenantApplicabilityResultSchema } from './tenant-applicability.js';

const nonEmptyString = z.string().min(1);

/** The three mutually exclusive deterministic downstream decisions. */
export const DeterministicImpactDecisionKindSchema = z.enum([
  'GUARDRAIL_FLOOR',
  'CLASSIFICATION_REQUIRED',
  'DETERMINISTIC_FINAL',
]);
export type DeterministicImpactDecisionKind = z.infer<
  typeof DeterministicImpactDecisionKindSchema
>;

const decisionBase = {
  riskEvaluation: RiskPolicyEvaluationResultSchema,
  tenantApplicability: TenantApplicabilityResultSchema,
  reason: nonEmptyString,
};

const GuardrailFloorDecisionSchema = z
  .object({
    kind: z.literal('GUARDRAIL_FLOOR'),
    ...decisionBase,
    stateFloor: RiskStateFloorSchema,
  })
  .strict()
  .superRefine((decision, context) => {
    if (decision.riskEvaluation.finalStateFloor !== decision.stateFloor) {
      context.addIssue({
        code: 'custom',
        path: ['stateFloor'],
        message:
          'GUARDRAIL_FLOOR stateFloor must equal riskEvaluation.finalStateFloor',
      });
    }
  });

const ClassificationRequiredDecisionSchema = z
  .object({
    kind: z.literal('CLASSIFICATION_REQUIRED'),
    ...decisionBase,
    stateFloor: z.null(),
  })
  .strict()
  .superRefine((decision, context) => {
    if (decision.riskEvaluation.finalStateFloor !== null) {
      context.addIssue({
        code: 'custom',
        path: ['riskEvaluation', 'finalStateFloor'],
        message: 'CLASSIFICATION_REQUIRED requires a null risk floor',
      });
    }
    if (decision.tenantApplicability.status !== 'APPLICABLE') {
      context.addIssue({
        code: 'custom',
        path: ['tenantApplicability', 'status'],
        message: 'CLASSIFICATION_REQUIRED requires APPLICABLE tenant context',
      });
    }
  });

const deterministicFinalStateSchema = z.enum([
  'NOT_APPLICABLE',
  'INSUFFICIENT_CONTEXT',
]);

const DeterministicFinalDecisionSchema = z
  .object({
    kind: z.literal('DETERMINISTIC_FINAL'),
    ...decisionBase,
    stateFloor: z.null(),
    state: deterministicFinalStateSchema,
  })
  .strict()
  .superRefine((decision, context) => {
    if (decision.riskEvaluation.finalStateFloor !== null) {
      context.addIssue({
        code: 'custom',
        path: ['riskEvaluation', 'finalStateFloor'],
        message: 'DETERMINISTIC_FINAL requires a null risk floor',
      });
    }

    if (
      decision.tenantApplicability.status !== 'NOT_APPLICABLE' &&
      decision.tenantApplicability.status !== 'INSUFFICIENT_CONTEXT'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['tenantApplicability', 'status'],
        message:
          'DETERMINISTIC_FINAL requires NOT_APPLICABLE or INSUFFICIENT_CONTEXT tenant context',
      });
    }

    if (decision.state !== decision.tenantApplicability.status) {
      context.addIssue({
        code: 'custom',
        path: ['state'],
        message:
          'DETERMINISTIC_FINAL state must equal tenant applicability status',
      });
    }
  });

/**
 * A JSON-safe decision that retains both complete deterministic inputs while
 * selecting exactly one downstream outcome.
 */
export const DeterministicImpactDecisionSchema = z.discriminatedUnion('kind', [
  GuardrailFloorDecisionSchema,
  ClassificationRequiredDecisionSchema,
  DeterministicFinalDecisionSchema,
]);
export type DeterministicImpactDecision = z.infer<
  typeof DeterministicImpactDecisionSchema
>;
