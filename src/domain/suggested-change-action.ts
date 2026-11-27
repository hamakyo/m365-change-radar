import { z } from 'zod';

import {
  AnalysisRecordSchema,
  type AnalysisRecord,
} from './analysis-record.js';
import { EvidenceIdSchema, type ProvenanceRecord } from './provenance.js';
import type { ImpactState } from './impact-assessment.js';

const nonEmptyString = z.string().min(1);
/** A known deadline must be explicit: a bare local time or epoch number is
 * rejected in favor of an offset-aware ISO datetime. */
const offsetIsoDateTime = z.iso.datetime({ offset: true });

/**
 * Exact five-kind classification of which operational purpose a suggested
 * step serves (investigate, plan, implement, communicate, validate). The
 * values deliberately stay free of provider- or product-specific vocabulary
 * so the purpose remains machine-checkable.
 */
export const SuggestedChangeActionKindSchema = z.enum([
  'INVESTIGATE',
  'PLAN',
  'IMPLEMENT',
  'COMMUNICATE',
  'VALIDATE',
]);
export type SuggestedChangeActionKind = z.infer<
  typeof SuggestedChangeActionKindSchema
>;

/**
 * Which generation path produced the suggestion. Discriminated on `origin`:
 * rule-derived suggestions must not speculate, and every AI-assisted
 * suggestion carries an explicit confidence score.
 */
export const SuggestedChangeActionOriginSchema = z.enum([
  'deterministic',
  'ai_inference',
]);
export type SuggestedChangeActionOrigin = z.infer<
  typeof SuggestedChangeActionOriginSchema
>;

/**
 * Known assignment fields are attached only when they are actually known:
 * there is no null sentinel and no empty-string placeholder, so an absent
 * field means "unknown" instead of an invented default.
 */
const sharedAssignmentFields = {
  actionId: EvidenceIdSchema,
  kind: SuggestedChangeActionKindSchema,
  title: nonEmptyString,
  description: nonEmptyString,
  ownerKey: nonEmptyString.optional(),
  dueAt: offsetIsoDateTime.optional(),
};

/**
 * A field that may be unknown must be expressed by absence only: an
 * own-property holding explicit `undefined` is a JSON lossy sentinel and is
 * rejected in addition to the normal absent-optional acceptance. Kept as a
 * per-variant `superRefine` so the check never widens into the envelope's
 * other objects.
 */
function refineNoExplicitUndefinedFields(
  value: Record<string, unknown>,
  context: z.RefinementCtx,
): void {
  (['ownerKey', 'dueAt'] as const).forEach((field) => {
    if (Object.hasOwn(value, field) && value[field] === undefined) {
      context.addIssue({
        code: 'custom',
        path: [field],
        message: `${field} must be omitted entirely when unknown (no explicit undefined)`,
      });
    }
  });
}

const uniqueSupportingEvidenceIds = z
  .array(EvidenceIdSchema)
  .min(1)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: 'supportingEvidenceIds must be unique',
  });

/**
 * JSON-stable confidence for AI-origin actions. Internal helper backing the
 * AI variant of `SuggestedChangeActionSchema` — deliberately not exported;
 * the public contract is the action schema itself. Finite numbers in
 * [0, 1] are required exactly as before, with one added
 * boundary: negative zero is rejected. JavaScript silently converts
 * `Object.is(value, -0)` values to the positive `0` during
 * `JSON.stringify`, so accepting `-0` would let a parsed-then-serialized
 * confidence change its observable value and break the JSON round-trip
 * promise this contract makes. `+0` stays a valid confidence.
 */
const jsonStableActionConfidence = z
  .number()
  .finite()
  .min(0)
  .max(1)
  .refine((value) => !Object.is(value, -0), {
    message: 'confidence must not be negative zero (-0 breaks JSON round-trip)',
  });

const deterministicVariantObject = z
  .object({
    ...sharedAssignmentFields,
    origin: z.literal('deterministic'),
    supportingEvidenceIds: uniqueSupportingEvidenceIds,
  })
  .strict()
  .superRefine(refineNoExplicitUndefinedFields);

const aiVariantObject = z
  .object({
    ...sharedAssignmentFields,
    origin: z.literal('ai_inference'),
    supportingEvidenceIds: uniqueSupportingEvidenceIds,
    confidence: jsonStableActionConfidence,
  })
  .strict()
  .superRefine(refineNoExplicitUndefinedFields);

