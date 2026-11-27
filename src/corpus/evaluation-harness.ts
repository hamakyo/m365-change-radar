import { z } from 'zod';

import type { ImpactState } from '../domain/impact-assessment.js';
import { ImpactStateSchema } from '../domain/impact-assessment.js';
import {
  CorpusFixtureIdSchema,
  GoldenCaseSchema,
  type GoldenCase,
} from './golden-corpus.js';

const rateSchema = z.number().finite().min(0).max(1).nullable();

export const ObservedGoldenStateSchema = z
  .object({
    caseId: CorpusFixtureIdSchema,
    observedState: ImpactStateSchema,
  })
  .strict();
export type ObservedGoldenState = z.infer<typeof ObservedGoldenStateSchema>;

const intCountSchema = z.number().int().min(0);

const GoldenImpactStateEvaluationResultBaseSchema = z
  .object({
    totalCases: intCountSchema,
    exactMatchCount: intCountSchema,
    exactMatchAccuracy: rateSchema,

    highImpactCases: intCountSchema,
    highImpactFalseNegatives: intCountSchema,
    highImpactFalseNegativeRate: rateSchema,

    expectedPositiveCases: intCountSchema,
    truePositives: intCountSchema,
    falseNegatives: intCountSchema,
    observedPositives: intCountSchema,
    falsePositives: intCountSchema,
    recall: rateSchema,
    precision: rateSchema,
    noiseRate: rateSchema,

    expectedInsufficientContextCases: intCountSchema,
    correctInsufficientContextCount: intCountSchema,
    insufficientContextAccuracy: rateSchema,
  })
  .strict();

type GoldenImpactStateEvaluationBase = z.infer<
  typeof GoldenImpactStateEvaluationResultBaseSchema
>;

function rateIssue(context: z.RefinementCtx, path: PropertyKey[]): void {
  context.addIssue({
    code: 'custom',
    path,
    message:
      'rate must equal count/denominator exactly (null when denominator is 0)',
  });
}

function expectRate(
  context: z.RefinementCtx,
  path: PropertyKey[],
  actual: number | null,
  numerator: number,
  denominator: number,
): void {
  if (denominator === 0) {
    if (actual !== null) {
      rateIssue(context, path);
    }
    return;
  }
  if (actual === null || actual !== numerator / denominator) {
    rateIssue(context, path);
  }
}

/**
 * Cross-field invariants that keep the counts and rates mutually consistent.
 * A tampered record (any count or rate edited independently, a rate kept as a
 * number where its denominator is zero, NaN/Infinity leaking through, or an
 * empty evaluation carrying non-vacuous values) fails validation.
 */
