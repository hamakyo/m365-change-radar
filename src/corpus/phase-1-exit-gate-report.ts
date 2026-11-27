import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { createDeterministicSuggestedActionOutput } from '../domain/deterministic-suggested-action-generator.js';
import type { ImpactState } from '../domain/impact-assessment.js';
import { RiskPolicySchema, type RiskPolicy } from '../domain/risk-policy.js';
import {
  TenantApplicabilityPolicySchema,
  type TenantApplicabilityPolicy,
} from '../domain/tenant-applicability.js';
import type { AnalyzeCommandSummary } from './analyze-cli.js';
import { createFixedInformationalClassifier } from './analyze-cli.js';
import {
  evaluateGoldenImpactStates,
  type GoldenImpactStateEvaluationResult,
  type ObservedGoldenState,
} from './evaluation-harness.js';
import {
  CorpusCollectionSchema,
  CorpusManifestSchema,
  type CorpusCollection,
} from './golden-corpus.js';
import type { ImpactAnalysisMatrixMetadataFactory } from './impact-analysis-matrix-runner.js';
import { runImpactAnalysisMatrix } from './impact-analysis-matrix-runner.js';

/**
 * Sentinel for Phase 1 exit-gate metrics the provider-free execution path
 * cannot legitimately produce. A `NOT_MEASURED` value counts as neither a
 * pass nor a fail; it is reported with a reason and blocks `PROCEED`.
 */
export const NOT_MEASURED = 'NOT_MEASURED';
export type NotMeasured = typeof NOT_MEASURED;

/** Status of one measured mandatory gate condition. */
export type MeasuredGateStatus = 'PASS' | 'FAIL';

/** One evaluated mandatory condition with its lossless reason. */
export type MeasuredGateCondition = {
  readonly status: MeasuredGateStatus;
  readonly reason: string;
};

/**
 * The measured mandatory Phase 1 exit-gate conditions, in fixed key order.
 * `PROCEED` requires every one of them to be `PASS`.
 */
export type MeasuredGateConditions = {
  readonly highImpactFalseNegatives: MeasuredGateCondition;
  readonly recall: MeasuredGateCondition;
  readonly insufficientContextAccuracy: MeasuredGateCondition;
};

/** One gate metric the provider-free path cannot measure. */
export type UnmeasuredMetric = {
  readonly status: NotMeasured;
  readonly reason: string;
};

/** The three Phase 1 gate metrics that are never measurable provider-free. */
export type Phase1UnmeasuredMetrics = {
  readonly modelCost: UnmeasuredMetric;
  readonly providerLatency: UnmeasuredMetric;
  readonly unsupportedClaimRate: UnmeasuredMetric;
};

/** Exit-gate decisions. `PROCEED` requires zero gate blockers. */
export type Phase1ExitGateDecision = 'PROCEED' | 'HOLD';

/** Required values for the measured mandatory gate conditions. */
export const PHASE1_REQUIRED_HIGH_IMPACT_FALSE_NEGATIVES = 0;
export const PHASE1_REQUIRED_RECALL = 1;
export const PHASE1_REQUIRED_INSUFFICIENT_CONTEXT_ACCURACY = 1;

/** Every gate metric that can appear as a blocker, in blocker output order. */
export type Phase1ExitGateBlockerMetric =
  | 'highImpactFalseNegatives'
  | 'recall'
  | 'insufficientContextAccuracy'
  | 'modelCost'
  | 'providerLatency'
  | 'unsupportedClaimRate';

/** Status carried by a blocker: a failed measured condition or unmeasured. */
export type Phase1ExitGateBlockerStatus = 'FAIL' | NotMeasured;

/**
 * One gate blocker with its lossless reason. Blockers are ordered: measured
 * `FAIL` blockers first in the fixed `MeasuredGateConditions` key order,
 * then unmeasured blockers in the fixed `Phase1UnmeasuredMetrics` key order.
 */
export type Phase1ExitGateBlocker = {
  readonly metric: Phase1ExitGateBlockerMetric;
  readonly status: Phase1ExitGateBlockerStatus;
  readonly reason: string;
};

/**
 * The deterministic Phase 1 exit-gate report. Every member is derived from
 * the tracked corpus and pre-existing parts only; key order is fixed by the
 * assembly site so repeated runs are byte-identical.
 */
