import { z } from 'zod';

import {
  AnalysisRecordSchema,
  type AnalysisRecord,
  type ChangeEventReference,
} from './analysis-record.js';
import { ChangeEventSchema, type ChangeEvent } from './change-event.js';
import type { DeterministicImpactDecision } from './deterministic-impact-decision.js';
import { DeterministicImpactDecisionSchema } from './deterministic-impact-decision.js';
import {
  createDeterministicEvidenceRecords,
  type DeterministicEvidenceRecord,
} from './deterministic-evidence-record-builder.js';
import {
  ImpactAssessmentSchema,
  type ImpactAssessment,
} from './impact-assessment.js';
import { TenantProfileSchema, type TenantProfile } from './tenant-profile.js';
import type {
  TenantApplicabilityMappingGap,
  TenantApplicabilityResult,
} from './tenant-applicability.js';
import type { VersionBundle } from './version-bundle.js';

const nonEmptyString = z.string().min(1);
/** Callers must supply an explicit offset-aware ISO datetime; clocks are not
 * consulted anywhere inside this builder. */
const offsetIsoDateTime = z.iso.datetime({ offset: true });

/**
 * Explicit analysis envelope metadata. Every value is caller-owned: this
 * builder never generates an identifier and never reads a clock.
 */
export const DeterministicFinalAnalysisMetadataSchema = z
  .object({
    analysisId: nonEmptyString,
    tenantId: nonEmptyString,
    createdAt: offsetIsoDateTime,
  })
  .strict();

export type DeterministicFinalAnalysisMetadata = z.infer<
  typeof DeterministicFinalAnalysisMetadataSchema
>;

type FinalDecision = Extract<
  DeterministicImpactDecision,
  { kind: 'DETERMINISTIC_FINAL' }
>;

function requireInsufficientApplicability(
  applicability: TenantApplicabilityResult,
): Extract<TenantApplicabilityResult, { status: 'INSUFFICIENT_CONTEXT' }> {
  if (applicability.status !== 'INSUFFICIENT_CONTEXT') {
    throw new Error(
      `DETERMINISTIC_FINAL state ${applicability.status} does not match its INSUFFICIENT_CONTEXT requirement`,
    );
  }
  return applicability;
}

/**
 * Select the exact `decision.tenant.<ruleIndex>` conclusion IDs for enabled
 * rules whose selector matched the change and whose condition group concluded
 * NO_MATCH, in policy rule-result order. Selector-only NO_MATCH conclusions
 * and risk conclusions are never final-assessment evidence.
 */
function nonApplicabilityEvidenceIds(decision: FinalDecision): string[] {
  const supportingIds = decision.tenantApplicability.ruleResults.flatMap(
    (ruleResult, ruleIndex) => {
      if (
        ruleResult.selectorStatus === 'MATCH' &&
        ruleResult.conditionGroupStatus === 'NO_MATCH'
      ) {
        return [`decision.tenant.${ruleIndex}`];
      }
      return [];
    },
  );

  if (supportingIds.length === 0) {
    throw new Error(
      'NOT_APPLICABLE requires at least one selector MATCH rule with a confirmed NO_MATCH condition group',
    );
  }

  const idSet = new Set<string>();
  supportingIds.forEach((id) => {
    if (idSet.has(id)) {
      throw new Error(`duplicate final assessment evidence ID: ${id}`);
    }
    idSet.add(id);
  });

  return supportingIds;
}

function copyMissingMappings(
  source: readonly TenantApplicabilityMappingGap[],
): TenantApplicabilityMappingGap[] {
  return source.map((gap) => ({ field: gap.field, value: gap.value }));
}

/**
 * Losslessly move the mapping-aware insufficiency fields into the final
 * assessment: reason, optional missingContext paths, and optional
 * missingMappings gaps keep their presence/absence, order, values, and the
 * null-versus-string distinction of every gap value.
 */
function buildInsufficientContextAssessment(
  applicability: TenantApplicabilityResult,
): ImpactAssessment {
  const parsedApplicability = requireInsufficientApplicability(applicability);

  const assessment: Record<string, unknown> = {
    state: 'INSUFFICIENT_CONTEXT',
    reason: parsedApplicability.reason,
  };

  if (
    Object.prototype.hasOwnProperty.call(parsedApplicability, 'missingContext')
  ) {
    if (parsedApplicability.missingContext === undefined) {
      throw new Error(
        'missingContext must be a non-empty path list when present on INSUFFICIENT_CONTEXT input',
      );
    }
    assessment.missingContext = [...parsedApplicability.missingContext];
  }

  if (
    Object.prototype.hasOwnProperty.call(parsedApplicability, 'missingMappings')
  ) {
    if (parsedApplicability.missingMappings === undefined) {
      throw new Error(
        'missingMappings must be a non-empty mapping-gap list when present on INSUFFICIENT_CONTEXT input',
      );
    }
    assessment.missingMappings = copyMissingMappings(
      parsedApplicability.missingMappings,
    );
  }

  return ImpactAssessmentSchema.parse(assessment);
}

