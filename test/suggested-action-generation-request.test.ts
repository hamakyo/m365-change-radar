import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  SuggestedChangeActionGenerationRequestSchema,
  SuggestedChangeActionResultSchema,
  createSuggestedChangeActionGenerationRequest,
} from '../src/index.js';

/** Minimal deterministic action targeting the AI fixture's provenance, used
 * only to confirm the Phase 1J-1 result envelope accepts/rejects the same
 * analyses this request contract accepts/rejects. */
const deterministicActionOnAiAnalysis = {
  origin: 'deterministic',
  actionId: 'action.align-check-001',
  kind: 'COMMUNICATE',
  title: 'Notify service owners of the upcoming deadline',
  description:
    'Send the deadline notice derived from the policy conclusion to every listed owner.',
  supportingEvidenceIds: ['rule.teams-review', 'source.deadline'],
} as const;

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

/** The tenant-profile fixture carries `profileVersion` "2026-08-26.1" while
 * both analysis fixtures were evaluated against "profile-2026-08-26.1", so
 * ownership-consistent inputs need this single-field retarget. */
function consistentProfile(): Record<string, unknown> {
  const profile = asRecord(readFixture('tenant-profile.json'));
  profile.profileVersion = 'profile-2026-08-26.1';
  return profile;
}

const changeEvent = readFixture('change-event.json') as Record<string, unknown>;

const aiAnalysis = readFixture('analysis-record-ai.json') as Record<
  string,
  unknown
>;
const aiVersionBundle = asRecord(aiAnalysis.versionBundle);

/** The no-AI fixture is NOT_APPLICABLE and references another event, so it
 * needs a state swap (with a matching evidence set from its own provenance)
 * plus an event-ref/provenance retarget to the shared ChangeEvent fixture
 * before it can act as the deterministic, AI-free ACTION_REQUIRED analysis of
 * an accepted request. Its versions stay message-v1 / profile-2026-08-26.1,
 * matching the version bundle it already carries. */
function actionableNoAiAnalysis(): Record<string, unknown> {
  const record = asRecord(clone(readFixture('analysis-record-no-ai.json')));
  record.changeEventRef = {
    source: 'microsoft-message-center',
    externalId: 'MC123456',
    sourceMessageVersion: 'message-v1',
  };
  for (const provenance of record.provenanceRecords as Array<
    Record<string, unknown>
  >) {
    if (provenance.kind === 'source_fact') {
      provenance.externalId = 'MC123456';
    }
  }
  record.impactAssessment = {
    state: 'ACTION_REQUIRED',
    reason: 'The change requires action before its deadline.',
    evidence: ['rule.no-impact'],
  };
  return record;
}

function buildRequest(
  overrides: Partial<{
    changeEvent: unknown;
    sourceMessageVersion: string;
    tenantProfile: unknown;
    analysisRecord: unknown;
  }>,
  base?: { noAi?: boolean },
): ReturnType<typeof createSuggestedChangeActionGenerationRequest> {
  const sourceMessageVersion =
    overrides.sourceMessageVersion ??
    (base?.noAi ? 'message-v1' : 'message-v3');
  return createSuggestedChangeActionGenerationRequest(
    (overrides.changeEvent ?? changeEvent) as never,
    sourceMessageVersion,
    (overrides.tenantProfile ?? consistentProfile()) as never,
    (overrides.analysisRecord ??
      (base?.noAi ? actionableNoAiAnalysis() : aiAnalysis)) as never,
  );
}

