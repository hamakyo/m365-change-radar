import type { AnalysisRecord } from './analysis-record.js';
import type { ChangeEvent } from './change-event.js';
import { ChangeEventSchema } from './change-event.js';
import {
  DeterministicFinalAnalysisMetadataSchema,
  createDeterministicFinalAnalysisRecord,
  type DeterministicFinalAnalysisMetadata,
} from './deterministic-final-analysis-record.js';
import {
  StructuredClassificationAIInferenceSchema,
  type StructuredClassificationAIInference,
} from './provenance.js';
import { RiskPolicySchema, type RiskPolicy } from './risk-policy.js';
import { evaluateRiskPolicy } from './risk-policy-evaluator.js';
import { createStructuredClassificationAnalysisRecord } from './structured-classification-analysis-record.js';
import { TenantProfileSchema, type TenantProfile } from './tenant-profile.js';
import {
  TenantApplicabilityPolicySchema,
  type TenantApplicabilityPolicy,
} from './tenant-applicability.js';
import { evaluateTenantApplicability } from './tenant-applicability-evaluator.js';
import { createDeterministicImpactDecision } from './deterministic-impact-decision-evaluator.js';
import { createStructuredImpactClassificationRequest } from './structured-impact-classification-request-builder.js';
import type { StructuredImpactClassificationRequest } from './structured-impact-classification.js';
import {
  StructuredImpactClassificationRequestSchema,
  StructuredImpactClassificationSchema,
  type StructuredImpactClassification,
} from './structured-impact-classification.js';
import type { StructuredImpactClassificationMergeResult } from './structured-impact-classification-merge.js';
import { createStructuredImpactClassificationMergeResult } from './structured-impact-classification-merge-evaluator.js';
import { z } from 'zod';

/**
 * Caller-owned analysis envelope metadata, reusing the existing strict
 * three-field deterministic-final contract unchanged (`analysisId`,
 * `tenantId`, offset-aware `createdAt`). The classifier execution identity is
 * never part of this envelope: prompt/model versions and the AI inference
 * record's evidence ID are read from the `AIInference` record the classifier
 * returns, so no duplicated execution-identity contract exists on the runner
 * path.
 */
export type ImpactAnalysisMetadata = DeterministicFinalAnalysisMetadata;

/**
 * Injected structured classifier boundary. Receives the complete strict
 * classification request built by the existing request builder and returns
 * the provider-call result shaped as the existing structured classification
 * AI inference record; the runner never touches any provider, SDK, API,
 * credential, or prompt text.
 */
export type StructuredImpactClassifier = (
  request: StructuredImpactClassificationRequest,
) => Promise<StructuredClassificationAIInference>;

/** The runner-level boundary contract for a non-empty source message
 * version: one strict parse shared by every caller-controlled string. */
const runnerSourceMessageVersionSchema = z.string().min(1);

/**
 * Orchestrate one change × tenant impact analysis end to end using only the
 * existing domain evaluators and builders.
 *
 * Every caller-controlled input — the `ChangeEvent`, the source message
 * version, the `TenantProfile`, the `RiskPolicy`, and the
 * `TenantApplicabilityPolicy` — is schema-parsed at the runner boundary
 * before any evaluator or builder runs, so no evaluator can observe an
 * unchecked value and downstream builders receive only parsed authoritative
 * values. The runner evaluates the risk policy, evaluates tenant
 * applicability, and selects the deterministic decision. A
 * `DETERMINISTIC_FINAL` decision is delegated to
 * `createDeterministicFinalAnalysisRecord` with the injected classifier
 * called zero times. Any other decision is converted into a structured
 * classification request by the existing builder; the authoritative request
 * drives the merge/record chain, while a lossless JSON clone re-parsed
 * through the unchanged `StructuredImpactClassificationRequestSchema` is
 * handed to the injected classifier exactly once, so any in-place inspection
 * or mutation by the classifier cannot reach the authoritative request, the
 * caller's inputs, or the returned `AnalysisRecord`. The returned record is
 * validated as a complete existing `StructuredClassificationAIInference`
 * (enforcing the confidence/reason/dependency ownership of the raw
 * proposal), the authoritative proposal is joined with the request through
 * the existing `StructuredImpactClassificationSchema`, passed through the
 * guardrail merge evaluator, and converted into the final AI-enabled
 * `AnalysisRecord` by the existing classification record builder.
 *
 * The function never mutates any input, never generates an identifier or
 * clock value, and never consults a provider: every AI execution identity
 * (prompt/model versions and the inference evidence ID) comes from the
 * classifier's returned record, and equal inputs with an equal classifier
 * result always yield a deep-equal record.
 */
