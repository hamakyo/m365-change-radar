import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ChangeEventSchema,
  DeterministicImpactDecisionSchema,
  ImpactAssessmentSchema,
  RiskPolicySchema,
  StructuredImpactClassificationMergeResultSchema,
  StructuredImpactClassificationSchema,
  TenantApplicabilityPolicySchema,
  TenantProfileSchema,
  createDeterministicImpactDecision,
  createStructuredImpactClassificationMergeResult,
  createStructuredImpactClassificationRequest,
  evaluateRiskPolicy,
  evaluateTenantApplicability,
  type ChangeEvent,
  type DeterministicImpactDecision,
  type StructuredImpactClassification,
  type StructuredImpactClassificationMergeResult,
  type TenantProfile,
} from '../src/index.js';

function readJson(path: string): unknown {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), path), 'utf8'),
  ) as unknown;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const riskPolicy = RiskPolicySchema.parse(
  readJson('test/fixtures/risk-policy.json'),
);
const tenantPolicy = TenantApplicabilityPolicySchema.parse(
  readJson('test/fixtures/tenant-applicability-policy.json'),
);
const baseEvent = ChangeEventSchema.parse(
  readJson('test/fixtures/change-event.json'),
);
const baseProfile = TenantProfileSchema.parse(
  readJson('test/fixtures/tenant-profile.json'),
);

function eventWith(overrides: Record<string, unknown>): ChangeEvent {
  return ChangeEventSchema.parse({
    ...baseEvent,
    products: ['Synthetic Teams'],
    ...overrides,
  });
}

function decisionFor(
  event: ChangeEvent,
  profile: TenantProfile = baseProfile,
): DeterministicImpactDecision {
  return DeterministicImpactDecisionSchema.parse(
    createDeterministicImpactDecision(
      evaluateRiskPolicy(riskPolicy, event),
      evaluateTenantApplicability(tenantPolicy, event, profile),
    ),
  );
}

function classificationFor(
  event: ChangeEvent,
  decision: DeterministicImpactDecision,
  proposedState:
    | 'ACTION_REQUIRED'
    | 'REVIEW_REQUIRED'
    | 'INFORMATIONAL'
    | 'NOT_APPLICABLE'
    | 'INSUFFICIENT_CONTEXT',
): StructuredImpactClassification {
  const request = createStructuredImpactClassificationRequest(
    event,
    'message-v1',
    baseProfile,
    decision,
  );
  const output = {
    proposedState,
    confidence: 0.75,
    reason: `Classifier proposed ${proposedState}.`,
    affectedComponents: ['Synthetic Teams'],
    supportingEvidenceIds: ['source.event.title'],
    ...(proposedState === 'INSUFFICIENT_CONTEXT'
      ? { missingContext: ['services.teams'] }
      : {}),
  } as const;
  return StructuredImpactClassificationSchema.parse({ request, output });
}

function riskConclusionIdFor(
  classification: StructuredImpactClassification,
  predicate: (
    result: DeterministicImpactDecision['riskEvaluation']['ruleResults'][number],
  ) => boolean,
): string {
  const decision = classification.request.decision;
  const record = classification.request.evidenceRecords.find(
    (candidate) =>
      candidate.kind === 'deterministic_conclusion' &&
      candidate.policyKind === 'risk_policy' &&
      decision.riskEvaluation.ruleResults.some(
        (ruleResult) =>
          ruleResult.ruleId === candidate.ruleId && predicate(ruleResult),
      ),
  );
  if (record === undefined) throw new Error('missing risk conclusion');
  return record.evidenceId;
}

function guardrailEvidenceId(
  classification: StructuredImpactClassification,
): string {
  const decision = classification.request.decision;
  if (decision.kind !== 'GUARDRAIL_FLOOR') {
    throw new Error('guardrail evidence requires a guardrail decision');
  }
  return riskConclusionIdFor(
    classification,
    (ruleResult) =>
      ruleResult.status !== 'NO_MATCH' &&
      ruleResult.stateFloor === decision.stateFloor,
  );
}

function acceptedResult(
  classification: StructuredImpactClassification,
): Extract<
  StructuredImpactClassificationMergeResult,
  { outcome: 'CLASSIFIER_ACCEPTED' }
