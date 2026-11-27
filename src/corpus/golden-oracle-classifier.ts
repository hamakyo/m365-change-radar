import type { StructuredImpactClassifier } from '../domain/impact-analysis-runner.js';
import {
  StructuredClassificationAIInferenceSchema,
  type StructuredClassificationAIInference,
} from '../domain/provenance.js';
import type { StructuredImpactClassificationOutput } from '../domain/structured-classification-output.js';
import {
  StructuredImpactClassificationRequestSchema,
  type StructuredImpactClassificationRequest,
} from '../domain/structured-impact-classification.js';
import {
  CorpusCollectionSchema,
  type CorpusCollection,
  type GoldenCase,
  type GoldenExpected,
} from './golden-corpus.js';

/**
 * Fixed evaluation-only execution identity. Every oracle inference record
 * announces this prompt/model identity so no consumer can mistake the copied
 * golden label for real model output or a Microsoft source fact, and no
 * production adapter may present itself under it.
 */
const ORACLE_IDENTITY = 'golden-label-oracle';

/** Fixed evidence ID of the synthetic `ai_inference` record. */
const ORACLE_INFERENCE_EVIDENCE_ID = 'ai.golden-label-oracle';

/**
 * Fixed synthetic confidence. The oracle copies a hand-authored label, so it
 * carries no model uncertainty; the value only satisfies the existing 0..1
 * confidence contract and never measures classification quality.
 */
const ORACLE_CONFIDENCE = 1;

/**
 * Supporting evidence the oracle cites. Every ID is verified to exist in the
 * request's evidence records before the proposal is built, so the copied
 * label never cites evidence outside its own request.
 */
const ORACLE_SUPPORTING_EVIDENCE_IDS = [
  'source.event.title',
  'source.event.body',
] as const;

function pairKey(changeExternalId: string, profileVersion: string): string {
  return JSON.stringify([changeExternalId, profileVersion]);
}

function compareCaseIds(left: GoldenCase, right: GoldenCase): number {
  if (left.caseId < right.caseId) return -1;
  if (left.caseId > right.caseId) return 1;
  return 0;
}

function oracleOutputFor(
  expected: GoldenExpected,
  request: StructuredImpactClassificationRequest,
): StructuredImpactClassificationOutput {
  const outputBase = {
    confidence: ORACLE_CONFIDENCE,
    reason: expected.reason,
    affectedComponents: [...new Set(request.changeEvent.products)],
    supportingEvidenceIds: [...ORACLE_SUPPORTING_EVIDENCE_IDS],
  };
  switch (expected.state) {
    case 'ACTION_REQUIRED':
      return { proposedState: 'ACTION_REQUIRED', ...outputBase };
    case 'REVIEW_REQUIRED':
      return { proposedState: 'REVIEW_REQUIRED', ...outputBase };
    case 'INFORMATIONAL':
      return { proposedState: 'INFORMATIONAL', ...outputBase };
    case 'NOT_APPLICABLE':
      return { proposedState: 'NOT_APPLICABLE', ...outputBase };
    case 'INSUFFICIENT_CONTEXT':
      return {
        proposedState: 'INSUFFICIENT_CONTEXT',
        ...outputBase,
        missingContext: [...expected.missingContext],
      };
    default: {
      const unsupportedState: never = expected;
      throw new Error(
        `unsupported golden label state: ${String(unsupportedState)}`,
      );
    }
  }
}

/**
 * Create the evaluation-only golden corpus oracle classifier for Phase 1
 * wiring verification.
 *
 * The factory re-parses the caller's corpus collection through the unchanged
 * `CorpusCollectionSchema`, resolves every golden case to exactly one
 * `(changeEvent.externalId, tenantProfile.profileVersion)` pair through its
 * referenced fixtures, and returns an async classifier that satisfies the
 * existing `StructuredImpactClassifier` boundary: given one validated
 * structured classification request, it resolves the request's pair to its
 * golden case and copies the hand-authored label — expected state, reason,
 * and for `INSUFFICIENT_CONTEXT` the lossless `missingContext` — into a
 * clearly synthetic `StructuredClassificationAIInference` under the fixed
 * `golden-label-oracle` prompt/model identity. Supporting evidence is limited
 * to IDs verified to exist in the request's own evidence records, and the
 * returned record self-validates through the existing
 * `StructuredClassificationAIInferenceSchema`, which enforces the
 * confidence/reason/ordered-dependency ownership of the bundled proposal.
 *
 * Fail-closed boundaries: a golden case referencing a missing change or
 * tenant profile fixture, or two cases resolving to the same pair, rejects
 * the factory; a request whose pair has no golden case, whose request lacks
 * an oracle evidence ID, or whose decision is `DETERMINISTIC_FINAL` (already
 * excluded by the existing request schema's two-kind decision member)
 * rejects the classifier call.
 *
 * This is not a production provider adapter and shows no model quality: it
 * performs no network, API, credential, clock, UUID, or filesystem work,
 * generates no identifier, mutates no input, and equal inputs always yield
 * deep-equal records that round-trip through JSON unchanged. It is
 * deliberately not exported from any barrel so it cannot be mistaken for a
 * production classifier implementation.
 */