export type Phase1ExitGateReport = {
  /** Corpus identity of the tracked manifest backing the whole report. */
  readonly corpus: {
    readonly corpusId: string;
    readonly corpusVersion: string;
  };
  /** Number of golden cases the pair results were joined onto (65). */
  readonly goldenCaseCount: number;
  /** The same matrix run's 500-pair summary (existing analyze summary shape). */
  readonly analyzeSummary: AnalyzeCommandSummary;
  /** Existing golden evaluation metrics recomputed over the same-run join. */
  readonly measuredMetrics: GoldenImpactStateEvaluationResult;
  /** Measured mandatory gate conditions evaluated from `measuredMetrics`. */
  readonly measuredGateConditions: MeasuredGateConditions;
  /** Gate metrics the provider-free path cannot measure, with fixed keys. */
  readonly unmeasuredMetrics: Phase1UnmeasuredMetrics;
  /**
   * `PROCEED` only when every measured mandatory condition is `PASS` and no
   * gate metric is unmeasured; `HOLD` otherwise.
   */
  readonly decision: Phase1ExitGateDecision;
  /** Measured `FAIL` blockers first, then unmeasured ones; fixed order. */
  readonly blockers: readonly Phase1ExitGateBlocker[];
};

/** Result of the Phase 1 exit-gate report command. On success `stdout` is
 * exactly the one-line JSON report plus its single trailing newline; on
 * failure `stdout` is always empty, so partial output is never emitted. */
export type Phase1ExitGateCommandResult = {
  exitCode: 0 | 1;
  stdout: string;
  stderr: string;
};

/**
 * Seam that keeps the command free of direct `process` access so tests can
 * point the loader at a different repository root without touching global
 * state.
 */
export type Phase1ExitGateCommandIo = {
  /** Returns the repository root that contains `corpus/` and `test/fixtures/`. */
  resolveProjectRoot(): string;
};

const DEFAULT_IO: Phase1ExitGateCommandIo = {
  resolveProjectRoot: () => process.cwd(),
};

/** The tracked Phase 1 corpus carries exactly 65 golden cases. */
export const PHASE1_EXPECTED_GOLDEN_CASE_COUNT = 65;

/** The tracked corpus matrix carries exactly 50 x 10 = 500 pairs. */
export const PHASE1_EXPECTED_PAIR_COUNT = 500;

/**
 * Fixed caller-owned source message version applied to every pair of the
 * exit-gate run, distinct from the analyze CLI's constant so recorded
 * provenance always names the command that produced it.
 */
const PHASE1_EXIT_GATE_SOURCE_MESSAGE_VERSION = 'phase1-exit-gate-1';

/** Fixed `createdAt` for every pair's analysis envelope metadata. No clock
 * is ever consulted; the value is a constant, offset-aware ISO datetime. */
const FIXED_CREATED_AT = '1970-01-01T00:00:00.000Z';

/**
 * Deterministic fixture-derived metadata factory, reusing the analyze CLI's
 * scheme: `analysisId` combines both fixture IDs (unique per pair because
 * duplicate fixture IDs already fail the matrix run), `tenantId` is the
 * tenant profile fixture ID, and `createdAt` is the fixed constant.
 */
const fixedMetadataFactory: ImpactAnalysisMatrixMetadataFactory = (pair) => ({
  analysisId: `analysis.${pair.changeFixtureId}.${pair.tenantProfileFixtureId}`,
  tenantId: pair.tenantProfileFixtureId,
  createdAt: FIXED_CREATED_AT,
});

/** Fixed per-metric reasons behind every `NOT_MEASURED` blocker. */
const UNMEASURED_METRIC_REASONS: Record<keyof Phase1UnmeasuredMetrics, string> =
  {
    modelCost:
      'no provider cost instrumentation exists in the provider-free Phase 1 path',
    providerLatency:
      'no provider latency instrumentation exists in the provider-free Phase 1 path',
    unsupportedClaimRate:
      'no provider output exists in the provider-free Phase 1 path to audit for unsupported claims',
  };

function buildUnmeasuredMetrics(): Phase1UnmeasuredMetrics {
  return {
    modelCost: {
      status: NOT_MEASURED,
      reason: UNMEASURED_METRIC_REASONS.modelCost,
    },
    providerLatency: {
      status: NOT_MEASURED,
      reason: UNMEASURED_METRIC_REASONS.providerLatency,
    },
    unsupportedClaimRate: {
      status: NOT_MEASURED,
      reason: UNMEASURED_METRIC_REASONS.unsupportedClaimRate,
    },
  };
}

