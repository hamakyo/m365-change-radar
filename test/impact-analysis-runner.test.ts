import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AnalysisRecordSchema,
  ChangeEventSchema,
  DeterministicImpactDecisionSchema,
  RiskPolicySchema,
  StructuredClassificationAIInferenceSchema,
  StructuredImpactClassificationSchema,
  TenantApplicabilityPolicySchema,
  TenantProfileSchema,
  createDeterministicImpactDecision,
  createImpactAnalysisRecord,
  createStructuredImpactClassificationRequest,
  evaluateRiskPolicy,
  evaluateTenantApplicability,
  type AnalysisRecord,
  type ChangeEvent,
  type DeterministicImpactDecision,
  type ImpactAnalysisMetadata,
  type StructuredClassificationAIInference,
  type StructuredImpactClassificationRequest,
  type StructuredImpactClassifier,
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

const metadata: ImpactAnalysisMetadata = {
  analysisId: 'analysis-runner-001',
  tenantId: 'tenant-under-test',
  createdAt: '2026-08-28T09:30:00+09:00',
};

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

/** Fully reported, clearly negative signals keep the risk policy from
 * establishing any floor so tenant-side finals can be isolated. */
const calmSignals = {
  isMajorChange: false,
  actionRequiredBy: null,
  hasAdminImpact: false,
  isRetirementOrDeprecation: false,
  hasSecurityImpact: false,
  hasPrivacyImpact: false,
  hasComplianceImpact: false,
  tags: [],
} as const;

function finalEvent(): ChangeEvent {
  return eventWith({
    severity: 'low',
    signals: calmSignals,
    products: ['Synthetic Teams'],
    categories: [],
  });
}

/** A no-floor classification-path event (positive signals without a major
 * change) so accepted proposals keep their proposed state. */
const classificationEvent = eventWith({
  severity: 'low',
  signals: { ...baseEvent.signals, hasAdminImpact: false },
});

/** REVIEW_REQUIRED guardrail floor. */
const reviewFloorEvent = eventWith({
  severity: 'high',
  signals: {
    ...baseEvent.signals,
    isMajorChange: true,
    hasAdminImpact: false,
  },
});

/** ACTION_REQUIRED guardrail floor. */
const actionFloorEvent = eventWith({
  severity: 'high',
  signals: {
    ...baseEvent.signals,
    isMajorChange: true,
    hasAdminImpact: true,
  },
});

function finalProfileWithTeamsEnabled(): TenantProfile {
  return baseProfile;
}

function notApplicableProfile(): TenantProfile {
  return TenantProfileSchema.parse({
    ...baseProfile,
    services: { ...baseProfile.services, teams: false },
  });
}

type ProposedState =
  | 'ACTION_REQUIRED'
  | 'REVIEW_REQUIRED'
  | 'INFORMATIONAL'
  | 'NOT_APPLICABLE'
  | 'INSUFFICIENT_CONTEXT';

function outputFor(
  proposedState: ProposedState,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    proposedState,
    confidence: 0.75,
    reason: `Classifier proposed ${proposedState}.`,
    affectedComponents: ['Synthetic Teams'],
    supportingEvidenceIds: ['source.event.title'],
    ...(proposedState === 'INSUFFICIENT_CONTEXT'
      ? { missingContext: ['services.teams'] }
      : {}),
    ...overrides,
  };
}

/**
 * Faithful stub classifier: builds the AI record exactly the way a provider
 * adapter would — the execution identity lives on the record, and the
 * ownership triple (confidence, reason, ordered dependencies) mirrors the
 * bundled raw proposal.
 */
function classifierFor(
  proposedState: ProposedState,
  overrides: {
    output?: Record<string, unknown>;
    evidenceId?: string;
    promptVersion?: string;
    model?: string;
    modelVersion?: string;
    confidence?: number;
  } = {},
): StructuredImpactClassifier & {
  calls: StructuredImpactClassificationRequest[];
} {
  const output = overrides.output ?? outputFor(proposedState);
  const inference: StructuredClassificationAIInference = {
    kind: 'ai_inference',
    evidenceId: overrides.evidenceId ?? 'ai.classification-proposal',
    promptVersion: overrides.promptVersion ?? 'prompt-2026-08',
    model: overrides.model ?? 'gpt-5.6-luna',
    modelVersion: overrides.modelVersion ?? 'gpt-5.6-luna-2026-08-01',
    confidence: overrides.confidence ?? (output.confidence as number),
    inference: output.reason as string,
    dependsOnEvidenceIds: [...(output.supportingEvidenceIds as string[])],
    classificationOutput:
      output as StructuredClassificationAIInference['classificationOutput'],
  };
  const calls: StructuredImpactClassificationRequest[] = [];
  const classifier = (async (
    request: StructuredImpactClassificationRequest,
  ) => {
    calls.push(request);
    return inference;
  }) as StructuredImpactClassifier & {
    calls: StructuredImpactClassificationRequest[];
  };
  classifier.calls = calls;
  return classifier;
}

