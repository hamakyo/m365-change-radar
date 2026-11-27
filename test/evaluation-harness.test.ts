import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  GoldenCaseSchema,
  GoldenImpactStateEvaluationResultSchema,
  ObservedGoldenStateSchema,
  evaluateGoldenImpactStates,
  type GoldenCase,
  type GoldenImpactStateEvaluationResult,
  type ImpactState,
  type ObservedGoldenState,
} from '../src/index.js';

function asGoldenCase(value: unknown): GoldenCase {
  return GoldenCaseSchema.parse(value);
}

function observation(
  caseId: string,
  observedState: ImpactState,
): ObservedGoldenState {
  return ObservedGoldenStateSchema.parse({ caseId, observedState });
}

function goldenCase(input: {
  caseId: string;
  state: ImpactState;
  highImpact?: boolean;
}): GoldenCase {
  return asGoldenCase({
    caseId: input.caseId,
    synthetic: true,
    changeFixtureId: `SYNTH-CHANGE-${input.caseId}`,
    tenantProfileFixtureId: `SYNTH-TENANT-${input.caseId}`,
    expected:
      input.state === 'INSUFFICIENT_CONTEXT'
        ? {
            state: input.state,
            reason: 'test case',
            missingContext: ['tenant.capabilities.viva'],
          }
        : { state: input.state, reason: 'test case' },
    importance: input.highImpact ? 'high' : 'medium',
    highImpact: input.highImpact ?? false,
    coverageTags: ['informational'],
    evaluationTags: ['unit-test'],
  });
}

function loadRealGoldenCases(): GoldenCase[] {
  const corpusRoot = resolve(process.cwd(), 'corpus');
  const manifest = JSON.parse(
    readFileSync(join(corpusRoot, 'manifest.json'), 'utf8'),
  ) as { goldenCases: Array<{ path: string }> };
  return manifest.goldenCases.map((entry) =>
    asGoldenCase(
      JSON.parse(readFileSync(join(corpusRoot, entry.path), 'utf8')),
    ),
  );
}

/**
 * A self-consistent result for a two-case evaluation:
 * expected [INFORMATIONAL, INFORMATIONAL], observed [ACTION_REQUIRED,
 * INFORMATIONAL]. Every invariant holds; individual tamper tests mutate
 * exactly one aspect to prove each check fires independently.
 */
const CONSISTENT_RESULT: GoldenImpactStateEvaluationResult = {
  totalCases: 2,
  exactMatchCount: 1,
  exactMatchAccuracy: 0.5,

  highImpactCases: 0,
  highImpactFalseNegatives: 0,
  highImpactFalseNegativeRate: null,

  expectedPositiveCases: 0,
  truePositives: 0,
  falseNegatives: 0,
  observedPositives: 1,
  falsePositives: 1,
  recall: null,
  precision: 0,
  noiseRate: 1,

  expectedInsufficientContextCases: 0,
  correctInsufficientContextCount: 0,
  insufficientContextAccuracy: null,
};

/** Every count zero and every rate null — the unique valid empty result. */
const VACUOUS_EMPTY_RESULT: GoldenImpactStateEvaluationResult = {
  totalCases: 0,
  exactMatchCount: 0,
  exactMatchAccuracy: null,

  highImpactCases: 0,
  highImpactFalseNegatives: 0,
  highImpactFalseNegativeRate: null,

  expectedPositiveCases: 0,
  truePositives: 0,
  falseNegatives: 0,
  observedPositives: 0,
  falsePositives: 0,
  recall: null,
  precision: null,
  noiseRate: null,

  expectedInsufficientContextCases: 0,
  correctInsufficientContextCount: 0,
  insufficientContextAccuracy: null,
};