/**
 * One blocker per failed measured mandatory gate condition (fixed order:
 * `highImpactFalseNegatives`, `recall`, `insufficientContextAccuracy`) and
 * one per unmeasured gate metric (fixed order: `modelCost`,
 * `providerLatency`, `unsupportedClaimRate`). Each blocker carries the
 * exact status and the lossless reason from the corresponding condition or
 * metric, with no duplicates. `unmeasured` is accepted as a partial so the
 * "nothing unmeasured" case is representable; unknown keys iterate as
 * absent and produce no blocker. Pure function: no I/O, no clock, no
 * randomness.
 */
export function buildBlockers(
  measured: MeasuredGateConditions,
  unmeasured: Partial<Phase1UnmeasuredMetrics>,
): Phase1ExitGateBlocker[] {
  const measuredBlockers = (
    Object.keys(measured) as Array<keyof MeasuredGateConditions>
  ).flatMap((metric) => {
    const condition = measured[metric];
    return condition.status === 'FAIL'
      ? [{ metric, status: condition.status, reason: condition.reason }]
      : [];
  });
  const unmeasuredBlockers = (
    Object.keys(unmeasured) as Array<keyof Phase1UnmeasuredMetrics>
  ).flatMap((metric) => {
    const metricStatus = unmeasured[metric];
    return metricStatus === undefined
      ? []
      : [
          {
            metric,
            status: metricStatus.status,
            reason: metricStatus.reason,
          },
        ];
  });
  return [...measuredBlockers, ...unmeasuredBlockers];
}

/**
 * Conservative exit-gate decision: `PROCEED` only when there are zero gate
 * blockers — that is, every measured mandatory gate condition passes AND no
 * gate metric remains unmeasured. Any measured `FAIL`, or any unmeasured
 * metric, forces `HOLD`: measured failures can never be waved through just
 * because everything unmeasured is accounted for. Pure function: no I/O,
 * no clock, no randomness.
 */
export function buildDecision(
  blockers: readonly Phase1ExitGateBlocker[],
): Phase1ExitGateDecision {
  return blockers.length > 0 ? 'HOLD' : 'PROCEED';
}

/** Unambiguous join key: fixture IDs are regex-restricted, so `::` is safe. */
function pairKey(
  changeFixtureId: string,
  tenantProfileFixtureId: string,
): string {
  return `${changeFixtureId}::${tenantProfileFixtureId}`;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
    return `${path}: ${issue.message}`;
  });
}

function fail(messages: readonly string[]): Phase1ExitGateCommandResult {
  return { exitCode: 1, stdout: '', stderr: `${messages.join('\n')}\n` };
}

function readAll(
  corpusRoot: string,
  entries: readonly { path: string }[],
  kind: string,
): unknown[] {
  return entries.map((entry) => {
    try {
      return readJson(join(corpusRoot, entry.path));
    } catch (error) {
      throw new Error(
        `Unable to read ${kind} ${entry.path}: ${describeError(error)}`,
        { cause: error },
      );
    }
  });
}

function readPolicy(projectRoot: string, fileName: string): unknown {
  const policyPath = join(projectRoot, 'test', 'fixtures', fileName);
  try {
    return readJson(policyPath);
  } catch (error) {
    throw new Error(
      `Unable to read policy fixture ${policyPath}: ${describeError(error)}`,
      { cause: error },
    );
  }
}

/**
 * Evaluate the three measured mandatory Phase 1 exit-gate conditions from
 * the golden evaluation metrics, in fixed key order: `highImpactFalseNegatives`
 * must be exactly 0, `recall` must be exactly 1, and
 * `insufficientContextAccuracy` must be exactly 1. Each condition records
 * its status and a lossless reason naming the observed value against the
 * required one. Pure function: no I/O, no clock, no randomness.
 */
export function buildMeasuredGateConditions(
  metrics: GoldenImpactStateEvaluationResult,
): MeasuredGateConditions {
  const highImpactFalseNegatives = metrics.highImpactFalseNegatives;
  const recall = metrics.recall;
  const insufficientContextAccuracy = metrics.insufficientContextAccuracy;
  return {
    highImpactFalseNegatives: {
      status:
        highImpactFalseNegatives === PHASE1_REQUIRED_HIGH_IMPACT_FALSE_NEGATIVES
          ? 'PASS'
          : 'FAIL',
      reason: `observed highImpactFalseNegatives=${highImpactFalseNegatives}, required exactly ${PHASE1_REQUIRED_HIGH_IMPACT_FALSE_NEGATIVES}`,
    },
    recall: {
      status: recall === PHASE1_REQUIRED_RECALL ? 'PASS' : 'FAIL',
      reason: `observed recall=${String(recall)}, required exactly ${PHASE1_REQUIRED_RECALL}`,
    },
    insufficientContextAccuracy: {
      status:
        insufficientContextAccuracy ===
        PHASE1_REQUIRED_INSUFFICIENT_CONTEXT_ACCURACY
          ? 'PASS'
          : 'FAIL',
      reason: `observed insufficientContextAccuracy=${String(insufficientContextAccuracy)}, required exactly ${PHASE1_REQUIRED_INSUFFICIENT_CONTEXT_ACCURACY}`,
    },
  };
}

