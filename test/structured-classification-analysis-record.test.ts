import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AnalysisRecordSchema,
  ChangeEventSchema,
  DeterministicImpactDecisionSchema,
  RiskPolicySchema,
  StructuredClassificationAIInferenceSchema,
  StructuredClassificationAnalysisMetadataSchema,
  StructuredImpactClassificationMergeResultSchema,
  StructuredImpactClassificationSchema,
  TenantApplicabilityPolicySchema,
  TenantProfileSchema,
  createDeterministicImpactDecision,
  createStructuredClassificationAnalysisRecord,
  createStructuredImpactClassificationMergeResult,
  createStructuredImpactClassificationRequest,
  evaluateRiskPolicy,
  evaluateTenantApplicability,
  type AIInference,
  type AnalysisRecord,
  type ChangeEvent,
  type DeterministicImpactDecision,
  type StructuredClassificationAnalysisMetadata,
  type StructuredImpactClassification,
  type StructuredImpactClassificationMergeResult,
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

const metadata: StructuredClassificationAnalysisMetadata = {
  analysisId: 'analysis-classification-001',
  tenantId: 'tenant-under-test',
  createdAt: '2026-08-27T09:30:00+09:00',
  inferenceEvidenceId: 'ai.classification-proposal',
  promptVersion: 'prompt-2026-08',
  model: 'gpt-5.6-luna',
  modelVersion: 'gpt-5.6-luna-2026-08-01',
};

type ProposedState =
  | 'ACTION_REQUIRED'
  | 'REVIEW_REQUIRED'
  | 'INFORMATIONAL'
  | 'NOT_APPLICABLE'
  | 'INSUFFICIENT_CONTEXT';

const allStates: ProposedState[] = [
  'ACTION_REQUIRED',
  'REVIEW_REQUIRED',
  'INFORMATIONAL',
  'NOT_APPLICABLE',
  'INSUFFICIENT_CONTEXT',
];

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

/** A no-floor classification-path event (positive signals without a major
 * change) so accepted proposals keep their proposed state. */
const classificationEvent = eventWith({
  severity: 'low',
  signals: { ...baseEvent.signals, hasAdminImpact: false },
});
const classificationDecision = decisionFor(classificationEvent);

/** REVIEW_REQUIRED guardrail floor. */
const reviewFloorEvent = eventWith({
  severity: 'high',
  signals: {
    ...baseEvent.signals,
    isMajorChange: true,
    hasAdminImpact: false,
  },
});
const reviewFloorDecision = decisionFor(reviewFloorEvent);

/** ACTION_REQUIRED guardrail floor. */
const actionFloorEvent = eventWith({
  severity: 'high',
  signals: {
    ...baseEvent.signals,
    isMajorChange: true,
    hasAdminImpact: true,
  },
});
const actionFloorDecision = decisionFor(actionFloorEvent);

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

function mergeFor(
  event: ChangeEvent,
  decision: DeterministicImpactDecision,
  proposedState: ProposedState,
  supportingEvidenceIds?: string[],
): StructuredImpactClassificationMergeResult {
  return createStructuredImpactClassificationMergeResult(
    classificationFor(
      event,
      decision,
      proposedState,
      baseProfile,
      supportingEvidenceIds,
    ),
  );
}

function recordFor(
  mergeResult: StructuredImpactClassificationMergeResult,
  meta: StructuredClassificationAnalysisMetadata = metadata,
): AnalysisRecord {
  return createStructuredClassificationAnalysisRecord(mergeResult, meta);
}

function aiRecordOf(record: AnalysisRecord): AIInference {
  const records = record.provenanceRecords;
  const last = records[records.length - 1];
  if (last === undefined || last.kind !== 'ai_inference') {
    throw new Error('expected a trailing AI inference record');
  }
  return last;
}

