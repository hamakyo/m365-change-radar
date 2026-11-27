import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  StructuredImpactClassificationRequestSchema,
  createImpactAnalysisRecord,
  createStructuredImpactClassificationRequest,
  type ImpactAnalysisMetadata,
  type RiskPolicy,
  type StructuredImpactClassificationRequest,
  type StructuredImpactClassifier,
  type TenantApplicabilityPolicy,
} from '../src/index.js';

function readFixture(name: string): unknown {
  const url = new URL(`./fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('fixture value is not an object');
  }
  return value as Record<string, unknown>;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const riskPolicyFixture = readFixture('risk-policy.json') as RiskPolicy;
const tenantPolicyFixture = readFixture(
  'tenant-applicability-policy.json',
) as TenantApplicabilityPolicy;
const baseEvent = asRecord(readFixture('change-event.json'));
const baseProfile = asRecord(readFixture('tenant-profile.json'));

const classificationMetadata: ImpactAnalysisMetadata = {
  analysisId: 'analysis-runner-boundary-001',
  tenantId: 'tenant-under-test',
  createdAt: '2026-08-28T09:30:00+09:00',
};

/** A classification-path event built from the shared fixture, mirroring the
 * Phase 1K-1 test's no-floor applicable pattern: negative signals keep the
 * risk floor at null while the tenant rule stays applicable, so the
 * non-final branch runs. */
const classificationEvent: Record<string, unknown> = {
  ...baseEvent,
  severity: 'low',
  signals: {
    ...(baseEvent.signals as Record<string, unknown>),
    hasAdminImpact: false,
  },
  products: ['Synthetic Teams'],
};

/** A guardrail ACTION_REQUIRED event for the floor-path contrast test. */
const actionFloorEvent: Record<string, unknown> = {
  ...baseEvent,
  severity: 'high',
  products: ['Synthetic Teams'],
  signals: {
    ...(baseEvent.signals as Record<string, unknown>),
    isMajorChange: true,
    hasAdminImpact: true,
  },
};

/** A clearly negative event matched by no enabled rule, with the teams
 * service disabled so tenant applicability confirms NOT_APPLICABLE — the
 * deterministic-final branch of the runner. */
const finalEvent: Record<string, unknown> = {
  ...baseEvent,
  severity: 'low',
  signals: {
    isMajorChange: false,
    actionRequiredBy: null,
    hasAdminImpact: false,
    isRetirementOrDeprecation: false,
    hasSecurityImpact: false,
    hasPrivacyImpact: false,
    hasComplianceImpact: false,
    tags: [],
  },
  categories: [],
};
const notApplicableProfile: Record<string, unknown> = {
  ...baseProfile,
  services: {
    ...(baseProfile.services as Record<string, unknown>),
    teams: false,
  },
};

/** Counting classifier that must never be reached: records any call and
 * then throws so a violation cannot pass silently. */
function countingClassifier(): StructuredImpactClassifier & {
  calls: StructuredImpactClassificationRequest[];
} {
  const calls: StructuredImpactClassificationRequest[] = [];
  const classifier = (async (
    request: StructuredImpactClassificationRequest,
  ) => {
    calls.push(request);
    throw new Error('classifier must not be reached in this test');
  }) as unknown as StructuredImpactClassifier & {
    calls: StructuredImpactClassificationRequest[];
  };
  classifier.calls = calls;
  return classifier;
}

function runRunner(
  overrides: {
    changeEvent?: unknown;
    sourceMessageVersion?: string;
    tenantProfile?: unknown;
    riskPolicy?: unknown;
    tenantApplicabilityPolicy?: unknown;
    metadata?: unknown;
    classifier?: StructuredImpactClassifier;
  } = {},
): Promise<unknown> {
  return createImpactAnalysisRecord(
    (overrides.changeEvent ?? classificationEvent) as never,
    overrides.sourceMessageVersion ?? 'message-v1',
    (overrides.tenantProfile ?? baseProfile) as never,
    (overrides.riskPolicy ?? riskPolicyFixture) as never,
    (overrides.tenantApplicabilityPolicy ?? tenantPolicyFixture) as never,
    (overrides.metadata ?? classificationMetadata) as never,
    overrides.classifier ?? countingClassifier(),
  );
}

describe('createImpactAnalysisRecord — runner-boundary input validation', () => {
  it('rejects an invalid raw change event before any evaluator or classifier runs', async () => {
    const classifier = countingClassifier();
    await expect(
      runRunner({
        changeEvent: { ...classificationEvent, severity: 'catastrophic' },
        classifier,
      }),
    ).rejects.toThrow();
    expect(classifier.calls.length).toBe(0);
  });

  it('rejects an empty source message version before any evaluator or classifier runs', async () => {
    const classifier = countingClassifier();
    await expect(
      runRunner({ sourceMessageVersion: '', classifier }),
    ).rejects.toThrow();
    expect(classifier.calls.length).toBe(0);
  });

  it('rejects an invalid raw tenant profile before any evaluator or classifier runs', async () => {
    const classifier = countingClassifier();
    await expect(
      runRunner({
        tenantProfile: { ...baseProfile, profileVersion: '' },
        classifier,
      }),
    ).rejects.toThrow();
    expect(classifier.calls.length).toBe(0);
  });

  it('rejects an invalid raw risk policy before any evaluator or classifier runs', async () => {
    const classifier = countingClassifier();
    await expect(
      runRunner({
        riskPolicy: {
          ...riskPolicyFixture,
          rules: [
            {
              ...riskPolicyFixture.rules[0],
              condition: { kind: 'tampered_condition' },
            },
          ],
        },
        classifier,
      }),
    ).rejects.toThrow();
    expect(classifier.calls.length).toBe(0);
  });

  it('rejects an invalid raw tenant applicability policy before any evaluator or classifier runs', async () => {
    const classifier = countingClassifier();
    await expect(
      runRunner({
        tenantApplicabilityPolicy: {
          ...tenantPolicyFixture,
          rules: [
            {
              ...tenantPolicyFixture.rules[0],
              selector: { field: 'not_a_field', values: ['Synthetic Teams'] },
            },
          ],
        },
        classifier,
      }),
    ).rejects.toThrow();
    expect(classifier.calls.length).toBe(0);
  });

  it('rejects a strict-extra metadata key before any evaluator or classifier runs', async () => {
    const classifier = countingClassifier();
    await expect(
      runRunner({
        metadata: { ...classificationMetadata, extraKey: true },
        classifier,
      }),
    ).rejects.toThrow();
    expect(classifier.calls.length).toBe(0);
  });
});

describe('createImpactAnalysisRecord — classifier clone isolation', () => {
  it('keeps the returned AnalysisRecord unaffected when the classifier mutates its received clone in place', async () => {
    let snapshotEvidenceCount = 0;
    let callCount = 0;
    const classifier: StructuredImpactClassifier = async (received) => {
      callCount += 1;
      // Snapshot the valid clone BEFORE trashing it: the returned AI record
      // must stay compatible with the ORIGINAL authoritative request.
      snapshotEvidenceCount = received.evidenceRecords.length;
      // Mutate nested request fields and evidence in place — every value the
      // merge/record chain could otherwise observe.
      (received.evidenceRecords as unknown[]).push({
        evidenceId: 'classifier.planted',
      });
      received.sourceMessageVersion = 'message-v999';
      received.changeEvent.externalId = 'MC999999';
      received.tenantProfile.profileVersion = 'profile-v999';
      if (
        received.decision.kind === 'CLASSIFICATION_REQUIRED' ||
        received.decision.kind === 'GUARDRAIL_FLOOR'
      ) {
        (received.decision as { stateFloor: unknown }).stateFloor =
          'NOT_APPLICABLE';
      }
      // Still return a valid inference for the original authoritative
      // request, so the runner completes and returns a record.
      return {
        kind: 'ai_inference',
        evidenceId: 'ai.classification-proposal',
        promptVersion: 'prompt-2026-08',
        model: 'gpt-5.6-luna',
        modelVersion: 'gpt-5.6-luna-2026-08-01',
        confidence: 0.75,
        inference: 'Classifier proposed INFORMATIONAL.',
        dependsOnEvidenceIds: ['source.event.title'],
        classificationOutput: {
          proposedState: 'INFORMATIONAL',
          confidence: 0.75,
          reason: 'Classifier proposed INFORMATIONAL.',
          affectedComponents: ['Synthetic Teams'],
          supportingEvidenceIds: ['source.event.title'],
        },
      };
    };
    const eventBefore = clone(classificationEvent);
    const profileBefore = clone(baseProfile);

    const record = (await runRunner({ classifier })) as {
      analysisId: string;
      tenantId: string;
      createdAt: string;
      changeEventRef: Record<string, unknown>;
      versionBundle: Record<string, unknown>;
      impactAssessment: Record<string, unknown>;
      provenanceRecords: Array<Record<string, unknown>>;
    };

    // The classifier ran exactly once.
    expect(callCount).toBe(1);

    // The returned record keeps the ORIGINAL ownership: event ref, caller
    // metadata, versions, and accepted assessment on the null floor.
    expect(record.changeEventRef).toEqual({
      source: 'microsoft-message-center',
      externalId: 'MC123456',
      sourceMessageVersion: 'message-v1',
    });
    expect(record.analysisId).toBe('analysis-runner-boundary-001');
    expect(record.tenantId).toBe('tenant-under-test');
    expect(record.createdAt).toBe('2026-08-28T09:30:00+09:00');
    expect(record.versionBundle.sourceMessageVersion).toBe('message-v1');
    expect(record.versionBundle.tenantProfileVersion).toBe('2026-08-26.1');
    expect(record.versionBundle.policyVersions).toEqual({
      riskPolicyRulesVersion: riskPolicyFixture.policyRulesVersion,
      tenantApplicabilityPolicyRulesVersion:
        tenantPolicyFixture.policyRulesVersion,
    });
    expect(record.versionBundle.ai).toEqual({
      used: true,
      promptVersion: 'prompt-2026-08',
      model: 'gpt-5.6-luna',
      modelVersion: 'gpt-5.6-luna-2026-08-01',
    });
    expect(record.impactAssessment).toEqual({
      state: 'INFORMATIONAL',
      reason: 'Classifier proposed INFORMATIONAL.',
      evidence: ['source.event.title'],
    });

    // The complete provenance keeps the authoritative request's deterministic
    // evidence prefix plus exactly one trailing AI record — the planted
    // evidence record never entered the record.
    expect(record.provenanceRecords.length).toBe(snapshotEvidenceCount + 1);
    const lastRecord = record.provenanceRecords.at(-1);
    expect(lastRecord?.evidenceId).toBe('ai.classification-proposal');

    // No planted or tampered value appears anywhere in the returned record.
    const serialized = JSON.stringify(record);
    for (const tampered of [
      'classifier.planted',
      'message-v999',
      'MC999999',
      'profile-v999',
    ]) {
      expect(serialized.includes(tampered)).toBe(false);
    }

    // The caller's inputs remain unchanged.
    expect(clone(classificationEvent)).toEqual(eventBefore);
    expect(clone(baseProfile)).toEqual(profileBefore);
  });

  it('hands the classifier a deep-equal separate clone of the authoritative request', async () => {
    let receivedSnapshot: unknown;
    const classifier: StructuredImpactClassifier = async (received) => {
      receivedSnapshot = clone(received);
      throw new Error('stop before merge work');
    };
    await expect(runRunner({ classifier })).rejects.toThrow(
      'stop before merge work',
    );

    // The classifier received a request deep-equal to the one the existing
    // builder produces from the same authoritative inputs.
    const authoritative = createStructuredImpactClassificationRequest(
      classificationEvent as never,
      'message-v1',
      baseProfile as never,
      // The decision is rebuilt by the runner internally; the builder needs
      // one, so compare against the schema-parsed snapshot instead.
      StructuredImpactClassificationRequestSchema.parse(receivedSnapshot)
        .decision,
    );
    expect(receivedSnapshot).toEqual(authoritative);
    expect(
      StructuredImpactClassificationRequestSchema.safeParse(receivedSnapshot)
        .success,
    ).toBe(true);
  });

  it('isolates nested classifier mutation from the authoritative request, caller inputs, and the record chain', async () => {
    let seen: StructuredImpactClassificationRequest | undefined;
    const classifier: StructuredImpactClassifier = async (received) => {
      seen = received;
      // Trash the clone at every nesting level the merge/record chain reads.
      (received.evidenceRecords as unknown[]).push({
        evidenceId: 'classifier.planted',
      });
      received.sourceMessageVersion = 'message-v999';
      received.changeEvent.externalId = 'MC999999';
      received.tenantProfile.profileVersion = 'profile-v999';
      throw new Error('stop before merge work');
    };
    const eventBefore = clone(classificationEvent);
    const profileBefore = clone(baseProfile);

    await expect(runRunner({ classifier })).rejects.toThrow(
      'stop before merge work',
    );

    // The mutations landed on the object the classifier received (proving
    // it was a real, writable object)…
    expect(seen?.sourceMessageVersion).toBe('message-v999');
    // …the merge/record chain never ran because the classifier threw…
    // …and the caller's inputs are untouched.
    expect(clone(classificationEvent)).toEqual(eventBefore);
    expect(clone(baseProfile)).toEqual(profileBefore);
    // The trashed clone the classifier saw no longer re-parses through the
    // unchanged request schema (its tampered event/evidence ownership is
    // rejected)…
    expect(
      StructuredImpactClassificationRequestSchema.safeParse(clone(seen))
        .success,
    ).toBe(false);
    // …and a fresh run receives a pristine deep-equal request again, so the
    // trash never reached anything the runner owns across runs.
    let pristine: unknown;
    await expect(
      runRunner({
        classifier: async (received) => {
          pristine = clone(received);
          throw new Error('stop again');
        },
      }),
    ).rejects.toThrow('stop again');
    expect(pristine).toMatchObject({ sourceMessageVersion: 'message-v1' });
    expect(
      StructuredImpactClassificationRequestSchema.safeParse(pristine).success,
    ).toBe(true);
  });
});

describe('createImpactAnalysisRecord — deterministic-final branch', () => {
  it('still calls the classifier zero times on the deterministic-final branch', async () => {
    const classifier = countingClassifier();
    const record = (await runRunner({
      changeEvent: finalEvent,
      tenantProfile: notApplicableProfile,
      classifier,
    })) as { versionBundle: { ai: unknown } };
    expect(classifier.calls.length).toBe(0);
    expect(record.versionBundle.ai).toEqual({ used: false });
  });
});

describe('createImpactAnalysisRecord — boundary-parse determinism', () => {
  const classifier: StructuredImpactClassifier = async () => ({
    kind: 'ai_inference',
    evidenceId: 'ai.classification-proposal',
    promptVersion: 'prompt-2026-08',
    model: 'gpt-5.6-luna',
    modelVersion: 'gpt-5.6-luna-2026-08-01',
    confidence: 0.75,
    inference: 'Classifier proposed INFORMATIONAL.',
    dependsOnEvidenceIds: ['source.event.title'],
    classificationOutput: {
      proposedState: 'INFORMATIONAL',
      confidence: 0.75,
      reason: 'Classifier proposed INFORMATIONAL.',
      affectedComponents: ['Synthetic Teams'],
      supportingEvidenceIds: ['source.event.title'],
    },
  });

  it('keeps accepted raw inputs deterministic across repeated runs', async () => {
    const first = (await runRunner({ classifier })) as {
      impactAssessment: { state: string };
    };
    const second = (await runRunner({
      changeEvent: actionFloorEvent,
      classifier,
    })) as { impactAssessment: { state: string } };
    const third = (await runRunner({ classifier })) as {
      impactAssessment: { state: string };
    };

    expect(third).toEqual(first);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    expect(second.impactAssessment.state).toBe('ACTION_REQUIRED');
  });
});