/**
 * Strict discriminated union over the generation origin. The deterministic
 * variant carries no `confidence` field at all — any own-property
 * `confidence` value, including explicit `undefined`, fails strict key
 * checking — while AI-assisted suggestions require a finite one in [0, 1]
 * that is not negative zero (the internal AI confidence boundary: `-0`
 * would turn into `0` through `JSON.stringify` and silently change value).
 * Both
 * variants reject an own-property explicit `undefined` for `ownerKey`
 * and `dueAt`, so unknown assignment data can only be expressed by true
 * field absence.
 */
export const SuggestedChangeActionSchema = z.discriminatedUnion('origin', [
  deterministicVariantObject,
  aiVariantObject,
]);

export type SuggestedChangeAction = z.infer<typeof SuggestedChangeActionSchema>;

function addIssue(
  context: z.RefinementCtx,
  path: PropertyKey[],
  message: string,
): void {
  context.addIssue({ code: 'custom', path, message });
}

/** The analysis states from which suggesting work to a human is legitimate. */
const actionableStates: readonly ImpactState[] = [
  'ACTION_REQUIRED',
  'REVIEW_REQUIRED',
];

type EnvelopeInput = {
  analysisRecord: AnalysisRecord;
  actions: readonly SuggestedChangeAction[];
};

/**
 * Cross-record refinements shared by the state gate. Checks run against the
 * parsed envelope only; no input object is read or written.
 *
 * - every `actionId` is unique within the result;
 * - every `supportingEvidenceIds` entry refers to a provenance record that
 *   exists inside the bundled analysisRecord. The whole provenance set is
 *   addressable — not just the assessment evidence subset — so actions can
 *   cite any evidence the analysis holds;
 * - `supportingEvidenceIds` order is preserved exactly as given (checked in
 *   input order, never reordered);
 * - deterministic actions reference no `ai_inference` record;
 * - every AI-origin action references at least one `ai_inference` record;
 * - the assessment state must be ACTION_REQUIRED or REVIEW_REQUIRED; the
 *   three other states are rejected as non-actionable inputs.
 */
function refineEnvelope(result: EnvelopeInput, context: z.RefinementCtx): void {
  const seenActionIds = new Set<string>();
  result.actions.forEach((action, index) => {
    if (seenActionIds.has(action.actionId)) {
      addIssue(
        context,
        ['actions', index, 'actionId'],
        `duplicate actionId: ${action.actionId}`,
      );
    }
    seenActionIds.add(action.actionId);
  });

  const assessmentState: ImpactState =
    result.analysisRecord.impactAssessment.state;
  if (!actionableStates.includes(assessmentState)) {
    addIssue(
      context,
      ['analysisRecord', 'impactAssessment', 'state'],
      `impactAssessment.state must be ACTION_REQUIRED or REVIEW_REQUIRED for suggested actions: ${assessmentState}`,
    );
  }

  const evidenceById = new Map<string, ProvenanceRecord>();
  result.analysisRecord.provenanceRecords.forEach((record) => {
    evidenceById.set(record.evidenceId, record);
  });

  result.actions.forEach((action, index) => {
    const deterministic = action.origin === 'deterministic';
    let referencesAiInference = false;

    action.supportingEvidenceIds.forEach((evidenceId, idIndex) => {
      const record = evidenceById.get(evidenceId);
      if (record === undefined) {
        addIssue(
          context,
          ['actions', index, 'supportingEvidenceIds', idIndex],
          `supporting evidence ID does not exist in this analysis: ${evidenceId}`,
        );
      }
      if (record?.kind === 'ai_inference') {
        referencesAiInference = true;
        if (deterministic) {
          addIssue(
            context,
            ['actions', index, 'supportingEvidenceIds', idIndex],
            `deterministic action must not reference AI inference evidence: ${evidenceId}`,
          );
        }
      }
    });

    if (!deterministic && !referencesAiInference) {
      addIssue(
        context,
        ['actions', index, 'supportingEvidenceIds'],
        'AI-origin action requires at least one AI inference reference',
      );
    }
  });
}

/**
 * Strict JSON-safe pairing of one final actionable `AnalysisRecord` with one
 * or more suggested, never-executed operational steps for a human owner.
 * The bundled analysis keeps its full existing validation chain (versions,
 * dependency closure, evidence integrity) because it is parsed with the
 * unchanged `AnalysisRecordSchema`.
 */
export const SuggestedChangeActionResultSchema = z
  .object({
    analysisRecord: AnalysisRecordSchema,
    actions: z.array(SuggestedChangeActionSchema).min(1),
  })
  .strict()
  .superRefine(refineEnvelope);

export type SuggestedChangeActionResult = z.infer<
  typeof SuggestedChangeActionResultSchema
>;
