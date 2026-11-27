import { z } from 'zod';

import { ChangeEventSchema, type ChangeEvent } from './change-event.js';
import {
  DeterministicImpactDecisionSchema,
  type DeterministicImpactDecision,
} from './deterministic-impact-decision.js';
import { createDeterministicEvidenceRecords } from './deterministic-evidence-record-builder.js';
import {
  StructuredImpactClassificationRequestSchema,
  type StructuredImpactClassificationRequest,
} from './structured-impact-classification.js';
import { TenantProfileSchema, type TenantProfile } from './tenant-profile.js';

const nonEmptyString = z.string().min(1);

/**
 * Build the strict structured-classification request from parsed inputs and
 * complete deterministic evaluator results. Evidence construction is shared
 * with the no-AI deterministic path; this wrapper only keeps the classifier
 * boundary for non-final decisions.
 */
export function createStructuredImpactClassificationRequest(
  changeEvent: ChangeEvent,
  sourceMessageVersion: string,
  tenantProfile: TenantProfile,
  decision: DeterministicImpactDecision,
): StructuredImpactClassificationRequest {
  const parsedEvent = ChangeEventSchema.parse(changeEvent);
  const parsedSourceMessageVersion = nonEmptyString.parse(sourceMessageVersion);
  const parsedProfile = TenantProfileSchema.parse(tenantProfile);
  const parsedDecision = DeterministicImpactDecisionSchema.parse(decision);

  if (parsedDecision.kind === 'DETERMINISTIC_FINAL') {
    throw new Error(
      'structured classification requests require a non-final deterministic decision',
    );
  }

  return StructuredImpactClassificationRequestSchema.parse({
    changeEvent: parsedEvent,
    sourceMessageVersion: parsedSourceMessageVersion,
    tenantProfile: parsedProfile,
    decision: parsedDecision,
    evidenceRecords: createDeterministicEvidenceRecords(
      parsedEvent,
      parsedSourceMessageVersion,
      parsedProfile,
      parsedDecision,
    ),
  });
}