> {
  const output = classification.output;
  const assessment =
    output.proposedState === 'INSUFFICIENT_CONTEXT'
      ? {
          state: 'INSUFFICIENT_CONTEXT' as const,
          reason: output.reason,
          missingContext: output.missingContext,
        }
      : {
          state: output.proposedState,
          reason: output.reason,
          evidence: output.supportingEvidenceIds,
        };
  return StructuredImpactClassificationMergeResultSchema.parse({
    outcome: 'CLASSIFIER_ACCEPTED',
    classification,
    stateFloor: classification.request.decision.stateFloor,
    mergedImpactAssessment: assessment,
    reason: output.reason,
  }) as Extract<
    StructuredImpactClassificationMergeResult,
    { outcome: 'CLASSIFIER_ACCEPTED' }
  >;
}

function raisedResult(
  classification: StructuredImpactClassification,
): Extract<
  StructuredImpactClassificationMergeResult,
  { outcome: 'GUARDRAIL_RAISED' }
> {
  const decision = classification.request.decision;
  if (decision.kind !== 'GUARDRAIL_FLOOR') {
    throw new Error('raised test input must have a guardrail floor');
  }
  const conclusionId = guardrailEvidenceId(classification);
  const reason = 'The deterministic risk floor raised the classifier proposal.';
  return StructuredImpactClassificationMergeResultSchema.parse({
    outcome: 'GUARDRAIL_RAISED',
    classification,
    stateFloor: decision.stateFloor,
    mergedImpactAssessment: {
      state: decision.stateFloor,
      reason,
      evidence: [conclusionId, ...classification.output.supportingEvidenceIds],
    },
    reason,
    guardrailEvidenceIds: [conclusionId],
  }) as Extract<
    StructuredImpactClassificationMergeResult,
    { outcome: 'GUARDRAIL_RAISED' }
  >;
}

const classificationEvent = eventWith({
  severity: 'low',
  signals: { ...baseEvent.signals, hasAdminImpact: false },
});
const reviewFloorEvent = eventWith({
  severity: 'high',
  signals: {
    ...baseEvent.signals,
    isMajorChange: true,
    hasAdminImpact: false,
  },
});
const actionFloorEvent = eventWith({
  severity: 'high',
  signals: {
    ...baseEvent.signals,
    isMajorChange: true,
    hasAdminImpact: true,
  },
});
const classificationDecision = decisionFor(classificationEvent);
const reviewFloorDecision = decisionFor(reviewFloorEvent);
const actionFloorDecision = decisionFor(actionFloorEvent);