async function recordFor(
  event: ChangeEvent,
  proposedState: ProposedState,
  classifier = classifierFor(proposedState),
  profile: TenantProfile = baseProfile,
): Promise<AnalysisRecord> {
  return createImpactAnalysisRecord(
    event,
    'message-v1',
    profile,
    riskPolicy,
    tenantPolicy,
    metadata,
    classifier,
  );
}

function aiRecordOf(
  record: AnalysisRecord,
): StructuredClassificationAIInference {
  const records = record.provenanceRecords;
  const last = records[records.length - 1];
  if (last === undefined || last.kind !== 'ai_inference') {
    throw new Error('expected a trailing AI inference record');
  }
  // Re-parsing asserts the appended record satisfies the strict structured
  // contract (proposal mandatory, ownership triple intact) and hands the
  // test a validated view.
  return StructuredClassificationAIInferenceSchema.parse(last);
}

describe('createImpactAnalysisRecord — deterministic final branch', () => {
  it('delegates NOT_APPLICABLE finals with zero classifier calls and a no-AI record', async () => {
    const classifier = classifierFor('INFORMATIONAL');
    const record = await createImpactAnalysisRecord(
      finalEvent(),
      'message-v1',
      notApplicableProfile(),
      riskPolicy,
      tenantPolicy,
      metadata,
      classifier,
    );

    expect(decisionFor(finalEvent(), notApplicableProfile()).kind).toBe(
      'DETERMINISTIC_FINAL',
    );
    expect(classifier.calls.length).toBe(0);
    expect(record.versionBundle.ai).toEqual({ used: false });
    expect(record.impactAssessment.state).toBe('NOT_APPLICABLE');
    expect(AnalysisRecordSchema.safeParse(record).success).toBe(true);
  });

  it('delegates INSUFFICIENT_CONTEXT finals with zero classifier calls', async () => {
    const classifier = classifierFor('INFORMATIONAL');
    const profile = TenantProfileSchema.parse({
      ...baseProfile,
      services: Object.fromEntries(
        Object.entries(baseProfile.services).filter(([key]) => key !== 'teams'),
      ),
    });
    const record = await createImpactAnalysisRecord(
      finalEvent(),
      'message-v1',
      profile,
      riskPolicy,
      tenantPolicy,
      metadata,
      classifier,
    );

    expect(classifier.calls.length).toBe(0);
    expect(record.versionBundle.ai).toEqual({ used: false });
    expect(record.impactAssessment.state).toBe('INSUFFICIENT_CONTEXT');
    expect(AnalysisRecordSchema.safeParse(record).success).toBe(true);
  });

  it('carries the caller metadata verbatim on the final branch', async () => {
    const record = await createImpactAnalysisRecord(
      finalEvent(),
      'message-v1',
      notApplicableProfile(),
      riskPolicy,
      tenantPolicy,
      metadata,
      classifierFor('INFORMATIONAL'),
    );

    expect(record.analysisId).toBe(metadata.analysisId);
    expect(record.tenantId).toBe(metadata.tenantId);
    expect(record.createdAt).toBe(metadata.createdAt);
    expect(record.versionBundle).toEqual({
      sourceMessageVersion: 'message-v1',
      tenantProfileVersion: notApplicableProfile().profileVersion,
      policyVersions: {
        riskPolicyRulesVersion: riskPolicy.policyRulesVersion,
        tenantApplicabilityPolicyRulesVersion: tenantPolicy.policyRulesVersion,
      },
      ai: { used: false },
    });
  });

  it('rejects extra metadata keys uniformly before evaluation on the final branch', async () => {
    await expect(
      createImpactAnalysisRecord(
        finalEvent(),
        'message-v1',
        notApplicableProfile(),
        riskPolicy,
        tenantPolicy,
        {
          ...metadata,
          promptVersion: 'prompt-2026-08',
        } as unknown as ImpactAnalysisMetadata,
        classifierFor('INFORMATIONAL'),
      ),
    ).rejects.toThrow();
  });
});

