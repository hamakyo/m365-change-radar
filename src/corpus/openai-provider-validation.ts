import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { createImpactAnalysisRecord } from '../domain/impact-analysis-runner.js';
import { RiskPolicySchema } from '../domain/risk-policy.js';
import { TenantApplicabilityPolicySchema } from '../domain/tenant-applicability.js';
import {
  OPENAI_RESPONSES_MODEL,
  OPENAI_RESPONSES_MODEL_VERSION,
  OPENAI_RESPONSES_PROMPT_VERSION,
  createOpenAIResponsesClassifier,
  type OpenAIProviderValidationObservation,
} from '../providers/openai-responses-classifier.js';
import {
  evaluateGoldenImpactStates,
  type GoldenImpactStateEvaluationResult,
  type ObservedGoldenState,
} from './evaluation-harness.js';
import {
  CorpusCollectionSchema,
  CorpusManifestSchema,
  type CorpusCollection,
  type GoldenCase,
} from './golden-corpus.js';

const SOURCE_MESSAGE_VERSION = 'openai-provider-validation-1';
const FIXED_CREATED_AT = '1970-01-01T00:00:00.000Z';

// Official GPT-5.4 Mini standard text-token prices captured for this
// validation on 2026-08-29. The snapshot and rates are emitted in the report
// so a later rerun cannot silently reinterpret the estimate under new prices.
const PRICING_SNAPSHOT = {
  capturedAt: '2026-08-29',
  currency: 'USD',
  unitTokens: 1_000_000,
  inputPerUnit: 0.75,
  cachedInputPerUnit: 0.075,
  outputPerUnit: 4.5,
} as const;

export type OpenAIProviderValidationCaseResult = {
  readonly caseId: string;
  readonly expectedState: string;
  readonly observedState: string;
  readonly providerCalled: boolean;
  readonly proposedState?: string;
  readonly confidence?: number;
  readonly reason?: string;
  readonly supportingEvidenceIds?: readonly string[];
  readonly affectedComponents?: readonly string[];
};

export type OpenAIProviderValidationReport = {
  readonly provider: 'openai';
  readonly endpoint: 'responses';
  readonly model: string;
  readonly requestedModelVersion: string;
  readonly promptVersion: string;
  readonly observedModelVersions: readonly string[];
  readonly corpus: {
    readonly corpusId: string;
    readonly corpusVersion: string;
  };
  readonly selectedCaseIds: readonly string[];
  readonly caseCount: number;
  readonly providerCallCount: number;
  readonly deterministicFinalCount: number;
  readonly stateMetrics: GoldenImpactStateEvaluationResult;
  readonly usage: {
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
  };
  readonly pricingSnapshot: typeof PRICING_SNAPSHOT;
  readonly estimatedCostUsd: number;
  readonly latencyMs: {
    readonly min: number;
    readonly mean: number;
    readonly p50: number;
    readonly p95: number;
    readonly max: number;
  };
  readonly automaticEvidenceChecks: {
    readonly status: 'PASS';
    readonly reason: string;
  };
  readonly unsupportedClaimRate: {
    readonly status: 'MANUAL_REVIEW_REQUIRED';
    readonly reason: string;
  };
  readonly cases: readonly OpenAIProviderValidationCaseResult[];
};

export type OpenAIProviderValidationCommandResult = {
  readonly exitCode: 0 | 1;
  readonly stdout: string;
  readonly stderr: string;
};

export type OpenAIProviderValidationCommandIo = {
  readonly apiKey: string | undefined;
  readonly resolveProjectRoot: () => string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
};

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readAll(
  corpusRoot: string,
  entries: readonly { path: string }[],
): unknown[] {
  return entries.map((entry) => readJson(join(corpusRoot, entry.path)));
}

