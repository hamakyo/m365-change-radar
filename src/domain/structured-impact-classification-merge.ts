import { z } from 'zod';

import {
  ImpactAssessmentSchema,
  type ImpactAssessment,
} from './impact-assessment.js';
import {
  DeterministicConclusionSchema,
  EvidenceIdSchema,
} from './provenance.js';
import {
  StructuredImpactClassificationSchema,
  type StructuredImpactClassification,
} from './structured-impact-classification.js';
import { RiskStateFloorSchema } from './risk-policy.js';

const nonEmptyString = z.string().min(1);

/** The two mutually exclusive ways a structured proposal can become final. */
export const ClassificationMergeOutcomeSchema = z.enum([
  'CLASSIFIER_ACCEPTED',
  'GUARDRAIL_RAISED',
]);
export type ClassificationMergeOutcome = z.infer<
  typeof ClassificationMergeOutcomeSchema
>;

const uniqueEvidenceIds = z
  .array(EvidenceIdSchema)
  .min(1)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: 'evidence IDs must be unique',
  });

const mergeResultBase = {
  classification: StructuredImpactClassificationSchema,
  stateFloor: RiskStateFloorSchema.nullable(),
  mergedImpactAssessment: ImpactAssessmentSchema,
  reason: nonEmptyString,
};