/**
 * Join the matrix run's pair outcomes onto the golden cases and evaluate the
 * existing golden impact-state metrics. Every golden case must match exactly
 * one pair by (changeFixtureId, tenantProfileFixtureId); a missing or
 * duplicated join key fails closed with the offending identity.
 */
function joinPairsOntoGoldenCases(
  goldenCases: CorpusCollection['goldenCases'],
  pairs: Awaited<ReturnType<typeof runImpactAnalysisMatrix>>['pairs'],
): GoldenImpactStateEvaluationResult {
  const observedStateByPairKey = new Map<string, ImpactState>();
  for (const pair of pairs) {
    const key = pairKey(pair.changeFixtureId, pair.tenantProfileFixtureId);
    if (observedStateByPairKey.has(key)) {
      throw new Error(`duplicate pair identity in matrix results: ${key}`);
    }
    observedStateByPairKey.set(key, pair.analysisRecord.impactAssessment.state);
  }

  const observations: ObservedGoldenState[] = [];
  for (const goldenCase of goldenCases) {
    const key = pairKey(
      goldenCase.changeFixtureId,
      goldenCase.tenantProfileFixtureId,
    );
    const observedState = observedStateByPairKey.get(key);
    if (observedState === undefined) {
      throw new Error(
        `golden case ${goldenCase.caseId} has no matching pair result for (changeFixtureId: ${goldenCase.changeFixtureId}, tenantProfileFixtureId: ${goldenCase.tenantProfileFixtureId})`,
      );
    }
    observations.push({ caseId: goldenCase.caseId, observedState });
  }

  return evaluateGoldenImpactStates(goldenCases, observations);
}

/**
 * Load the repository default tracked corpus, run every change x tenant
 * fixture pair through the existing impact analysis matrix runner exactly
 * once, and build the Phase 1 exit-gate report from that single run, using
 * only pre-existing parts: the existing `createFixedInformationalClassifier`
 * fixed provider-free INFORMATIONAL classifier, the existing
 * `createDeterministicSuggestedActionOutput` action generator behind the
 * existing runner boundary, fixture-derived metadata, and the existing
 * `evaluateGoldenImpactStates` evaluator over the 500-pair / 65-golden-case
 * join. The two evaluation policies are loaded from the existing
 * `test/fixtures` JSON files and parsed with the existing contracts.
 *
 * This is the entire phase1:report CLI logic; the actual process boundary
 * (stdout/stderr/exit code) lives in a thin wrapper script. Loading,
 * validation, matrix, and join failures each return a distinct multi-line
 * stderr message with exit code 1 and empty stdout; nothing is ever written
 * to disk and no fixture is mutated. No new Zod contract, provider adapter,
 * or external API exists in this slice. On success the report JSON is built
 * with the fixed key order `corpus`, `goldenCaseCount`, `analyzeSummary`,
 * `measuredMetrics`, `measuredGateConditions`, `unmeasuredMetrics`,
 * `decision`, `blockers` and a single trailing newline, so repeated runs
 * over the same tracked corpus are byte-identical.
 */