describe('createStructuredClassificationAnalysisRecord', () => {
  it('builds schema-valid records for CLASSIFIER_ACCEPTED in all five proposed states', () => {
    // Null floor (classification path) accepts every state.
    allStates.forEach((proposedState) => {
      const record = recordFor(
        mergeFor(classificationEvent, classificationDecision, proposedState),
      );

      expect(record.impactAssessment.state).toBe(proposedState);
      expect(record.versionBundle.ai).toEqual({
        used: true,
        promptVersion: metadata.promptVersion,
        model: metadata.model,
        modelVersion: metadata.modelVersion,
      });
      expect(AnalysisRecordSchema.safeParse(record).success).toBe(true);
    });

    // REVIEW floor accepts ACTION and REVIEW; ACTION floor accepts only
    // ACTION — the two accepted-below-null scenarios at raised floors.
    const actionAcceptedAtReview = recordFor(
      mergeFor(reviewFloorEvent, reviewFloorDecision, 'ACTION_REQUIRED'),
    );
    expect(actionAcceptedAtReview.impactAssessment.state).toBe(
      'ACTION_REQUIRED',
    );
    expect(AnalysisRecordSchema.safeParse(actionAcceptedAtReview).success).toBe(
      true,
    );

    const reviewAcceptedAtReview = recordFor(
      mergeFor(reviewFloorEvent, reviewFloorDecision, 'REVIEW_REQUIRED'),
    );
    expect(reviewAcceptedAtReview.impactAssessment.state).toBe(
      'REVIEW_REQUIRED',
    );
    expect(AnalysisRecordSchema.safeParse(reviewAcceptedAtReview).success).toBe(
      true,
    );

    const actionAcceptedAtAction = recordFor(
      mergeFor(actionFloorEvent, actionFloorDecision, 'ACTION_REQUIRED'),
    );
    expect(actionAcceptedAtAction.impactAssessment.state).toBe(
      'ACTION_REQUIRED',
    );
    expect(AnalysisRecordSchema.safeParse(actionAcceptedAtAction).success).toBe(
      true,
    );
  });

  it('keeps the accepted assessment deep-equal to the merge result assessment', () => {
    allStates.forEach((proposedState) => {
      const mergeResult = mergeFor(
        classificationEvent,
        classificationDecision,
        proposedState,
      );
      expect(mergeResult.outcome).toBe('CLASSIFIER_ACCEPTED');
      const record = recordFor(clone(mergeResult));

      expect(record.impactAssessment).toEqual(
        mergeResult.mergedImpactAssessment,
      );
      if (proposedState === 'INSUFFICIENT_CONTEXT') {
        expect('evidence' in record.impactAssessment).toBe(false);
        expect(
          record.impactAssessment.state === 'INSUFFICIENT_CONTEXT' &&
            record.impactAssessment.missingContext,
        ).toEqual(['services.teams']);
      } else if ('evidence' in record.impactAssessment) {
        expect(record.impactAssessment.evidence).toEqual([
          'source.event.title',
        ]);
      }
      expect(record.provenanceRecords.length).toBe(
        mergeResult.classification.request.evidenceRecords.length + 1,
      );
    });
  });

  it('preserves raised evidence order for GUARDRAIL_RAISED across both floors', () => {
    const supportingIds = ['source.event.title', 'decision.risk.0'];
    [
      { event: reviewFloorEvent, decision: reviewFloorDecision },
      { event: actionFloorEvent, decision: actionFloorDecision },
    ].forEach(({ event, decision }) => {
      (
        ['INFORMATIONAL', 'NOT_APPLICABLE', 'INSUFFICIENT_CONTEXT'] as const
      ).forEach((proposedState) => {
        const mergeResult = mergeFor(
          event,
          decision,
          proposedState,
          supportingIds,
        );
        expect(mergeResult.outcome).toBe('GUARDRAIL_RAISED');
        const record = recordFor(clone(mergeResult));

        expect(record.impactAssessment).toEqual(
          mergeResult.mergedImpactAssessment,
        );
        // Raised state always sits at its deterministic floor.
        expect(record.impactAssessment.state).toBe(
          decision.kind === 'GUARDRAIL_FLOOR' ? decision.stateFloor : null,
        );
        // The AI record's dependencies are exactly the raw output's
        // supporting evidence — never extended with guardrail IDs.
        expect(aiRecordOf(record).dependsOnEvidenceIds).toEqual(supportingIds);

        // The merged evidence union stays untouched in the assessment.
        if (
          mergeResult.mergedImpactAssessment.state !== 'INSUFFICIENT_CONTEXT'
        ) {
          const expectedEvidence = mergeResult.mergedImpactAssessment.evidence;
          expect(expectedEvidence.length).toBeGreaterThan(1);
          // Guardrail IDs lead, in request evidence order.
          expect(expectedEvidence).toContain('decision.risk.0');
        }
      });
    });
  });

  it('appends exactly one structured AI inference after a complete deterministic prefix', () => {
    const mergeResult = mergeFor(
      classificationEvent,
      classificationDecision,
      'REVIEW_REQUIRED',
    );
    const record = recordFor(clone(mergeResult));

    const requestRecords = mergeResult.classification.request.evidenceRecords;
    expect(requestRecords.length).toBeGreaterThan(0);
    record.provenanceRecords.forEach((recordItem, index) => {
      if (index < requestRecords.length) {
        expect(recordItem).toEqual(requestRecords[index]);
      }
    });
    expect(record.provenanceRecords.length).toBe(requestRecords.length + 1);

    const aiInferences = record.provenanceRecords.filter(
      (recordItem) => recordItem.kind === 'ai_inference',
    );
    expect(aiInferences.length).toBe(1);
    expect(aiRecordOf(record)).toEqual(aiInferences[0]);

    // Dependency closure: every AI dependency exists among deterministic IDs.
    const deterministicIds = new Set(
      requestRecords.map(
        (requestRecord: { evidenceId: string }) => requestRecord.evidenceId,
      ),
    );
    aiRecordOf(record).dependsOnEvidenceIds.forEach((id) => {
      expect(deterministicIds.has(id)).toBe(true);
    });
    // And the deterministic prefix already closed over itself.
    requestRecords.forEach((requestRecord) => {
      if (requestRecord.kind !== 'deterministic_conclusion') return;
      requestRecord.dependsOnEvidenceIds.forEach((id) => {
        expect(deterministicIds.has(id)).toBe(true);
      });
    });
  });

  it('owns the AI execution identity and a lossless classification output', () => {
    const mergeResult = mergeFor(
      reviewFloorEvent,
      reviewFloorDecision,
      'INSUFFICIENT_CONTEXT',
      ['source.event.title'],
    );
    const record = recordFor(clone(mergeResult));
    const aiRecord = aiRecordOf(record);
    const output = mergeResult.classification.output;

    expect(aiRecord.evidenceId).toBe(metadata.inferenceEvidenceId);
    expect(aiRecord.promptVersion).toBe(metadata.promptVersion);
    expect(aiRecord.model).toBe(metadata.model);
    expect(aiRecord.modelVersion).toBe(metadata.modelVersion);
    expect(aiRecord.confidence).toBe(output.confidence);
    expect(aiRecord.inference).toBe(output.reason);
    expect(aiRecord.dependsOnEvidenceIds).toEqual([
      ...output.supportingEvidenceIds,
    ]);
    expect(aiRecord.classificationOutput).toEqual(output);
    // The raise never rewrote the raw proposal carried by the record.
    expect(output.proposedState).toBe('INSUFFICIENT_CONTEXT');
  });

  it('derives versionBundle and changeEventRef from the request and metadata only', () => {
    const mergeResult = mergeFor(
      classificationEvent,
      classificationDecision,
      'INFORMATIONAL',
    );
    const record = recordFor(clone(mergeResult));
    const request = mergeResult.classification.request;

    expect(record.versionBundle.sourceMessageVersion).toBe(
      request.sourceMessageVersion,
    );
    expect(record.versionBundle.tenantProfileVersion).toBe(
      request.tenantProfile.profileVersion,
    );
    expect(record.versionBundle.policyVersions).toEqual({
      riskPolicyRulesVersion:
        request.decision.riskEvaluation.policyRulesVersion,
      tenantApplicabilityPolicyRulesVersion:
        request.decision.tenantApplicability.policyRulesVersion,
    });
    expect(record.changeEventRef).toEqual({
      source: request.changeEvent.source,
      externalId: request.changeEvent.externalId,
      sourceMessageVersion: request.sourceMessageVersion,
    });
    expect(record.analysisId).toBe(metadata.analysisId);
    expect(record.tenantId).toBe(metadata.tenantId);
    expect(record.createdAt).toBe(metadata.createdAt);
  });

  it('converts every merge result of the full 15-state matrix losslessly', () => {
    let converted = 0;
    [
      { event: classificationEvent, decision: classificationDecision },
      { event: reviewFloorEvent, decision: reviewFloorDecision },
      { event: actionFloorEvent, decision: actionFloorDecision },
    ].forEach(({ event, decision }) => {
      allStates.forEach((proposedState) => {
        const mergeResult = mergeFor(event, decision, proposedState);
        const before = clone(mergeResult);
        const record = recordFor(mergeResult);
        converted += 1;

        expect(record.impactAssessment).toEqual(
          mergeResult.mergedImpactAssessment,
        );
        expect(AnalysisRecordSchema.safeParse(record).success).toBe(true);
        expect(
          AnalysisRecordSchema.parse(JSON.parse(JSON.stringify(record))),
        ).toEqual(record);
        expect(mergeResult).toEqual(before);
      });
    });
    expect(converted).toBe(15);
  });

  it('connects every non-final corpus pair through a full conversion', () => {
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

    let converted = 0;
    let skippedFinal = 0;
    events.forEach((event) =>
      profiles.forEach((profile) => {
        const decision = decisionFor(event, profile);
        if (decision.kind === 'DETERMINISTIC_FINAL') {
          skippedFinal += 1;
          return;
        }
        const classification = classificationFor(
          event,
          decision,
          'INFORMATIONAL',
          profile,
        );
        const mergeResult =
          createStructuredImpactClassificationMergeResult(classification);
        const record = recordFor(mergeResult);
        expect(AnalysisRecordSchema.safeParse(record).success).toBe(true);
        expect(record.changeEventRef.externalId).toBe(event.externalId);
        converted += 1;
      }),
    );

    expect(converted + skippedFinal).toBe(500);
    expect(converted).toBeGreaterThan(400);
  }, 60_000);

  it('rejects a duplicate inference evidence ID against deterministic evidence', () => {
    const mergeResult = mergeFor(
      classificationEvent,
      classificationDecision,
      'INFORMATIONAL',
    );
    const firstEvidenceId =
      mergeResult.classification.request.evidenceRecords[0]!.evidenceId;
    expect(() =>
      recordFor(clone(mergeResult), {
        ...metadata,
        inferenceEvidenceId: firstEvidenceId,
      }),
    ).toThrow(/must not collide with a deterministic evidence ID/);
  });

  it('rejects empty, extra-key, and malformed metadata values', () => {
    const mergeResult = mergeFor(
      classificationEvent,
      classificationDecision,
      'INFORMATIONAL',
    );

    (
      [
        'analysisId',
        'tenantId',
        'inferenceEvidenceId',
        'promptVersion',
        'model',
        'modelVersion',
      ] as const
    ).forEach((field) => {
      expect(() =>
        recordFor(clone(mergeResult), { ...metadata, [field]: '' }),
      ).toThrow();
    });

    // Metadata missing any required field fails its strict schema.
    const incompleteMetadata = {
      analysisId: metadata.analysisId,
      tenantId: metadata.tenantId,
      createdAt: metadata.createdAt,
      promptVersion: metadata.promptVersion,
      model: metadata.model,
      modelVersion: metadata.modelVersion,
    };
    expect(
      StructuredClassificationAnalysisMetadataSchema.safeParse(
        incompleteMetadata,
      ).success,
    ).toBe(false);
    // And the builder rejects the incomplete envelope too.
    expect(() =>
      recordFor(
        clone(mergeResult),
        incompleteMetadata as unknown as StructuredClassificationAnalysisMetadata,
      ),
    ).toThrow();

    expect(() =>
      recordFor(clone(mergeResult), {
        ...metadata,
        extraKey: 'nope',
      } as unknown as StructuredClassificationAnalysisMetadata),
    ).toThrow();
  });

  it('carries classificationOutput without a JSON round-trip normalization', () => {
    const proposal = {
      proposedState: 'INSUFFICIENT_CONTEXT',
      confidence: 0,
      reason: 'Raw proposal values are carried verbatim.',
      affectedComponents: ['Synthetic Teams'],
      supportingEvidenceIds: ['source.event.title'],
      missingContext: ['services.teams'],
    } as const;
    // Sanity: the value passes every schema (negative zero is rejected at
    // the schema boundary, so positive zero is the storable zero), so any
    // loss below is caused by JSON serialization, not validation.
    expect(
      StructuredImpactClassificationSchema.safeParse({
        request: createStructuredImpactClassificationRequest(
          classificationEvent,
          'message-v1',
          baseProfile,
          classificationDecision,
        ),
        output: proposal,
      }).success,
    ).toBe(true);
    expect(Object.is(proposal.confidence, 0)).toBe(true);

    const classification = StructuredImpactClassificationSchema.parse({
      request: createStructuredImpactClassificationRequest(
        classificationEvent,
        'message-v1',
        baseProfile,
        classificationDecision,
      ),
      output: proposal,
    });
    const before = structuredClone(classification);
    const mergeResult =
      createStructuredImpactClassificationMergeResult(classification);
    const mergeResultBeforeBuilder = structuredClone(mergeResult);
    const record = recordFor(mergeResult);
    const aiRecord = aiRecordOf(record);
    // Parsing through the structured schema doubles as proof that the
    // appended record is fully valid without any serialization clone.
    const structuredAiRecord =
      StructuredClassificationAIInferenceSchema.parse(aiRecord);

    // The confidence value is kept verbatim by direct ownership (and for
    // +0 even a JSON round trip would be lossless; the builder never
    // serializes either way).
    expect(
      Object.is(structuredAiRecord.classificationOutput.confidence, 0),
    ).toBe(true);
    expect(
      Object.is(JSON.parse(JSON.stringify({ c: proposal.confidence })).c, 0),
    ).toBe(true);
    // Deep-equal to its own source, but never an alias of the merge
    // result's output object: the appended record carries its own
    // validated deep clone.
    expect(structuredAiRecord).toEqual(aiRecord);
    expect(aiRecord.classificationOutput).toEqual(
      mergeResult.classification.output,
    );
    expect(aiRecord.classificationOutput).not.toBe(
      mergeResult.classification.output,
    );
    // The builder mutated nothing: both the classification input and the
    // merge result stay deep-equal to their pre-call snapshots.
    expect(classification).toEqual(before);
    expect(mergeResult).toEqual(mergeResultBeforeBuilder);
    // And re-running the builder on the same input stays deterministic
    // (structuredClone, not JSON.parse(JSON.stringify(...))).
    expect(recordFor(structuredClone(mergeResult))).toEqual(record);
  });

  it('rejects offset-naive and malformed createdAt while accepting valid offsets', () => {
    const mergeResult = mergeFor(
      classificationEvent,
      classificationDecision,
      'INFORMATIONAL',
    );

    ['2026-08-27T09:30:00', '2026-08-27', '1766861400000'].forEach(
      (createdAt) => {
        expect(() =>
          recordFor(clone(mergeResult), { ...metadata, createdAt }),
        ).toThrow();
      },
    );

    expect(
      StructuredClassificationAnalysisMetadataSchema.safeParse({
        ...metadata,
        createdAt: '2026-08-27T00:30:00Z',
      }).success,
    ).toBe(true);
  });

  it('binds each record to its own call metadata without cross-contamination', () => {
    const mergeResult = mergeFor(
      classificationEvent,
      classificationDecision,
      'INFORMATIONAL',
    );
    const recordA = recordFor(clone(mergeResult), metadata);
    const otherMetadata: StructuredClassificationAnalysisMetadata = {
      ...metadata,
      analysisId: 'analysis-classification-002',
      promptVersion: 'prompt-other',
    };
    const recordB = recordFor(clone(mergeResult), otherMetadata);

    expect(aiRecordOf(recordA).promptVersion).toBe(metadata.promptVersion);
    expect(aiRecordOf(recordB).promptVersion).toBe('prompt-other');
    expect(recordA.versionBundle.ai).toEqual({
      used: true,
      promptVersion: metadata.promptVersion,
      model: metadata.model,
      modelVersion: metadata.modelVersion,
    });
    if (recordB.versionBundle.ai.used) {
      expect(recordB.versionBundle.ai.promptVersion).toBe('prompt-other');
    }
  });

  it('rejects tampered request evidence before producing a record', () => {
    const classification = classificationFor(
      reviewFloorEvent,
      reviewFloorDecision,
      'INFORMATIONAL',
    );
    const riskIndex = classification.request.evidenceRecords.findIndex(
      (record) =>
        record.kind === 'deterministic_conclusion' &&
        record.policyKind === 'risk_policy',
    );
    expect(riskIndex).toBeGreaterThanOrEqual(0);
    const riskRecord = classification.request.evidenceRecords[riskIndex];
    if (
      riskRecord === undefined ||
      riskRecord.kind !== 'deterministic_conclusion'
    ) {
      throw new Error('missing risk conclusion');
    }

    const wrongVersion = {
      ...classification,
      request: {
        ...classification.request,
        evidenceRecords: classification.request.evidenceRecords.map(
          (recordItem, index) =>
            index === riskIndex &&
            recordItem.kind === 'deterministic_conclusion'
              ? { ...recordItem, policyRulesVersion: 'third-version' }
              : recordItem,
        ),
      },
    } as StructuredImpactClassification;
    // The tampered classification is rejected before any builder work happens:
    // the evaluator path already throws, and if an unvalidated merge-shaped
    // object were handed over, the builder's own re-parse must reject it too.
    const staleMergeObject = {
      outcome: 'CLASSIFIER_ACCEPTED',
      classification: wrongVersion,
      stateFloor: null,
      mergedImpactAssessment: {
        state: 'INFORMATIONAL',
        reason: 'Classifier proposed INFORMATIONAL.',
        evidence: ['source.event.title'],
      },
      reason: 'Fabricated.',
    };
    expect(() =>
      recordFor(staleMergeObject as StructuredImpactClassificationMergeResult),
    ).toThrow();

    const danglingSupport = {
      ...classification,
      output: {
        ...classification.output,
        supportingEvidenceIds: ['missing.evidence'],
      },
    } as StructuredImpactClassification;
    const danglingMergeObject = {
      outcome: 'CLASSIFIER_ACCEPTED',
      classification: danglingSupport,
      stateFloor: null,
      mergedImpactAssessment: {
        state: 'INFORMATIONAL',
        reason: 'Classifier proposed INFORMATIONAL.',
        evidence: ['missing.evidence'],
      },
      reason: 'Fabricated.',
    };
    expect(() =>
      recordFor(
        danglingMergeObject as StructuredImpactClassificationMergeResult,
      ),
    ).toThrow();

    // And directly calling the public evaluator on tampered input throws too.
    expect(() =>
      createStructuredImpactClassificationMergeResult(wrongVersion),
    ).toThrow();
    expect(() =>
      createStructuredImpactClassificationMergeResult(danglingSupport),
    ).toThrow();
  });

  it('rejects a merge result whose mergedImpactAssessment was altered post-merge', () => {
    const mergeResult = mergeFor(
      classificationEvent,
      classificationDecision,
      'ACTION_REQUIRED',
    );
    const tampered = {
      ...clone(mergeResult),
      mergedImpactAssessment: {
        state: 'REVIEW_REQUIRED',
        reason: 'Rewritten by an untrusted intermediate.',
        evidence: ['source.event.title'],
      },
    } as StructuredImpactClassificationMergeResult;

    expect(() => recordFor(tampered)).toThrow();
  });

  it('rejects dangling AI dependencies introduced on both sides', () => {
    const mergeResult = mergeFor(
      classificationEvent,
      classificationDecision,
      'REVIEW_REQUIRED',
    );
    // A record carrying matching dependency/output edits but no envelope
    // validation cannot exist here; instead prove that even a fully
    // self-consistent fabrication fails when the evidence does not exist.
    const fabricated = {
      outcome: 'CLASSIFIER_ACCEPTED',
      classification: {
        ...clone(mergeResult.classification),
        output: {
          ...clone(mergeResult.classification.output),
          supportingEvidenceIds: [
            ...mergeResult.classification.output.supportingEvidenceIds,
            'ghost.id',
          ],
        },
      },
      stateFloor: null,
      mergedImpactAssessment: clone(mergeResult.mergedImpactAssessment),
      reason: mergeResult.reason,
    };
    expect(() =>
      recordFor(fabricated as StructuredImpactClassificationMergeResult),
    ).toThrow();
  });

  it('is deterministic, non-mutating, and JSON round-trip stable', () => {
    const mergeResult = mergeFor(
      reviewFloorEvent,
      reviewFloorDecision,
      'NOT_APPLICABLE',
      ['source.event.title'],
    );
    const before = clone(mergeResult);
    const metadataBefore = clone(metadata);

    const first = recordFor(mergeResult, metadata);
    const second = recordFor(clone(before), clone(metadataBefore));

    expect(first).toEqual(second);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    expect(
      AnalysisRecordSchema.parse(JSON.parse(JSON.stringify(first))),
    ).toEqual(first);
    expect(mergeResult).toEqual(before);
    expect(metadata).toEqual(metadataBefore);
  });
});

// Re-export-free runtime reference keeping the discriminated-union import used
// for type-level casts of intentionally invalid fixtures.
void StructuredImpactClassificationMergeResultSchema;
void StructuredImpactClassificationSchema;