export function createGoldenCorpusImpactClassifier(
  collection: CorpusCollection,
): StructuredImpactClassifier {
  const parsedCollection = CorpusCollectionSchema.parse(collection);
  const changeFixtureByFixtureId = new Map(
    parsedCollection.changeFixtures.map(
      (fixture) => [fixture.fixtureId, fixture] as const,
    ),
  );
  const profileFixtureByFixtureId = new Map(
    parsedCollection.tenantProfileFixtures.map(
      (fixture) => [fixture.fixtureId, fixture] as const,
    ),
  );

  // Resolve every golden case to its request pair in canonical caseId order
  // so duplicate detection is deterministic regardless of collection order.
  const caseByPair = new Map<string, GoldenCase>();
  const duplicates: string[] = [];
  for (const goldenCase of [...parsedCollection.goldenCases].sort(
    compareCaseIds,
  )) {
    const changeFixture = changeFixtureByFixtureId.get(
      goldenCase.changeFixtureId,
    );
    if (changeFixture === undefined) {
      throw new Error(
        `golden case ${goldenCase.caseId} references missing change fixture: ${goldenCase.changeFixtureId}`,
      );
    }
    const profileFixture = profileFixtureByFixtureId.get(
      goldenCase.tenantProfileFixtureId,
    );
    if (profileFixture === undefined) {
      throw new Error(
        `golden case ${goldenCase.caseId} references missing tenant profile fixture: ${goldenCase.tenantProfileFixtureId}`,
      );
    }
    const key = pairKey(
      changeFixture.event.externalId,
      profileFixture.profile.profileVersion,
    );
    const existing = caseByPair.get(key);
    if (existing !== undefined) {
      duplicates.push(
        `${existing.caseId} and ${goldenCase.caseId} both resolve to change externalId ${changeFixture.event.externalId} with tenant profileVersion ${profileFixture.profile.profileVersion}`,
      );
      continue;
    }
    caseByPair.set(key, goldenCase);
  }
  if (duplicates.length > 0) {
    throw new Error(
      `golden corpus must resolve exactly one case per (changeEvent.externalId, tenantProfile.profileVersion) pair; duplicate pairs: ${duplicates.join('; ')}`,
    );
  }

  return async (request) => {
    // The existing request schema is the only request boundary: its decision
    // member is the existing two-kind non-final union, so a
    // DETERMINISTIC_FINAL decision is rejected by this parse itself and no
    // oracle-specific decision rule exists.
    const parsedRequest =
      StructuredImpactClassificationRequestSchema.parse(request);

    const evidenceIds = new Set(
      parsedRequest.evidenceRecords.map((record) => record.evidenceId),
    );
    for (const evidenceId of ORACLE_SUPPORTING_EVIDENCE_IDS) {
      if (!evidenceIds.has(evidenceId)) {
        throw new Error(
          `golden oracle classifier supporting evidence does not exist in this request: ${evidenceId}`,
        );
      }
    }

    const goldenCase = caseByPair.get(
      pairKey(
        parsedRequest.changeEvent.externalId,
        parsedRequest.tenantProfile.profileVersion,
      ),
    );
    if (goldenCase === undefined) {
      throw new Error(
        `golden corpus has no case for change externalId ${parsedRequest.changeEvent.externalId} with tenant profileVersion ${parsedRequest.tenantProfile.profileVersion}`,
      );
    }

    const output = oracleOutputFor(goldenCase.expected, parsedRequest);
    const inferenceRecord: StructuredClassificationAIInference = {
      kind: 'ai_inference',
      evidenceId: ORACLE_INFERENCE_EVIDENCE_ID,
      promptVersion: ORACLE_IDENTITY,
      model: ORACLE_IDENTITY,
      modelVersion: ORACLE_IDENTITY,
      confidence: ORACLE_CONFIDENCE,
      inference: output.reason,
      dependsOnEvidenceIds: [...output.supportingEvidenceIds],
      classificationOutput: output,
    };
    return StructuredClassificationAIInferenceSchema.parse(inferenceRecord);
  };
}