export async function runPhase1ExitGateReportCommand(
  io: Phase1ExitGateCommandIo = DEFAULT_IO,
): Promise<Phase1ExitGateCommandResult> {
  const projectRoot = io.resolveProjectRoot();
  const corpusRoot = join(projectRoot, 'corpus');
  const manifestPath = join(corpusRoot, 'manifest.json');

  let manifestValue: unknown;
  try {
    manifestValue = readJson(manifestPath);
  } catch (error) {
    return fail([
      `Unable to read corpus manifest ${manifestPath}: ${describeError(error)}`,
    ]);
  }

  const manifestResult = CorpusManifestSchema.safeParse(manifestValue);
  if (!manifestResult.success) {
    return fail([
      'Corpus manifest is invalid:',
      ...formatZodIssues(manifestResult.error),
    ]);
  }

  let collectionInput: {
    manifest: typeof manifestResult.data;
    changeFixtures: unknown[];
    tenantProfileFixtures: unknown[];
    goldenCases: unknown[];
  };
  try {
    collectionInput = {
      manifest: manifestResult.data,
      changeFixtures: readAll(
        corpusRoot,
        manifestResult.data.changeFixtures,
        'change fixture',
      ),
      tenantProfileFixtures: readAll(
        corpusRoot,
        manifestResult.data.tenantProfileFixtures,
        'tenant profile fixture',
      ),
      goldenCases: readAll(
        corpusRoot,
        manifestResult.data.goldenCases,
        'golden case',
      ),
    };
  } catch (error) {
    return fail([`Unable to load corpus files: ${describeError(error)}`]);
  }

  let collection: CorpusCollection;
  try {
    collection = CorpusCollectionSchema.parse(collectionInput);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return fail([
        'Corpus collection failed schema validation:',
        ...formatZodIssues(error),
      ]);
    }
    return fail([
      `Corpus collection failed schema validation: ${describeError(error)}`,
    ]);
  }

  if (collection.goldenCases.length !== PHASE1_EXPECTED_GOLDEN_CASE_COUNT) {
    return fail([
      `Phase 1 exit gate expects ${PHASE1_EXPECTED_GOLDEN_CASE_COUNT} golden cases, found ${collection.goldenCases.length}`,
    ]);
  }

  let riskPolicy: RiskPolicy;
  try {
    riskPolicy = RiskPolicySchema.parse(
      readPolicy(projectRoot, 'risk-policy.json'),
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return fail([
        'Risk policy fixture failed schema validation:',
        ...formatZodIssues(error),
      ]);
    }
    return fail([describeError(error)]);
  }

  let tenantApplicabilityPolicy: TenantApplicabilityPolicy;
  try {
    tenantApplicabilityPolicy = TenantApplicabilityPolicySchema.parse(
      readPolicy(projectRoot, 'tenant-applicability-policy.json'),
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return fail([
        'Tenant applicability policy fixture failed schema validation:',
        ...formatZodIssues(error),
      ]);
    }
    return fail([describeError(error)]);
  }

  let result: Awaited<ReturnType<typeof runImpactAnalysisMatrix>>;
  try {
    result = await runImpactAnalysisMatrix({
      collection,
      sourceMessageVersion: PHASE1_EXIT_GATE_SOURCE_MESSAGE_VERSION,
      riskPolicy,
      tenantApplicabilityPolicy,
      metadataFactory: fixedMetadataFactory,
      classifier: createFixedInformationalClassifier(),
      actionGenerator: async (request) =>
        createDeterministicSuggestedActionOutput(request),
    });
  } catch (error) {
    return fail([`Impact analysis matrix run failed: ${describeError(error)}`]);
  }

  if (result.processedCount !== PHASE1_EXPECTED_PAIR_COUNT) {
    return fail([
      `Phase 1 exit gate expects ${PHASE1_EXPECTED_PAIR_COUNT} pair results, matrix produced ${result.processedCount}`,
    ]);
  }

  let measuredMetrics: GoldenImpactStateEvaluationResult;
  try {
    measuredMetrics = joinPairsOntoGoldenCases(
      collection.goldenCases,
      result.pairs,
    );
  } catch (error) {
    return fail([`Phase 1 exit gate join failed: ${describeError(error)}`]);
  }

  const unmeasuredMetrics = buildUnmeasuredMetrics();
  const measuredGateConditions = buildMeasuredGateConditions(measuredMetrics);
  const blockers = buildBlockers(measuredGateConditions, unmeasuredMetrics);
  const report: Phase1ExitGateReport = {
    corpus: {
      corpusId: collection.manifest.corpusId,
      corpusVersion: collection.manifest.corpusVersion,
    },
    goldenCaseCount: collection.goldenCases.length,
    analyzeSummary: {
      corpusId: collection.manifest.corpusId,
      corpusVersion: collection.manifest.corpusVersion,
      processedCount: result.processedCount,
      stateCounts: result.stateCounts,
      actionCount: result.actionCount,
    },
    measuredMetrics,
    measuredGateConditions,
    unmeasuredMetrics,
    decision: buildDecision(blockers),
    blockers,
  };
  return { exitCode: 0, stdout: `${JSON.stringify(report)}\n`, stderr: '' };
}