describe('evaluation harness contracts', () => {
  it('produces perfect metrics for the real 65-case corpus evaluated at its expected states', () => {
    const goldenCases = loadRealGoldenCases();
    expect(goldenCases).toHaveLength(65);

    const observations = goldenCases.map((goldenCase) =>
      observation(goldenCase.caseId, goldenCase.expected.state),
    );

    const result = evaluateGoldenImpactStates(goldenCases, observations);

    expect(result.totalCases).toBe(65);
    expect(result.exactMatchCount).toBe(65);
    expect(result.exactMatchAccuracy).toBe(1);
    expect(result.expectedPositiveCases).toBe(39);
    expect(result.truePositives).toBe(39);
    expect(result.falseNegatives).toBe(0);
    expect(result.observedPositives).toBe(39);
    expect(result.falsePositives).toBe(0);
    expect(result.recall).toBe(1);
    expect(result.precision).toBe(1);
    expect(result.noiseRate).toBe(0);
    const realInsufficientCount = goldenCases.filter(
      (goldenCase) => goldenCase.expected.state === 'INSUFFICIENT_CONTEXT',
    ).length;
    expect(result.expectedInsufficientContextCases).toBe(realInsufficientCount);
    expect(result.correctInsufficientContextCount).toBe(realInsufficientCount);
    if (realInsufficientCount === 0) {
      // Zero denominators stay null instead of inventing numbers.
      expect(result.insufficientContextAccuracy).toBe(null);
    } else {
      expect(result.insufficientContextAccuracy).toBe(1);
    }
    expect(result.highImpactFalseNegativeRate).toBe(0);
  });

  it('accepts the canonical hand-built consistent record as schema-valid', () => {
    expect(() =>
      GoldenImpactStateEvaluationResultSchema.parse(CONSISTENT_RESULT),
    ).not.toThrow();
  });

  it('returns exactly the vacuous record for empty inputs', () => {
    expect(evaluateGoldenImpactStates([], [])).toEqual(VACUOUS_EMPTY_RESULT);
  });

  it('counts a deliberate high-impact false negative', () => {
    const goldenCases = [
      goldenCase({ caseId: 'A1', state: 'ACTION_REQUIRED', highImpact: true }),
      goldenCase({ caseId: 'A2', state: 'INFORMATIONAL', highImpact: false }),
    ];
    const observations = [
      observation('A1', 'NOT_APPLICABLE'),
      observation('A2', 'INFORMATIONAL'),
    ];

    const result = evaluateGoldenImpactStates(goldenCases, observations);

    expect(result.totalCases).toBe(2);
    expect(result.exactMatchCount).toBe(1);
    expect(result.exactMatchAccuracy).toBeCloseTo(0.5);
    expect(result.highImpactCases).toBe(1);
    expect(result.highImpactFalseNegatives).toBe(1);
    expect(result.highImpactFalseNegativeRate).toBe(1);
    expect(result.recall).toBe(0);
    expect(result.precision).toBe(null);
    expect(result.noiseRate).toBe(null);
  });

  it('treats an observed positive on a non-positive expectation as a false positive and noise', () => {
    const goldenCases = [
      goldenCase({ caseId: 'B1', state: 'INFORMATIONAL', highImpact: false }),
      goldenCase({ caseId: 'B2', state: 'REVIEW_REQUIRED', highImpact: true }),
    ];
    const observations = [
      observation('B1', 'ACTION_REQUIRED'),
      observation('B2', 'REVIEW_REQUIRED'),
    ];

    const result = evaluateGoldenImpactStates(goldenCases, observations);

    expect(result.truePositives).toBe(1);
    expect(result.falsePositives).toBe(1);
    expect(result.observedPositives).toBe(2);
    expect(result.recall).toBe(1);
    expect(result.precision).toBe(0.5);
    expect(result.noiseRate).toBe(0.5);
    expect(result.highImpactFalseNegatives).toBe(0);
    expect(result.highImpactFalseNegativeRate).toBe(0);
  });

  it('measures insufficient-context accuracy against the real corpus with injected context errors', () => {
    const goldenCases = loadRealGoldenCases();
    const insufficient = goldenCases.filter(
      (goldenCase) => goldenCase.expected.state === 'INSUFFICIENT_CONTEXT',
    );
    expect(insufficient.length).toBeGreaterThan(0);

    // Corrupt every insufficient-context observation into INFORMATIONAL, keep
    // everything else perfect.
    const observations = goldenCases.map((goldenCase) =>
      observation(
        goldenCase.caseId,
        goldenCase.expected.state === 'INSUFFICIENT_CONTEXT'
          ? 'INFORMATIONAL'
          : goldenCase.expected.state,
      ),
    );

    const result = evaluateGoldenImpactStates(goldenCases, observations);

    expect(result.expectedInsufficientContextCases).toBe(insufficient.length);
    expect(result.correctInsufficientContextCount).toBe(0);
    expect(result.insufficientContextAccuracy).toBe(0);

    const repaired = observations.map((entry) =>
      entry.observedState === 'INFORMATIONAL' &&
      goldenCases.find((goldenCase) => goldenCase.caseId === entry.caseId)
        ?.expected.state === 'INSUFFICIENT_CONTEXT'
        ? observation(entry.caseId, 'INSUFFICIENT_CONTEXT')
        : entry,
    );
    const repairedResult = evaluateGoldenImpactStates(goldenCases, repaired);
    expect(repairedResult.insufficientContextAccuracy).toBe(1);
  });

  it('rejects duplicate golden cases, duplicate observations, missing and surplus observations', () => {
    const first = goldenCase({ caseId: 'C1', state: 'INFORMATIONAL' });
    const second = goldenCase({ caseId: 'C2', state: 'INFORMATIONAL' });
    const goldenCases = [first, second];
    const observations = [
      observation('C1', 'INFORMATIONAL'),
      observation('C2', 'INFORMATIONAL'),
    ];

    expect(() =>
      evaluateGoldenImpactStates([first, second, first], observations),
    ).toThrowError(/duplicate golden caseIds: C1/);

    expect(() =>
      evaluateGoldenImpactStates(goldenCases, [
        ...observations,
        observation('C1', 'INFORMATIONAL'),
      ]),
    ).toThrowError(/duplicate observation caseIds: C1/);

    expect(() =>
      evaluateGoldenImpactStates(goldenCases, [
        observation('C1', 'INFORMATIONAL'),
      ]),
    ).toThrowError(/missing observations for caseIds: C2/);

    expect(() =>
      evaluateGoldenImpactStates(goldenCases, [
        ...observations,
        observation('UNKNOWN-CASE', 'INFORMATIONAL'),
      ]),
    ).toThrowError(/observations for unknown caseIds: UNKNOWN-CASE/);
  });

  it('enforces strict schemas on both inputs and rejects unknown extra fields (via explicit casts)', () => {
    const goldenCases = [goldenCase({ caseId: 'D1', state: 'INFORMATIONAL' })];

    // TypeScript's input contract already prevents this statically; a JS
    // caller or unsafe cast must still be rejected by the runtime re-parse.
    expect(() =>
      evaluateGoldenImpactStates(
        [
          {
            ...goldenCases[0],
            extraField: true,
          } as unknown as GoldenCase,
        ],
        [observation('D1', 'INFORMATIONAL')],
      ),
    ).toThrow(/extraField/);

    expect(() =>
      evaluateGoldenImpactStates(goldenCases, [
        {
          caseId: 'D1',
          observedState: 'INFORMATIONAL',
          reason: 'extra fields are rejected',
        } as unknown as ObservedGoldenState,
      ]),
    ).toThrow(/reason/);

    expect(() =>
      evaluateGoldenImpactStates(goldenCases, [
        {
          caseId: 'D1',
          observedState: 'TERRIBLY_WRONG_STATE',
        } as unknown as ObservedGoldenState,
      ]),
    ).toThrow();
  });

  it('does not mutate its inputs', () => {
    const goldenCases = [
      goldenCase({ caseId: 'E1', state: 'REVIEW_REQUIRED', highImpact: true }),
      goldenCase({ caseId: 'E2', state: 'INFORMATIONAL' }),
    ];
    const observations = [
      observation('E1', 'REVIEW_REQUIRED'),
      observation('E2', 'ACTION_REQUIRED'),
    ];
    const frozenGoldens = Object.freeze([...goldenCases]);
    const frozenObservations = Object.freeze([...observations]);
    const goldensSnapshot = JSON.stringify(frozenGoldens);
    const observationsSnapshot = JSON.stringify(frozenObservations);

    evaluateGoldenImpactStates(frozenGoldens, frozenObservations);

    expect(JSON.stringify(frozenGoldens)).toBe(goldensSnapshot);
    expect(JSON.stringify(frozenObservations)).toBe(observationsSnapshot);
  });

  it('is deterministic regardless of input ordering (round-trip deep-equal)', () => {
    const goldenCases = loadRealGoldenCases();
    const observations = goldenCases.map((goldenCase) =>
      observation(goldenCase.caseId, goldenCase.expected.state),
    );

    const forward = evaluateGoldenImpactStates(goldenCases, observations);
    const reversed = evaluateGoldenImpactStates(
      [...goldenCases].reverse(),
      [...observations].reverse(),
    );

    expect(reversed).toEqual(forward);
    // Round-trip through JSON keeps the result valid under the same schema.
    expect(() =>
      GoldenImpactStateEvaluationResultSchema.parse(
        JSON.parse(JSON.stringify(forward)),
      ),
    ).not.toThrow();
  });

  it('emits only finite in-range rates or null, never fabricated numbers', () => {
    const goldenCases = [
      goldenCase({ caseId: 'F1', state: 'ACTION_REQUIRED', highImpact: false }),
    ];
    const observations = [observation('F1', 'ACTION_REQUIRED')];
    const result = evaluateGoldenImpactStates(goldenCases, observations);
    // Every present rate is finite within [0, 1]; absent ones are null.
    for (const value of [
      result.exactMatchAccuracy,
      result.highImpactFalseNegativeRate,
      result.recall,
      result.precision,
      result.noiseRate,
      result.insufficientContextAccuracy,
    ]) {
      expect(value === null || Number.isFinite(value)).toBe(true);
    }
    expect(result.falsePositives).toBe(0);
    expect(result.falseNegatives).toBe(0);
    expect(result.noiseRate).toBe(0);
    expect(result.insufficientContextAccuracy).toBe(null);
  });
});

