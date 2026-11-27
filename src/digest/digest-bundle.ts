import { z } from 'zod';

import {
  assertUndefinedFree,
  deduplicateRoadmapRecords,
  type NormalizedRoadmapRecord,
} from '../adapters/microsoft-roadmap/index.js';
import {
  AnalysisRecordSchema,
  type AnalysisRecord,
} from '../domain/analysis-record.js';
import { ChangeEventSchema } from '../domain/change-event.js';
import { createDeterministicSuggestedActionOutput } from '../domain/deterministic-suggested-action-generator.js';
import {
  ImpactStateSchema,
  type ImpactState,
} from '../domain/impact-assessment.js';
import {
  createImpactAnalysisRecord,
  type StructuredImpactClassifier,
} from '../domain/impact-analysis-runner.js';
import { RiskPolicySchema, type RiskPolicy } from '../domain/risk-policy.js';
import { createSuggestedChangeActionGenerationRequest } from '../domain/suggested-action-generation-request.js';
import {
  generateSuggestedChangeActionResult,
  type SuggestedChangeActionGenerator,
} from '../domain/suggested-action-generation-runner.js';
import {
  SuggestedChangeActionResultSchema,
  type SuggestedChangeActionResult,
} from '../domain/suggested-change-action.js';
import { evaluateTenantApplicability } from '../domain/tenant-applicability-evaluator.js';
import {
  TenantApplicabilityPolicySchema,
  type TenantApplicabilityPolicy,
  type TenantApplicabilityResult,
} from '../domain/tenant-applicability.js';
import {
  TenantProfileSchema,
  type TenantProfile,
} from '../domain/tenant-profile.js';
import { createRoadmapRuleClassifier } from './deterministic-classifier.js';

const nonEmptyString = z.string().min(1);
const isoDateTime = z.iso.datetime({ offset: true });

export const StateCountsSchema = z
  .object({
    ACTION_REQUIRED: z.number().int().min(0),
    REVIEW_REQUIRED: z.number().int().min(0),
    INFORMATIONAL: z.number().int().min(0),
    NOT_APPLICABLE: z.number().int().min(0),
    INSUFFICIENT_CONTEXT: z.number().int().min(0),
  })
  .strict();

export type StateCounts = z.infer<typeof StateCountsSchema>;

export const DigestPersonaSummarySchema = z
  .object({
    personaId: nonEmptyString,
    profileVersion: nonEmptyString,
    employees: z.number().int().nonnegative().optional(),
    ownership: z.record(nonEmptyString, nonEmptyString).optional(),
    stateCounts: StateCountsSchema,
    actionCount: z.number().int().min(0),
  })
  .strict();

export type DigestPersonaSummary = z.infer<typeof DigestPersonaSummarySchema>;

export const DigestPersonaOutcomeSchema = z
  .object({
    personaId: nonEmptyString,
    analysisRecord: AnalysisRecordSchema,
    suggestedChangeActionResult: SuggestedChangeActionResultSchema.optional(),
  })
  .strict();

export type DigestPersonaOutcome = z.infer<typeof DigestPersonaOutcomeSchema>;

export const DigestChangeEntrySchema = z
  .object({
    changeEvent: ChangeEventSchema,
    sourceMessageVersion: nonEmptyString,
    outcomes: z.array(DigestPersonaOutcomeSchema).min(1),
  })
  .strict();

export type DigestChangeEntry = z.infer<typeof DigestChangeEntrySchema>;