describe('createImpactAnalysisRecord — classification branch', () => {
  it('builds the request with the existing builder and calls the classifier exactly once with it', async () => {
    const classifier = classifierFor('REVIEW_REQUIRED');
    const record = await recordFor(
      classificationEvent,
      'REVIEW_REQUIRED',
      classifier,
    );

    expect(classifier.calls.length).toBe(1);
    const request = classifier.calls[0];
    if (request === undefined) throw new Error('expected one request');
    expect(request).toEqual(
      createStructuredImpactClassificationRequest(
        classificationEvent,
        'message-v1',
        baseProfile,
        decisionFor(classificationEvent),
      ),
    );
    expect(request.decision.kind).toBe('CLASSIFICATION_REQUIRED');
    expect(record.versionBundle.ai).toEqual({
      used: true,
      promptVersion: 'prompt-2026-08',
      model: 'gpt-5.6-luna',
      modelVersion: 'gpt-5.6-luna-2026-08-01',
    });
  });

  it('routes the three non-final decision kinds through exactly one call', async () => {
    for (const event of [
      classificationEvent,
      reviewFloorEvent,
      actionFloorEvent,
    ]) {
      const classifier = classifierFor('INFORMATIONAL');
      const record = await recordFor(event, 'INFORMATIONAL', classifier);
      expect(classifier.calls.length).toBe(1);
      expect(classifier.calls[0]?.decision.kind).toBe(decisionFor(event).kind);
      expect(record.versionBundle.ai.used).toBe(true);
      expect(AnalysisRecordSchema.safeParse(record).success).toBe(true);
    }
  });

  it('takes the execution identity from the returned AI record, not from any runner contract', async () => {
    const classifier = classifierFor('INFORMATIONAL', {
      evidenceId: 'ai.runner-evidence',
      promptVersion: 'prompt-runner-identity',
      model: 'model-from-classifier',
      modelVersion: 'model-version-from-classifier',
    });
    const record = await recordFor(
      classificationEvent,
      'INFORMATIONAL',
      classifier,
    );

    const aiRecord = aiRecordOf(record);
    expect(aiRecord.evidenceId).toBe('ai.runner-evidence');
    expect(aiRecord.promptVersion).toBe('prompt-runner-identity');
    expect(aiRecord.model).toBe('model-from-classifier');
    expect(aiRecord.modelVersion).toBe('model-version-from-classifier');
    expect(record.versionBundle.ai).toEqual({
      used: true,
      promptVersion: 'prompt-runner-identity',
      model: 'model-from-classifier',
      modelVersion: 'model-version-from-classifier',
    });
  });

  it('produces a valid CLASSIFIER_ACCEPTED record for every proposed state on the null floor', async () => {
    const states: ProposedState[] = [
      'ACTION_REQUIRED',
      'REVIEW_REQUIRED',
      'INFORMATIONAL',
      'NOT_APPLICABLE',
      'INSUFFICIENT_CONTEXT',
    ];
    for (const proposedState of states) {
      const classifier = classifierFor(proposedState);
      const record = await recordFor(
        classificationEvent,
        proposedState,
        classifier,
      );

      expect(record.impactAssessment.state).toBe(proposedState);
      expect(AnalysisRecordSchema.safeParse(record).success).toBe(true);
      expect(record.provenanceRecords.length).toBe(
        classifier.calls[0]!.evidenceRecords.length + 1,
      );
      expect(record.provenanceRecords[0]).toEqual(
        classifier.calls[0]!.evidenceRecords[0],
      );
    }
  });

  it('produces floor-raised records when the proposal sits below the deterministic floor', async () => {
    for (const proposedState of [
      'INFORMATIONAL',
      'NOT_APPLICABLE',
      'INSUFFICIENT_CONTEXT',
    ] as const) {
      const classifier = classifierFor(proposedState);
      const record = await recordFor(
        reviewFloorEvent,
        proposedState,
        classifier,
      );

      expect(record.impactAssessment.state).toBe('REVIEW_REQUIRED');
      expect(AnalysisRecordSchema.safeParse(record).success).toBe(true);
      expect(
        record.impactAssessment.state === 'REVIEW_REQUIRED' &&
          record.impactAssessment.evidence.includes('decision.risk.0'),
      ).toBe(true);
      // The raw proposal keeps its INSUFFICIENT_CONTEXT shape on the AI record.
      if (proposedState === 'INSUFFICIENT_CONTEXT') {
        expect(aiRecordOf(record).classificationOutput.proposedState).toBe(
          'INSUFFICIENT_CONTEXT',
        );
        expect(
          'missingContext' in aiRecordOf(record).classificationOutput,
        ).toBe(true);
      }
    }
  });

  it('accepts proposals at or above the guardrail floor unchanged', async () => {
    const acceptedAtReview = await recordFor(
      reviewFloorEvent,
      'ACTION_REQUIRED',
      classifierFor('ACTION_REQUIRED'),
    );
    expect(acceptedAtReview.impactAssessment.state).toBe('ACTION_REQUIRED');
    expect(acceptedAtReview.impactAssessment).toEqual({
      state: 'ACTION_REQUIRED',
      reason: 'Classifier proposed ACTION_REQUIRED.',
      evidence: ['source.event.title'],
    });

    const acceptedAtAction = await recordFor(
      actionFloorEvent,
      'ACTION_REQUIRED',
      classifierFor('ACTION_REQUIRED'),
    );
    expect(acceptedAtAction.impactAssessment.state).toBe('ACTION_REQUIRED');
  });

  it('keeps the ownership triple of the AI record bound to the proposal', async () => {
    // The proposal itself carries confidence 0.42; the classifier record
    // mirrors it so the existing ownership rule accepts the result.
    const classifier = classifierFor('INFORMATIONAL', {
      output: outputFor('INFORMATIONAL', { confidence: 0.42 }),
      confidence: 0.42,
    });
    const record = await recordFor(
      classificationEvent,
      'INFORMATIONAL',
      classifier,
    );
    const aiRecord = aiRecordOf(record);

    expect(aiRecord.confidence).toBe(0.42);
    expect(aiRecord.inference).toBe('Classifier proposed INFORMATIONAL.');
    expect(aiRecord.dependsOnEvidenceIds).toEqual(['source.event.title']);
    expect(aiRecord.classificationOutput).toEqual(
      outputFor('INFORMATIONAL', { confidence: 0.42 }),
    );
  });

  it('does not mutate any input and stays deterministic across repeated runs', async () => {
    const eventBefore = clone(classificationEvent);
    const profileBefore = clone(baseProfile);
    const metadataBefore = clone(metadata);

    const first = await recordFor(
      classificationEvent,
      'REVIEW_REQUIRED',
      classifierFor('REVIEW_REQUIRED'),
    );
    const second = await recordFor(
      classificationEvent,
      'REVIEW_REQUIRED',
      classifierFor('REVIEW_REQUIRED'),
    );

    expect(first).toEqual(second);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    expect(
      AnalysisRecordSchema.parse(JSON.parse(JSON.stringify(first))),
    ).toEqual(first);
    expect(clone(classificationEvent)).toEqual(eventBefore);
    expect(clone(baseProfile)).toEqual(profileBefore);
    expect(clone(metadata)).toEqual(metadataBefore);
  });
});

