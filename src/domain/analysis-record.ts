import { z } from 'zod';

import {
  ImpactAssessmentSchema,
  type ImpactAssessment,
} from './impact-assessment.js';
import { ProvenanceRecordSchema, type ProvenanceRecord } from './provenance.js';
import { VersionBundleSchema } from './version-bundle.js';

const nonEmptyString = z.string().min(1);
const isoDateTime = z.iso.datetime({ offset: true });

export const ChangeEventReferenceSchema = z
  .object({
    source: nonEmptyString,
    externalId: nonEmptyString,
    sourceMessageVersion: nonEmptyString,
  })
  .strict();

export type ChangeEventReference = z.infer<typeof ChangeEventReferenceSchema>;

const AnalysisRecordBaseSchema = z
  .object({
    analysisId: nonEmptyString,
    tenantId: nonEmptyString,
    createdAt: isoDateTime,
    changeEventRef: ChangeEventReferenceSchema,
    versionBundle: VersionBundleSchema,
    impactAssessment: ImpactAssessmentSchema,
    provenanceRecords: z.array(ProvenanceRecordSchema).min(1),
  })
  .strict();

function assessmentEvidenceIds(assessment: ImpactAssessment): string[] {
  return assessment.state === 'INSUFFICIENT_CONTEXT' ? [] : assessment.evidence;
}

function dependencyIds(record: ProvenanceRecord): string[] {
  if (
    record.kind === 'deterministic_conclusion' ||
    record.kind === 'ai_inference'
  ) {
    return record.dependsOnEvidenceIds;
  }
  return [];
}

function addMissingReferenceIssue(
  context: z.RefinementCtx,
  id: string,
  path: PropertyKey[],
): void {
  context.addIssue({
    code: 'custom',
    path,
    message: `evidence ID does not exist in this analysis: ${id}`,
  });
}

export const AnalysisRecordSchema = AnalysisRecordBaseSchema.superRefine(
  (record, context) => {
    const evidenceIds = new Set<string>();

    record.provenanceRecords.forEach((provenance, index) => {
      if (evidenceIds.has(provenance.evidenceId)) {
        context.addIssue({
          code: 'custom',
          path: ['provenanceRecords', index, 'evidenceId'],
          message: `duplicate evidence ID: ${provenance.evidenceId}`,
        });
      }
      evidenceIds.add(provenance.evidenceId);
    });

    const assessmentIds = assessmentEvidenceIds(record.impactAssessment);
    const assessmentIdSet = new Set<string>();
    assessmentIds.forEach((id, index) => {
      if (assessmentIdSet.has(id)) {
        context.addIssue({
          code: 'custom',
          path: ['impactAssessment', 'evidence', index],
          message: `duplicate assessment evidence ID: ${id}`,
        });
      }
      assessmentIdSet.add(id);
      if (!evidenceIds.has(id)) {
        addMissingReferenceIssue(context, id, [
          'impactAssessment',
          'evidence',
          index,
        ]);
      }
    });

    record.provenanceRecords.forEach((provenance, index) => {
      dependencyIds(provenance).forEach((id, dependencyIndex) => {
        if (!evidenceIds.has(id)) {
          addMissingReferenceIssue(context, id, [
            'provenanceRecords',
            index,
            'dependsOnEvidenceIds',
            dependencyIndex,
          ]);
        }
      });
    });

    if (
      record.changeEventRef.sourceMessageVersion !==
      record.versionBundle.sourceMessageVersion
    ) {
      context.addIssue({
        code: 'custom',
        path: ['changeEventRef', 'sourceMessageVersion'],
        message: 'ChangeEvent reference version must match the version bundle',
      });
    }

    const aiUsage = record.versionBundle.ai;
    let aiInferenceCount = 0;
    record.provenanceRecords.forEach((provenance, index) => {
      if (provenance.kind === 'source_fact') {
        if (
          provenance.sourceMessageVersion !==
          record.versionBundle.sourceMessageVersion
        ) {
          context.addIssue({
            code: 'custom',
            path: ['provenanceRecords', index, 'sourceMessageVersion'],
            message: 'source fact version must match the version bundle',
          });
        }
        if (
          provenance.source !== record.changeEventRef.source ||
          provenance.externalId !== record.changeEventRef.externalId
        ) {
          context.addIssue({
            code: 'custom',
            path: ['provenanceRecords', index],
            message: 'source fact must refer to the envelope ChangeEvent',
          });
        }
      }

      if (
        provenance.kind === 'tenant_fact' &&
        provenance.tenantProfileVersion !==
          record.versionBundle.tenantProfileVersion
      ) {
        context.addIssue({
          code: 'custom',
          path: ['provenanceRecords', index, 'tenantProfileVersion'],
          message: 'tenant fact version must match the version bundle',
        });
      }

      if (provenance.kind === 'deterministic_conclusion') {
        const expectedPolicyRulesVersion =
          provenance.policyKind === 'risk_policy'
            ? record.versionBundle.policyVersions.riskPolicyRulesVersion
            : record.versionBundle.policyVersions
                .tenantApplicabilityPolicyRulesVersion;

        if (provenance.policyRulesVersion !== expectedPolicyRulesVersion) {
          context.addIssue({
            code: 'custom',
            path: ['provenanceRecords', index, 'policyRulesVersion'],
            message:
              'deterministic conclusion version must match its owning policy in the version bundle',
          });
        }
      }

      if (provenance.kind === 'ai_inference') {
        aiInferenceCount += 1;
        if (
          aiUsage.used &&
          (provenance.promptVersion !== aiUsage.promptVersion ||
            provenance.model !== aiUsage.model ||
            provenance.modelVersion !== aiUsage.modelVersion)
        ) {
          context.addIssue({
            code: 'custom',
            path: ['provenanceRecords', index],
            message:
              'AI inference execution details must match the version bundle',
          });
        }
      }
    });

    if (!aiUsage.used && aiInferenceCount > 0) {
      context.addIssue({
        code: 'custom',
        path: ['versionBundle', 'ai', 'used'],
        message: 'AI inference records require an AI-enabled version bundle',
      });
    }
    if (aiUsage.used && aiInferenceCount === 0) {
      context.addIssue({
        code: 'custom',
        path: ['provenanceRecords'],
        message: 'AI-enabled analyses require at least one AI inference record',
      });
    }
  },
);

export type AnalysisRecord = z.infer<typeof AnalysisRecordSchema>;
