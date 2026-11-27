import { z } from 'zod';

import { JsonValueSchema } from './json-value.js';

const nonEmptyString = z.string().min(1);
const isoDateTime = z.iso.datetime({ offset: true });

export const SeveritySchema = z.enum(['low', 'medium', 'high', 'critical']);
export type Severity = z.infer<typeof SeveritySchema>;

export const ChangeSignalTagSchema = z.enum([
  'admin-impact',
  'retirement',
  'deprecation',
  'security',
  'privacy',
  'compliance',
]);
export type ChangeSignalTag = z.infer<typeof ChangeSignalTagSchema>;

const uniqueSignalTags = z
  .array(ChangeSignalTagSchema)
  .refine((tags) => new Set(tags).size === tags.length, {
    message: 'signal tags must be unique',
  });

/**
 * Normalized, source-neutral indicators available to deterministic policies.
 * Optional properties intentionally preserve the distinction between an
 * explicitly reported false value and a signal that was not reported.
 */
export const ChangeSignalsSchema = z
  .object({
    isMajorChange: z.boolean().optional(),
    actionRequiredBy: isoDateTime.nullable().optional(),
    hasAdminImpact: z.boolean().optional(),
    isRetirementOrDeprecation: z.boolean().optional(),
    hasSecurityImpact: z.boolean().optional(),
    hasPrivacyImpact: z.boolean().optional(),
    hasComplianceImpact: z.boolean().optional(),
    tags: uniqueSignalTags.optional(),
  })
  .strict();

export type ChangeSignals = z.infer<typeof ChangeSignalsSchema>;

const ChangeEventBaseSchema = z
  .object({
    source: nonEmptyString,
    externalId: nonEmptyString,
    title: nonEmptyString,
    body: z.string(),
    publishedAt: isoDateTime,
    updatedAt: isoDateTime,
    products: z.array(nonEmptyString),
    categories: z.array(nonEmptyString),
    severity: SeveritySchema.nullable().optional(),
    signals: ChangeSignalsSchema.optional(),
    sourceMetadata: JsonValueSchema,
  })
  .strict();

export const ChangeEventSchema = ChangeEventBaseSchema.superRefine(
  (event, context) => {
    if (Date.parse(event.updatedAt) < Date.parse(event.publishedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['updatedAt'],
        message: 'updatedAt must not be earlier than publishedAt',
      });
    }
  },
);

export type ChangeEvent = z.infer<typeof ChangeEventSchema>;