export const DigestBundleSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    generatedAt: isoDateTime,
    window: z
      .object({
        days: z.number().int().positive(),
        since: isoDateTime,
        until: isoDateTime,
        limit: z.number().int().positive(),
      })
      .strict(),
    feedSource: z
      .object({
        mode: z.enum(['live', 'input']),
        location: nonEmptyString,
        fetchedItemCount: z.number().int().min(0),
        selectedItemCount: z.number().int().min(0),
      })
      .strict(),
    policyVersions: z
      .object({
        riskPolicyId: nonEmptyString,
        riskPolicyRulesVersion: nonEmptyString,
        tenantApplicabilityPolicyId: nonEmptyString,
        tenantApplicabilityPolicyRulesVersion: nonEmptyString,
      })
      .strict(),
    personas: z.array(DigestPersonaSummarySchema).min(1),
    summary: z
      .object({
        changeCount: z.number().int().min(0),
        sovereignCloudExcludedCount: z.number().int().min(0),
        personaCount: z.number().int().positive(),
        pairCount: z.number().int().min(0),
        stateCounts: StateCountsSchema,
        actionCount: z.number().int().min(0),
      })
      .strict(),
    entries: z.array(DigestChangeEntrySchema),
  })
  .strict()
  .superRefine((bundle, ctx) => {
    try {
      assertUndefinedFree(bundle);
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

export type DigestBundle = z.infer<typeof DigestBundleSchema>;

export type PersonaProfileInput = {
  readonly personaId: string;
  readonly profile: TenantProfile;
};

export type RunDigestPipelineOptions = {
  readonly records: readonly NormalizedRoadmapRecord[];
  readonly fetchedItemCount?: number;
  readonly feedMode: 'live' | 'input';
  readonly feedLocation: string;
  readonly personas: readonly PersonaProfileInput[];
  readonly riskPolicy: RiskPolicy;
  readonly tenantApplicabilityPolicy: TenantApplicabilityPolicy;
  readonly now: string;
  readonly days: number;
  readonly limit: number;
  readonly classifier?: StructuredImpactClassifier;
  readonly actionGenerator?: SuggestedChangeActionGenerator;
};

const ACTIONABLE_STATES: ReadonlySet<ImpactState> = new Set(
  ImpactStateSchema.options.filter(
    (state) => state === 'ACTION_REQUIRED' || state === 'REVIEW_REQUIRED',
  ),
);

function createEmptyStateCounts(): Record<ImpactState, number> {
  return {
    ACTION_REQUIRED: 0,
    REVIEW_REQUIRED: 0,
    INFORMATIONAL: 0,
    NOT_APPLICABLE: 0,
    INSUFFICIENT_CONTEXT: 0,
  };
}

/**
 * Returns `true` if and only if tenant applicability resolved to confirmed
 * `NOT_APPLICABLE` exclusively through sovereign-cloud environment partition
 * rules (`environment.cloud_* === false`, zero `UNKNOWN` conditions, zero
 * mapping gaps).
 *
 * Service-level non-applicability within the same cloud (`services.* === false`)
 * and unknown cloud flags (`INSUFFICIENT_CONTEXT`) return `false`.
 */
export function isConfirmedSovereignCloudNonApplicable(
  applicability: TenantApplicabilityResult,
): boolean {
  if (applicability.status !== 'NOT_APPLICABLE') {
    return false;
  }
  const matchedRules = applicability.ruleResults.filter(
    (ruleResult) => ruleResult.selectorStatus === 'MATCH',
  );
  if (matchedRules.length === 0) {
    return false;
  }
  return matchedRules.every(
    (ruleResult) =>
      ruleResult.conditionGroupStatus === 'NO_MATCH' &&
      ruleResult.conditionResults.length > 0 &&
      ruleResult.conditionResults.every(
        (cond) =>
          cond.section === 'environment' &&
          cond.key.startsWith('cloud_') &&
          cond.status === 'NO_MATCH' &&
          cond.observed === false,
      ),
  );
}

/**
 * When a change is confirmed non-applicable due to physical cloud-instance
 * partitioning (for example, a `GCC / GCC High / DoD`-only feature evaluated
 * against a `Worldwide` commercial tenant), suppress commercial risk-floor
 * escalation while preserving the exact `policyId` and `policyRulesVersion` so
 * `createImpactAnalysisRecord` emits a schema-valid `DETERMINISTIC_FINAL` ->
 * `NOT_APPLICABLE` (`ai.used = false`) record.
 */
export function resolveEffectiveRiskPolicyForCloudPartition(
  riskPolicy: RiskPolicy,
  applicability: TenantApplicabilityResult,
): RiskPolicy {
  if (!isConfirmedSovereignCloudNonApplicable(applicability)) {
    return riskPolicy;
  }
  return RiskPolicySchema.parse({
    ...riskPolicy,
    rules: riskPolicy.rules.map((rule) => ({
      ...rule,
      enabled: false,
    })),
  });
}

/**
 * Filter normalized Roadmap records by `[since, until]` window on `updatedAt`,
 * deduplicate by `externalId`, and cap to `limit` in deterministic order.
 */
export function selectRoadmapRecordsForWindow(input: {
  readonly records: readonly NormalizedRoadmapRecord[];
  readonly now: string;
  readonly days: number;
  readonly limit: number;
}): {
  readonly since: string;
  readonly until: string;
  readonly selected: NormalizedRoadmapRecord[];
} {
  const untilIso = new Date(
    Date.parse(isoDateTime.parse(input.now)),
  ).toISOString();
  const days = z.number().int().positive().parse(input.days);
  const limit = z.number().int().positive().parse(input.limit);
  const untilMs = Date.parse(untilIso);
  const sinceMs = untilMs - days * 86_400_000;
  const sinceIso = new Date(sinceMs).toISOString();

  const deduplicated = deduplicateRoadmapRecords(input.records);
  const withinWindow = deduplicated.filter((record) => {
    const updatedMs = Date.parse(record.changeEvent.updatedAt);
    return updatedMs >= sinceMs && updatedMs <= untilMs;
  });

  return {
    since: sinceIso,
    until: untilIso,
    selected: withinWindow.slice(0, limit),
  };
}

function isSovereignMetadataFlag(record: NormalizedRoadmapRecord): boolean {
  const meta = record.changeEvent.sourceMetadata;
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    return false;
  }
  return (meta as Record<string, unknown>).sovereignCloudOnly === true;
}

/**
 * Execute the end-to-end digest pipeline across normalized Roadmap changes and
 * selected `TenantProfile` personas using `createImpactAnalysisRecord` and
 * `generateSuggestedChangeActionResult`.
 */
export async function runDigestPipeline(
  options: RunDigestPipelineOptions,
): Promise<DigestBundle> {
  const riskPolicy = RiskPolicySchema.parse(options.riskPolicy);
  const tenantApplicabilityPolicy = TenantApplicabilityPolicySchema.parse(
    options.tenantApplicabilityPolicy,
  );
  const generatedAt = new Date(
    Date.parse(isoDateTime.parse(options.now)),
  ).toISOString();

  if (options.personas.length === 0) {
    throw new Error('Digest pipeline requires at least one persona profile.');
  }

  const seenPersonaIds = new Set<string>();
  const validatedPersonas = [...options.personas]
    .map((entry) => {
      const personaId = nonEmptyString.parse(entry.personaId.trim());
      if (seenPersonaIds.has(personaId)) {
        throw new Error(`Duplicate personaId in digest pipeline: ${personaId}`);
      }
      seenPersonaIds.add(personaId);
      return {
        personaId,
        profile: TenantProfileSchema.parse(entry.profile),
      };
    })
    .sort((a, b) => a.personaId.localeCompare(b.personaId));

  const classifier = options.classifier ?? createRoadmapRuleClassifier();
  const actionGenerator: SuggestedChangeActionGenerator =
    options.actionGenerator ??
    (async (request) => createDeterministicSuggestedActionOutput(request));

  const { since, until, selected } = selectRoadmapRecordsForWindow({
    records: options.records,
    now: generatedAt,
    days: options.days,
    limit: options.limit,
  });

  const personaStateCounts = new Map<string, Record<ImpactState, number>>();
  const personaActionCounts = new Map<string, number>();
  for (const persona of validatedPersonas) {
    personaStateCounts.set(persona.personaId, createEmptyStateCounts());
    personaActionCounts.set(persona.personaId, 0);
  }

  const globalStateCounts = createEmptyStateCounts();
  let globalActionCount = 0;
  let sovereignCloudExcludedCount = 0;

  const entries: DigestChangeEntry[] = [];

  for (const record of selected) {
    const outcomes: DigestPersonaOutcome[] = [];

    for (const persona of validatedPersonas) {
      const applicabilityPreview = evaluateTenantApplicability(
        tenantApplicabilityPolicy,
        record.changeEvent,
        persona.profile,
      );
      const effectiveRiskPolicy = resolveEffectiveRiskPolicyForCloudPartition(
        riskPolicy,
        applicabilityPreview,
      );

      const analysisId = `analysis.roadmap-${record.changeEvent.externalId}.${persona.personaId}`;
      const analysisRecord: AnalysisRecord = await createImpactAnalysisRecord(
        record.changeEvent,
        record.sourceMessageVersion,
        persona.profile,
        effectiveRiskPolicy,
        tenantApplicabilityPolicy,
        {
          analysisId,
          tenantId: persona.personaId,
          createdAt: generatedAt,
        },
        classifier,
      );

      const state = analysisRecord.impactAssessment.state;
      globalStateCounts[state] += 1;
      const pCounts = personaStateCounts.get(persona.personaId);
      if (pCounts !== undefined) {
        pCounts[state] += 1;
      }

      let suggestedChangeActionResult: SuggestedChangeActionResult | undefined;
      if (ACTIONABLE_STATES.has(state)) {
        const actionRequest = createSuggestedChangeActionGenerationRequest(
          record.changeEvent,
          record.sourceMessageVersion,
          persona.profile,
          analysisRecord,
        );
        suggestedChangeActionResult = await generateSuggestedChangeActionResult(
          actionRequest,
          actionGenerator,
        );
        globalActionCount += suggestedChangeActionResult.actions.length;
        personaActionCounts.set(
          persona.personaId,
          (personaActionCounts.get(persona.personaId) ?? 0) +
            suggestedChangeActionResult.actions.length,
        );
      }

      outcomes.push({
        personaId: persona.personaId,
        analysisRecord,
        ...(suggestedChangeActionResult !== undefined
          ? { suggestedChangeActionResult }
          : {}),
      });
    }

    if (
      isSovereignMetadataFlag(record) &&
      outcomes.every(
        (outcome) =>
          outcome.analysisRecord.impactAssessment.state === 'NOT_APPLICABLE',
      )
    ) {
      sovereignCloudExcludedCount += 1;
    }

    entries.push({
      changeEvent: record.changeEvent,
      sourceMessageVersion:
        record.changeEvent.source.length > 0
          ? record.sourceMessageVersion
          : record.sourceMessageVersion,
      outcomes,
    });
  }

  const personas: DigestPersonaSummary[] = validatedPersonas.map((persona) => ({
    personaId: persona.personaId,
    profileVersion: persona.profile.profileVersion,
    ...(persona.profile.organization.employees !== undefined
      ? { employees: persona.profile.organization.employees }
      : {}),
    ...(Object.keys(persona.profile.ownership).length > 0
      ? { ownership: { ...persona.profile.ownership } }
      : {}),
    stateCounts:
      personaStateCounts.get(persona.personaId) ?? createEmptyStateCounts(),
    actionCount: personaActionCounts.get(persona.personaId) ?? 0,
  }));

  const bundleCandidate: DigestBundle = {
    schemaVersion: '1.0',
    generatedAt,
    window: {
      days: options.days,
      since,
      until,
      limit: options.limit,
    },
    feedSource: {
      mode: options.feedMode,
      location: options.feedLocation,
      fetchedItemCount: options.fetchedItemCount ?? options.records.length,
      selectedItemCount: selected.length,
    },
    policyVersions: {
      riskPolicyId: riskPolicy.policyId,
      riskPolicyRulesVersion: riskPolicy.policyRulesVersion,
      tenantApplicabilityPolicyId: tenantApplicabilityPolicy.policyId,
      tenantApplicabilityPolicyRulesVersion:
        tenantApplicabilityPolicy.policyRulesVersion,
    },
    personas,
    summary: {
      changeCount: entries.length,
      sovereignCloudExcludedCount,
      personaCount: personas.length,
      pairCount: entries.length * personas.length,
      stateCounts: globalStateCounts,
      actionCount: globalActionCount,
    },
    entries,
  };

  return DigestBundleSchema.parse(bundleCandidate);
}
