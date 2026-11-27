import { z } from 'zod';

import {
  AnalysisRecordSchema,
  type AnalysisRecord,
  type ChangeEventReference,
} from './analysis-record.js';
import type { ImpactAssessment } from './impact-assessment.js';
import { ImpactAssessmentSchema } from './impact-assessment.js';
import {
  StructuredClassificationAIInferenceSchema,
  type StructuredClassificationAIInference,
} from './provenance.js';
import { EvidenceIdSchema } from './evidence-id.js';
import {
  StructuredImpactClassificationMergeResultSchema,
  type StructuredImpactClassificationMergeResult,
} from './structured-impact-classification-merge.js';
import { VersionBundleSchema, type AIUsage } from './version-bundle.js';

const nonEmptyString = z.string().min(1);
/** Callers must supply an explicit offset-aware ISO datetime; clocks are not
 * consulted anywhere inside this builder. */
const offsetIsoDateTime = z.iso.datetime({ offset: true });

/**
 * Explicit analysis envelope and execution-identity metadata. Every value is
 * caller-owned: this builder never generates an identifier, never reads a
 * clock, and never invents a model identity.
 */
export const StructuredClassificationAnalysisMetadataSchema = z
  .object({
    analysisId: nonEmptyString,
    tenantId: nonEmptyString,
    createdAt: offsetIsoDateTime,
    inferenceEvidenceId: EvidenceIdSchema,
    promptVersion: nonEmptyString,
    model: nonEmptyString,
    modelVersion: nonEmptyString,
  })
  .strict();

export type StructuredClassificationAnalysisMetadata = z.infer<
  typeof StructuredClassificationAnalysisMetadataSchema
>;

/**
 * Losslessly copy the validated merge assessment into the final record:
 * state, reason, evidence (or the `INSUFFICIENT_CONTEXT` missingContext /
 * missingMappings fields) keep their exact values, order, and presence — the
 * classification path never invents a mapping-gap field the merge result did
 * not carry.
 */
function buildImpactAssessment(
  mergeResult: StructuredImpactClassificationMergeResult,
): ImpactAssessment {
  const source = mergeResult.mergedImpactAssessment;
  const assessment: Record<string, unknown> = {
    state: source.state,
    reason: source.reason,
  };

  if (source.state === 'INSUFFICIENT_CONTEXT') {
    if (source.missingContext !== undefined) {
      assessment.missingContext = [...source.missingContext];
    }
    if (source.missingMappings !== undefined) {
      assessment.missingMappings = source.missingMappings.map((gap) => ({
        field: gap.field,
        value: gap.value,
      }));
    }
  } else {
    assessment.evidence = [...source.evidence];
  }

  return ImpactAssessmentSchema.parse(assessment);
}

/**
 * Derive the AI-used version bundle entirely from the request versions and
 * caller metadata: no default version exists anywhere on this path.
 */
function buildVersionBundle(
  sourceMessageVersion: string,
  profileVersion: string,
  riskPolicyRulesVersion: string,
  tenantApplicabilityPolicyRulesVersion: string,
  ai: AIUsage & { used: true },
) {
  return VersionBundleSchema.parse({
    sourceMessageVersion,
    tenantProfileVersion: profileVersion,
    policyVersions: {
      riskPolicyRulesVersion,
      tenantApplicabilityPolicyRulesVersion,
    },
    ai: {
      used: true,
      promptVersion: ai.promptVersion,
      model: ai.model,
      modelVersion: ai.modelVersion,
    },
  });
}

/** The change event reference copies the request's event identity verbatim. */
function buildChangeEventReference(
  mergeResult: StructuredImpactClassificationMergeResult,
): ChangeEventReference {
  const changeEvent = mergeResult.classification.request.changeEvent;
  return {
    source: changeEvent.source,
    externalId: changeEvent.externalId,
    sourceMessageVersion:
      mergeResult.classification.request.sourceMessageVersion,
  };
}

/**
 * Convert an already-validated structured classification merge result into a
 * final AI-enabled `AnalysisRecord` without calling any provider, generating
 * an identifier, or reading a clock.
 *
 * The function is pure and deterministic: it re-parses both inputs through
 * their strict schemas (so any tampering is rejected), revalidates the full
 * request/output chain, preserves every deterministic provenance record in ID,
 * order, and content, appends exactly one classification AI inference record
 * whose execution identity comes from the caller metadata, copies the merged
 * impact assessment losslessly, and self-validates the finished record against
 * {@link AnalysisRecordSchema}. Equal inputs always yield deep-equal records.
 */
export function createStructuredClassificationAnalysisRecord(
  mergeResult: StructuredImpactClassificationMergeResult,
  metadata: StructuredClassificationAnalysisMetadata,
): AnalysisRecord {
  const parsedMetadata =
    StructuredClassificationAnalysisMetadataSchema.parse(metadata);
  const parsedMergeResult =
    StructuredImpactClassificationMergeResultSchema.parse(mergeResult);
  const classification = parsedMergeResult.classification;
  const output = classification.output;

  const inferenceRecord: StructuredClassificationAIInference = {
    kind: 'ai_inference',
    evidenceId: parsedMetadata.inferenceEvidenceId,
    promptVersion: parsedMetadata.promptVersion,
    model: parsedMetadata.model,
    modelVersion: parsedMetadata.modelVersion,
    confidence: output.confidence,
    inference: output.reason,
    dependsOnEvidenceIds: [...output.supportingEvidenceIds],
    // Carried by direct reference: the output above is already a validated
    // deep clone produced by the merge-result re-parse, and the trailing
    // StructuredClassificationAIInferenceSchema.parse below hands the record
    // its own validated clone. No JSON round-trip may happen inside the
    // builder — it would silently normalize raw proposal values.
    classificationOutput: output,
  };

  const existingIds = new Set(
    classification.request.evidenceRecords.map((record) => record.evidenceId),
  );
  if (existingIds.has(inferenceRecord.evidenceId)) {
    throw new Error(
      `inferenceEvidenceId must not collide with a deterministic evidence ID: ${inferenceRecord.evidenceId}`,
    );
  }

  const provenanceRecords = [
    ...classification.request.evidenceRecords,
    StructuredClassificationAIInferenceSchema.parse(inferenceRecord),
  ];

  const decision = classification.request.decision;
  const record = {
    analysisId: parsedMetadata.analysisId,
    tenantId: parsedMetadata.tenantId,
    createdAt: parsedMetadata.createdAt,
    changeEventRef: buildChangeEventReference(parsedMergeResult),
    versionBundle: buildVersionBundle(
      classification.request.sourceMessageVersion,
      classification.request.tenantProfile.profileVersion,
      decision.riskEvaluation.policyRulesVersion,
      decision.tenantApplicability.policyRulesVersion,
      {
        used: true,
        promptVersion: parsedMetadata.promptVersion,
        model: parsedMetadata.model,
        modelVersion: parsedMetadata.modelVersion,
      },
    ),
    impactAssessment: buildImpactAssessment(parsedMergeResult),
    provenanceRecords,
  };

  return AnalysisRecordSchema.parse(record);
}
