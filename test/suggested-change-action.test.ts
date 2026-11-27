import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  AnalysisRecordSchema,
  SuggestedChangeActionKindSchema,
  SuggestedChangeActionOriginSchema,
  SuggestedChangeActionSchema,
  SuggestedChangeActionResultSchema,
} from '../src/index.js';
import type { AnalysisRecord } from '../src/index.js';

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

/** The no-AI fixture is NOT_APPLICABLE, so it needs a state swap (with a
 * matching evidence set from its own provenance) before it can act as the
 * deterministic, AI-free analysis of an actionable result. */
function actionableNoAiAnalysis(): Record<string, unknown> {
  const record = asRecord(
    JSON.parse(JSON.stringify(readFixture('analysis-record-no-ai.json'))),
  );
  record.impactAssessment = {
    state: 'ACTION_REQUIRED',
    reason: 'The change requires action before its deadline.',
    evidence: ['rule.no-impact'],
  };
  return record;
}

function aiAnalysis(): AnalysisRecord {
  return AnalysisRecordSchema.parse(readFixture('analysis-record-ai.json'));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Evidence IDs for the no-AI ACTION_REQUIRED standalone-action variant. */
const deterministicAction = {
  origin: 'deterministic',
  actionId: 'action.notify-owner-001',
  kind: 'COMMUNICATE',
  title: 'Notify service owners of the upcoming deadline',
  description:
    'Send the deadline notice derived from the policy conclusion to every listed owner.',
  ownerKey: 'teams-service-owners',
  dueAt: '2026-10-01T00:00:00+09:00',
  supportingEvidenceIds: ['rule.no-impact'],
} as const;

/** Same action retargeted at the AI fixture's deterministic provenance. */
const deterministicActionOnAiAnalysis = {
  ...deterministicAction,
  supportingEvidenceIds: ['rule.teams-review', 'source.deadline'],
} as const;

const aiAction = {
  origin: 'ai_inference',
  actionId: 'action.draft-plan-001',
  kind: 'PLAN',
  title: 'Draft a rollout plan for the affected service',
  description:
    'Use the AI impact summary to draft tenant-specific rollout steps for review.',
  confidence: 0.82,
  supportingEvidenceIds: ['rule.teams-review', 'ai.impact-summary'],
} as const;

describe('SuggestedChangeAction kinds and origins', () => {
  it('accepts all five exact kind values in standalone actions', () => {
    const kinds = [
      'INVESTIGATE',
      'PLAN',
      'IMPLEMENT',
      'COMMUNICATE',
      'VALIDATE',
    ] as const;
    kinds.forEach((kind) => {
      const parsed = SuggestedChangeActionSchema.safeParse({
        ...deterministicAction,
        actionId: `action.${kind.toLowerCase()}`,
        kind,
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.kind).toBe(kind);
      }
    });
    expect(SuggestedChangeActionKindSchema.options).toEqual([...kinds]);
  });

  it('exposes exactly two origin values', () => {
    expect(SuggestedChangeActionOriginSchema.options).toEqual([
      'deterministic',
      'ai_inference',
    ]);
  });

  it('rejects unknown kind values outside the exact five', () => {
    const parsed = SuggestedChangeActionSchema.safeParse({
      ...deterministicAction,
      kind: 'DELEGATE',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('SuggestedChangeAction variant rules', () => {
  it('accepts a deterministic action without confidence and without assignment fields', () => {
    const parsed = SuggestedChangeActionSchema.parse({
      origin: 'deterministic',
      actionId: 'action.investigate-001',
      kind: 'INVESTIGATE',
      title: 'Investigate which teams use the retired feature',
      description: 'List every team still referencing the feature.',
      supportingEvidenceIds: ['tenant.services.stream'],
    });
    expect(parsed.origin).toBe('deterministic');
    expect('confidence' in parsed).toBe(false);
    expect('ownerKey' in parsed).toBe(false);
    expect('dueAt' in parsed).toBe(false);
  });

  it('forbids confidence on the deterministic origin entirely, including null and explicit undefined', () => {
    [0.5, 1, null, undefined].forEach((confidence) => {
      const parsed = SuggestedChangeActionSchema.safeParse({
        ...deterministicAction,
        confidence,
      });
      expect(parsed.success).toBe(false);
    });
  });

  it('carries no confidence key in the deterministic shape or any accepted parse', () => {
    const parsed = SuggestedChangeActionSchema.parse(deterministicAction);
    expect('confidence' in parsed).toBe(false);
    expect(Object.hasOwn(parsed, 'confidence')).toBe(false);

    const revived = JSON.parse(JSON.stringify(parsed)) as Record<
      string,
      unknown
    >;
    expect(Object.hasOwn(revived, 'confidence')).toBe(false);
    expect(SuggestedChangeActionSchema.safeParse(revived).success).toBe(true);
  });

  it('rejects own-property explicit undefined for ownerKey and dueAt on both origins', () => {
    const inputs = [
      { ...deterministicAction, ownerKey: undefined },
      { ...deterministicAction, dueAt: undefined },
      { ...aiAction, ownerKey: undefined },
      { ...aiAction, dueAt: undefined },
    ];
    inputs.forEach((action) => {
      const parsed = SuggestedChangeActionSchema.safeParse(action);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(
          parsed.error.issues.some((issue) =>
            issue.message.includes(
              'must be omitted entirely when unknown (no explicit undefined)',
            ),
          ),
        ).toBe(true);
      }
    });

    // Truly absent assignment fields stay accepted on both origins.
    (
      [
        ['origin', 'deterministic'],
        ['origin', 'ai_inference'],
      ] as const
    ).forEach(([, origin]) => {
      const absent = {
        origin,
        actionId: `action.absent-${origin}`,
        kind: 'VALIDATE',
        title: 'Verify the rollout outcome afterwards',
        description: 'Check tenant telemetry once the change has shipped.',
        supportingEvidenceIds:
          origin === 'deterministic'
            ? ['rule.no-impact']
            : ['rule.teams-review', 'ai.impact-summary'],
        ...(origin === 'ai_inference' ? { confidence: 0.4 } : {}),
      };
      expect(SuggestedChangeActionSchema.safeParse(absent).success).toBe(true);
    });
  });

  it('keeps JSON stringify/parse deep-equal with own-property presence intact', () => {
    const populated = SuggestedChangeActionSchema.parse(deterministicAction);
    const revivedPopulated = JSON.parse(JSON.stringify(populated));
    expect(revivedPopulated).toEqual(populated);
    expect(Object.hasOwn(revivedPopulated, 'ownerKey')).toBe(true);
    expect(Object.hasOwn(revivedPopulated, 'dueAt')).toBe(true);

    const bare = SuggestedChangeActionSchema.parse({
      origin: 'deterministic',
      actionId: 'action.bare-001',
      kind: 'INVESTIGATE',
      title: 'Investigate which teams use the retired feature',
      description: 'List every team still referencing the feature.',
      supportingEvidenceIds: ['tenant.services.stream'],
    });
    expect(Object.hasOwn(bare, 'ownerKey')).toBe(false);
    expect(Object.hasOwn(bare, 'dueAt')).toBe(false);
    const revivedBare = JSON.parse(JSON.stringify(bare));
    expect(revivedBare).toEqual(bare);
    expect(Object.hasOwn(revivedBare, 'ownerKey')).toBe(false);
    expect(Object.hasOwn(revivedBare, 'dueAt')).toBe(false);

    const ai = SuggestedChangeActionSchema.parse(aiAction);
    const revivedAi = JSON.parse(JSON.stringify(ai));
    expect(revivedAi).toEqual(ai);
    expect(revivedAi).toMatchObject({ confidence: 0.82 });
  });

  it('requires finite 0..1 confidence on the AI origin and rejects out-of-range values', () => {
    [0, 0.25, 1].forEach((confidence) => {
      const parsed = SuggestedChangeActionSchema.safeParse({
        ...aiAction,
        actionId: `action.confidence-${String(confidence)}`,
        confidence,
      });
      expect(parsed.success).toBe(true);
    });
    [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY].forEach(
      (confidence) => {
        const parsed = SuggestedChangeActionSchema.safeParse({
          ...aiAction,
          confidence,
        });
        expect(parsed.success).toBe(false);
      },
    );
  });

  it('requires non-empty title and description and rejects empty strings', () => {
    [''].forEach((empty) => {
      const titled = SuggestedChangeActionSchema.safeParse({
        ...deterministicAction,
        title: empty,
      });
      expect(titled.success).toBe(false);
      const described = SuggestedChangeActionSchema.safeParse({
        ...deterministicAction,
        description: empty,
      });
      expect(described.success).toBe(false);
      const owned = SuggestedChangeActionSchema.safeParse({
        ...deterministicAction,
        ownerKey: empty,
      });
      expect(owned.success).toBe(false);
    });
  });

  it('requires at least one supporting evidence ID and rejects duplicates', () => {
    const empty = SuggestedChangeActionSchema.safeParse({
      ...deterministicAction,
      supportingEvidenceIds: [],
    });
    expect(empty.success).toBe(false);

    const duplicate = SuggestedChangeActionSchema.safeParse({
      ...aiAction,
      supportingEvidenceIds: ['rule.teams-review', 'rule.teams-review'],
    });
    expect(duplicate.success).toBe(false);
  });

  it('preserves supportingEvidenceIds order without reordering', () => {
    const parsed = SuggestedChangeActionSchema.parse({
      ...aiAction,
      supportingEvidenceIds: ['ai.impact-summary', 'rule.teams-review'],
    });
    expect(parsed.supportingEvidenceIds).toEqual([
      'ai.impact-summary',
      'rule.teams-review',
    ]);
  });

  it('rejects strict extra fields on either variant', () => {
    const onDeterministic = SuggestedChangeActionSchema.safeParse({
      ...deterministicAction,
      note: 'extra',
    });
    expect(onDeterministic.success).toBe(false);
    const onAi = SuggestedChangeActionSchema.safeParse({
      ...aiAction,
      note: 'extra',
    });
    expect(onAi.success).toBe(false);
  });
});

describe('knownActionAssignment dueAt handling', () => {
  it('accepts Z-style UTC datetimes', () => {
    const parsed = SuggestedChangeActionSchema.parse({
      ...deterministicAction,
      dueAt: '2026-10-01T00:00:00Z',
    });
    expect(parsed.dueAt).toBe('2026-10-01T00:00:00Z');
  });

  it('accepts numeric-offset datetimes such as +09:00', () => {
    const parsed = SuggestedChangeActionSchema.parse({
      ...deterministicAction,
      dueAt: '2026-10-01T09:30:00+09:00',
    });
    expect(parsed.dueAt).toBe('2026-10-01T09:30:00+09:00');
  });

  it('rejects bare local datetime strings as deadlines', () => {
    const parsed = SuggestedChangeActionSchema.safeParse({
      ...deterministicAction,
      dueAt: '2026-10-01T00:00:00',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects epoch numbers and other non-ISO values as deadlines', () => {
    [1759248000, '2026-10-01'].forEach((dueAt) => {
      const parsed = SuggestedChangeActionSchema.safeParse({
        ...deterministicAction,
        dueAt,
      });
      expect(parsed.success).toBe(false);
    });
  });

  it('treats absent fields as unknown and rejects null or empty sentinels for ownerKey and dueAt', () => {
    [null, ''].forEach((sentinel) => {
      const owner = SuggestedChangeActionSchema.safeParse({
        ...deterministicAction,
        ownerKey: sentinel,
      });
      expect(owner.success).toBe(false);
      const due = SuggestedChangeActionSchema.safeParse({
        ...deterministicAction,
        dueAt: sentinel,
      });
      expect(due.success).toBe(false);
    });
  });
});

describe('SuggestedChangeActionResult envelope', () => {
  it('accepts deterministic actions with a no-AI ACTION_REQUIRED analysis', () => {
    const result = SuggestedChangeActionResultSchema.safeParse({
      analysisRecord: actionableNoAiAnalysis(),
      actions: [{ ...deterministicAction }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts deterministic actions with a no-AI REVIEW_REQUIRED analysis', () => {
    const analysis = actionableNoAiAnalysis();
    const assessment = asRecord(analysis.impactAssessment);
    assessment.state = 'REVIEW_REQUIRED';
    const result = SuggestedChangeActionResultSchema.safeParse({
      analysisRecord: analysis,
      actions: [{ ...deterministicAction }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts AI-origin actions with an AI-enabled REVIEW_REQUIRED analysis', () => {
    const result = SuggestedChangeActionResultSchema.safeParse({
      analysisRecord: readFixture('analysis-record-ai.json'),
      actions: [{ ...aiAction }, { ...deterministicActionOnAiAnalysis }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects explicit undefined confidence, ownerKey, and dueAt own properties inside results', () => {
    const inputs = [
      { ...deterministicAction, confidence: undefined },
      { ...deterministicAction, ownerKey: undefined },
      { ...deterministicAction, dueAt: undefined },
      { ...aiAction, ownerKey: undefined },
      { ...aiAction, dueAt: undefined },
    ];
    inputs.forEach((action) => {
      const result = SuggestedChangeActionResultSchema.safeParse({
        analysisRecord: readFixture('analysis-record-ai.json'),
        actions: [action],
      });
      expect(result.success).toBe(false);
    });
  });

  it('keeps accepted result JSON stringify/parse deep-equal with own-property presence intact', () => {
    const input = {
      analysisRecord: aiAnalysis(),
      actions: [
        { ...deterministicActionOnAiAnalysis },
        {
          origin: 'deterministic',
          actionId: 'action.bare-envelope-001',
          kind: 'VALIDATE',
          title: 'Confirm the rollout outcome afterwards',
          description: 'Check tenant telemetry once the change has shipped.',
          supportingEvidenceIds: ['rule.teams-review'],
        },
        { ...aiAction },
      ],
    };
    const parsed = SuggestedChangeActionResultSchema.parse(input);

    const populated = parsed.actions[0];
    expect(populated).toBeDefined();
    if (populated) {
      expect(Object.hasOwn(populated, 'ownerKey')).toBe(true);
      expect(Object.hasOwn(populated, 'dueAt')).toBe(true);
      expect(Object.hasOwn(populated, 'confidence')).toBe(false);
    }

    const bare = parsed.actions[1];
    expect(bare).toBeDefined();
    if (bare) {
      expect(Object.hasOwn(bare, 'ownerKey')).toBe(false);
      expect(Object.hasOwn(bare, 'dueAt')).toBe(false);
      expect(Object.hasOwn(bare, 'confidence')).toBe(false);
    }

    const aiParsedAction = parsed.actions[2];
    expect(aiParsedAction).toBeDefined();
    if (aiParsedAction && aiParsedAction.origin === 'ai_inference') {
      expect(Object.hasOwn(aiParsedAction, 'confidence')).toBe(true);
    }

    const revived = SuggestedChangeActionResultSchema.parse(
      JSON.parse(JSON.stringify(parsed)),
    );
    expect(revived).toEqual(parsed);
  });

  it('allows actions to reference any provenance record, beyond assessment evidence only', () => {
    // source.deadline is provenance but not part of the AI fixture's
    // assessment evidence list, and it is referenced here first.
    const parsed = SuggestedChangeActionSchema.safeParse({
      origin: 'deterministic',
      actionId: 'action.read-deadline',
      kind: 'INVESTIGATE',
      title: 'Confirm the message-center deadline',
      description: 'Read the raw deadline field from the source fact.',
      supportingEvidenceIds: ['source.deadline'],
    });
    expect(parsed.success).toBe(true);

    const result = SuggestedChangeActionResultSchema.safeParse({
      analysisRecord: readFixture('analysis-record-ai.json'),
      actions: [
        {
          origin: 'deterministic',
          actionId: 'action.read-deadline-result',
          kind: 'INVESTIGATE',
          title: 'Confirm the message-center deadline',
          description: 'Read the raw deadline field from the source fact.',
          supportingEvidenceIds: ['source.deadline'],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('keeps supportingEvidenceIds order inside a parsed result', () => {
    const parsed = SuggestedChangeActionResultSchema.parse({
      analysisRecord: readFixture('analysis-record-ai.json'),
      actions: [
        {
          ...aiAction,
          supportingEvidenceIds: ['ai.impact-summary', 'rule.teams-review'],
        },
      ],
    });
    expect(parsed.actions[0]?.supportingEvidenceIds).toEqual([
      'ai.impact-summary',
      'rule.teams-review',
    ]);
  });

  it('rejects results when actions are empty', () => {
    const result = SuggestedChangeActionResultSchema.safeParse({
      analysisRecord: readFixture('analysis-record-ai.json'),
      actions: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects duplicate action IDs within one result', () => {
    const result = SuggestedChangeActionResultSchema.safeParse({
      analysisRecord: readFixture('analysis-record-ai.json'),
      actions: [{ ...deterministicAction }, { ...deterministicAction }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue: { message: string }) =>
          issue.message.includes('duplicate actionId'),
        ),
      ).toBe(true);
    }
  });

  it('rejects dangling supportingEvidenceIds that provenance never contains', () => {
    const result = SuggestedChangeActionResultSchema.safeParse({
      analysisRecord: readFixture('analysis-record-ai.json'),
      actions: [
        {
          ...deterministicAction,
          supportingEvidenceIds: ['rule.teams-review', 'ghost.evidence'],
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue: { message: string }) =>
          issue.message.includes('does not exist in this analysis'),
        ),
      ).toBe(true);
    }
  });

  it('rejects deterministic actions that reference AI inference evidence', () => {
    const result = SuggestedChangeActionResultSchema.safeParse({
      analysisRecord: readFixture('analysis-record-ai.json'),
      actions: [
        {
          ...deterministicAction,
          supportingEvidenceIds: ['ai.impact-summary'],
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue: { message: string }) =>
          issue.message.includes('must not reference AI inference evidence'),
        ),
      ).toBe(true);
    }
  });

  it('rejects AI-origin actions without any AI inference reference', () => {
    const result = SuggestedChangeActionResultSchema.safeParse({
      analysisRecord: readFixture('analysis-record-ai.json'),
      actions: [{ ...aiAction, supportingEvidenceIds: ['source.deadline'] }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue: { message: string }) =>
          issue.message.includes('AI inference reference'),
        ),
      ).toBe(true);
    }
  });

  it.each(['INFORMATIONAL', 'NOT_APPLICABLE', 'INSUFFICIENT_CONTEXT'] as const)(
    'rejects a %s analysis as a non-actionable basis for suggested actions',
    (state) => {
      const analysis: Record<string, unknown> = clone(aiAnalysis());
      if (state === 'INSUFFICIENT_CONTEXT') {
        analysis.impactAssessment = {
          state,
          reason: 'The tenant profile lacks the required paths.',
          missingContext: ['/services/stream'],
        };
      } else {
        analysis.impactAssessment = {
          state,
          reason: `Reason for ${state}.`,
          evidence: ['rule.teams-review'],
        };
      }
      const result = SuggestedChangeActionResultSchema.safeParse({
        analysisRecord: analysis,
        actions: [{ ...aiAction }],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some((issue: { message: string }) =>
            issue.message.includes(
              'must be ACTION_REQUIRED or REVIEW_REQUIRED',
            ),
          ),
        ).toBe(true);
      }
    },
  );

  it('still enforces AnalysisRecord version, dependency, and evidence integrity through the bundled schema', () => {
    const mismatched = asRecord(clone(readFixture('analysis-record-ai.json')));
    const versionBundle = asRecord(mismatched.versionBundle);
    versionBundle.sourceMessageVersion = 'message-v999';

    const result = SuggestedChangeActionResultSchema.safeParse({
      analysisRecord: mismatched,
      actions: [{ ...aiAction }],
    });
    expect(result.success).toBe(false);

    const danglingDependency = asRecord(
      clone(readFixture('analysis-record-ai.json')),
    );
    const records = danglingDependency.provenanceRecords;
    if (!Array.isArray(records)) {
      throw new Error('fixture lost its provenance records');
    }
    const conclusion = asRecord(records[2]);
    conclusion.dependsOnEvidenceIds = ['missing.dependency'];

    const dependencyResult = SuggestedChangeActionResultSchema.safeParse({
      analysisRecord: danglingDependency,
      actions: [{ ...aiAction }],
    });
    expect(dependencyResult.success).toBe(false);
  });
});

describe('JSON safety and input preservation', () => {
  it('round-trips an accepted result through JSON.stringify/parse unchanged', () => {
    const input = {
      analysisRecord: aiAnalysis(),
      actions: [
        { ...deterministicActionOnAiAnalysis },
        {
          ...aiAction,
          ownerKey: 'change-manager',
          dueAt: '2026-09-15T17:00:00+02:00',
        },
      ],
    };
    const parsed = SuggestedChangeActionResultSchema.parse(input);
    const roundTripped = SuggestedChangeActionResultSchema.parse(
      JSON.parse(JSON.stringify(parsed)),
    );
    expect(roundTripped).toEqual(parsed);
  });

  it('does not mutate its inputs during parsing', () => {
    const analysisBefore = clone(aiAnalysis());
    const deterministicBefore = clone(deterministicActionOnAiAnalysis);
    const aiBefore = clone({ ...aiAction, confidence: 0.82 });
    const analysisInput = clone(analysisBefore);
    const deterministicInput = clone(deterministicBefore);
    const aiInput = clone(aiBefore);

    SuggestedChangeActionResultSchema.parse({
      analysisRecord: analysisInput,
      actions: [deterministicInput, aiInput],
    });

    expect(analysisInput).toEqual(analysisBefore);
    expect(deterministicInput).toEqual(deterministicBefore);
    expect(aiInput).toEqual(aiBefore);
  });
});
