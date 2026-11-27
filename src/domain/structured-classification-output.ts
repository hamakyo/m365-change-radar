import { z } from 'zod';

import { EvidenceIdSchema } from './evidence-id.js';

const nonEmptyString = z.string().min(1);

const uniqueStrings = z
  .array(nonEmptyString)
  .refine((values) => new Set(values).size === values.length, {
    message: 'values must be unique',
  });

const supportingEvidenceIds = z
  .array(EvidenceIdSchema)
  .min(1)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: 'supporting evidence IDs must be unique',
  });

/**
 * Shared confidence schema for every `StructuredImpactClassificationOutput`
 * variant: a finite number from 0 through 1 that explicitly rejects negative
 * zero. `-0 === 0` passes the numeric bounds, but `JSON.stringify(-0)`
 * serializes as `0`, so a confidence of `-0` would silently change value
 * across a JSON round trip and break the output's JSON-safe contract.
 * Positive zero and every other in-range finite value are accepted
 * unchanged. This shared instance is the single enforcement point, so the
 * refinement applies to all five `proposedState` variants at once.
 */
const confidenceSchema = z
  .number()
  .finite()
  .min(0)
  .max(1)
  .refine((value) => !Object.is(value, -0), {
    message: 'confidence must not be negative zero',
  });

const outputBase = {
  confidence: confidenceSchema,
  reason: nonEmptyString,
  affectedComponents: uniqueStrings,
  supportingEvidenceIds,
};

const outputWithoutMissingContext = z
  .object({
    proposedState: z.enum([
      'ACTION_REQUIRED',
      'REVIEW_REQUIRED',
      'INFORMATIONAL',
      'NOT_APPLICABLE',
    ]),
    ...outputBase,
  })
  .strict();

const insufficientContextOutput = z
  .object({
    proposedState: z.literal('INSUFFICIENT_CONTEXT'),
    ...outputBase,
    missingContext: uniqueStrings.min(1),
  })
  .strict();

/**
 * Five-state structured model output, before any future floor merge.
 *
 * This schema moved out of `structured-impact-classification.ts` in Phase
 * 1I-4 so the AI provenance layer can embed it as a strict, lossless record
 * of the raw classifier proposal without a circular module dependency. The
 * parsing behavior and the public type are unchanged.
 */
export const StructuredImpactClassificationOutputSchema = z.discriminatedUnion(
  'proposedState',
  [outputWithoutMissingContext, insufficientContextOutput],
);
export type StructuredImpactClassificationOutput = z.infer<
  typeof StructuredImpactClassificationOutputSchema
>;