describe('createImpactAnalysisRecord — classifier boundary failures', () => {
  it('rejects a tampered AI record whose ownership triple contradicts the proposal', async () => {
    // A provider that returns a confidence disagreeing with the raw
    // proposal's confidence violates the existing ownership rule and must
    // be rejected before any merge work happens.
    const base: StructuredClassificationAIInference = {
      kind: 'ai_inference',
      evidenceId: 'ai.classification-proposal',
      promptVersion: 'prompt-2026-08',
      model: 'gpt-5.6-luna',
      modelVersion: 'gpt-5.6-luna-2026-08-01',
      confidence: 0.99,
      inference: 'Classifier proposed INFORMATIONAL.',
      dependsOnEvidenceIds: ['source.event.title'],
      classificationOutput: outputFor('INFORMATIONAL', {
        confidence: 0.75,
      }) as StructuredClassificationAIInference['classificationOutput'],
    };
    expect(
      StructuredClassificationAIInferenceSchema.safeParse(base).success,
    ).toBe(false);

    await expect(
      createImpactAnalysisRecord(
        classificationEvent,
        'message-v1',
        baseProfile,
        riskPolicy,
        tenantPolicy,
        metadata,
        async () => base,
      ),
    ).rejects.toThrow(/confidence must match/);
  });

  it('rejects a tampered AI record whose dependency order contradicts the proposal', async () => {
    const base: StructuredClassificationAIInference = {
      kind: 'ai_inference',
      evidenceId: 'ai.classification-proposal',
      promptVersion: 'prompt-2026-08',
      model: 'gpt-5.6-luna',
      modelVersion: 'gpt-5.6-luna-2026-08-01',
      confidence: 0.75,
      inference: 'Classifier proposed INFORMATIONAL.',
      dependsOnEvidenceIds: ['source.event.title', 'source.event.body'],
      classificationOutput: outputFor(
        'INFORMATIONAL',
      ) as StructuredClassificationAIInference['classificationOutput'],
    };
    expect(
      StructuredClassificationAIInferenceSchema.safeParse(base).success,
    ).toBe(false);

    await expect(
      createImpactAnalysisRecord(
        classificationEvent,
        'message-v1',
        baseProfile,
        riskPolicy,
        tenantPolicy,
        metadata,
        async () => base,
      ),
    ).rejects.toThrow(/dependsOnEvidenceIds must equal/);
  });

  it('rejects a classifier result whose proposal references evidence outside the request', async () => {
    const classifier = classifierFor('INFORMATIONAL', {
      output: outputFor('INFORMATIONAL', {
        supportingEvidenceIds: ['ghost.evidence'],
      }),
    });
    await expect(
      createImpactAnalysisRecord(
        classificationEvent,
        'message-v1',
        baseProfile,
        riskPolicy,
        tenantPolicy,
        metadata,
        classifier,
      ),
    ).rejects.toThrow(/supporting evidence ID does not exist/);
    expect(classifier.calls.length).toBe(1);
  });

  it('rejects a classifier record that omits the structured proposal entirely', async () => {
    await expect(
      createImpactAnalysisRecord(
        classificationEvent,
        'message-v1',
        baseProfile,
        riskPolicy,
        tenantPolicy,
        metadata,
        // A generic AI record without classificationOutput violates the
        // structured inference schema (output required).
        async () =>
          ({
            kind: 'ai_inference',
            evidenceId: 'ai.classification-proposal',
            promptVersion: 'prompt-2026-08',
            model: 'gpt-5.6-luna',
            modelVersion: 'gpt-5.6-luna-2026-08-01',
            confidence: 0.75,
            inference: 'No structured proposal attached.',
            dependsOnEvidenceIds: ['source.event.title'],
          }) as unknown as StructuredClassificationAIInference,
      ),
    ).rejects.toThrow();
  });

  it('propagates a classifier rejection without producing a record', async () => {
    await expect(
      createImpactAnalysisRecord(
        classificationEvent,
        'message-v1',
        baseProfile,
        riskPolicy,
        tenantPolicy,
        metadata,
        async () => {
          throw new Error('provider unavailable');
        },
      ),
    ).rejects.toThrow('provider unavailable');
  });

  it('propagates a synchronous classifier throw without producing a record', async () => {
    await expect(
      createImpactAnalysisRecord(
        classificationEvent,
        'message-v1',
        baseProfile,
        riskPolicy,
        tenantPolicy,
        metadata,
        (() => {
          throw new Error('sync failure');
        }) as unknown as StructuredImpactClassifier,
      ),
    ).rejects.toThrow('sync failure');
  });

  it('calls the classifier zero times when the decision is deterministic final even if it would throw', async () => {
    const throwingClassifier: StructuredImpactClassifier = async () => {
      throw new Error('must never be called');
    };
    const record = await createImpactAnalysisRecord(
      finalEvent(),
      'message-v1',
      notApplicableProfile(),
      riskPolicy,
      tenantPolicy,
      metadata,
      throwingClassifier,
    );
    expect(record.versionBundle.ai).toEqual({ used: false });
  });
});

