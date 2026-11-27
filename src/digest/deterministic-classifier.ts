import type { StructuredImpactClassifier } from '../domain/impact-analysis-runner.js';
import {
  StructuredClassificationAIInferenceSchema,
  type StructuredClassificationAIInference,
} from '../domain/provenance.js';
import { StructuredImpactClassificationRequestSchema } from '../domain/structured-impact-classification.js';

export const ROADMAP_DETERMINISTIC_CLASSIFIER_EVIDENCE_ID =
  'ai.provider-free-roadmap-classifier';
export const ROADMAP_DETERMINISTIC_CLASSIFIER_PROMPT_VERSION =
  'provider-free-roadmap-rule-classifier-v1';
export const ROADMAP_DETERMINISTIC_CLASSIFIER_MODEL =
  'provider-free-deterministic-classifier';
export const ROADMAP_DETERMINISTIC_CLASSIFIER_MODEL_VERSION = '1.0.0';

const DETERMINISTIC_CONFIDENCE = 0.5;

/**
 * Provider-free ($0 API cost) deterministic classifier for public Microsoft 365
 * Roadmap digest runs.
 *
 * - Never calls any external API, SDK, network socket, clock, or RNG.
 * - Uses only evidence records already present in `StructuredImpactClassificationRequest`.
 * - Proposes `REVIEW_REQUIRED` when the tenant applicability status is
 *   `APPLICABLE`, `changeEvent.signals.hasAdminImpact === true`, and the tenant
 *   profile has not explicitly opted out via `changePolicy.adminImpactRequiresReview === false`.
 * - Proposes `INFORMATIONAL` otherwise; any deterministic `GUARDRAIL_FLOOR`
 *   (`ACTION_REQUIRED` or `REVIEW_REQUIRED`) is still enforced upward by
 *   `createStructuredImpactClassificationMergeResult`.
 */
export function createRoadmapRuleClassifier(): StructuredImpactClassifier {
  return async (rawRequest) => {
    const request =
      StructuredImpactClassificationRequestSchema.parse(rawRequest);

    const availableIds = new Set(
      request.evidenceRecords.map((record) => record.evidenceId),
    );

    const supportingEvidenceIds: string[] = [];
    const pushIfPresent = (id: string): void => {
      if (availableIds.has(id) && !supportingEvidenceIds.includes(id)) {
        supportingEvidenceIds.push(id);
      }
    };

    pushIfPresent('source.event.title');
    pushIfPresent('source.event.body');
    pushIfPresent('source.event.signals.hasAdminImpact');

    for (const record of request.evidenceRecords) {
      if (
        record.kind === 'deterministic_conclusion' &&
        record.policyKind === 'tenant_applicability_policy'
      ) {
        pushIfPresent(record.evidenceId);
      }
    }

    if (supportingEvidenceIds.length === 0) {
      throw new Error(
        'provider-free roadmap classifier found no qualifying request-local evidence IDs',
      );
    }

    const isApplicable =
      request.decision.tenantApplicability.status === 'APPLICABLE';
    const hasAdminImpact = request.changeEvent.signals?.hasAdminImpact === true;
    const adminReviewEnabled =
      request.tenantProfile.changePolicy.adminImpactRequiresReview !== false;

    const affectedComponents = [...request.changeEvent.products];

    const proposedState =
      isApplicable && hasAdminImpact && adminReviewEnabled
        ? ('REVIEW_REQUIRED' as const)
        : ('INFORMATIONAL' as const);

    const reason =
      proposedState === 'REVIEW_REQUIRED'
        ? 'Provider-free deterministic rule classifier: change carries normalized administrator impact signal for an applicable tenant service and requires IT review.'
        : 'Provider-free deterministic rule classifier: no external LLM invoked; proposing INFORMATIONAL prior to deterministic risk-policy guardrail merge.';

    const output = {
      proposedState,
      confidence: DETERMINISTIC_CONFIDENCE,
      reason,
      affectedComponents,
      supportingEvidenceIds,
    };

    const inferenceRecord: StructuredClassificationAIInference = {
      kind: 'ai_inference',
      evidenceId: ROADMAP_DETERMINISTIC_CLASSIFIER_EVIDENCE_ID,
      promptVersion: ROADMAP_DETERMINISTIC_CLASSIFIER_PROMPT_VERSION,
      model: ROADMAP_DETERMINISTIC_CLASSIFIER_MODEL,
      modelVersion: ROADMAP_DETERMINISTIC_CLASSIFIER_MODEL_VERSION,
      confidence: DETERMINISTIC_CONFIDENCE,
      inference: reason,
      dependsOnEvidenceIds: [...supportingEvidenceIds],
      classificationOutput: output,
    };

    return StructuredClassificationAIInferenceSchema.parse(inferenceRecord);
  };
}