const crossFieldRefinement = (
  result: GoldenImpactStateEvaluationBase,
  context: z.RefinementCtx,
): void => {
  const {
    totalCases,
    exactMatchCount,
    exactMatchAccuracy,
    highImpactCases,
    highImpactFalseNegatives,
    highImpactFalseNegativeRate,
    expectedPositiveCases,
    truePositives,
    falseNegatives,
    observedPositives,
    falsePositives,
    recall,
    precision,
    noiseRate,
    expectedInsufficientContextCases,
    correctInsufficientContextCount,
    insufficientContextAccuracy,
  } = result;

  const bounds: Array<[string, number, string, number]> = [
    ['exactMatchCount', exactMatchCount, 'totalCases', totalCases],
    ['highImpactCases', highImpactCases, 'totalCases', totalCases],
    [
      'highImpactFalseNegatives',
      highImpactFalseNegatives,
      'highImpactCases',
      highImpactCases,
    ],
    ['expectedPositiveCases', expectedPositiveCases, 'totalCases', totalCases],
    ['observedPositives', observedPositives, 'totalCases', totalCases],
    [
      'truePositives_vs_expected',
      truePositives,
      'expectedPositiveCases',
      expectedPositiveCases,
    ],
    [
      'truePositives_vs_observed',
      truePositives,
      'observedPositives',
      observedPositives,
    ],
    [
      'falsePositives_vs_observed',
      falsePositives,
      'observedPositives',
      observedPositives,
    ],
    [
      'expectedInsufficientContextCases',
      expectedInsufficientContextCases,
      'totalCases',
      totalCases,
    ],
    [
      'correctInsufficientContextCount',
      correctInsufficientContextCount,
      'expectedInsufficientContextCases',
      expectedInsufficientContextCases,
    ],
  ];
  for (const [name, value, boundName, bound] of bounds) {
    if (value > bound) {
      context.addIssue({
        code: 'custom',
        path: [name],
        message: `${name} (${value}) exceeds ${boundName} (${bound})`,
      });
    }
  }

  if (falseNegatives !== expectedPositiveCases - truePositives) {
    context.addIssue({
      code: 'custom',
      path: ['falseNegatives'],
      message:
        'falseNegatives must equal expectedPositiveCases - truePositives',
    });
  }

  if (falsePositives !== observedPositives - truePositives) {
    context.addIssue({
      code: 'custom',
      path: ['falsePositives'],
      message: 'falsePositives must equal observedPositives - truePositives',
    });
  }

  expectRate(
    context,
    ['exactMatchAccuracy'],
    exactMatchAccuracy,
    exactMatchCount,
    totalCases,
  );
  expectRate(
    context,
    ['highImpactFalseNegativeRate'],
    highImpactFalseNegativeRate,
    highImpactFalseNegatives,
    highImpactCases,
  );
  expectRate(context, ['recall'], recall, truePositives, expectedPositiveCases);
  expectRate(
    context,
    ['precision'],
    precision,
    truePositives,
    observedPositives,
  );
  expectRate(
    context,
    ['noiseRate'],
    noiseRate,
    falsePositives,
    observedPositives,
  );
  expectRate(
    context,
    ['insufficientContextAccuracy'],
    insufficientContextAccuracy,
    correctInsufficientContextCount,
    expectedInsufficientContextCases,
  );

  // An empty evaluation is valid only when it is fully vacuous: every count
  // zero and every rate null. Nothing else may hide behind totalCases: 0.
  if (totalCases === 0) {
    const counts = [
      exactMatchCount,
      highImpactCases,
      highImpactFalseNegatives,
      expectedPositiveCases,
      truePositives,
      falseNegatives,
      observedPositives,
      falsePositives,
      expectedInsufficientContextCases,
      correctInsufficientContextCount,
    ];
    const rates = [
      exactMatchAccuracy,
      highImpactFalseNegativeRate,
      recall,
      precision,
      noiseRate,
      insufficientContextAccuracy,
    ];
    if (
      counts.some((count) => count !== 0) ||
      rates.some((rate) => rate !== null)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['totalCases'],
        message:
          'an empty evaluation (totalCases: 0) must carry zero counts and null rates only',
      });
    }
  }
};

export const GoldenImpactStateEvaluationResultSchema =
  GoldenImpactStateEvaluationResultBaseSchema.superRefine(crossFieldRefinement);
export type GoldenImpactStateEvaluationResult = z.infer<
  typeof GoldenImpactStateEvaluationResultSchema
>;

function ratio(numerator: number, denominator: number): number | null {
  // Zero-denominator rates stay null instead of inventing a number.
  if (denominator === 0) return null;
  return numerator / denominator;
}

function isObservedPositive(state: ImpactState): boolean {
  return state === 'ACTION_REQUIRED' || state === 'REVIEW_REQUIRED';
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function sortedStrings(values: readonly string[]): string[] {
  return [...values].sort(compareStrings);
}

function findDuplicateCaseIds(caseIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const caseId of caseIds) {
    if (seen.has(caseId)) {
      duplicates.add(caseId);
    }
    seen.add(caseId);
  }
  return sortedStrings([...duplicates]);
}

/**
 * Pure deterministic evaluation of golden impact states.
 *
 * Both inputs are re-parsed against their strict schemas (so unsafe casts or
 * JS callers passing invalid data are still rejected at runtime) and never
 * mutated. The returned result validates itself against
 * `GoldenImpactStateEvaluationResultSchema` and is JSON-safe. Identical case
 * sets and observation sets always produce a deep-equal result regardless of
 * input array ordering.
 *
 * Rejected inputs:
 * - duplicate golden case IDs;
 * - duplicate observation case IDs;
 * - missing observations (a golden case without an observation);
 * - surplus observations (an observation for an unknown case ID).
 */