function loadCollection(projectRoot: string): CorpusCollection {
  const corpusRoot = join(projectRoot, 'corpus');
  const manifest = CorpusManifestSchema.parse(
    readJson(join(corpusRoot, 'manifest.json')),
  );
  return CorpusCollectionSchema.parse({
    manifest,
    changeFixtures: readAll(corpusRoot, manifest.changeFixtures),
    tenantProfileFixtures: readAll(corpusRoot, manifest.tenantProfileFixtures),
    goldenCases: readAll(corpusRoot, manifest.goldenCases),
  });
}

function selectedGoldenCases(collection: CorpusCollection): GoldenCase[] {
  // Full-corpus validation: every tracked golden case, in manifest order.
  return collection.goldenCases.map((goldenCase) => goldenCase);
}

function percentile(sorted: readonly number[], value: number): number {
  const index = Math.max(0, Math.ceil(value * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function roundMilliseconds(value: number): number {
  return Number(value.toFixed(3));
}

function aggregateLatency(
  observations: readonly OpenAIProviderValidationObservation[],
): OpenAIProviderValidationReport['latencyMs'] {
  if (observations.length === 0) {
    return { min: 0, mean: 0, p50: 0, p95: 0, max: 0 };
  }
  const sorted = observations
    .map((observation) => observation.latencyMs)
    .sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    min: roundMilliseconds(sorted[0] ?? 0),
    mean: roundMilliseconds(total / sorted.length),
    p50: roundMilliseconds(percentile(sorted, 0.5)),
    p95: roundMilliseconds(percentile(sorted, 0.95)),
    max: roundMilliseconds(sorted.at(-1) ?? 0),
  };
}

function aggregateUsage(
  observations: readonly OpenAIProviderValidationObservation[],
): OpenAIProviderValidationReport['usage'] {
  return observations.reduce(
    (usage, observation) => ({
      inputTokens: usage.inputTokens + observation.inputTokens,
      cachedInputTokens:
        usage.cachedInputTokens + observation.cachedInputTokens,
      outputTokens: usage.outputTokens + observation.outputTokens,
      totalTokens: usage.totalTokens + observation.totalTokens,
    }),
    { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
}

function estimateCost(usage: OpenAIProviderValidationReport['usage']): number {
  const uncachedInputTokens = Math.max(
    0,
    usage.inputTokens - usage.cachedInputTokens,
  );
  const estimate =
    (uncachedInputTokens * PRICING_SNAPSHOT.inputPerUnit +
      usage.cachedInputTokens * PRICING_SNAPSHOT.cachedInputPerUnit +
      usage.outputTokens * PRICING_SNAPSHOT.outputPerUnit) /
    PRICING_SNAPSHOT.unitTokens;
  return Number(estimate.toFixed(9));
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function fail(error: unknown): OpenAIProviderValidationCommandResult {
  return {
    exitCode: 1,
    stdout: '',
    stderr: `OpenAI provider validation failed: ${describeError(error)}\n`,
  };
}

export async function runOpenAIProviderValidationCommand(
  io: OpenAIProviderValidationCommandIo,
): Promise<OpenAIProviderValidationCommandResult> {
  try {
    const apiKey = z.string().min(1).parse(io.apiKey);
    const projectRoot = io.resolveProjectRoot();
    const collection = loadCollection(projectRoot);
    const riskPolicy = RiskPolicySchema.parse(
      readJson(join(projectRoot, 'test', 'fixtures', 'risk-policy.json')),
    );
    const tenantApplicabilityPolicy = TenantApplicabilityPolicySchema.parse(
      readJson(
        join(
          projectRoot,
          'test',
          'fixtures',
          'tenant-applicability-policy.json',
        ),
      ),
    );
    const classifier = createOpenAIResponsesClassifier({
      apiKey,
      fetch: io.fetch,
      now: io.now,
    });
    const changeById = new Map(
      collection.changeFixtures.map((entry) => [entry.fixtureId, entry]),
    );
    const profileById = new Map(
      collection.tenantProfileFixtures.map((entry) => [entry.fixtureId, entry]),
    );
    const selected = selectedGoldenCases(collection);
    const observations: ObservedGoldenState[] = [];
    const cases: OpenAIProviderValidationCaseResult[] = [];

    for (const goldenCase of selected) {
      const changeFixture = changeById.get(goldenCase.changeFixtureId);
      const profileFixture = profileById.get(goldenCase.tenantProfileFixtureId);
      if (changeFixture === undefined || profileFixture === undefined) {
        throw new Error(
          `OpenAI provider validation case has an unresolved fixture: ${goldenCase.caseId}`,
        );
      }
      const beforeCalls = classifier.getObservations().length;
      let record;
      try {
        record = await createImpactAnalysisRecord(
          changeFixture.event,
          SOURCE_MESSAGE_VERSION,
          profileFixture.profile,
          riskPolicy,
          tenantApplicabilityPolicy,
          {
            analysisId: `openai-validation.${goldenCase.caseId}`,
            tenantId: profileFixture.fixtureId,
            createdAt: FIXED_CREATED_AT,
          },
          classifier,
        );
      } catch (error) {
        throw new Error(
          `OpenAI provider validation failed for ${goldenCase.caseId}: ${describeError(error)}`,
          { cause: error },
        );
      }
      const afterCalls = classifier.getObservations().length;
      const callsForCase = afterCalls - beforeCalls;
      if (callsForCase !== 0 && callsForCase !== 1) {
        throw new Error(
          `OpenAI provider validation expected zero or one provider call for ${goldenCase.caseId}, observed ${callsForCase}`,
        );
      }
      const inference = record.provenanceRecords.find(
        (entry) => entry.kind === 'ai_inference',
      );
      observations.push({
        caseId: goldenCase.caseId,
        observedState: record.impactAssessment.state,
      });
      cases.push({
        caseId: goldenCase.caseId,
        expectedState: goldenCase.expected.state,
        observedState: record.impactAssessment.state,
        providerCalled: callsForCase === 1,
        ...(inference?.classificationOutput === undefined
          ? {}
          : {
              proposedState: inference.classificationOutput.proposedState,
              confidence: inference.classificationOutput.confidence,
              reason: inference.classificationOutput.reason,
              supportingEvidenceIds: [
                ...inference.classificationOutput.supportingEvidenceIds,
              ],
              affectedComponents: [
                ...inference.classificationOutput.affectedComponents,
              ],
            }),
      });
    }

    const providerObservations = classifier.getObservations();
    const usage = aggregateUsage(providerObservations);
    const report: OpenAIProviderValidationReport = {
      provider: 'openai',
      endpoint: 'responses',
      model: OPENAI_RESPONSES_MODEL,
      requestedModelVersion: OPENAI_RESPONSES_MODEL_VERSION,
      promptVersion: OPENAI_RESPONSES_PROMPT_VERSION,
      observedModelVersions: uniqueSorted(
        providerObservations.map((entry) => entry.modelVersion),
      ),
      corpus: {
        corpusId: collection.manifest.corpusId,
        corpusVersion: collection.manifest.corpusVersion,
      },
      selectedCaseIds: selected.map((goldenCase) => goldenCase.caseId),
      caseCount: selected.length,
      providerCallCount: providerObservations.length,
      deterministicFinalCount: selected.length - providerObservations.length,
      stateMetrics: evaluateGoldenImpactStates(selected, observations),
      usage,
      pricingSnapshot: PRICING_SNAPSHOT,
      estimatedCostUsd: estimateCost(usage),
      latencyMs: aggregateLatency(providerObservations),
      automaticEvidenceChecks: {
        status: 'PASS',
        reason:
          'all returned evidence IDs resolved inside their request and all affected components matched the supplied change products/categories',
      },
      unsupportedClaimRate: {
        status: 'MANUAL_REVIEW_REQUIRED',
        reason:
          'free-text reasons require human claim-level review; schema and evidence-reference validation alone cannot prove every sentence is supported',
      },
      cases,
    };
    return { exitCode: 0, stdout: `${JSON.stringify(report)}\n`, stderr: '' };
  } catch (error) {
    return fail(error);
  }
}