describe('createImpactAnalysisRecord — guardrail merge integration', () => {
  it('appends exactly one AI record after the complete deterministic prefix', async () => {
    const classifier = classifierFor('REVIEW_REQUIRED');
    const record = await recordFor(
      classificationEvent,
      'REVIEW_REQUIRED',
      classifier,
    );
    const request = classifier.calls[0]!;
    const aiRecords = record.provenanceRecords.filter(
      (entry) => entry.kind === 'ai_inference',
    );
    expect(aiRecords.length).toBe(1);
    record.provenanceRecords.forEach((entry, index) => {
      if (index < request.evidenceRecords.length) {
        expect(entry).toEqual(request.evidenceRecords[index]);
      }
    });
    expect(record.provenanceRecords.length).toBe(
      request.evidenceRecords.length + 1,
    );
  });

  it('maps every classifier proposal and floor through the full 15-state matrix', async () => {
    const states: ProposedState[] = [
      'ACTION_REQUIRED',
      'REVIEW_REQUIRED',
      'INFORMATIONAL',
      'NOT_APPLICABLE',
      'INSUFFICIENT_CONTEXT',
    ];
    const matrix = [
      { event: classificationEvent },
      { event: reviewFloorEvent },
      { event: actionFloorEvent },
    ];

    let converted = 0;
    for (const { event } of matrix) {
      for (const proposedState of states) {
        const record = await recordFor(event, proposedState);
        converted += 1;
        expect(AnalysisRecordSchema.safeParse(record).success).toBe(true);
        expect(
          StructuredImpactClassificationSchema.safeParse({
            request: createStructuredImpactClassificationRequest(
              event,
              'message-v1',
              baseProfile,
              decisionFor(event),
            ),
            output: outputFor(proposedState),
          }).success,
        ).toBe(true);

        const decision = decisionFor(event);
        const accepted =
          decision.stateFloor === null ||
          (decision.stateFloor === 'REVIEW_REQUIRED' &&
            (proposedState === 'ACTION_REQUIRED' ||
              proposedState === 'REVIEW_REQUIRED')) ||
          (decision.stateFloor === 'ACTION_REQUIRED' &&
            proposedState === 'ACTION_REQUIRED');
        if (accepted) {
          expect(record.impactAssessment.state).toBe(proposedState);
        } else {
          expect(record.impactAssessment.state).toBe(decision.stateFloor);
        }
      }
    }
    expect(converted).toBe(15);
  });
});

