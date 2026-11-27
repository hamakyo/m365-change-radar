import { z } from 'zod';

import { EvidenceIdSchema } from './evidence-id.js';
import { JsonValueSchema } from './json-value.js';
import {
  StructuredImpactClassificationOutputSchema,
  type StructuredImpactClassificationOutput,
} from './structured-classification-output.js';

const nonEmptyString = z.string().min(1);

export const DeterministicPolicyKindSchema = z.enum([
  'risk_policy',
  'tenant_applicability_policy',
]);
export type DeterministicPolicyKind = z.infer<
  typeof DeterministicPolicyKindSchema
>;

export { EvidenceIdSchema, type EvidenceId } from './evidence-id.js';

const presentFactObservationSchema = z
  .object({
    presence: z.literal('present'),
    value: JsonValueSchema,
  })
  .strict();

const absentFactObservationSchema = z
  .object({
    presence: z.literal('absent'),
  })
  .strict();

export const FactObservationSchema = z.discriminatedUnion('presence', [
  presentFactObservationSchema,
  absentFactObservationSchema,
]);
export type FactObservation = z.infer<typeof FactObservationSchema>;

const evidenceIdList = z
  .array(EvidenceIdSchema)
  .min(1)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: 'evidence IDs must be unique within a dependency list',
  });

export const SourceFactSchema = z
  .object({
    kind: z.literal('source_fact'),
    evidenceId: EvidenceIdSchema,
    source: nonEmptyString,
    externalId: nonEmptyString,
    sourceMessageVersion: nonEmptyString,
    path: nonEmptyString,
    observation: FactObservationSchema,
  })
  .strict();

export type SourceFact = z.infer<typeof SourceFactSchema>;

export const TenantFactSchema = z
  .object({
    kind: z.literal('tenant_fact'),
    evidenceId: EvidenceIdSchema,
    tenantProfileVersion: nonEmptyString,
    path: nonEmptyString,
    observation: FactObservationSchema,
  })
  .strict();

export type TenantFact = z.infer<typeof TenantFactSchema>;

export const DeterministicConclusionSchema = z
  .object({
    kind: z.literal('deterministic_conclusion'),
    evidenceId: EvidenceIdSchema,
    policyKind: DeterministicPolicyKindSchema,
    policyRulesVersion: nonEmptyString,
    ruleId: nonEmptyString,
    conclusion: nonEmptyString,
    dependsOnEvidenceIds: evidenceIdList,
  })
  .strict();

export type DeterministicConclusion = z.infer<
  typeof DeterministicConclusionSchema
>;

/**
 * Optional structured classifier output carried by a generic `ai_inference`
 * record. When present it is parsed as a complete, strict
 * `StructuredImpactClassificationOutput`, so the raw proposal survives with
 * its exact order and values (including `missingContext` for
 * `INSUFFICIENT_CONTEXT` proposals).
 */
const classificationOutputSchema =
  StructuredImpactClassificationOutputSchema.optional();

/**
 * Same-record ownership of the shared AI fields by the structured output:
 * `confidence === classificationOutput.confidence`,
 * `inference === classificationOutput.reason`, and an order-exact
 * `dependsOnEvidenceIds === classificationOutput.supportingEvidenceIds`.
 * Missing, extra, reordered, duplicated, or mismatched values are rejected.
 */
function addOwnershipIssues(
  record: {
    confidence: number;
    inference: string;
    dependsOnEvidenceIds: string[];
    classificationOutput?: StructuredImpactClassificationOutput | undefined;
  },
  context: z.RefinementCtx,
): void {
  const output = record.classificationOutput;
  if (output === undefined) {
    return;
  }

  if (record.confidence !== output.confidence) {
    context.addIssue({
      code: 'custom',
      path: ['classificationOutput', 'confidence'],
      message: 'confidence must match classificationOutput.confidence',
    });
  }
  if (record.inference !== output.reason) {
    context.addIssue({
      code: 'custom',
      path: ['classificationOutput', 'reason'],
      message: 'inference must match classificationOutput.reason',
    });
  }
  if (
    record.dependsOnEvidenceIds.length !==
      output.supportingEvidenceIds.length ||
    !record.dependsOnEvidenceIds.every(
      (id, index) => id === output.supportingEvidenceIds[index],
    )
  ) {
    context.addIssue({
      code: 'custom',
      path: ['dependsOnEvidenceIds'],
      message:
        'dependsOnEvidenceIds must equal classificationOutput.supportingEvidenceIds in order',
    });
  }
}

const aiInferenceBaseObject = z
  .object({
    kind: z.literal('ai_inference'),
    evidenceId: EvidenceIdSchema,
    promptVersion: nonEmptyString,
    model: nonEmptyString,
    modelVersion: nonEmptyString,
    confidence: z.number().finite().min(0).max(1),
    inference: nonEmptyString,
    dependsOnEvidenceIds: evidenceIdList,
  })
  .strict();

/**
 * Generic AI inference record; may carry a structured output without
 * requiring one.
 */
export const AIInferenceSchema = aiInferenceBaseObject
  .extend({
    classificationOutput: classificationOutputSchema,
  })
  .superRefine((record, context) => {
    addOwnershipIssues(record, context);
  });

export type AIInference = z.infer<typeof AIInferenceSchema>;

/**
 * Classification-specific refinement of `AIInference`: the complete
 * `StructuredImpactClassificationOutput` is required at both the schema and
 * type level (the required field comes from this Zod object itself), and the
 * record's confidence, reason text, and dependency IDs are owned by that
 * output. The ownership rule is the same single implementation shared with
 * `AIInferenceSchema`, so generic and structured records behave identically
 * whenever an output is present.
 */
export const StructuredClassificationAIInferenceSchema = aiInferenceBaseObject
  .extend({
    classificationOutput: StructuredImpactClassificationOutputSchema,
  })
  .superRefine(addOwnershipIssues);

export type StructuredClassificationAIInference = z.infer<
  typeof StructuredClassificationAIInferenceSchema
>;

export const ProvenanceRecordSchema = z.discriminatedUnion('kind', [
  SourceFactSchema,
  TenantFactSchema,
  DeterministicConclusionSchema,
  AIInferenceSchema,
]);

export type ProvenanceRecord = z.infer<typeof ProvenanceRecordSchema>;
