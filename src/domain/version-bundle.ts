import { z } from 'zod';

const nonEmptyString = z.string().min(1);

const NoAIUsageSchema = z
  .object({
    used: z.literal(false),
  })
  .strict();

const AIUsedSchema = z
  .object({
    used: z.literal(true),
    promptVersion: nonEmptyString,
    model: nonEmptyString,
    modelVersion: nonEmptyString,
  })
  .strict();

export const AIUsageSchema = z.discriminatedUnion('used', [
  NoAIUsageSchema,
  AIUsedSchema,
]);

export type AIUsage = z.infer<typeof AIUsageSchema>;

export const PolicyVersionBundleSchema = z
  .object({
    riskPolicyRulesVersion: nonEmptyString,
    tenantApplicabilityPolicyRulesVersion: nonEmptyString,
  })
  .strict();

export type PolicyVersionBundle = z.infer<typeof PolicyVersionBundleSchema>;

export const VersionBundleSchema = z
  .object({
    sourceMessageVersion: nonEmptyString,
    tenantProfileVersion: nonEmptyString,
    policyVersions: PolicyVersionBundleSchema,
    ai: AIUsageSchema,
  })
  .strict();

export type VersionBundle = z.infer<typeof VersionBundleSchema>;
