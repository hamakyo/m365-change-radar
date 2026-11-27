import { z } from 'zod';

import {
  AnalysisRecordSchema,
  type AnalysisRecord,
} from '../domain/analysis-record.js';
import {
  DeterministicFinalAnalysisMetadataSchema,
  type DeterministicFinalAnalysisMetadata,
} from '../domain/deterministic-final-analysis-record.js';
import type { ImpactState } from '../domain/impact-assessment.js';
import {
  createImpactAnalysisRecord,
  type ImpactAnalysisMetadata,
  type StructuredImpactClassifier,
} from '../domain/impact-analysis-runner.js';
import { RiskPolicySchema, type RiskPolicy } from '../domain/risk-policy.js';
import {
  createSuggestedChangeActionGenerationRequest,
  type SuggestedChangeActionGenerationRequest,
} from '../domain/suggested-action-generation-request.js';
import {
  generateSuggestedChangeActionResult,
  type SuggestedChangeActionGenerator,
} from '../domain/suggested-action-generation-runner.js';
import {
  SuggestedChangeActionResultSchema,
  type SuggestedChangeActionResult,
} from '../domain/suggested-change-action.js';
import {
  TenantApplicabilityPolicySchema,
  type TenantApplicabilityPolicy,
} from '../domain/tenant-applicability.js';
import {
  CorpusCollectionSchema,
  type CorpusCollection,
  type CorpusFixtureId,
} from './golden-corpus.js';

const nonEmptyString = z.string().min(1);

/** The analysis states from which generating suggested actions is
 * legitimate; identical to the boundary already enforced by the existing
 * `SuggestedChangeActionGenerationRequestSchema` gate. */
const ACTIONABLE_STATES: readonly ImpactState[] = [
  'ACTION_REQUIRED',
  'REVIEW_REQUIRED',
];

/** Identity of one change × tenant pair inside the matrix, carrying the
 * corpus fixture IDs of both sides. Passed to the caller's metadata factory
 * and embedded in every pair-attributed failure. */
export type ImpactAnalysisMatrixPairIdentity = {
  readonly changeFixtureId: CorpusFixtureId;
  readonly tenantProfileFixtureId: CorpusFixtureId;
};

/**
 * Caller-owned metadata factory. The matrix core never generates an
 * identifier or reads a clock: the analysis envelope metadata for every pair
 * is received from this factory and strictly validated with the existing
 * three-field deterministic-final contract (`analysisId`, `tenantId`,
 * offset-aware `createdAt`) before the pair runs. A returned value that
 * fails that contract, or an `analysisId` the factory already produced for
 * a different pair, fails the whole run closed with the pair identity.
 */
export type ImpactAnalysisMatrixMetadataFactory = (
  pair: ImpactAnalysisMatrixPairIdentity,
) => ImpactAnalysisMetadata;

/** Injection boundary of the matrix core. Everything is caller-owned: the
 * validated fixture collection, the two policies, the per-pair metadata
 * factory, the structured classifier, and the optional action generator. */
export type ImpactAnalysisMatrixInput = {
  /** Validated input fixtures. Parsed again at the boundary through the
   * unchanged `CorpusCollectionSchema`; duplicate change or tenant-profile
   * fixture IDs fail the run before any pair is processed. */
  readonly collection: CorpusCollection;
  /** Caller-owned non-empty source message version applied to every pair. */
  readonly sourceMessageVersion: string;
  readonly riskPolicy: RiskPolicy;
  readonly tenantApplicabilityPolicy: TenantApplicabilityPolicy;
  readonly metadataFactory: ImpactAnalysisMatrixMetadataFactory;
  readonly classifier: StructuredImpactClassifier;
  /** Optional action generator. When omitted, actionable pairs still
   * produce their `AnalysisRecord` but never carry an action result. When
   * provided, it is called exactly once per actionable pair
   * (ACTION_REQUIRED/REVIEW_REQUIRED) and zero times for the three
   * non-actionable states. */
  readonly actionGenerator?: SuggestedChangeActionGenerator;
};

/** Auditable output of one change × tenant pair. `suggestedChangeActionResult`
 * is present exactly when the pair's final state was actionable and an
 * action generator was provided; the key is omitted entirely otherwise
 * (never an explicit `undefined`), keeping every accepted outcome JSON-safe. */
export type ImpactAnalysisMatrixPairOutcome = {
  readonly changeFixtureId: CorpusFixtureId;
  readonly tenantProfileFixtureId: CorpusFixtureId;
  readonly analysisRecord: AnalysisRecord;
  readonly suggestedChangeActionResult?: SuggestedChangeActionResult;
};

/**
 * JSON-safe strict record of the complete matrix run. This is an internal
 * TypeScript result — deliberately not a new Zod contract — whose members
 * are all existing validated contracts (`AnalysisRecord`,
 * `SuggestedChangeActionResult`) plus plain counts, so a future stdout/JSON
 * renderer can consume it without re-deriving anything.
 */