export function evaluateGoldenImpactStates(
  goldenCasesInput: readonly GoldenCase[],
  observationsInput: readonly ObservedGoldenState[],
): GoldenImpactStateEvaluationResult {
  const goldenCases = goldenCasesInput.map((entry) =>
    GoldenCaseSchema.parse(entry),
  );
  const observations = observationsInput.map((entry) =>
    ObservedGoldenStateSchema.parse(entry),
  );

  const duplicateGoldenCaseIds = findDuplicateCaseIds(
    goldenCases.map((goldenCase) => goldenCase.caseId),
  );
  if (duplicateGoldenCaseIds.length > 0) {
    throw new Error(
      `duplicate golden caseIds: ${duplicateGoldenCaseIds.join(', ')}`,
    );
  }

  const duplicateObservationCaseIds = findDuplicateCaseIds(
    observations.map((observation) => observation.caseId),
  );
  if (duplicateObservationCaseIds.length > 0) {
    throw new Error(
      `duplicate observation caseIds: ${duplicateObservationCaseIds.join(', ')}`,
    );
  }

  const observationStateByCaseId = new Map<string, ImpactState>();
  for (const observation of observations) {
    observationStateByCaseId.set(observation.caseId, observation.observedState);
  }

  const missingObservationCaseIds = sortedStrings(
    goldenCases
      .filter((goldenCase) => !observationStateByCaseId.has(goldenCase.caseId))
      .map((goldenCase) => goldenCase.caseId),
  );
  if (missingObservationCaseIds.length > 0) {
    throw new Error(
      `missing observations for caseIds: ${missingObservationCaseIds.join(', ')}`,
    );
  }

  const goldenCaseIds = new Set(goldenCases.map((c) => c.caseId));
  const surplusObservationCaseIds = sortedStrings(
    observations
      .map((observation) => observation.caseId)
      .filter((caseId) => !goldenCaseIds.has(caseId)),
  );
  if (surplusObservationCaseIds.length > 0) {
    throw new Error(
      `observations for unknown caseIds: ${surplusObservationCaseIds.join(', ')}`,
    );
  }

  // Accumulate in canonical (sorted-by-caseId) order so every counter depends
  // only on set membership, never on input array order.
  const sortedGoldenCases = [...goldenCases].sort((a, b) =>
    compareStrings(a.caseId, b.caseId),
  );

  let exactMatchCount = 0;

  let highImpactCases = 0;
  let highImpactFalseNegatives = 0;

  let expectedPositiveCases = 0;
  let truePositives = 0;
  let falseNegatives = 0;
  let observedPositives = 0;
  let falsePositives = 0;

  let expectedInsufficientContextCases = 0;
  let correctInsufficientContextCount = 0;

  for (const goldenCase of sortedGoldenCases) {
    const observedState = observationStateByCaseId.get(goldenCase.caseId);
    const expectedState = goldenCase.expected.state;

    if (observedState === expectedState) {
      exactMatchCount += 1;
    }

    if (goldenCase.highImpact) {
      highImpactCases += 1;
      if (observedState === undefined || !isObservedPositive(observedState)) {
        highImpactFalseNegatives += 1;
      }
    }

    const expectedPositive =
      expectedState === 'ACTION_REQUIRED' ||
      expectedState === 'REVIEW_REQUIRED';

    if (expectedPositive) {
      expectedPositiveCases += 1;
    }

    if (observedState !== undefined && isObservedPositive(observedState)) {
      observedPositives += 1;
      if (expectedPositive) {
        truePositives += 1;
      } else {
        falsePositives += 1;
      }
    } else if (expectedPositive) {
      falseNegatives += 1;
    }

    if (expectedState === 'INSUFFICIENT_CONTEXT') {
      expectedInsufficientContextCases += 1;
      if (observedState === 'INSUFFICIENT_CONTEXT') {
        correctInsufficientContextCount += 1;
      }
    }
  }

  return GoldenImpactStateEvaluationResultSchema.parse({
    totalCases: sortedGoldenCases.length,
    exactMatchCount,
    exactMatchAccuracy: ratio(exactMatchCount, sortedGoldenCases.length),

    highImpactCases,
    highImpactFalseNegatives,
    highImpactFalseNegativeRate: ratio(
      highImpactFalseNegatives,
      highImpactCases,
    ),

    expectedPositiveCases,
    truePositives,
    falseNegatives,
    observedPositives,
    falsePositives,
    recall: ratio(truePositives, expectedPositiveCases),
    precision: ratio(truePositives, observedPositives),
    noiseRate: ratio(falsePositives, observedPositives),

    expectedInsufficientContextCases,
    correctInsufficientContextCount,
    insufficientContextAccuracy: ratio(
      correctInsufficientContextCount,
      expectedInsufficientContextCases,
    ),
  });
}