describe('createImpactAnalysisRecord — corpus routing', () => {
  it('routes the complete 500-pair corpus through the correct branch without any record contamination', async () => {
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
    expect(events.length).toBe(50);
    expect(profiles.length).toBe(10);
    expect(events.length * profiles.length).toBe(500);

    let finalCount = 0;
    let classificationCount = 0;
    let floorCount = 0;
    let visited = 0;

    for (const event of events) {
      for (const profile of profiles) {
        visited += 1;
        const decision = decisionFor(event, profile);
        const classifier = classifierFor('INFORMATIONAL');
        const record = await createImpactAnalysisRecord(
          event,
          'message-v1',
          profile,
          riskPolicy,
          tenantPolicy,
          metadata,
          classifier,
        );
        expect(AnalysisRecordSchema.safeParse(record).success).toBe(true);
        expect(record.changeEventRef).toEqual({
          source: event.source,
          externalId: event.externalId,
          sourceMessageVersion: 'message-v1',
        });
        expect(record.tenantId).toBe(metadata.tenantId);

        if (decision.kind === 'DETERMINISTIC_FINAL') {
          finalCount += 1;
          expect(classifier.calls.length).toBe(0);
          expect(record.versionBundle.ai).toEqual({ used: false });
          continue;
        }

        expect(classifier.calls.length).toBe(1);
        expect(record.versionBundle.ai.used).toBe(true);
        if (decision.kind === 'GUARDRAIL_FLOOR') {
          floorCount += 1;
        } else {
          classificationCount += 1;
        }
      }
    }

    expect(visited).toBe(500);
    expect(finalCount + classificationCount + floorCount).toBe(500);
    expect(finalCount).toBeGreaterThan(0);
    expect(classificationCount).toBeGreaterThan(0);
    expect(floorCount).toBeGreaterThan(0);
  }, 120_000);

  it('keeps routing stable when the runner is invoked through the public barrel', async () => {
    const record = await createImpactAnalysisRecord(
      classificationEvent,
      'message-v1',
      finalProfileWithTeamsEnabled(),
      riskPolicy,
      tenantPolicy,
      metadata,
      classifierFor('INFORMATIONAL'),
    );
    expect(record.changeEventRef).toEqual({
      source: classificationEvent.source,
      externalId: classificationEvent.externalId,
      sourceMessageVersion: 'message-v1',
    });
  });
});