describe('evaluation result schema cross-field integrity', () => {
  function tampered(
    patch: Partial<Record<keyof GoldenImpactStateEvaluationResult, unknown>>,
  ): Record<string, unknown> {
    return { ...CONSISTENT_RESULT, ...patch };
  }

  it.each`
    field                                 | value | expectedMessage
    ${'exactMatchCount'}                  | ${3}  | ${/exceeds totalCases/}
    ${'highImpactCases'}                  | ${5}  | ${/exceeds totalCases/}
    ${'highImpactFalseNegatives'}         | ${1}  | ${/exceeds highImpactCases/}
    ${'expectedPositiveCases'}            | ${9}  | ${/exceeds totalCases/}
    ${'observedPositives'}                | ${4}  | ${/exceeds totalCases/}
    ${'truePositives'}                    | ${1}  | ${/exceeds (expectedPositiveCases|observedPositives)/}
    ${'expectedInsufficientContextCases'} | ${7}  | ${/exceeds totalCases/}
    ${'correctInsufficientContextCount'}  | ${1}  | ${/exceeds expectedInsufficientContextCases/}
  `(
    'rejects $field=$value violating a count bound',
    ({ field, value, expectedMessage }) => {
      expect(() =>
        GoldenImpactStateEvaluationResultSchema.parse(
          tampered({ [field]: value }),
        ),
      ).toThrowError(expectedMessage);
    },
  );

  it.each`
    field                            | value
    ${'exactMatchAccuracy'}          | ${0.75}
    ${'highImpactFalseNegativeRate'} | ${0.25}
    ${'recall'}                      | ${1}
    ${'precision'}                   | ${0.5}
    ${'noiseRate'}                   | ${0}
    ${'insufficientContextAccuracy'} | ${1}
  `(
    'rejects tampered $field whose formula no longer matches the counts',
    ({ field, value }) => {
      expect(() =>
        GoldenImpactStateEvaluationResultSchema.parse(
          tampered({ [field]: value }),
        ),
      ).toThrowError(/rate must equal/);
    },
  );

  it('rejects a numeric rate kept where its denominator is zero', () => {
    expect(() =>
      GoldenImpactStateEvaluationResultSchema.parse(
        tampered({ highImpactFalseNegativeRate: 0 }),
      ),
    ).toThrowError(/rate must equal/);
  });

  it('rejects a null rate where its denominator is non-zero', () => {
    expect(() =>
      GoldenImpactStateEvaluationResultSchema.parse(
        tampered({ precision: null }),
      ),
    ).toThrowError(/rate must equal/);
  });

  it('rejects falseNegatives inconsistent with expectedPositiveCases - truePositives', () => {
    // Make expected positives non-zero (and recall consistent) so only the
    // falseNegatives equation can fire.
    expect(() =>
      GoldenImpactStateEvaluationResultSchema.parse(
        tampered({ expectedPositiveCases: 1, recall: 0 }),
      ),
    ).toThrowError(/falseNegatives must equal/);
  });

  it('rejects falsePositives inconsistent with observedPositives - truePositives', () => {
    expect(() =>
      GoldenImpactStateEvaluationResultSchema.parse(
        tampered({
          observedPositives: 2,
          noiseRate: 0.5,
          exactMatchAccuracy: 0,
          exactMatchCount: 0,
        }),
      ),
    ).toThrowError(/falsePositives must equal/);
  });

  it('rejects an empty evaluation carrying any non-vacuous count or rate', () => {
    expect(() =>
      GoldenImpactStateEvaluationResultSchema.parse(
        tampered({ totalCases: 0, exactMatchCount: 99 }),
      ),
    ).toThrowError(/must carry zero counts and null rates only/);
    expect(() =>
      GoldenImpactStateEvaluationResultSchema.parse(
        tampered({ totalCases: 0, falsePositives: 1 }),
      ),
    ).toThrowError(/must carry zero counts and null rates only/);
    expect(() =>
      GoldenImpactStateEvaluationResultSchema.parse(
        tampered({ totalCases: 0, recall: 1 }),
      ),
    ).toThrowError(/must carry zero counts and null rates only/);
  });

  it.each`
    field                   | value
    ${'exactMatchAccuracy'} | ${Number.NaN}
    ${'precision'}          | ${Number.POSITIVE_INFINITY}
    ${'noiseRate'}          | ${Number.NEGATIVE_INFINITY}
    ${'exactMatchCount'}    | ${1.5}
    ${'totalCases'}         | ${-1}
    ${'exactMatchCount'}    | ${null}
  `('rejects malformed $field ($value)', ({ field, value }) => {
    expect(() =>
      GoldenImpactStateEvaluationResultSchema.parse(
        tampered({ [field]: value }),
      ),
    ).toThrow();
  });

  it('rejects unknown extra fields on the result record', () => {
    expect(() =>
      GoldenImpactStateEvaluationResultSchema.parse(
        tampered({
          unsupportedClaimRate: 0.01,
        } as Record<string, unknown>),
      ),
    ).toThrowError(/unsupportedClaimRate/);
  });
});
