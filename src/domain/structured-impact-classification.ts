import { z } from 'zod';

import { ChangeEventSchema } from './change-event.js';
import { DeterministicImpactDecisionSchema } from './deterministic-impact-decision.js';
import {
  DeterministicConclusionSchema,
  SourceFactSchema,
  TenantFactSchema,
} from './provenance.js';
import { TenantProfileSchema } from './tenant-profile.js';
import {
  StructuredImpactClassificationOutputSchema as SharedOutputSchema,
  type StructuredImpactClassificationOutput,
} from './structured-classification-output.js';

const nonEmptyString = z.string().min(1);

/** Provenance records that a structured classifier may inspect. */
export const ClassifierEvidenceRecordSchema = z.discriminatedUnion('kind', [
  SourceFactSchema,
  TenantFactSchema,
  DeterministicConclusionSchema,
]);
export type ClassifierEvidenceRecord = z.infer<
  typeof ClassifierEvidenceRecordSchema
>;

const uniqueEvidenceRecords = z
  .array(ClassifierEvidenceRecordSchema)
  .min(1)
  .superRefine((records, context) => {
    const seen = new Set<string>();
    records.forEach((record, index) => {
      if (seen.has(record.evidenceId)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'evidenceId'],
          message: `duplicate evidence ID: ${record.evidenceId}`,
        });
      }
      seen.add(record.evidenceId);
    });
  });

const classifierDecisionSchema = z.discriminatedUnion('kind', [
  DeterministicImpactDecisionSchema.options[0],
  DeterministicImpactDecisionSchema.options[1],
]);

/** Input record for a structured classification call. */
export const StructuredImpactClassificationRequestSchema = z
  .object({
    changeEvent: ChangeEventSchema,
    sourceMessageVersion: nonEmptyString,
    tenantProfile: TenantProfileSchema,
    decision: classifierDecisionSchema,
    evidenceRecords: uniqueEvidenceRecords,
  })
  .strict()
  .superRefine((request, context) => {
    const evidenceIds = new Set(
      request.evidenceRecords.map((record) => record.evidenceId),
    );

    request.evidenceRecords.forEach((record, index) => {
      if (record.kind === 'source_fact') {
        if (record.source !== request.changeEvent.source) {
          context.addIssue({
            code: 'custom',
            path: ['evidenceRecords', index, 'source'],
            message: 'source fact source must match changeEvent.source',
          });
        }
        if (record.externalId !== request.changeEvent.externalId) {
          context.addIssue({
            code: 'custom',
            path: ['evidenceRecords', index, 'externalId'],
            message: 'source fact externalId must match changeEvent.externalId',
          });
        }
        if (record.sourceMessageVersion !== request.sourceMessageVersion) {
          context.addIssue({
            code: 'custom',
            path: ['evidenceRecords', index, 'sourceMessageVersion'],
            message:
              'source fact sourceMessageVersion must match request sourceMessageVersion',
          });
        }
      }

      if (
        record.kind === 'tenant_fact' &&
        record.tenantProfileVersion !== request.tenantProfile.profileVersion
      ) {
        context.addIssue({
          code: 'custom',
          path: ['evidenceRecords', index, 'tenantProfileVersion'],
          message:
            'tenant fact tenantProfileVersion must match tenantProfile.profileVersion',
        });
      }

      if (record.kind === 'deterministic_conclusion') {
        const expectedPolicyRulesVersion =
          record.policyKind === 'risk_policy'
            ? request.decision.riskEvaluation.policyRulesVersion
            : request.decision.tenantApplicability.policyRulesVersion;

        if (record.policyRulesVersion !== expectedPolicyRulesVersion) {
          context.addIssue({
            code: 'custom',
            path: ['evidenceRecords', index, 'policyRulesVersion'],
            message:
              'deterministic conclusion policyRulesVersion must match its owning decision policy',
          });
        }

        record.dependsOnEvidenceIds.forEach((evidenceId, dependencyIndex) => {
          if (!evidenceIds.has(evidenceId)) {
            context.addIssue({
              code: 'custom',
              path: [
                'evidenceRecords',
                index,
                'dependsOnEvidenceIds',
                dependencyIndex,
              ],
              message: `dependency evidence ID does not exist in this request: ${evidenceId}`,
            });
          }
        });
      }
    });
  });
export type StructuredImpactClassificationRequest = z.infer<
  typeof StructuredImpactClassificationRequestSchema
>;

/**
 * Five-state structured model output, before any future floor merge.
 *
 * Phase 1I-4 moved the schema itself into the dependency-light
 * `structured-classification-output.ts` module so AI provenance can embed it;
 * this file re-exports the same schema instance to keep every existing
 * public import path and runtime value identical.
 */
export const StructuredImpactClassificationOutputSchema = SharedOutputSchema;
export { type StructuredImpactClassificationOutput };

/** A request and its structured output with request-local evidence references. */
export const StructuredImpactClassificationSchema = z
  .object({
    request: StructuredImpactClassificationRequestSchema,
    output: StructuredImpactClassificationOutputSchema,
  })
  .strict()
  .superRefine((classification, context) => {
    const evidenceIds = new Set(
      classification.request.evidenceRecords.map((record) => record.evidenceId),
    );
    classification.output.supportingEvidenceIds.forEach((evidenceId, index) => {
      if (!evidenceIds.has(evidenceId)) {
        context.addIssue({
          code: 'custom',
          path: ['output', 'supportingEvidenceIds', index],
          message: `supporting evidence ID does not exist in this request: ${evidenceId}`,
        });
      }
    });
  });
export type StructuredImpactClassification = z.infer<
  typeof StructuredImpactClassificationSchema
>;
