import { z } from 'zod';

import { ChangeEventSchema } from '../domain/change-event.js';
import { RiskStateFloorSchema } from '../domain/risk-policy.js';
import { TenantProfileSchema } from '../domain/tenant-profile.js';

const nonEmptyString = z.string().min(1);
const shortReason = z.string().min(1).max(280);

export const CorpusFixtureIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export type CorpusFixtureId = z.infer<typeof CorpusFixtureIdSchema>;

export const CorpusPathSchema = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      !path.includes('\\') &&
      !path.split('/').includes('..') &&
      path.endsWith('.json'),
    'corpus paths must be relative JSON paths',
  );
export type CorpusPath = z.infer<typeof CorpusPathSchema>;

export const CorpusCoverageTagSchema = z.enum([
  'major-change',
  'admin-deadline',
  'admin-impact',
  'high-severity',
  'critical-severity',
  'retirement',
  'deprecation',
  'security',
  'privacy',
  'compliance',
  'unknown-tenant-context',
  'clearly-non-applicable',
  'informational',
  'tenant-variation',
  'confirmed-absence',
  'unknown-signal',
  'ambiguous-scope',
  'contradictory-source-signals',
  'user-communication',
  'ownership',
  'maintenance-window',
  'platform-difference',
  'endpoint-difference',
  'teams',
  'exchange-online',
  'sharepoint-onedrive',
  'intune',
  'entra-id',
  'defender-security',
  'purview-compliance',
  'power-platform',
  'viva',
]);
export type CorpusCoverageTag = z.infer<typeof CorpusCoverageTagSchema>;

const coverageTags = z
  .array(CorpusCoverageTagSchema)
  .min(1)
  .refine((tags) => new Set(tags).size === tags.length, {
    message: 'coverage tags must be unique',
  });

const evaluationTags = z
  .array(nonEmptyString)
  .min(1)
  .refine((tags) => new Set(tags).size === tags.length, {
    message: 'evaluation tags must be unique',
  });

const syntheticMarker = z.literal(true);

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const ChangeFixtureSchema = z
  .object({
    fixtureId: CorpusFixtureIdSchema,
    synthetic: syntheticMarker,
    event: ChangeEventSchema,
    coverageTags,
  })
  .strict()
  .superRefine((fixture, context) => {
    if (
      !isObjectRecord(fixture.event.sourceMetadata) ||
      fixture.event.sourceMetadata.synthetic !== true
    ) {
      context.addIssue({
        code: 'custom',
        path: ['event', 'sourceMetadata', 'synthetic'],
        message:
          'synthetic change fixtures must mark sourceMetadata.synthetic=true',
      });
    }
  });
export type ChangeFixture = z.infer<typeof ChangeFixtureSchema>;

export const TenantProfileFixtureSchema = z
  .object({
    fixtureId: CorpusFixtureIdSchema,
    synthetic: syntheticMarker,
    profile: TenantProfileSchema,
    coverageTags,
  })
  .strict();
export type TenantProfileFixture = z.infer<typeof TenantProfileFixtureSchema>;

const ActionExpectedSchema = z
  .object({
    state: z.literal('ACTION_REQUIRED'),
    minimumRiskFloor: RiskStateFloorSchema.optional(),
    reason: shortReason,
  })
  .strict();

const ReviewExpectedSchema = z
  .object({
    state: z.literal('REVIEW_REQUIRED'),
    minimumRiskFloor: z.literal('REVIEW_REQUIRED').optional(),
    reason: shortReason,
  })
  .strict();

const InformationalExpectedSchema = z
  .object({
    state: z.literal('INFORMATIONAL'),
    reason: shortReason,
  })
  .strict();

const NotApplicableExpectedSchema = z
  .object({
    state: z.literal('NOT_APPLICABLE'),
    reason: shortReason,
  })
  .strict();

const InsufficientContextExpectedSchema = z
  .object({
    state: z.literal('INSUFFICIENT_CONTEXT'),
    reason: shortReason,
    missingContext: z
      .array(nonEmptyString)
      .min(1)
      .refine((paths) => new Set(paths).size === paths.length, {
        message: 'missing context paths must be unique',
      }),
  })
  .strict();

export const GoldenExpectedSchema = z.discriminatedUnion('state', [
  ActionExpectedSchema,
  ReviewExpectedSchema,
  InformationalExpectedSchema,
  NotApplicableExpectedSchema,
  InsufficientContextExpectedSchema,
]);
export type GoldenExpected = z.infer<typeof GoldenExpectedSchema>;

export const GoldenImportanceSchema = z.enum([
  'low',
  'medium',
  'high',
  'critical',
]);
export type GoldenImportance = z.infer<typeof GoldenImportanceSchema>;

export const GoldenCaseSchema = z
  .object({
    caseId: CorpusFixtureIdSchema,
    synthetic: syntheticMarker,
    changeFixtureId: CorpusFixtureIdSchema,
    tenantProfileFixtureId: CorpusFixtureIdSchema,
    expected: GoldenExpectedSchema,
    importance: GoldenImportanceSchema,
    highImpact: z.boolean(),
    coverageTags,
    evaluationTags,
  })
  .strict();
export type GoldenCase = z.infer<typeof GoldenCaseSchema>;

export const CorpusFileReferenceSchema = z
  .object({
    fixtureId: CorpusFixtureIdSchema,
    path: CorpusPathSchema,
  })
  .strict();
export type CorpusFileReference = z.infer<typeof CorpusFileReferenceSchema>;

export const CorpusCaseReferenceSchema = z
  .object({
    caseId: CorpusFixtureIdSchema,
    path: CorpusPathSchema,
  })
  .strict();
export type CorpusCaseReference = z.infer<typeof CorpusCaseReferenceSchema>;

export const CorpusManifestSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+(?:\.\d+)*$/),
    corpusId: CorpusFixtureIdSchema,
    corpusVersion: nonEmptyString,
    synthetic: syntheticMarker,
    changeFixtures: z.array(CorpusFileReferenceSchema).min(1),
    tenantProfileFixtures: z.array(CorpusFileReferenceSchema).min(1),
    goldenCases: z.array(CorpusCaseReferenceSchema).min(1),
  })
  .strict();
export type CorpusManifest = z.infer<typeof CorpusManifestSchema>;

export const CorpusCollectionSchema = z
  .object({
    manifest: CorpusManifestSchema,
    changeFixtures: z.array(ChangeFixtureSchema).min(1),
    tenantProfileFixtures: z.array(TenantProfileFixtureSchema).min(1),
    goldenCases: z.array(GoldenCaseSchema).min(1),
  })
  .strict();
export type CorpusCollection = z.infer<typeof CorpusCollectionSchema>;