describe('structured classification merge contract', () => {
  it('accepts the complete 15-state floor comparison matrix with one outcome per pair', () => {
    const allStates = [
      'ACTION_REQUIRED',
      'REVIEW_REQUIRED',
      'INFORMATIONAL',
      'NOT_APPLICABLE',
      'INSUFFICIENT_CONTEXT',
    ] as const;
    const matrix = [
      { event: classificationEvent, decision: classificationDecision },
      { event: reviewFloorEvent, decision: reviewFloorDecision },
      { event: actionFloorEvent, decision: actionFloorDecision },
    ];

    expect(matrix).toHaveLength(3);
    matrix.forEach(({ event, decision }) => {
      allStates.forEach((proposedState) => {
        const classification = classificationFor(
          event,
          decision,
          proposedState,
        );
        const accepted =
          decision.stateFloor === null ||
          (decision.stateFloor === 'REVIEW_REQUIRED' &&
            (proposedState === 'ACTION_REQUIRED' ||
              proposedState === 'REVIEW_REQUIRED')) ||
          (decision.stateFloor === 'ACTION_REQUIRED' &&
            proposedState === 'ACTION_REQUIRED');

        if (accepted) {
          const result = acceptedResult(classification);
          expect(result.outcome).toBe('CLASSIFIER_ACCEPTED');
          expect(result.mergedImpactAssessment.state).toBe(proposedState);
        } else {
          const result = raisedResult(classification);
          expect(result.outcome).toBe('GUARDRAIL_RAISED');
          expect(result.mergedImpactAssessment.state).toBe(decision.stateFloor);
        }
        expect(
          StructuredImpactClassificationMergeResultSchema.parse(
            JSON.parse(
              JSON.stringify(
                accepted
                  ? acceptedResult(classification)
                  : raisedResult(classification),
              ),
            ),
          ),
        ).toEqual(
          accepted
            ? acceptedResult(classification)
            : raisedResult(classification),
        );
      });
    });
  });

  it('copies an accepted classifier assessment without losing state, reason, evidence, or missingContext', () => {
    const states = [
      'ACTION_REQUIRED',
      'REVIEW_REQUIRED',
      'INFORMATIONAL',
      'NOT_APPLICABLE',
    ] as const;
    states.forEach((state) => {
      const classification = classificationFor(
        classificationEvent,
        classificationDecision,
        state,
      );
      const result = acceptedResult(classification);
      expect(result.mergedImpactAssessment).toEqual({
        state,
        reason: classification.output.reason,
        evidence: classification.output.supportingEvidenceIds,
      });
    });

    const insufficient = classificationFor(
      classificationEvent,
      classificationDecision,
      'INSUFFICIENT_CONTEXT',
    );
    if (insufficient.output.proposedState !== 'INSUFFICIENT_CONTEXT') {
      throw new Error('expected an insufficient-context output');
    }
    expect(acceptedResult(insufficient).mergedImpactAssessment).toEqual({
      state: 'INSUFFICIENT_CONTEXT',
      reason: insufficient.output.reason,
      missingContext: insufficient.output.missingContext,
    });
  });

  it('retains the floor and the exact guardrail/classifier evidence union when raised', () => {
    const classification = classificationFor(
      reviewFloorEvent,
      reviewFloorDecision,
      'INFORMATIONAL',
    );
    const result = raisedResult(classification);
    const conclusionId = guardrailEvidenceId(classification);

    expect(result).toMatchObject({
      outcome: 'GUARDRAIL_RAISED',
      stateFloor: 'REVIEW_REQUIRED',
      guardrailEvidenceIds: [conclusionId],
      mergedImpactAssessment: {
        state: 'REVIEW_REQUIRED',
        reason: result.reason,
        evidence: [conclusionId, 'source.event.title'],
      },
    });
    expect(
      new Set(
        result.mergedImpactAssessment.state === 'INSUFFICIENT_CONTEXT'
          ? []
          : result.mergedImpactAssessment.evidence,
      ),
    ).toEqual(new Set([conclusionId, 'source.event.title']));
  });

  it('rejects a proposed state below the floor marked CLASSIFIER_ACCEPTED', () => {
    const classification = classificationFor(
      reviewFloorEvent,
      reviewFloorDecision,
      'INFORMATIONAL',
    );
    expect(
      StructuredImpactClassificationMergeResultSchema.safeParse({
        outcome: 'CLASSIFIER_ACCEPTED',
        classification,
        stateFloor: 'ACTION_REQUIRED',
        reason: classification.output.reason,
        mergedImpactAssessment: {
          state: 'INFORMATIONAL',
          reason: classification.output.reason,
          evidence: classification.output.supportingEvidenceIds,
        },
      }).success,
    ).toBe(false);
  });

  it('accepts matching and unknown risk conclusions only when they establish the exact final floor', () => {
    const matchingClassification = classificationFor(
      reviewFloorEvent,
      reviewFloorDecision,
      'INFORMATIONAL',
    );
    const matchingResult = raisedResult(matchingClassification);
    expect(matchingResult.guardrailEvidenceIds).toHaveLength(1);

    const unknownRaw: Record<string, unknown> = {
      ...baseEvent,
      products: ['Synthetic Teams'],
    };
    delete unknownRaw.severity;
    delete unknownRaw.signals;
    const unknownEvent = ChangeEventSchema.parse(unknownRaw);
    const unknownDecision = decisionFor(unknownEvent);
    expect(unknownDecision).toMatchObject({
      kind: 'GUARDRAIL_FLOOR',
      stateFloor: 'REVIEW_REQUIRED',
    });
    const unknownClassification = classificationFor(
      unknownEvent,
      unknownDecision,
      'INFORMATIONAL',
    );
    const unknownResult = raisedResult(unknownClassification);
    const unknownConclusion =
      unknownClassification.request.evidenceRecords.find(
        (record) =>
          record.kind === 'deterministic_conclusion' &&
          record.policyKind === 'risk_policy' &&
          unknownDecision.riskEvaluation.ruleResults.some(
            (ruleResult) =>
              ruleResult.ruleId === record.ruleId &&
              ruleResult.status === 'UNKNOWN' &&
              ruleResult.stateFloor === unknownDecision.stateFloor,
          ),
      );
    expect(unknownConclusion).toBeDefined();
    expect(unknownResult.guardrailEvidenceIds).toContain(
      unknownConclusion?.evidenceId,
    );

    const actionClassification = classificationFor(
      actionFloorEvent,
      actionFloorDecision,
      'INFORMATIONAL',
    );
    const actionRaised = raisedResult(actionClassification);
    const reviewFloorConclusion = riskConclusionIdFor(
      actionClassification,
      (ruleResult) =>
        ruleResult.status !== 'NO_MATCH' &&
        ruleResult.stateFloor === 'REVIEW_REQUIRED',
    );
    expect(
      StructuredImpactClassificationMergeResultSchema.safeParse({
        ...actionRaised,
        guardrailEvidenceIds: [reviewFloorConclusion],
        mergedImpactAssessment: {
          ...actionRaised.mergedImpactAssessment,
          evidence: [reviewFloorConclusion, 'source.event.title'],
        },
      }).success,
    ).toBe(false);
  });

  it('rejects GUARDRAIL_RAISED for a null floor, a classification decision, or an accepted proposal', () => {
    const nullFloorClassification = classificationFor(
      classificationEvent,
      classificationDecision,
      'INFORMATIONAL',
    );
    expect(() => raisedResult(nullFloorClassification)).toThrow();

    const acceptedProposal = classificationFor(
      reviewFloorEvent,
      reviewFloorDecision,
      'REVIEW_REQUIRED',
    );
    const conclusionId = guardrailEvidenceId(acceptedProposal);
    expect(
      StructuredImpactClassificationMergeResultSchema.safeParse({
        outcome: 'GUARDRAIL_RAISED',
        classification: acceptedProposal,
        stateFloor: 'REVIEW_REQUIRED',
        reason: 'incorrectly raised',
        guardrailEvidenceIds: [conclusionId],
        mergedImpactAssessment: {
          state: 'REVIEW_REQUIRED',
          reason: 'incorrectly raised',
          evidence: [conclusionId, 'source.event.title'],
        },
      }).success,
    ).toBe(false);
  });

  it('rejects floor, assessment, and outcome inconsistencies', () => {
    const classification = classificationFor(
      reviewFloorEvent,
      reviewFloorDecision,
      'INFORMATIONAL',
    );
    const raised = raisedResult(classification);
    const conclusionId = guardrailEvidenceId(classification);

    expect(
      StructuredImpactClassificationMergeResultSchema.safeParse({
        ...raised,
        stateFloor: 'ACTION_REQUIRED',
      }).success,
    ).toBe(false);
    expect(
      StructuredImpactClassificationMergeResultSchema.safeParse({
        ...raised,
        mergedImpactAssessment: {
          ...raised.mergedImpactAssessment,
          state: 'ACTION_REQUIRED',
        },
      }).success,
    ).toBe(false);
    expect(
      StructuredImpactClassificationMergeResultSchema.safeParse({
        ...raised,
        mergedImpactAssessment: {
          state: 'REVIEW_REQUIRED',
          reason: 'wrong merge reason',
          evidence: [conclusionId, 'source.event.title'],
        },
      }).success,
    ).toBe(false);
  });

  it('requires unique risk conclusion IDs and rejects missing, tenant, or unrelated conclusion evidence', () => {
    const classification = classificationFor(
      reviewFloorEvent,
      reviewFloorDecision,
      'INFORMATIONAL',
    );
    const raised = raisedResult(classification);
    const tenantConclusion = classification.request.evidenceRecords.find(
      (record) =>
        record.kind === 'deterministic_conclusion' &&
        record.policyKind === 'tenant_applicability_policy',
    );
    if (tenantConclusion === undefined)
      throw new Error('missing tenant conclusion');

    expect(
      StructuredImpactClassificationMergeResultSchema.safeParse({
        ...raised,
        guardrailEvidenceIds: [
          raised.guardrailEvidenceIds[0]!,
          raised.guardrailEvidenceIds[0]!,
        ],
      }).success,
    ).toBe(false);
    expect(
      StructuredImpactClassificationMergeResultSchema.safeParse({
        ...raised,
        guardrailEvidenceIds: ['missing.risk.conclusion'],
      }).success,
    ).toBe(false);
    expect(
      StructuredImpactClassificationMergeResultSchema.safeParse({
        ...raised,
        guardrailEvidenceIds: [tenantConclusion.evidenceId],
      }).success,
    ).toBe(false);

    const noMatchConclusion = classification.request.evidenceRecords.find(
      (record) =>
        record.kind === 'deterministic_conclusion' &&
        record.policyKind === 'risk_policy' &&
        reviewFloorDecision.riskEvaluation.ruleResults.some(
          (ruleResult) =>
            ruleResult.ruleId === record.ruleId &&
            ruleResult.status === 'NO_MATCH',
        ),
    );
    if (noMatchConclusion === undefined)
      throw new Error('missing NO_MATCH risk conclusion');
    expect(
      StructuredImpactClassificationMergeResultSchema.safeParse({
        ...raised,
        guardrailEvidenceIds: [noMatchConclusion.evidenceId],
        mergedImpactAssessment: {
          ...raised.mergedImpactAssessment,
          evidence: [noMatchConclusion.evidenceId, 'source.event.title'],
        },
      }).success,
    ).toBe(false);

    const unrelatedRisk = {
      kind: 'deterministic_conclusion' as const,
      evidenceId: 'unrelated.risk.conclusion',
      policyKind: 'risk_policy' as const,
      policyRulesVersion: reviewFloorDecision.riskEvaluation.policyRulesVersion,
      ruleId: 'not-a-rule-result',
      conclusion: 'unrelated',
      dependsOnEvidenceIds: ['source.event.title'],
    };
    const unrelatedClassification = StructuredImpactClassificationSchema.parse({
      ...classification,
      request: {
        ...classification.request,
        evidenceRecords: [
          ...classification.request.evidenceRecords,
          unrelatedRisk,
        ],
      },
    });
    expect(
      StructuredImpactClassificationMergeResultSchema.safeParse({
        ...raised,
        classification: unrelatedClassification,
        guardrailEvidenceIds: [unrelatedRisk.evidenceId],
      }).success,
    ).toBe(false);
  });

  it('rejects assessment evidence that is classifier-only, guardrail-only, duplicated, or contains missingContext after a raise', () => {
    const classification = classificationFor(
      reviewFloorEvent,
      reviewFloorDecision,
      'INFORMATIONAL',
    );
    const raised = raisedResult(classification);
    const conclusionId = guardrailEvidenceId(classification);
    const invalidAssessments = [
      {
        state: 'REVIEW_REQUIRED' as const,
        reason: raised.reason,
        evidence: ['source.event.title'],
      },
      {
        state: 'REVIEW_REQUIRED' as const,
        reason: raised.reason,
        evidence: [conclusionId],
      },
      {
        state: 'REVIEW_REQUIRED' as const,
        reason: raised.reason,
        evidence: ['source.event.title', conclusionId],
      },
      {
        state: 'REVIEW_REQUIRED' as const,
        reason: raised.reason,
        evidence: [conclusionId, 'source.event.title', 'source.event.title'],
      },
      {
        state: 'REVIEW_REQUIRED' as const,
        reason: raised.reason,
        evidence: [conclusionId, 'source.event.title'],
        missingContext: ['services.teams'],
      },
    ];
    invalidAssessments.forEach((mergedImpactAssessment) => {
      expect(
        StructuredImpactClassificationMergeResultSchema.safeParse({
          ...raised,
          mergedImpactAssessment,
        }).success,
      ).toBe(false);
    });
  });

  it('rejects accepted assessments that do not copy output evidence or missingContext', () => {
    const evidenceClassification = classificationFor(
      classificationEvent,
      classificationDecision,
      'REVIEW_REQUIRED',
    );
    const accepted = acceptedResult(evidenceClassification);
    expect(
      StructuredImpactClassificationMergeResultSchema.safeParse({
        ...accepted,
        mergedImpactAssessment: {
          state: 'REVIEW_REQUIRED',
          reason: evidenceClassification.output.reason,
          evidence: ['source.event.body'],
        },
      }).success,
    ).toBe(false);

    const insufficient = classificationFor(
      classificationEvent,
      classificationDecision,
      'INSUFFICIENT_CONTEXT',
    );
    const insufficientResult = acceptedResult(insufficient);
    expect(
      StructuredImpactClassificationMergeResultSchema.safeParse({
        ...insufficientResult,
        mergedImpactAssessment: {
          state: 'INSUFFICIENT_CONTEXT',
          reason: insufficient.output.reason,
          missingContext: ['environment.windows'],
        },
      }).success,
    ).toBe(false);
    expect(
      StructuredImpactClassificationMergeResultSchema.safeParse({
        ...insufficientResult,
        mergedImpactAssessment: {
          state: 'INSUFFICIENT_CONTEXT',
          reason: insufficient.output.reason,
        },
      }).success,
    ).toBe(false);
  });

  it('keeps classifier-only INSUFFICIENT_CONTEXT lossless and rejects tampered missingMappings', () => {
    const insufficient = classificationFor(
      classificationEvent,
      classificationDecision,
      'INSUFFICIENT_CONTEXT',
    );
    if (insufficient.output.proposedState !== 'INSUFFICIENT_CONTEXT') {
      throw new Error('expected an insufficient-context output');
    }

    // The evaluator copies only the fields the output actually owns: the
    // merged assessment must not invent mapping gaps the classifier lacks.
    const result =
      createStructuredImpactClassificationMergeResult(insufficient);
    expect(result.outcome).toBe('CLASSIFIER_ACCEPTED');
    if (result.outcome !== 'CLASSIFIER_ACCEPTED') {
      throw new Error('expected an accepted merge result');
    }
    expect(result.mergedImpactAssessment).toEqual({
      state: 'INSUFFICIENT_CONTEXT',
      reason: insufficient.output.reason,
      missingContext: [...insufficient.output.missingContext],
    });
    expect(result.mergedImpactAssessment).not.toHaveProperty('missingMappings');

    for (const tamperedMissingMappings of [
      [{ field: 'products', value: null }],
      [
        { field: 'products', value: 'Synthetic Teams' },
        { field: 'categories', value: null },
      ],
      [],
    ]) {
      expect(
        StructuredImpactClassificationMergeResultSchema.safeParse({
          ...result,
          mergedImpactAssessment: {
            state: 'INSUFFICIENT_CONTEXT' as const,
            reason: insufficient.output.reason,
            missingContext: [...insufficient.output.missingContext],
            missingMappings: tamperedMissingMappings,
          },
        }).success,
      ).toBe(false);
    }
  });

  it('round-trips all outcomes and rejects strict extras or unknown outcomes', () => {
    const classification = classificationFor(
      reviewFloorEvent,
      reviewFloorDecision,
      'INFORMATIONAL',
    );
    const raised = raisedResult(classification);
    expect(
      StructuredImpactClassificationMergeResultSchema.parse(
        JSON.parse(JSON.stringify(raised)),
      ),
    ).toEqual(raised);

    const accepted = acceptedResult(
      classificationFor(
        classificationEvent,
        classificationDecision,
        'ACTION_REQUIRED',
      ),
    );
    expect(
      StructuredImpactClassificationMergeResultSchema.parse(
        JSON.parse(JSON.stringify(accepted)),
      ),
    ).toEqual(accepted);
    expect(
      StructuredImpactClassificationMergeResultSchema.safeParse({
        ...accepted,
        outcome: 'UNKNOWN',
      }).success,
    ).toBe(false);
    expect(
      StructuredImpactClassificationMergeResultSchema.safeParse({
        ...accepted,
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      StructuredImpactClassificationMergeResultSchema.safeParse({
        ...accepted,
        guardrailEvidenceIds: ['decision.risk.0'],
      }).success,
    ).toBe(false);
  });

  it('keeps nested classification and decision records complete and schema-valid', () => {
    const classification = classificationFor(
      reviewFloorEvent,
      reviewFloorDecision,
      'REVIEW_REQUIRED',
    );
    const result = acceptedResult(classification);
    expect(result.classification.request.decision).toEqual(
      DeterministicImpactDecisionSchema.parse(
        result.classification.request.decision,
      ),
    );
    expect(ImpactAssessmentSchema.parse(result.mergedImpactAssessment)).toEqual(
      result.mergedImpactAssessment,
    );
  });

  it('does not mutate inputs and is deterministic for repeated construction', () => {
    const classification = classificationFor(
      reviewFloorEvent,
      reviewFloorDecision,
      'INFORMATIONAL',
    );
    const input = {
      classification,
      decision: classification.request.decision,
    };
    const before = clone(input);
    const first = raisedResult(classification);
    const second = raisedResult(classification);
    expect(first).toEqual(second);
    expect(input).toEqual(before);
  });
});
