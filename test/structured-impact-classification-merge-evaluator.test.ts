import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ChangeEventSchema,
  DeterministicImpactDecisionSchema,
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
  type TenantProfile,
} from '../src/index.js';

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const riskPolicy = RiskPolicySchema.parse(
  readJson(resolve(process.cwd(), 'test/fixtures/risk-policy.json')),
);
const tenantPolicy = TenantApplicabilityPolicySchema.parse(
  readJson(
    resolve(process.cwd(), 'test/fixtures/tenant-applicability-policy.json'),
  ),
);
const baseEvent = ChangeEventSchema.parse(
  readJson(resolve(process.cwd(), 'test/fixtures/change-event.json')),
);
const baseProfile = TenantProfileSchema.parse(
  readJson(resolve(process.cwd(), 'test/fixtures/tenant-profile.json')),
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

type ProposedState =
  | 'ACTION_REQUIRED'
  | 'REVIEW_REQUIRED'
  | 'INFORMATIONAL'
  | 'NOT_APPLICABLE'
  | 'INSUFFICIENT_CONTEXT';

function classificationFor(
  event: ChangeEvent,
  decision: DeterministicImpactDecision,
  proposedState: ProposedState,
  profile: TenantProfile = baseProfile,
  supportingEvidenceIds: string[] = ['source.event.title'],
): StructuredImpactClassification {
  const request = createStructuredImpactClassificationRequest(
    event,
    'message-v1',
    profile,
    decision,
  );
  return StructuredImpactClassificationSchema.parse({
    request,
    output: {
      proposedState,
      confidence: 0.75,
      reason: `Classifier proposed ${proposedState}.`,
      affectedComponents: ['Synthetic Teams'],
      supportingEvidenceIds,
      ...(proposedState === 'INSUFFICIENT_CONTEXT'
        ? { missingContext: ['services.teams'] }
        : {}),
    },
  });
}

function contributingRiskIds(
  classification: StructuredImpactClassification,
): string[] {
  const decision = classification.request.decision;
  if (decision.kind !== 'GUARDRAIL_FLOOR') {
    throw new Error('expected a guardrail decision');
  }
  const ruleIds = new Set(
    decision.riskEvaluation.ruleResults
      .filter(
        (result) =>
          result.status !== 'NO_MATCH' &&
          result.stateFloor === decision.riskEvaluation.finalStateFloor,
      )
      .map((result) => result.ruleId),
  );
  return classification.request.evidenceRecords.flatMap((record) =>
    record.kind === 'deterministic_conclusion' &&
    record.policyKind === 'risk_policy' &&
    record.policyRulesVersion === decision.riskEvaluation.policyRulesVersion &&
    ruleIds.has(record.ruleId)
      ? [record.evidenceId]
      : [],
  );
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

describe('structured classification merge evaluator', () => {
  it('evaluates the complete 15-state floor comparison matrix', () => {
    const states: ProposedState[] = [
      'ACTION_REQUIRED',
      'REVIEW_REQUIRED',
      'INFORMATIONAL',
      'NOT_APPLICABLE',
      'INSUFFICIENT_CONTEXT',
    ];
    const matrix = [
      { event: classificationEvent, decision: classificationDecision },
      { event: reviewFloorEvent, decision: reviewFloorDecision },
      { event: actionFloorEvent, decision: actionFloorDecision },
    ];

    matrix.forEach(({ event, decision }) => {
      states.forEach((proposedState) => {
        const classification = classificationFor(
          event,
          decision,
          proposedState,
        );
        const result =
          createStructuredImpactClassificationMergeResult(classification);
        const accepted =
          decision.stateFloor === null ||
          (decision.stateFloor === 'REVIEW_REQUIRED' &&
            (proposedState === 'ACTION_REQUIRED' ||
              proposedState === 'REVIEW_REQUIRED')) ||
          (decision.stateFloor === 'ACTION_REQUIRED' &&
            proposedState === 'ACTION_REQUIRED');

        expect(result.outcome).toBe(
          accepted ? 'CLASSIFIER_ACCEPTED' : 'GUARDRAIL_RAISED',
        );
        expect(result.stateFloor).toBe(decision.stateFloor);
        expect(result.classification).toEqual(classification);
        expect(
          StructuredImpactClassificationMergeResultSchema.parse(
            JSON.parse(JSON.stringify(result)),
          ),
        ).toEqual(result);
      });
    });
  });

  it('copies every accepted proposal losslessly and uses a deterministic reason', () => {
    const states: ProposedState[] = [
      'ACTION_REQUIRED',
      'REVIEW_REQUIRED',
      'INFORMATIONAL',
      'NOT_APPLICABLE',
      'INSUFFICIENT_CONTEXT',
    ];
    states.forEach((proposedState) => {
      const classification = classificationFor(
        classificationEvent,
        classificationDecision,
        proposedState,
      );
      const before = clone(classification);
      const first =
        createStructuredImpactClassificationMergeResult(classification);
      const second =
        createStructuredImpactClassificationMergeResult(classification);

      expect(first.outcome).toBe('CLASSIFIER_ACCEPTED');
      expect(first.reason).toBeTruthy();
      expect(first.reason).toBe(second.reason);
      expect(first.mergedImpactAssessment).toEqual(
        classification.output.proposedState === 'INSUFFICIENT_CONTEXT'
          ? {
              state: proposedState,
              reason: classification.output.reason,
              missingContext: classification.output.missingContext,
            }
          : {
              state: proposedState,
              reason: classification.output.reason,
              evidence: classification.output.supportingEvidenceIds,
            },
      );
      expect(classification).toEqual(before);
      expect(first).toEqual(second);
    });
  });

  it('raises below-floor proposals with every contributing risk conclusion in request order', () => {
    const classification = classificationFor(
      reviewFloorEvent,
      reviewFloorDecision,
      'INFORMATIONAL',
      baseProfile,
      ['source.event.title', 'decision.risk.0'],
    );
    const expectedGuardrailIds = contributingRiskIds(classification);
    expect(expectedGuardrailIds.length).toBeGreaterThan(1);

    const result =
      createStructuredImpactClassificationMergeResult(classification);
    expect(result.outcome).toBe('GUARDRAIL_RAISED');
    if (result.outcome !== 'GUARDRAIL_RAISED') {
      throw new Error('expected guardrail result');
    }
    expect(result.guardrailEvidenceIds).toEqual(expectedGuardrailIds);
    expect(result.mergedImpactAssessment).toEqual({
      state: 'REVIEW_REQUIRED',
      reason: result.reason,
      evidence: [...expectedGuardrailIds, 'source.event.title'],
    });
    expect(result.reason).toBe(
      'The deterministic risk floor raised the classifier proposal.',
    );
  });

  it('raises an INSUFFICIENT_CONTEXT proposal and preserves UNKNOWN contributors', () => {
    const rawEvent: Record<string, unknown> = {
      ...baseEvent,
      products: ['Synthetic Teams'],
    };
    delete rawEvent.severity;
    delete rawEvent.signals;
    const unknownEvent = ChangeEventSchema.parse(rawEvent);
    const unknownDecision = decisionFor(unknownEvent);
    expect(unknownDecision).toMatchObject({
      kind: 'GUARDRAIL_FLOOR',
      stateFloor: 'REVIEW_REQUIRED',
    });

    const classification = classificationFor(
      unknownEvent,
      unknownDecision,
      'INSUFFICIENT_CONTEXT',
    );
    const expectedGuardrailIds = contributingRiskIds(classification);
    const result =
      createStructuredImpactClassificationMergeResult(classification);

    expect(result.outcome).toBe('GUARDRAIL_RAISED');
    if (result.outcome !== 'GUARDRAIL_RAISED') {
      throw new Error('expected guardrail result');
    }
    expect(result.guardrailEvidenceIds).toEqual(expectedGuardrailIds);
    expect(result.mergedImpactAssessment).toEqual({
      state: 'REVIEW_REQUIRED',
      reason: result.reason,
      evidence: [...expectedGuardrailIds, 'source.event.title'],
    });
  });

  it('rejects a raised result when no contributing conclusion remains', () => {
    const classification = classificationFor(
      reviewFloorEvent,
      reviewFloorDecision,
      'INFORMATIONAL',
    );
    const withoutRiskConclusions = {
      ...classification,
      request: {
        ...classification.request,
        evidenceRecords: classification.request.evidenceRecords.filter(
          (record) =>
            !(
              record.kind === 'deterministic_conclusion' &&
              record.policyKind === 'risk_policy'
            ),
        ),
      },
    } as StructuredImpactClassification;

    expect(() =>
      createStructuredImpactClassificationMergeResult(withoutRiskConclusions),
    ).toThrow(/contributing risk conclusion/);
  });

  it('parses and rejects tampered input before producing a merge result', () => {
    const classification = classificationFor(
      reviewFloorEvent,
      reviewFloorDecision,
      'INFORMATIONAL',
    );
    const riskRecordIndex = classification.request.evidenceRecords.findIndex(
      (record) =>
        record.kind === 'deterministic_conclusion' &&
        record.policyKind === 'risk_policy',
    );
    expect(riskRecordIndex).toBeGreaterThanOrEqual(0);
    const riskRecord = classification.request.evidenceRecords[riskRecordIndex];
    if (riskRecord === undefined) throw new Error('missing risk conclusion');

    const wrongVersion = {
      ...classification,
      request: {
        ...classification.request,
        evidenceRecords: classification.request.evidenceRecords.map(
          (record, index) =>
            index === riskRecordIndex &&
            record.kind === 'deterministic_conclusion'
              ? { ...record, policyRulesVersion: 'third-version' }
              : record,
        ),
      },
    } as StructuredImpactClassification;
    expect(() =>
      createStructuredImpactClassificationMergeResult(wrongVersion),
    ).toThrow();

    const duplicateEvidence = {
      ...classification,
      request: {
        ...classification.request,
        evidenceRecords: [
          ...classification.request.evidenceRecords,
          classification.request.evidenceRecords[0]!,
        ],
      },
    } as StructuredImpactClassification;
    expect(() =>
      createStructuredImpactClassificationMergeResult(duplicateEvidence),
    ).toThrow();

    const danglingSupport = {
      ...classification,
      output: {
        ...classification.output,
        supportingEvidenceIds: ['missing.evidence'],
      },
    } as StructuredImpactClassification;
    expect(() =>
      createStructuredImpactClassificationMergeResult(danglingSupport),
    ).toThrow();
  });

  it('rejects DETERMINISTIC_FINAL input at the classifier boundary', () => {
    const classification = classificationFor(
      classificationEvent,
      classificationDecision,
      'INFORMATIONAL',
    );
    const finalDecision = {
      ...classification.request.decision,
      kind: 'DETERMINISTIC_FINAL',
      state: 'NOT_APPLICABLE',
    } as unknown as DeterministicImpactDecision;
    const invalid = {
      ...classification,
      request: { ...classification.request, decision: finalDecision },
    } as StructuredImpactClassification;
    expect(() =>
      createStructuredImpactClassificationMergeResult(invalid),
    ).toThrow();
  });

  it('connects the evaluator to every non-final corpus change/profile pair', () => {
    const changeDirectory = resolve(process.cwd(), 'corpus/changes');
    const profileDirectory = resolve(process.cwd(), 'corpus/tenant-profiles');
    const events = readdirSync(changeDirectory)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => {
        const fixture = readJson(join(changeDirectory, name)) as {
          event: unknown;
        };
        return ChangeEventSchema.parse(fixture.event);
      });
    const profiles = readdirSync(profileDirectory)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => {
        const fixture = readJson(join(profileDirectory, name)) as {
          profile: unknown;
        };
        return TenantProfileSchema.parse(fixture.profile);
      });

    let evaluated = 0;
    let skippedFinal = 0;
    events.forEach((event) =>
      profiles.forEach((profile) => {
        const decision = decisionFor(event, profile);
        if (decision.kind === 'DETERMINISTIC_FINAL') {
          skippedFinal += 1;
          return;
        }
        const request = createStructuredImpactClassificationRequest(
          event,
          'message-v1',
          profile,
          decision,
        );
        const classification = StructuredImpactClassificationSchema.parse({
          request,
          output: {
            proposedState: 'INFORMATIONAL',
            confidence: 0.5,
            reason: 'Corpus evaluator proposal.',
            affectedComponents: [],
            supportingEvidenceIds: ['source.event.title'],
          },
        });
        const result =
          createStructuredImpactClassificationMergeResult(classification);
        expect(result.classification.request.changeEvent).toEqual(event);
        expect(result.classification.request.tenantProfile).toEqual(profile);
        evaluated += 1;
      }),
    );

    expect(evaluated).toBe(500 - skippedFinal);
    expect(evaluated).toBeGreaterThan(0);
    expect(skippedFinal).toBeGreaterThan(0);
  });
});
