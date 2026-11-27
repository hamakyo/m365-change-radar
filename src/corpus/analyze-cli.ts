import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { createDeterministicSuggestedActionOutput } from '../domain/deterministic-suggested-action-generator.js';
import type { StructuredImpactClassifier } from '../domain/impact-analysis-runner.js';
import {
  StructuredClassificationAIInferenceSchema,
  type StructuredClassificationAIInference,
} from '../domain/provenance.js';
import { RiskPolicySchema, type RiskPolicy } from '../domain/risk-policy.js';
import {
  TenantApplicabilityPolicySchema,
  type TenantApplicabilityPolicy,
} from '../domain/tenant-applicability.js';
import type { ImpactAnalysisMatrixPairIdentity } from './impact-analysis-matrix-runner.js';
import {
  runImpactAnalysisMatrix,
  type ImpactAnalysisMatrixMetadataFactory,
  type ImpactAnalysisMatrixResult,
} from './impact-analysis-matrix-runner.js';
import {
  CorpusCollectionSchema,
  CorpusManifestSchema,
  type CorpusCollection,
} from './golden-corpus.js';

/**
 * Result of the analyze command. On success `stdout` is exactly the one-line
 * JSON summary plus its single trailing newline; on failure `stdout` is
 * always empty, so partial output is never emitted.
 */
export type AnalyzeCommandResult = {
  exitCode: 0 | 1;
  stdout: string;
  stderr: string;
};

/**
 * Seam that keeps the command free of direct `process` access so tests can
 * point the loader at a different repository root without touching global
 * state.
 */
export type AnalyzeCommandIo = {
  /** Returns the repository root that contains `corpus/` and `test/fixtures/`. */
  resolveProjectRoot(): string;
};

const DEFAULT_IO: AnalyzeCommandIo = {
  resolveProjectRoot: () => process.cwd(),
};

/**
 * The one-line JSON success payload: corpus identity, the number of
 * processed change × tenant pairs, the five-state distribution, and the
 * total number of generated suggested actions. Key order is fixed by the
 * literal below, so repeated runs over the same tracked corpus are
 * byte-identical.
 */
export type AnalyzeCommandSummary = Pick<
  ImpactAnalysisMatrixResult,
  'processedCount' | 'stateCounts' | 'actionCount'
> & {
  readonly corpusId: string;
  readonly corpusVersion: string;
};

/**
 * Fixed caller-owned source message version applied to every pair. No
 * fixture constrains this value: the request builder stamps it onto every
 * source fact it creates, so one constant keeps the whole run consistent.
 */
const ANALYZE_SOURCE_MESSAGE_VERSION = 'analyze-cli-1';

/** Fixed `createdAt` for every pair's analysis envelope metadata. No clock
 * is ever consulted; the value is a constant, offset-aware ISO datetime. */
const FIXED_CREATED_AT = '1970-01-01T00:00:00.000Z';

/**
 * Fixed execution identity of the provider-free analyze classifier. Every
 * inference record announces this synthetic identity so no consumer can
 * mistake the constant INFORMATIONAL proposal for real model output, a
 * Microsoft source fact, or the evaluation-only golden oracle
 * (`golden-label-oracle`), and no production adapter may present itself
 * under it.
 */
const FIXED_CLASSIFIER_IDENTITY = 'analyze-cli-fixed-informational';

/** Fixed evidence ID of the synthetic `ai_inference` record. */
const FIXED_INFERENCE_EVIDENCE_ID = 'ai.analyze-cli-fixed-informational';

/** Fixed provider-free model identity of the synthetic record. */
const FIXED_MODEL = 'provider-free-deterministic-classifier';

/** Fixed model version of the synthetic record. */
const FIXED_MODEL_VERSION = 'v1';

/**
 * Fixed synthetic confidence. The proposal is a constant, so the value only
 * satisfies the existing 0..1 confidence contract and never measures
 * classification quality.
 */
const FIXED_CONFIDENCE = 0.5;

/**
 * Fixed reason carried by both the proposal and the synthetic `ai_inference`
 * record, so the recorded provenance always explains its own constancy.
 */
const FIXED_REASON =
  'Fixed provider-free analyze classifier: no external model output is consulted, so every non-final request receives the constant INFORMATIONAL proposal for synthetic smoke analysis.';

/**
 * Supporting evidence the fixed classifier cites. The existing request
 * builder creates `source.event.title` and `source.event.body` facts for
 * every request, so the IDs always resolve; the classifier still verifies
 * them against its own request before building the proposal, and the
 * existing request-local join re-verifies them in the runner.
 */
const FIXED_SUPPORTING_EVIDENCE_IDS = [
  'source.event.title',
  'source.event.body',
] as const;

/**
 * Deterministic fixture-derived metadata factory. The analysis envelope for
 * every pair is derived only from the pair's corpus fixture IDs and the
 * fixed constant above: `analysisId` combines both fixture IDs (unique per
 * pair because duplicate fixture IDs already fail the matrix run),
 * `tenantId` is the tenant profile fixture ID, and `createdAt` is the fixed
 * constant. No identifier is generated and no clock is read.
 */