function buildFinalAssessment(decision: FinalDecision): ImpactAssessment {
  if (decision.state === 'NOT_APPLICABLE') {
    return ImpactAssessmentSchema.parse({
      state: 'NOT_APPLICABLE',
      reason: decision.tenantApplicability.reason,
      evidence: nonApplicabilityEvidenceIds(decision),
    });
  }

  return buildInsufficientContextAssessment(decision.tenantApplicability);
}

function buildVersionBundle(
  sourceMessageVersion: string,
  profileVersion: string,
  riskPolicyRulesVersion: string,
  tenantApplicabilityPolicyRulesVersion: string,
): VersionBundle {
  return {
    sourceMessageVersion,
    tenantProfileVersion: profileVersion,
    policyVersions: {
      riskPolicyRulesVersion,
      tenantApplicabilityPolicyRulesVersion,
    },
    ai: { used: false },
  };
}

function buildChangeEventReference(
  changeEvent: ChangeEvent,
  sourceMessageVersion: string,
): ChangeEventReference {
  return {
    source: changeEvent.source,
    externalId: changeEvent.externalId,
    sourceMessageVersion,
  };
}

/**
 * Convert an already-determined `DETERMINISTIC_FINAL` decision into a final
 * no-AI `AnalysisRecord` without consulting any classifier.
 *
 * The function is pure and deterministic: it never generates identifiers or
 * timestamps, never mutates any input, and accepts no metadata beyond the
 * three required caller-owned fields. The same inputs always yield a
 * deep-equal record, the returned record round-trips through JSON, and
 * provenance delegation keeps the fixed evidence order and dependency closure
 * of {@link createDeterministicEvidenceRecords}.
 */
export function createDeterministicFinalAnalysisRecord(
  changeEvent: ChangeEvent,
  sourceMessageVersion: string,
  tenantProfile: TenantProfile,
  decision: DeterministicImpactDecision,
  metadata: DeterministicFinalAnalysisMetadata,
): AnalysisRecord {
  const parsedMetadata =
    DeterministicFinalAnalysisMetadataSchema.parse(metadata);
  const parsedSourceMessageVersion = nonEmptyString.parse(sourceMessageVersion);
  const parsedProfile = TenantProfileSchema.parse(tenantProfile);
  const parsedEvent = ChangeEventSchema.parse(changeEvent);

  if (decision === null || typeof decision !== 'object') {
    throw new TypeError('decision must be a DETERMINISTIC_FINAL object');
  }
  if ((decision as { kind?: unknown }).kind !== 'DETERMINISTIC_FINAL') {
    throw new Error(
      `createDeterministicFinalAnalysisRecord requires kind=DETERMINISTIC_FINAL; received kind=${String((decision as { kind?: unknown }).kind)}`,
    );
  }

  // The complete strict-schema parse happens after the focused kind gate so
  // GUARDRAIL_FLOOR and CLASSIFICATION_REQUIRED are rejected by identity while
  // structural defects in a final decision are still caught by the shared
  // decision schema refinements.
  const parsedDecision = DeterministicImpactDecisionSchema.parse(decision);
  if (parsedDecision.kind !== 'DETERMINISTIC_FINAL') {
    throw new Error('decision must remain DETERMINISTIC_FINAL after parsing');
  }

  const provenanceRecords: DeterministicEvidenceRecord[] =
    createDeterministicEvidenceRecords(
      parsedEvent,
      parsedSourceMessageVersion,
      parsedProfile,
      parsedDecision,
    );

  const record = {
    analysisId: parsedMetadata.analysisId,
    tenantId: parsedMetadata.tenantId,
    createdAt: parsedMetadata.createdAt,
    changeEventRef: buildChangeEventReference(
      parsedEvent,
      parsedSourceMessageVersion,
    ),
    versionBundle: buildVersionBundle(
      parsedSourceMessageVersion,
      parsedProfile.profileVersion,
      parsedDecision.riskEvaluation.policyRulesVersion,
      parsedDecision.tenantApplicability.policyRulesVersion,
    ),
    impactAssessment: buildFinalAssessment(parsedDecision),
    provenanceRecords,
  };

  return AnalysisRecordSchema.parse(record);
}