export async function createImpactAnalysisRecord(
  changeEvent: ChangeEvent,
  sourceMessageVersion: string,
  tenantProfile: TenantProfile,
  riskPolicy: RiskPolicy,
  tenantApplicabilityPolicy: TenantApplicabilityPolicy,
  metadata: ImpactAnalysisMetadata,
  classifier: StructuredImpactClassifier,
): Promise<AnalysisRecord> {
  // Validate every caller-controlled input at the runner boundary before
  // any evaluator or builder runs. Only the parsed authoritative values
  // below ever reach evaluateRiskPolicy, evaluateTenantApplicability, or any
  // downstream builder, so no evaluator can observe an unchecked input.
  const authoritativeEvent = ChangeEventSchema.parse(changeEvent);
  const authoritativeSourceMessageVersion =
    runnerSourceMessageVersionSchema.parse(sourceMessageVersion);
  const authoritativeProfile = TenantProfileSchema.parse(tenantProfile);
  const authoritativeRiskPolicy = RiskPolicySchema.parse(riskPolicy);
  const authoritativeTenantApplicabilityPolicy =
    TenantApplicabilityPolicySchema.parse(tenantApplicabilityPolicy);

  // Validate the caller-owned envelope before any branch: the same strict
  // three-field contract applies to both branches, so unknown extra keys are
  // rejected uniformly and the envelope fields below are exact parsed copies.
  const parsedMetadata =
    DeterministicFinalAnalysisMetadataSchema.parse(metadata);

  const riskEvaluation = evaluateRiskPolicy(
    authoritativeRiskPolicy,
    authoritativeEvent,
  );
  const tenantApplicability = evaluateTenantApplicability(
    authoritativeTenantApplicabilityPolicy,
    authoritativeEvent,
    authoritativeProfile,
  );
  const decision = createDeterministicImpactDecision(
    riskEvaluation,
    tenantApplicability,
  );

  if (decision.kind === 'DETERMINISTIC_FINAL') {
    return createDeterministicFinalAnalysisRecord(
      authoritativeEvent,
      authoritativeSourceMessageVersion,
      authoritativeProfile,
      decision,
      parsedMetadata,
    );
  }

  // The authoritative request stays runner-owned: it drives the merge and
  // record chain below and is never handed to the classifier, because the
  // existing builder shares nested members with the parsed caller inputs by
  // reference.
  const authoritativeRequest = createStructuredImpactClassificationRequest(
    authoritativeEvent,
    authoritativeSourceMessageVersion,
    authoritativeProfile,
    decision,
  );

  // Structurally separate clone for the classifier: a JSON round-trip —
  // always lossless for builder-produced requests, whose strict JSON-safe
  // members guarantee serialization safety — followed by a full re-parse
  // through the unchanged `StructuredImpactClassificationRequestSchema`.
  // Only this clone reaches the classifier, exactly once, so any in-place
  // inspection or mutation by the classifier can never reach the
  // authoritative request, the caller's inputs, or the returned record.
  const classifierRequest = StructuredImpactClassificationRequestSchema.parse(
    JSON.parse(JSON.stringify(authoritativeRequest)) as unknown,
  );

  // Exactly one classifier call on the classification path, receiving the
  // runner-owned clone. The return value is re-parsed through the existing
  // strict schema, so a tampered, incomplete, or otherwise invalid AI record
  // — including a violated confidence/reason/dependency ownership rule — is
  // rejected here before any merge work happens.
  const inferenceRecord = StructuredClassificationAIInferenceSchema.parse(
    await classifier(classifierRequest),
  );

  // Join the raw proposal with the authoritative request through the
  // existing schema: the proposal's supporting evidence IDs must exist in
  // this request, so a classifier result from a different request cannot
  // cross the boundary.
  const classification: StructuredImpactClassification =
    StructuredImpactClassificationSchema.parse({
      request: authoritativeRequest,
      output: inferenceRecord.classificationOutput,
    });

  const mergeResult: StructuredImpactClassificationMergeResult =
    createStructuredImpactClassificationMergeResult(classification);

  // The execution identity comes from the returned AI record; the existing
  // seven-field metadata contract is satisfied by combining the caller's
  // envelope with that identity — no runner-level identity contract exists.
  return createStructuredClassificationAnalysisRecord(mergeResult, {
    analysisId: parsedMetadata.analysisId,
    tenantId: parsedMetadata.tenantId,
    createdAt: parsedMetadata.createdAt,
    inferenceEvidenceId: inferenceRecord.evidenceId,
    promptVersion: inferenceRecord.promptVersion,
    model: inferenceRecord.model,
    modelVersion: inferenceRecord.modelVersion,
  });
}
