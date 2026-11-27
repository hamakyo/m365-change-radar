import {
  StructuredImpactClassificationMergeResultSchema,
  type StructuredImpactClassificationMergeResult,
} from './structured-impact-classification-merge.js';
import {
  StructuredImpactClassificationSchema,
  type StructuredImpactClassification,
} from './structured-impact-classification.js';
import { type RiskStateFloor } from './risk-policy.js';
import { type ImpactAssessment } from './impact-assessment.js';

const acceptedReason =
  'The classifier proposal satisfies the deterministic floor.';
const raisedReason =
  'The deterministic risk floor raised the classifier proposal.';

function floorAcceptsState(
  floor: RiskStateFloor | null,
  proposedState: ImpactAssessment['state'],
): boolean {
  if (floor === null) return true;
  if (floor === 'ACTION_REQUIRED') {
    return proposedState === 'ACTION_REQUIRED';
  }
  return (
    proposedState === 'ACTION_REQUIRED' || proposedState === 'REVIEW_REQUIRED'
  );
}

function assessmentForAcceptedProposal(
  classification: StructuredImpactClassification,
): ImpactAssessment {
  const output = classification.output;
  if (output.proposedState === 'INSUFFICIENT_CONTEXT') {
    return {
      state: output.proposedState,
      reason: output.reason,
      missingContext: [...output.missingContext],
    };
  }

  return {
    state: output.proposedState,
    reason: output.reason,
    evidence: [...output.supportingEvidenceIds],
  };
}

function mergeEvidence(
  guardrailEvidenceIds: readonly string[],
  supportingEvidenceIds: readonly string[],
): string[] {
  return [...new Set([...guardrailEvidenceIds, ...supportingEvidenceIds])];
}

function contributingGuardrailEvidenceIds(
  classification: StructuredImpactClassification,
): string[] {
  const decision = classification.request.decision;
  if (decision.kind !== 'GUARDRAIL_FLOOR') {
    throw new Error('GUARDRAIL_RAISED requires a GUARDRAIL_FLOOR decision');
  }

  const finalFloor = decision.riskEvaluation.finalStateFloor;
  if (finalFloor === null || decision.stateFloor !== finalFloor) {
    throw new Error('guardrail decision must declare a non-null risk floor');
  }

  const contributingRuleIds = new Set(
    decision.riskEvaluation.ruleResults
      .filter(
        (ruleResult) =>
          ruleResult.status !== 'NO_MATCH' &&
          ruleResult.stateFloor === finalFloor,
      )
      .map((ruleResult) => ruleResult.ruleId),
  );

  const evidenceIds = classification.request.evidenceRecords.flatMap(
    (record) => {
      if (
        record.kind !== 'deterministic_conclusion' ||
        record.policyKind !== 'risk_policy' ||
        record.policyRulesVersion !==
          decision.riskEvaluation.policyRulesVersion ||
        !contributingRuleIds.has(record.ruleId)
      ) {
        return [];
      }
      return [record.evidenceId];
    },
  );

  if (evidenceIds.length === 0) {
    throw new Error('GUARDRAIL_RAISED requires a contributing risk conclusion');
  }
  return evidenceIds;
}

/**
 * Deterministically compares a structured classifier proposal with its
 * already-computed deterministic decision floor.
 */
export function createStructuredImpactClassificationMergeResult(
  classification: StructuredImpactClassification,
): StructuredImpactClassificationMergeResult {
  const parsedClassification =
    StructuredImpactClassificationSchema.parse(classification);
  const decision = parsedClassification.request.decision;
  const stateFloor = decision.stateFloor;
  const proposedState = parsedClassification.output.proposedState;

  if (stateFloor === null || floorAcceptsState(stateFloor, proposedState)) {
    return StructuredImpactClassificationMergeResultSchema.parse({
      outcome: 'CLASSIFIER_ACCEPTED',
      classification: parsedClassification,
      stateFloor,
      mergedImpactAssessment:
        assessmentForAcceptedProposal(parsedClassification),
      reason: acceptedReason,
    });
  }

  const guardrailEvidenceIds =
    contributingGuardrailEvidenceIds(parsedClassification);
  return StructuredImpactClassificationMergeResultSchema.parse({
    outcome: 'GUARDRAIL_RAISED',
    classification: parsedClassification,
    stateFloor,
    mergedImpactAssessment: {
      state: stateFloor,
      reason: raisedReason,
      evidence: mergeEvidence(
        guardrailEvidenceIds,
        parsedClassification.output.supportingEvidenceIds,
      ),
    },
    reason: raisedReason,
    guardrailEvidenceIds,
  });
}