export type ImpactAnalysisMatrixResult = {
  /** Number of pairs processed; always
   * `changeFixtures.length × tenantProfileFixtures.length` because silent
   * skips do not exist. */
  readonly processedCount: number;
  /** One outcome per pair in the fixed change-major / profile-minor
   * declaration order of the input collections. */
  readonly pairs: readonly ImpactAnalysisMatrixPairOutcome[];
  /** Final-state distribution across all pairs; every one of the five
   * states is present as a key. */
  readonly stateCounts: Readonly<Record<ImpactState, number>>;
  /** Total number of suggested actions across all generated action
   * results (0 when no generator was provided). */
  readonly actionCount: number;
};

function formatPair(pair: ImpactAnalysisMatrixPairIdentity): string {
  return `(changeFixtureId: ${pair.changeFixtureId}, tenantProfileFixtureId: ${pair.tenantProfileFixtureId})`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withCause(message: string, cause: unknown): Error {
  return new Error(message, { cause });
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function findDuplicateFixtureIds(
  fixtures: readonly { readonly fixtureId: CorpusFixtureId }[],
): CorpusFixtureId[] {
  const seen = new Set<CorpusFixtureId>();
  const duplicates = new Set<CorpusFixtureId>();
  for (const fixture of fixtures) {
    if (seen.has(fixture.fixtureId)) {
      duplicates.add(fixture.fixtureId);
    }
    seen.add(fixture.fixtureId);
  }
  return [...duplicates].sort(compareStrings);
}

/**
 * Process every change × tenant fixture pair exactly once in a fixed order,
 * connecting only existing runners: `createImpactAnalysisRecord` for the
 * per-pair impact analysis and — for the actionable states
 * (ACTION_REQUIRED/REVIEW_REQUIRED) and only when an action generator was
 * injected — `generateSuggestedChangeActionResult` behind the existing
 * `createSuggestedChangeActionGenerationRequest` builder.
 *
 * Matrix runner invariants (fail closed, no silent skips):
 *
 * - Fixed order: pairs iterate change-major / profile-minor in the
 *   declaration order of the validated input collections, so equal inputs
 *   with equal injected behavior always produce a deep-equal, JSON-safe
 *   result.
 * - Every input is schema-validated at the boundary with the existing
 *   contracts (`CorpusCollectionSchema`, `RiskPolicySchema`,
 *   `TenantApplicabilityPolicySchema`, the strict three-field metadata
 *   contract) before any pair runs; duplicate change or tenant-profile
 * fixture IDs abort the run before any pair is processed.
 * - Every failure is attributed to its pair identity and aborts the whole
 *   run: an invalid or colliding metadata factory return, a pair whose
 *   impact analysis fails, or an actionable pair whose action request or
 *   action generation fails. The original error is preserved as `cause`.
 * - `DETERMINISTIC_FINAL` pairs call the injected classifier zero times
 *   (inherited from the existing runner); classification/floor pairs call
 *   it exactly once.
 * - The action generator is called exactly once per actionable pair and
 *   zero times for INFORMATIONAL, NOT_APPLICABLE, and INSUFFICIENT_CONTEXT;
 *   generated results are self-verified with the existing
 *   `SuggestedChangeActionResultSchema`.
 * - The core is I/O-free: no filesystem, stdout, network, clock, or UUID
 *   access. All execution identity arrives through the caller's metadata
 *   factory and the classifier's returned AI record; nothing is ever read
 *   from or written to the inputs or the environment.
 */
export async function runImpactAnalysisMatrix(
  input: ImpactAnalysisMatrixInput,
): Promise<ImpactAnalysisMatrixResult> {
  // Boundary validation with the existing schemas only: the parsed
  // authoritative values below are the sole inputs of every downstream
  // runner call, and each parse failure aborts the run before any pair.
  const collection = CorpusCollectionSchema.parse(input.collection);
  const sourceMessageVersion = nonEmptyString.parse(input.sourceMessageVersion);
  const riskPolicy = RiskPolicySchema.parse(input.riskPolicy);
  const tenantApplicabilityPolicy = TenantApplicabilityPolicySchema.parse(
    input.tenantApplicabilityPolicy,
  );
  const { metadataFactory, classifier } = input;
  const actionGenerator = input.actionGenerator;

  // Duplicate fixture IDs fail the whole run before any pair is processed:
  // a duplicated fixture would silently multiply its column or row in the
  // matrix, so there is no de-duplication fallback.
  const duplicateChangeFixtureIds = findDuplicateFixtureIds(
    collection.changeFixtures,
  );
  if (duplicateChangeFixtureIds.length > 0) {
    throw new Error(
      `duplicate change fixture IDs in corpus collection: ${duplicateChangeFixtureIds.join(', ')}`,
    );
  }
  const duplicateProfileFixtureIds = findDuplicateFixtureIds(
    collection.tenantProfileFixtures,
  );
  if (duplicateProfileFixtureIds.length > 0) {
    throw new Error(
      `duplicate tenant profile fixture IDs in corpus collection: ${duplicateProfileFixtureIds.join(', ')}`,
    );
  }

  const pairs: ImpactAnalysisMatrixPairOutcome[] = [];
  const stateCounts: Record<ImpactState, number> = {
    ACTION_REQUIRED: 0,
    REVIEW_REQUIRED: 0,
    INFORMATIONAL: 0,
    NOT_APPLICABLE: 0,
    INSUFFICIENT_CONTEXT: 0,
  };
  let actionCount = 0;
  const analysisIdOwner = new Map<string, ImpactAnalysisMatrixPairIdentity>();

  // Fixed change-major / profile-minor order over the declaration order of
  // the validated collections; every pair is visited exactly once.
  for (const changeFixture of collection.changeFixtures) {
    for (const profileFixture of collection.tenantProfileFixtures) {
      const pair: ImpactAnalysisMatrixPairIdentity = {
        changeFixtureId: changeFixture.fixtureId,
        tenantProfileFixtureId: profileFixture.fixtureId,
      };
      const pairLabel = formatPair(pair);

      // The metadata envelope is received from the caller's factory and
      // strictly validated with the existing deterministic-final contract.
      // A factory throw and a schema-invalid return are distinct,
      // pair-attributed failures.
      let rawMetadata: unknown;
      try {
        rawMetadata = metadataFactory(pair);
      } catch (error) {
        throw withCause(
          `analysis metadata factory threw for pair ${pairLabel}: ${errorMessage(error)}`,
          error,
        );
      }
      let metadata: DeterministicFinalAnalysisMetadata;
      try {
        metadata = DeterministicFinalAnalysisMetadataSchema.parse(rawMetadata);
      } catch (error) {
        throw withCause(
          `analysis metadata factory returned invalid metadata for pair ${pairLabel}: ${errorMessage(error)}`,
          error,
        );
      }

      // One analysisId identifies one pair: reuse for a second pair is a
      // caller-side collision and fails closed with both identities.
      const previousOwner = analysisIdOwner.get(metadata.analysisId);
      if (previousOwner !== undefined) {
        throw new Error(
          `analysis metadata collision for pair ${pairLabel}: analysisId "${metadata.analysisId}" was already produced for pair ${formatPair(previousOwner)}`,
        );
      }
      analysisIdOwner.set(metadata.analysisId, pair);

      // Per-pair impact analysis through the existing runner only. Any
      // failure (including a classifier failure) is attributed to this
      // pair and aborts the run — the matrix is never partially returned.
      let record: AnalysisRecord;
      try {
        record = await createImpactAnalysisRecord(
          changeFixture.event,
          sourceMessageVersion,
          profileFixture.profile,
          riskPolicy,
          tenantApplicabilityPolicy,
          metadata,
          classifier,
        );
      } catch (error) {
        throw withCause(
          `impact analysis failed for pair ${pairLabel}: ${errorMessage(error)}`,
          error,
        );
      }

      // Self-verification of the generated record with the existing schema.
      let verifiedRecord: AnalysisRecord;
      try {
        verifiedRecord = AnalysisRecordSchema.parse(record);
      } catch (error) {
        throw withCause(
          `impact analysis record failed self-verification for pair ${pairLabel}: ${errorMessage(error)}`,
          error,
        );
      }

      const state = verifiedRecord.impactAssessment.state;
      stateCounts[state] += 1;

      // Action generation only for the actionable states and only when a
      // generator was injected: exactly one generator call per actionable
      // pair, zero for every non-actionable state and every generator-free
      // run.
      let suggestedChangeActionResult: SuggestedChangeActionResult | undefined;
      if (ACTIONABLE_STATES.includes(state) && actionGenerator !== undefined) {
        let actionRequest: SuggestedChangeActionGenerationRequest;
        try {
          actionRequest = createSuggestedChangeActionGenerationRequest(
            changeFixture.event,
            sourceMessageVersion,
            profileFixture.profile,
            verifiedRecord,
          );
        } catch (error) {
          throw withCause(
            `suggested action generation request failed for pair ${pairLabel}: ${errorMessage(error)}`,
            error,
          );
        }

        let actionResult: SuggestedChangeActionResult;
        try {
          actionResult = await generateSuggestedChangeActionResult(
            actionRequest,
            actionGenerator,
          );
        } catch (error) {
          throw withCause(
            `suggested action generation failed for pair ${pairLabel}: ${errorMessage(error)}`,
            error,
          );
        }

        // Self-verification of the generated result with the existing
        // Phase 1J-1 result contract.
        try {
          suggestedChangeActionResult =
            SuggestedChangeActionResultSchema.parse(actionResult);
        } catch (error) {
          throw withCause(
            `suggested action result failed self-verification for pair ${pairLabel}: ${errorMessage(error)}`,
            error,
          );
        }
        actionCount += suggestedChangeActionResult.actions.length;
      }

      // The optional key is omitted entirely when absent so every accepted
      // outcome round-trips through JSON without an explicit undefined.
      pairs.push({
        changeFixtureId: pair.changeFixtureId,
        tenantProfileFixtureId: pair.tenantProfileFixtureId,
        analysisRecord: verifiedRecord,
        ...(suggestedChangeActionResult !== undefined
          ? { suggestedChangeActionResult }
          : {}),
      });
    }
  }

  return {
    processedCount: pairs.length,
    pairs,
    stateCounts: { ...stateCounts },
    actionCount,
  };
}