const fixedMetadataFactory: ImpactAnalysisMatrixMetadataFactory = (pair) =>
  metadataForPair(pair);

function metadataForPair(pair: ImpactAnalysisMatrixPairIdentity): {
  analysisId: string;
  tenantId: string;
  createdAt: string;
} {
  return {
    analysisId: `analysis.${pair.changeFixtureId}.${pair.tenantProfileFixtureId}`,
    tenantId: pair.tenantProfileFixtureId,
    createdAt: FIXED_CREATED_AT,
  };
}

/**
 * Create the provider-free fixed classifier for the analyze command.
 *
 * Given one validated structured classification request, it returns the
 * constant `INFORMATIONAL` proposal as the existing structured
 * classification AI inference record: fixed identity, fixed confidence,
 * fixed reason, and fixed supporting evidence limited to IDs verified to
 * exist in the request's own evidence records. The returned record
 * self-validates through the existing
 * `StructuredClassificationAIInferenceSchema`, which enforces the
 * confidence/reason/ordered-dependency ownership of the bundled proposal.
 * GUARDRAIL_FLOOR decisions are still raised to the policy floor by the
 * existing merge evaluator, so the constant proposal never lowers a floor.
 *
 * This is not a production provider adapter and shows no model quality: it
 * performs no network, API, credential, clock, UUID, or filesystem work,
 * generates no identifier beyond the fixed constants, mutates no input, and
 * equal requests always yield deep-equal records that round-trip through
 * JSON unchanged. The golden corpus oracle is deliberately not involved:
 * its 65 labels cover only a subset of pairs and are never extrapolated to
 * the full matrix.
 */
export function createFixedInformationalClassifier(): StructuredImpactClassifier {
  return async (request) => {
    const evidenceIds = new Set(
      request.evidenceRecords.map((record) => record.evidenceId),
    );
    for (const evidenceId of FIXED_SUPPORTING_EVIDENCE_IDS) {
      if (!evidenceIds.has(evidenceId)) {
        throw new Error(
          `fixed informational classifier supporting evidence does not exist in this request: ${evidenceId}`,
        );
      }
    }

    const output = {
      proposedState: 'INFORMATIONAL' as const,
      confidence: FIXED_CONFIDENCE,
      reason: FIXED_REASON,
      affectedComponents: [] as string[],
      supportingEvidenceIds: [...FIXED_SUPPORTING_EVIDENCE_IDS],
    };
    const inferenceRecord: StructuredClassificationAIInference = {
      kind: 'ai_inference',
      evidenceId: FIXED_INFERENCE_EVIDENCE_ID,
      promptVersion: FIXED_CLASSIFIER_IDENTITY,
      model: FIXED_MODEL,
      modelVersion: FIXED_MODEL_VERSION,
      confidence: FIXED_CONFIDENCE,
      inference: FIXED_REASON,
      dependsOnEvidenceIds: [...output.supportingEvidenceIds],
      classificationOutput: output,
    };
    return StructuredClassificationAIInferenceSchema.parse(inferenceRecord);
  };
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

function fail(messages: readonly string[]): AnalyzeCommandResult {
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
 * Load the repository default tracked corpus and run every change × tenant
 * fixture pair through the existing impact analysis matrix runner, using
 * only pre-existing parts: the fixed provider-free INFORMATIONAL classifier
 * above, the existing `createDeterministicSuggestedActionOutput` action
 * generator behind the existing runner boundary, and fixture-derived
 * metadata. The two evaluation policies are loaded from the existing
 * `test/fixtures` JSON files and parsed with the existing contracts.
 *
 * This is the entire analyze CLI logic; the actual process boundary
 * (stdout/stderr/exit code) lives in a thin wrapper script. Loading,
 * validation, and matrix failures each return a distinct multi-line stderr
 * message with exit code 1 and empty stdout; nothing is ever written to
 * disk and no fixture is mutated. On success the summary JSON is built with
 * a fixed key order and a single trailing newline, so repeated runs over
 * the same tracked corpus are byte-identical.
 */
export async function runAnalyzeCommand(
  io: AnalyzeCommandIo = DEFAULT_IO,
): Promise<AnalyzeCommandResult> {
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

  let result: ImpactAnalysisMatrixResult;
  try {
    result = await runImpactAnalysisMatrix({
      collection,
      sourceMessageVersion: ANALYZE_SOURCE_MESSAGE_VERSION,
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

  const summary: AnalyzeCommandSummary = {
    corpusId: collection.manifest.corpusId,
    corpusVersion: collection.manifest.corpusVersion,
    processedCount: result.processedCount,
    stateCounts: result.stateCounts,
    actionCount: result.actionCount,
  };
  return { exitCode: 0, stdout: `${JSON.stringify(summary)}\n`, stderr: '' };
}
