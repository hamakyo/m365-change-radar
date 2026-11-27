import { z } from 'zod';

import { TenantApplicabilityMappingGapSchema } from './tenant-applicability.js';

const nonEmptyString = z.string().min(1);
const evidence = z.array(nonEmptyString).min(1);

const uniqueMissingContext = z
  .array(nonEmptyString)
  .min(1)
  .refine((values) => new Set(values).size === values.length, {
    message: 'missingContext values must be unique',
  });

const uniqueMissingMappings = z
  .array(TenantApplicabilityMappingGapSchema)
  .min(1)
  .refine(
    (gaps) =>
      new Set(gaps.map((gap) => JSON.stringify([gap.field, gap.value])))
        .size === gaps.length,
    { message: 'mapping gaps must be unique' },
  );

export const ImpactStateSchema = z.enum([
  'ACTION_REQUIRED',
  'REVIEW_REQUIRED',
  'INFORMATIONAL',
  'NOT_APPLICABLE',
  'INSUFFICIENT_CONTEXT',
]);
export type ImpactState = z.infer<typeof ImpactStateSchema>;

const explainableState = (
  state: 'ACTION_REQUIRED' | 'REVIEW_REQUIRED' | 'INFORMATIONAL',
) =>
  z
    .object({
      state: z.literal(state),
      reason: nonEmptyString,
      evidence,
    })
    .strict();

const ActionRequiredSchema = explainableState('ACTION_REQUIRED');
const ReviewRequiredSchema = explainableState('REVIEW_REQUIRED');
const InformationalSchema = explainableState('INFORMATIONAL');

const NotApplicableSchema = z
  .object({
    state: z.literal('NOT_APPLICABLE'),
    reason: nonEmptyString,
    evidence,
  })
  .strict();

const InsufficientContextSchema = z
  .object({
    state: z.literal('INSUFFICIENT_CONTEXT'),
    reason: nonEmptyString,
    /** Missing tenant profile paths; absent when only the mapping is missing. */
    missingContext: uniqueMissingContext.optional(),
    /** Mapping gaps for event values with no policy mapping. These are not
     * evidence IDs and never refer to provenance records. */
    missingMappings: uniqueMissingMappings.optional(),
  })
  .strict()
  .superRefine((assessment, context) => {
    const hasMissingContext = assessment.missingContext !== undefined;
    const hasMissingMappings = assessment.missingMappings !== undefined;
    if (!hasMissingContext && !hasMissingMappings) {
      context.addIssue({
        code: 'custom',
        path: ['missingContext'],
        message:
          'INSUFFICIENT_CONTEXT requires missingContext or missingMappings',
      });
    }
  });

export const ImpactAssessmentSchema = z.discriminatedUnion('state', [
  ActionRequiredSchema,
  ReviewRequiredSchema,
  InformationalSchema,
  NotApplicableSchema,
  InsufficientContextSchema,
]);

export type ImpactAssessment = z.infer<typeof ImpactAssessmentSchema>;