describe('createSuggestedChangeActionGenerationRequest acceptance', () => {
  it('accepts a no-AI ACTION_REQUIRED analysis with matching inputs', () => {
    const request = buildRequest({}, { noAi: true });

    const parsed =
      SuggestedChangeActionGenerationRequestSchema.safeParse(request);
    expect(parsed.success).toBe(true);
  });

  it('accepts an AI-enabled REVIEW_REQUIRED analysis with matching inputs', () => {
    const request = buildRequest({});

    const parsed =
      SuggestedChangeActionGenerationRequestSchema.safeParse(request);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.analysisRecord.versionBundle.ai.used).toBe(true);
      expect(parsed.data.analysisRecord.impactAssessment.state).toBe(
        'REVIEW_REQUIRED',
      );
    }
  });

  it('accepts a no-AI REVIEW_REQUIRED variant via direct schema parse', () => {
    const record = actionableNoAiAnalysis();
    const assessment = asRecord(record.impactAssessment);
    assessment.state = 'REVIEW_REQUIRED';
    const parsed = SuggestedChangeActionGenerationRequestSchema.safeParse({
      changeEvent,
      sourceMessageVersion: 'message-v1',
      tenantProfile: consistentProfile(),
      analysisRecord: record,
    });
    expect(parsed.success).toBe(true);
  });

  it('returns exactly the four bundled members with keys equal to the parsed inputs', () => {
    const request = buildRequest({});
    expect(Object.keys(request).sort()).toEqual([
      'analysisRecord',
      'changeEvent',
      'sourceMessageVersion',
      'tenantProfile',
    ]);
    expect(request.changeEvent).toEqual(changeEvent);
    expect(request.tenantProfile).toEqual(consistentProfile());
    expect(request.analysisRecord).toEqual(aiAnalysis);
  });

  it('carries the analysis identity through unchanged', () => {
    const request = buildRequest({});
    expect(request.analysisRecord.changeEventRef).toEqual(
      asRecord(aiAnalysis.changeEventRef),
    );
    expect(request.analysisRecord.provenanceRecords.length).toBeGreaterThan(0);
  });
});