function floorAcceptsState(
  floor: z.infer<typeof RiskStateFloorSchema> | null,
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

function addIssue(
  context: z.RefinementCtx,
  path: PropertyKey[],
  message: string,
): void {
  context.addIssue({ code: 'custom', path, message });
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function acceptedAssessmentMatchesOutput(
  classification: StructuredImpactClassification,
  assessment: ImpactAssessment,
  context: z.RefinementCtx,
): void {
  const output = classification.output;
  if (assessment.state !== output.proposedState) {
    addIssue(
      context,
      ['mergedImpactAssessment', 'state'],
      'accepted assessment state must equal output proposedState',
    );
  }
  if (assessment.reason !== output.reason) {
    addIssue(
      context,
      ['mergedImpactAssessment', 'reason'],
      'accepted assessment reason must equal output reason',
    );
  }

  if (output.proposedState === 'INSUFFICIENT_CONTEXT') {
    if (assessment.state !== 'INSUFFICIENT_CONTEXT') {
      addIssue(
        context,
        ['mergedImpactAssessment'],
        'accepted insufficient-context assessment must be INSUFFICIENT_CONTEXT',
      );
      return;
    }
    const copiedMissingContext =
      assessment.missingContext !== undefined &&
      sameStrings(assessment.missingContext, output.missingContext);
    if (!copiedMissingContext) {
      addIssue(
        context,
        ['mergedImpactAssessment'],
        'accepted insufficient-context assessment must copy missingContext',
      );
    }
    // Lossless insufficiency ownership: the classifier output carries no
    // mapping-gap field, so an accepted assessment must never invent one.
    if ('missingMappings' in assessment) {
      addIssue(
        context,
        ['mergedImpactAssessment', 'missingMappings'],
        'accepted insufficient-context assessment must not add missingMappings',
      );
    }
    return;
  }

  if (
    assessment.state === 'INSUFFICIENT_CONTEXT' ||
    !sameStrings(assessment.evidence, output.supportingEvidenceIds)
  ) {
    addIssue(
      context,
      ['mergedImpactAssessment'],
      'accepted assessment evidence must copy supportingEvidenceIds',
    );
  }
}

function riskConclusionIds(
  classification: StructuredImpactClassification,
): Set<string> {
  return new Set(
    classification.request.evidenceRecords
      .filter(
        (record): record is z.infer<typeof DeterministicConclusionSchema> =>
          record.kind === 'deterministic_conclusion' &&
          record.policyKind === 'risk_policy',
      )
      .map((record) => record.evidenceId),
  );
}

function mergeEvidence(
  guardrailEvidenceIds: readonly string[],
  supportingEvidenceIds: readonly string[],
): string[] {
  return [...new Set([...guardrailEvidenceIds, ...supportingEvidenceIds])];
}

function raisedEvidenceIsValid(
  classification: StructuredImpactClassification,
  guardrailEvidenceIds: readonly string[],
  assessment: ImpactAssessment,
  context: z.RefinementCtx,
): void {
  const decision = classification.request.decision;
  const riskEvaluation = decision.riskEvaluation;
  const validRiskIds = riskConclusionIds(classification);
  const recordsById = new Map(
    classification.request.evidenceRecords.map((record) => [
      record.evidenceId,
      record,
    ]),
  );

  guardrailEvidenceIds.forEach((evidenceId, index) => {
    const record = recordsById.get(evidenceId);
    if (
      record === undefined ||
      !validRiskIds.has(evidenceId) ||
      record.kind !== 'deterministic_conclusion' ||
      record.policyRulesVersion !== riskEvaluation.policyRulesVersion
    ) {
      addIssue(
        context,
        ['guardrailEvidenceIds', index],
        'guardrail evidence must refer to a risk_policy deterministic conclusion in the request',
      );
      return;
    }
    const contributingRule = riskEvaluation.ruleResults.find(
      (ruleResult) =>
        ruleResult.ruleId === record.ruleId &&
        ruleResult.status !== 'NO_MATCH' &&
        ruleResult.stateFloor === decision.stateFloor,
    );
    if (contributingRule === undefined) {
      addIssue(
        context,
        ['guardrailEvidenceIds', index],
        'guardrail evidence must refer to a risk rule result',
      );
    }
  });

  if (assessment.state === 'INSUFFICIENT_CONTEXT') {
    addIssue(
      context,
      ['mergedImpactAssessment'],
      'guardrail-raised assessment must have a floor state and evidence',
    );
    return;
  }

  const expectedEvidence = mergeEvidence(
    guardrailEvidenceIds,
    classification.output.supportingEvidenceIds,
  );
  if (!sameStrings(assessment.evidence, expectedEvidence)) {
    addIssue(
      context,
      ['mergedImpactAssessment', 'evidence'],
      'raised assessment evidence must be the exact guardrail and classifier evidence union',
    );
  }
  if (new Set(assessment.evidence).size !== assessment.evidence.length) {
    addIssue(
      context,
      ['mergedImpactAssessment', 'evidence'],
      'raised assessment evidence must be unique',
    );
  }
}

const classifierAcceptedSchema = z
  .object({
    outcome: z.literal('CLASSIFIER_ACCEPTED'),
    ...mergeResultBase,
  })
  .strict()
  .superRefine((result, context) => {
    const decision = result.classification.request.decision;
    if (result.stateFloor !== decision.stateFloor) {
      addIssue(
        context,
        ['stateFloor'],
        'stateFloor must equal the deterministic decision stateFloor',
      );
    }
    if (
      !floorAcceptsState(
        result.stateFloor,
        result.classification.output.proposedState,
      )
    ) {
      addIssue(
        context,
        ['outcome'],
        'CLASSIFIER_ACCEPTED requires a proposed state at or above the risk floor',
      );
    }
    acceptedAssessmentMatchesOutput(
      result.classification,
      result.mergedImpactAssessment,
      context,
    );
  });

const guardrailRaisedSchema = z
  .object({
    outcome: z.literal('GUARDRAIL_RAISED'),
    ...mergeResultBase,
    guardrailEvidenceIds: uniqueEvidenceIds,
  })
  .strict()
  .superRefine((result, context) => {
    const decision = result.classification.request.decision;
    if (decision.kind !== 'GUARDRAIL_FLOOR') {
      addIssue(
        context,
        ['outcome'],
        'GUARDRAIL_RAISED requires a GUARDRAIL_FLOOR decision',
      );
    }
    if (result.stateFloor !== decision.stateFloor) {
      addIssue(
        context,
        ['stateFloor'],
        'stateFloor must equal the deterministic decision stateFloor',
      );
    }
    if (
      floorAcceptsState(
        result.stateFloor,
        result.classification.output.proposedState,
      )
    ) {
      addIssue(
        context,
        ['outcome'],
        'GUARDRAIL_RAISED requires a proposed state below the risk floor',
      );
    }

    const assessment = result.mergedImpactAssessment;
    if (
      assessment.state !== result.stateFloor ||
      assessment.reason !== result.reason
    ) {
      addIssue(
        context,
        ['mergedImpactAssessment'],
        'raised assessment must use the deterministic decision floor and merge reason',
      );
    }
    raisedEvidenceIsValid(
      result.classification,
      result.guardrailEvidenceIds,
      assessment,
      context,
    );
  });

/** A strict, JSON-safe record of applying the deterministic risk floor. */
export const StructuredImpactClassificationMergeResultSchema =
  z.discriminatedUnion('outcome', [
    classifierAcceptedSchema,
    guardrailRaisedSchema,
  ]);

export type StructuredImpactClassificationMergeResult = z.infer<
  typeof StructuredImpactClassificationMergeResultSchema
>;