describe('action generation eligibility gate', () => {
  it.each(['INFORMATIONAL', 'NOT_APPLICABLE', 'INSUFFICIENT_CONTEXT'] as const)(
    'rejects a %s analysis as non-actionable input',
    (state) => {
      const analysis = clone(aiAnalysis);
      if (state === 'INSUFFICIENT_CONTEXT') {
        analysis.impactAssessment = {
          state,
          reason: 'The tenant profile lacks the required paths.',
          missingContext: ['/services/teams'],
        };
      } else {
        analysis.impactAssessment = {
          state,
          reason: `Reason for ${state}.`,
          evidence: ['rule.teams-review'],
        };
      }
      const parsed = SuggestedChangeActionGenerationRequestSchema.safeParse({
        changeEvent,
        sourceMessageVersion: 'message-v3',
        tenantProfile: consistentProfile(),
        analysisRecord: analysis,
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(
          parsed.error.issues.some((issue: { message: string }) =>
            issue.message.includes(
              'must be ACTION_REQUIRED or REVIEW_REQUIRED',
            ),
          ),
        ).toBe(true);
      }
    },
  );

  it('rejects an otherwise-valid analysis when the builder receives a non-actionable state', () => {
    const analysis = clone(aiAnalysis);
    analysis.impactAssessment = {
      state: 'INFORMATIONAL',
      reason: 'Nothing to act on.',
      evidence: ['rule.teams-review'],
    };
    expect(() =>
      createSuggestedChangeActionGenerationRequest(
        changeEvent as never,
        'message-v3',
        consistentProfile() as never,
        analysis as never,
      ),
    ).toThrow(/must be ACTION_REQUIRED or REVIEW_REQUIRED/);
  });
});

describe('source ownership validation', () => {
  it('rejects a changeEvent whose source differs from changeEventRef', () => {
    const event = { ...clone(changeEvent), source: 'other-source' };
    const parsed = SuggestedChangeActionGenerationRequestSchema.safeParse({
      changeEvent: event,
      sourceMessageVersion: 'message-v3',
      tenantProfile: consistentProfile(),
      analysisRecord: aiAnalysis,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((issue: { message: string }) =>
          issue.message.includes(
            'changeEvent source/externalId must exactly match',
          ),
        ),
      ).toBe(true);
    }
  });

  it('rejects a changeEvent whose externalId differs from changeEventRef', () => {
    const event = { ...clone(changeEvent), externalId: 'MC000000' };
    const parsed = SuggestedChangeActionGenerationRequestSchema.safeParse({
      changeEvent: event,
      sourceMessageVersion: 'message-v3',
      tenantProfile: consistentProfile(),
      analysisRecord: aiAnalysis,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects sourceMessageVersion mismatching changeEventRef', () => {
    const parsed = SuggestedChangeActionGenerationRequestSchema.safeParse({
      changeEvent,
      sourceMessageVersion: 'message-v2',
      tenantProfile: consistentProfile(),
      analysisRecord: aiAnalysis,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((issue: { message: string }) =>
          issue.message.includes(
            'must exactly match analysisRecord.changeEventRef.sourceMessageVersion',
          ),
        ),
      ).toBe(true);
    }
  });

  it('rejects sourceMessageVersion mismatching versionBundle while changeEventRef agrees', () => {
    const tamperedBundle = asRecord(clone(aiVersionBundle));
    tamperedBundle.sourceMessageVersion = 'message-v9';
    const analysis = asRecord(clone(aiAnalysis));
    analysis.versionBundle = tamperedBundle;

    // Note: AnalysisRecord's own refinement would reject this bundle drift;
    // assert at the builder boundary through a schema-only check first.
    const builderRejected = (() => {
      try {
        createSuggestedChangeActionGenerationRequest(
          changeEvent as never,
          'message-v3',
          consistentProfile() as never,
          analysis as never,
        );
        return false;
      } catch {
        return true;
      }
    })();
    expect(builderRejected).toBe(true);
  });

  it('keeps event-ref vs bundle drift rejected by the inherited AnalysisRecord chain', () => {
    const analysis = asRecord(clone(aiAnalysis));
    const ref = asRecord(clone(analysis.changeEventRef));
    ref.sourceMessageVersion = 'message-v7';
    analysis.changeEventRef = ref;

    const parsed = SuggestedChangeActionGenerationRequestSchema.safeParse({
      changeEvent,
      sourceMessageVersion: 'message-v3',
      tenantProfile: consistentProfile(),
      analysisRecord: analysis,
    });
    expect(parsed.success).toBe(false);
  });
});

describe('tenant ownership validation', () => {
  it('rejects a profile whose profileVersion differs from versionBundle.tenantProfileVersion', () => {
    const profile = asRecord(consistentProfile());
    profile.profileVersion = 'profile-1999-01-01.7';
    const parsed = SuggestedChangeActionGenerationRequestSchema.safeParse({
      changeEvent,
      sourceMessageVersion: 'message-v3',
      tenantProfile: profile,
      analysisRecord: aiAnalysis,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((issue: { message: string }) =>
          issue.message.includes(
            'tenantProfile.profileVersion must exactly match',
          ),
        ),
      ).toBe(true);
    }
  });

  it('rejects the raw tenant-profile fixture version against the AI analysis bundle', () => {
    const profile = asRecord(readFixture('tenant-profile.json'));
    const parsed = SuggestedChangeActionGenerationRequestSchema.safeParse({
      changeEvent,
      sourceMessageVersion: 'message-v3',
      tenantProfile: profile,
      analysisRecord: aiAnalysis,
    });
    expect(parsed.success).toBe(false);
  });
});

describe('strict schema rejections', () => {
  it('rejects empty sourceMessageVersion strings', () => {
    const parsed = SuggestedChangeActionGenerationRequestSchema.safeParse({
      changeEvent,
      sourceMessageVersion: '',
      tenantProfile: consistentProfile(),
      analysisRecord: aiAnalysis,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects strict extra fields at the envelope level', () => {
    const parsed = SuggestedChangeActionGenerationRequestSchema.safeParse({
      changeEvent,
      sourceMessageVersion: 'message-v3',
      tenantProfile: consistentProfile(),
      analysisRecord: aiAnalysis,
      extra: 'nope',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects missing required envelope fields', () => {
    [
      {
        sourceMessageVersion: 'message-v3',
        tenantProfile: {},
        analysisRecord: {},
      },
      { changeEvent: {}, tenantProfile: {}, analysisRecord: {} },
      {
        changeEvent: {},
        sourceMessageVersion: 'message-v3',
        analysisRecord: {},
      },
      {
        changeEvent: {},
        sourceMessageVersion: 'message-v3',
        tenantProfile: {},
      },
    ].forEach((input) => {
      const parsed =
        SuggestedChangeActionGenerationRequestSchema.safeParse(input);
      expect(parsed.success).toBe(false);
    });
  });

  it('rejects invalid ChangeEvent inputs', () => {
    const badEvent = { ...clone(changeEvent), publishedAt: 'not-a-date' };
    const parsed = SuggestedChangeActionGenerationRequestSchema.safeParse({
      changeEvent: badEvent,
      sourceMessageVersion: 'message-v3',
      tenantProfile: consistentProfile(),
      analysisRecord: aiAnalysis,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects invalid TenantProfile inputs', () => {
    const badProfile = { ...consistentProfile(), profileVersion: '' };
    const parsed = SuggestedChangeActionGenerationRequestSchema.safeParse({
      changeEvent,
      sourceMessageVersion: 'message-v3',
      tenantProfile: badProfile,
      analysisRecord: aiAnalysis,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects invalid AnalysisRecord inputs such as empty provenance', () => {
    const badAnalysis = { ...clone(aiAnalysis), provenanceRecords: [] };
    const parsed = SuggestedChangeActionGenerationRequestSchema.safeParse({
      changeEvent,
      sourceMessageVersion: 'message-v3',
      tenantProfile: consistentProfile(),
      analysisRecord: badAnalysis,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a tampered dependency closure inside the analysis', () => {
    const analysis = asRecord(clone(aiAnalysis));
    const records = analysis.provenanceRecords;
    if (!Array.isArray(records)) {
      throw new Error('fixture lost its provenance records');
    }
    const conclusion = asRecord(records[2]);
    conclusion.dependsOnEvidenceIds = ['missing.dependency'];

    const parsed = SuggestedChangeActionGenerationRequestSchema.safeParse({
      changeEvent,
      sourceMessageVersion: 'message-v3',
      tenantProfile: consistentProfile(),
      analysisRecord: analysis,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a tampered policy version inside the analysis', () => {
    const analysis = asRecord(clone(aiAnalysis));
    const records = analysis.provenanceRecords;
    if (!Array.isArray(records)) {
      throw new Error('fixture lost its provenance records');
    }
    const conclusion = asRecord(records[2]);
    conclusion.policyRulesVersion = 'policy-1999-01';

    const parsed = SuggestedChangeActionGenerationRequestSchema.safeParse({
      changeEvent,
      sourceMessageVersion: 'message-v3',
      tenantProfile: consistentProfile(),
      analysisRecord: analysis,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a tampered evidence reference inside the assessment', () => {
    const analysis = asRecord(clone(aiAnalysis));
    const assessment = asRecord(analysis.impactAssessment);
    assessment.evidence = ['rule.teams-review', 'ghost.evidence'];

    const parsed = SuggestedChangeActionGenerationRequestSchema.safeParse({
      changeEvent,
      sourceMessageVersion: 'message-v3',
      tenantProfile: consistentProfile(),
      analysisRecord: analysis,
    });
    expect(parsed.success).toBe(false);
  });
});

describe('purity and determinism', () => {
  it('does not mutate any of its four inputs', () => {
    const eventBefore = clone(changeEvent);
    const profileBefore = clone(consistentProfile());
    const analysisBefore = clone(aiAnalysis);
    const eventInput = clone(changeEvent);
    const profileInput = clone(consistentProfile());
    const analysisInput = clone(aiAnalysis);

    createSuggestedChangeActionGenerationRequest(
      eventInput as never,
      'message-v3',
      profileInput as never,
      analysisInput as never,
    );

    expect(eventInput).toEqual(eventBefore);
    expect(profileInput).toEqual(profileBefore);
    expect(analysisInput).toEqual(analysisBefore);
  });

  it('produces deep-equal requests for identical inputs across repeated calls', () => {
    const first = createSuggestedChangeActionGenerationRequest(
      changeEvent as never,
      'message-v3',
      consistentProfile() as never,
      aiAnalysis as never,
    );
    const second = createSuggestedChangeActionGenerationRequest(
      changeEvent as never,
      'message-v3',
      consistentProfile() as never,
      aiAnalysis as never,
    );
    expect(second).toEqual(first);
  });

  it('round-trips accepted requests through JSON stringify/parse unchanged', () => {
    const first = createSuggestedChangeActionGenerationRequest(
      changeEvent as never,
      'message-v3',
      consistentProfile() as never,
      aiAnalysis as never,
    );
    const revived = JSON.parse(JSON.stringify(first));
    const second = SuggestedChangeActionGenerationRequestSchema.parse(revived);
    expect(second).toEqual(first);

    const revivable = SuggestedChangeActionGenerationRequestSchema.parse(
      JSON.parse(JSON.stringify(revived)),
    );
    expect(revivable).toEqual(second);
  });
});

describe('JSON-safe explicit-undefined refusal (actionRequestUndefinedFree)', () => {
  /** Injects an own property holding an explicit `undefined` at the given
   * object under `parent[key]` without JSON round-trip erasure, then asserts
   * the schema rejects the whole request with a single, path-carrying
   * `actionRequestUndefinedFree` issue (safeParse must not throw). */
  function expectUndefinedRejectedAt(
    inject: (request: Record<string, unknown>) => void,
  ): void {
    const request: Record<string, unknown> = {
      changeEvent: clone(changeEvent),
      sourceMessageVersion: 'message-v3',
      tenantProfile: consistentProfile(),
      analysisRecord: clone(aiAnalysis),
    };
    inject(request);

    let unexpectedThrow: unknown;
    let parsed!: ReturnType<
      typeof SuggestedChangeActionGenerationRequestSchema.safeParse
    >;
    try {
      parsed = SuggestedChangeActionGenerationRequestSchema.safeParse(
        request as never,
      );
    } catch (error) {
      unexpectedThrow = error;
    }
    expect(unexpectedThrow).toBeUndefined();
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const undefinedIssues = parsed.error.issues.filter((issue) =>
        issue.message.includes('explicit undefined is not allowed anywhere'),
      );
      expect(undefinedIssues.length).toBe(1);
      expect(undefinedIssues[0]?.message).toMatch(/\(found at: .+\)/);
    }
  }

  it('rejects changeEvent.signals.isMajorChange: undefined via direct schema parse', () => {
    expectUndefinedRejectedAt((request) => {
      const event = asRecord(request.changeEvent);
      event.signals = Object.assign({}, asRecord(event.signals), {
        isMajorChange: undefined,
      });
    });
  });

  it('rejects an optional tenant-profile member passed as undefined via direct schema parse', () => {
    expectUndefinedRejectedAt((request) => {
      const profile = asRecord(request.tenantProfile);
      profile.maintenance = Object.assign({}, asRecord(profile.maintenance), {
        timezone: undefined,
      });
    });
  });

  it('rejects a deep nested undefined inside the analysis provenance via direct schema parse', () => {
    expectUndefinedRejectedAt((request) => {
      const analysis = asRecord(request.analysisRecord);
      const records = analysis.provenanceRecords;
      if (!Array.isArray(records)) {
        throw new Error('fixture lost its provenance records');
      }
      const aiRecord = asRecord(records[3]);
      if (aiRecord.kind !== 'ai_inference') {
        throw new Error('expected the AI inference record at index 3');
      }
      aiRecord.classificationOutput = undefined;
    });
  });

  it('rejects an array element holding explicit undefined via direct schema parse', () => {
    // Typed array slots are rejected by the member schema itself, with a
    // path-carrying issue pointing at the offending index.
    const request: Record<string, unknown> = {
      changeEvent: clone(changeEvent),
      sourceMessageVersion: 'message-v3',
      tenantProfile: consistentProfile(),
      analysisRecord: clone(aiAnalysis),
    };
    asRecord(request.changeEvent).products = ['Microsoft Teams', undefined];

    const parsed = SuggestedChangeActionGenerationRequestSchema.safeParse(
      request as never,
    );
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some(
          (issue) =>
            issue.path.includes('products') &&
            String(issue.message).includes('undefined'),
        ),
      ).toBe(true);
    }
  });

  it('rejects the same inputs through the builder without throwing raw errors', () => {
    const event = clone(changeEvent);
    event.signals = Object.assign({}, asRecord(changeEvent.signals), {
      isMajorChange: undefined,
    });
    let builderError: unknown;
    try {
      createSuggestedChangeActionGenerationRequest(
        event as never,
        'message-v3',
        consistentProfile() as never,
        aiAnalysis as never,
      );
    } catch (error) {
      builderError = error;
    }
    expect(builderError).toBeInstanceOf(Error);
    expect(String(builderError)).toContain(
      'explicit undefined is not allowed anywhere in the request',
    );
    expect(String(builderError)).toContain('changeEvent.signals.isMajorChange');
  });

  it('keeps falsy-but-defined values accepted where member schemas allow them', () => {
    const event = clone(changeEvent);
    const eventRecord = asRecord(event);
    eventRecord.body = '';
    eventRecord.products = [];
    eventRecord.categories = [];
    eventRecord.severity = null;
    eventRecord.signals = {
      isMajorChange: false,
      actionRequiredBy: null,
      hasAdminImpact: true,
      isRetirementOrDeprecation: false,
      hasSecurityImpact: false,
      hasPrivacyImpact: false,
      hasComplianceImpact: false,
      tags: [],
    };

    const parsed = SuggestedChangeActionGenerationRequestSchema.safeParse({
      changeEvent: event,
      sourceMessageVersion: 'message-v3',
      tenantProfile: consistentProfile(),
      analysisRecord: aiAnalysis,
    });
    expect(parsed.success).toBe(true);
  });

  it('reports the undefined issue alongside the ownership issues it co-occurs with', () => {
    const request: Record<string, unknown> = {
      changeEvent: clone(changeEvent),
      sourceMessageVersion: 'message-v9',
      tenantProfile: consistentProfile(),
      analysisRecord: clone(aiAnalysis),
    };
    const event = asRecord(request.changeEvent);
    event.signals = Object.assign({}, asRecord(event.signals), {
      isMajorChange: undefined,
    });

    const parsed = SuggestedChangeActionGenerationRequestSchema.safeParse(
      request as never,
    );
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const messages = parsed.error.issues.map((issue) => issue.message);
      expect(
        messages.some((message) => message.includes('explicit undefined')),
      ).toBe(true);
      expect(
        messages.some((message) => message.includes('must exactly match')),
      ).toBe(true);
    }
  });

  it('JSON round-trips every accepted request with no undefined property at any depth', () => {
    const requests = [
      createSuggestedChangeActionGenerationRequest(
        changeEvent as never,
        'message-v3',
        consistentProfile() as never,
        aiAnalysis as never,
      ),
      createSuggestedChangeActionGenerationRequest(
        changeEvent as never,
        'message-v1',
        consistentProfile() as never,
        actionableNoAiAnalysis() as never,
      ),
    ];

    requests.forEach((request) => {
      const serialized = JSON.stringify(request);
      expect(serialized).not.toContain('undefined');
      const revived = JSON.parse(serialized) as unknown;
      expect(revived).toEqual(request);
      // The revived data re-parses as an accepted request unchanged.
      expect(
        SuggestedChangeActionGenerationRequestSchema.safeParse(revived).success,
      ).toBe(true);
      // The freshly built output also re-parses: the builder's own final
      // parse guarantees its returned value carries no own property holding
      // an explicit `undefined` at any depth.
      expect(
        SuggestedChangeActionGenerationRequestSchema.safeParse(request).success,
      ).toBe(true);
    });
  });
});

describe('Phase 1J-1 boundary alignment', () => {
  it('accepts the same AI analysis that a SuggestedChangeActionResult envelope accepts', () => {
    const request = createSuggestedChangeActionGenerationRequest(
      changeEvent as never,
      'message-v3',
      consistentProfile() as never,
      aiAnalysis as never,
    );
    // Phase 1J-1 result gate: REVIEW_REQUIRED is actionable, so the same
    // analysis paired with one valid action parses as a result envelope.
    expect(
      SuggestedChangeActionResultSchema.safeParse({
        analysisRecord: clone(aiAnalysis),
        actions: [{ ...deterministicActionOnAiAnalysis }],
      }).success,
    ).toBe(true);
    expect(
      SuggestedChangeActionGenerationRequestSchema.safeParse({
        changeEvent,
        sourceMessageVersion: 'message-v3',
        tenantProfile: consistentProfile(),
        analysisRecord: aiAnalysis,
      }).success,
    ).toBe(true);
    expect(request.analysisRecord.impactAssessment.state).toBe(
      'REVIEW_REQUIRED',
    );
  });

  it.each(['INFORMATIONAL', 'NOT_APPLICABLE', 'INSUFFICIENT_CONTEXT'] as const)(
    'rejects %s in both the request contract and the Phase 1J-1 result envelope',
    (state) => {
      const nonActionable = (): Record<string, unknown> => {
        const analysis = clone(aiAnalysis);
        if (state === 'INSUFFICIENT_CONTEXT') {
          analysis.impactAssessment = {
            state,
            reason: 'The tenant profile lacks the required paths.',
            missingContext: ['/services/teams'],
          };
        } else {
          analysis.impactAssessment = {
            state,
            reason: `Reason for ${state}.`,
            evidence: ['rule.teams-review'],
          };
        }
        return analysis;
      };

      expect(
        SuggestedChangeActionGenerationRequestSchema.safeParse({
          changeEvent,
          sourceMessageVersion: 'message-v3',
          tenantProfile: consistentProfile(),
          analysisRecord: nonActionable(),
        }).success,
      ).toBe(false);

      expect(
        SuggestedChangeActionResultSchema.safeParse({
          analysisRecord: nonActionable(),
          actions: [{ ...deterministicActionOnAiAnalysis }],
        }).success,
      ).toBe(false);
    },
  );
});
