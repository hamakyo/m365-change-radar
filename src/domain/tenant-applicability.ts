import { z } from 'zod';

const nonEmptyString = z.string().min(1);

/** Sections of TenantProfile that this contract permits a rule to inspect. */
export const TenantContextSectionSchema = z.enum([
  'services',
  'environment',
  'capabilities',
]);
export type TenantContextSection = z.infer<typeof TenantContextSectionSchema>;

/**
 * One declarative lookup in the tenant profile. The section is deliberately a
 * closed vocabulary: ownership, changePolicy, maintenance, and organization
 * are not policy inputs in this phase.
 */
export const TenantContextConditionSchema = z
  .object({
    section: TenantContextSectionSchema,
    key: nonEmptyString,
    equals: z.boolean(),
  })
  .strict();
export type TenantContextCondition = z.infer<
  typeof TenantContextConditionSchema
>;

/** Three-valued result for one tenant context lookup. */
export const TenantContextConditionStatusSchema = z.enum([
  'MATCH',
  'NO_MATCH',
  'UNKNOWN',
]);
export type TenantContextConditionStatus = z.infer<
  typeof TenantContextConditionStatusSchema
>;

/** Event fields available to a tenant applicability selector. */
export const TenantApplicabilityEventSelectorFieldSchema = z.enum([
  'products',
  'categories',
]);
export type TenantApplicabilityEventSelectorField = z.infer<
  typeof TenantApplicabilityEventSelectorFieldSchema
>;

const uniqueBoundedStrings = z
  .array(nonEmptyString)
  .min(1)
  .max(8)
  .refine((values) => new Set(values).size === values.length, {
    message: 'values must be unique',
  });

const ProductsSelectorSchema = z
  .object({
    field: z.literal('products'),
    values: uniqueBoundedStrings,
  })
  .strict();

const CategoriesSelectorSchema = z
  .object({
    field: z.literal('categories'),
    values: uniqueBoundedStrings,
  })
  .strict();

/**
 * A selector can inspect only normalized ChangeEvent.products or
 * ChangeEvent.categories. `field` is the discriminator so source metadata,
 * provider paths, regular expressions, and executable predicates cannot enter
 * a policy.
 */
export const TenantApplicabilityEventSelectorSchema = z.discriminatedUnion(
  'field',
  [ProductsSelectorSchema, CategoriesSelectorSchema],
);
export type TenantApplicabilityEventSelector = z.infer<
  typeof TenantApplicabilityEventSelectorSchema
>;

const boundedContextConditions = z
  .array(TenantContextConditionSchema)
  .min(1)
  .max(8)
  .refine(
    (conditions) =>
      new Set(
        conditions.map(
          (condition) => `${condition.section}\u0000${condition.key}`,
        ),
      ).size === conditions.length,
    {
      message:
        'condition paths must be unique within an all_of or any_of group',
    },
  );

export const TenantApplicabilityAllOfConditionSchema = z
  .object({
    kind: z.literal('all_of'),
    conditions: boundedContextConditions,
  })
  .strict();
export type TenantApplicabilityAllOfCondition = z.infer<
  typeof TenantApplicabilityAllOfConditionSchema
>;

export const TenantApplicabilityAnyOfConditionSchema = z
  .object({
    kind: z.literal('any_of'),
    conditions: boundedContextConditions,
  })
  .strict();
export type TenantApplicabilityAnyOfCondition = z.infer<
  typeof TenantApplicabilityAnyOfConditionSchema
>;

/**
 * Bounded tenant condition DSL. Groups contain TenantContextCondition values
 * only; nested groups and arbitrary expression trees are not accepted.
 */
export const TenantApplicabilityConditionSchema = z.discriminatedUnion('kind', [
  TenantApplicabilityAllOfConditionSchema,
  TenantApplicabilityAnyOfConditionSchema,
]);
export type TenantApplicabilityCondition = z.infer<
  typeof TenantApplicabilityConditionSchema
>;

/** One policy rule that maps an event selector to tenant conditions. */
export const TenantApplicabilityRuleSchema = z
  .object({
    ruleId: nonEmptyString,
    enabled: z.boolean(),
    selector: TenantApplicabilityEventSelectorSchema,
    condition: TenantApplicabilityConditionSchema,
    description: nonEmptyString.optional(),
  })
  .strict();
export type TenantApplicabilityRule = z.infer<
  typeof TenantApplicabilityRuleSchema
>;

/**
 * Versioned tenant applicability policy. Rule IDs are unique within one
 * policy so result records can refer to one enabled rule unambiguously. A
 * policy may include disabled rules, but must retain at least one enabled rule.
 */
export const TenantApplicabilityPolicySchema = z
  .object({
    policyId: nonEmptyString,
    policyRulesVersion: nonEmptyString,
    description: nonEmptyString,
    rules: z.array(TenantApplicabilityRuleSchema).min(1),
  })
  .strict()
  .superRefine((policy, context) => {
    const seen = new Set<string>();
    policy.rules.forEach((rule, index) => {
      if (seen.has(rule.ruleId)) {
        context.addIssue({
          code: 'custom',
          path: ['rules', index, 'ruleId'],
          message: `duplicate rule ID: ${rule.ruleId}`,
        });
      }
      seen.add(rule.ruleId);
    });
    if (!policy.rules.some((rule) => rule.enabled)) {
      context.addIssue({
        code: 'custom',
        path: ['rules'],
        message: 'policy must contain at least one enabled rule',
      });
    }
  });
export type TenantApplicabilityPolicy = z.infer<
  typeof TenantApplicabilityPolicySchema
>;

/** Final tenant applicability states, independent from ImpactAssessment. */
export const TenantApplicabilityStatusSchema = z.enum([
  'APPLICABLE',
  'NOT_APPLICABLE',
  'INSUFFICIENT_CONTEXT',
]);
export type TenantApplicabilityStatus = z.infer<
  typeof TenantApplicabilityStatusSchema
>;

/** Selector outcome for an enabled rule result. */
export const TenantApplicabilitySelectorStatusSchema = z.enum([
  'MATCH',
  'NO_MATCH',
]);
export type TenantApplicabilitySelectorStatus = z.infer<
  typeof TenantApplicabilitySelectorStatusSchema
>;

/** A profile path that was inspected or was needed but absent. */
export const TenantContextPathSchema = z
  .string()
  .regex(
    /^(?:services|environment|capabilities)\..+$/,
    'tenant context paths must address services, environment, or capabilities',
  );
export type TenantContextPath = z.infer<typeof TenantContextPathSchema>;

const uniqueTenantPaths = z
  .array(TenantContextPathSchema)
  .min(1)
  .refine((paths) => new Set(paths).size === paths.length, {
    message: 'tenant paths must be unique',
  });

/** A selector value not represented by the policy mapping. `null` records an
 * empty selector event array with no value available for evaluation. */
export const TenantApplicabilityMappingGapSchema = z
  .object({
    field: TenantApplicabilityEventSelectorFieldSchema,
    value: nonEmptyString.nullable(),
  })
  .strict();
export type TenantApplicabilityMappingGap = z.infer<
  typeof TenantApplicabilityMappingGapSchema
>;

const uniqueMappingGaps = z
  .array(TenantApplicabilityMappingGapSchema)
  .min(1)
  .refine(
    (gaps) =>
      new Set(gaps.map((gap) => JSON.stringify([gap.field, gap.value])))
        .size === gaps.length,
    { message: 'mapping gaps must be unique' },
  );

/**
 * Result for one inspected tenant condition. `observed: null` represents an
 * absent profile key; false remains an explicit observed boolean.
 */
export const TenantApplicabilityConditionResultSchema = z
  .object({
    status: TenantContextConditionStatusSchema,
    section: TenantContextSectionSchema,
    key: nonEmptyString,
    expected: z.boolean(),
    observed: z.boolean().nullable(),
    path: TenantContextPathSchema,
    reason: nonEmptyString,
  })
  .strict()
  .superRefine((result, context) => {
    const expectedPath = `${result.section}.${result.key}`;
    if (result.path !== expectedPath) {
      context.addIssue({
        code: 'custom',
        path: ['path'],
        message: 'path must match section and key',
      });
    }

    if (result.status === 'UNKNOWN') {
      if (result.observed !== null) {
        context.addIssue({
          code: 'custom',
          path: ['observed'],
          message: 'UNKNOWN condition results must have observed=null',
        });
      }
      return;
    }

    if (result.observed === null) {
      context.addIssue({
        code: 'custom',
        path: ['observed'],
        message: 'known condition results must include an observed boolean',
      });
      return;
    }

    const isMatch = result.observed === result.expected;
    if (result.status === 'MATCH' && !isMatch) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'MATCH requires observed to equal expected',
      });
    }
    if (result.status === 'NO_MATCH' && isMatch) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'NO_MATCH requires observed to differ from expected',
      });
    }
  });
export type TenantApplicabilityConditionResult = z.infer<
  typeof TenantApplicabilityConditionResultSchema
>;

const uniqueConditionResults = z
  .array(TenantApplicabilityConditionResultSchema)
  .min(1)
  .max(8)
  .refine(
    (results) =>
      new Set(results.map((result) => result.path)).size === results.length,
    { message: 'condition result paths must be unique' },
  );

const conditionGroupKindSchema = z.enum(['all_of', 'any_of']);

const aggregateConditionStatus = (
  kind: z.infer<typeof conditionGroupKindSchema>,
  results: TenantApplicabilityConditionResult[],
): TenantContextConditionStatus => {
  const statuses = results.map((result) => result.status);
  if (kind === 'all_of') {
    if (statuses.includes('NO_MATCH')) return 'NO_MATCH';
    if (statuses.includes('UNKNOWN')) return 'UNKNOWN';
    return 'MATCH';
  }

  if (statuses.includes('MATCH')) return 'MATCH';
  if (statuses.includes('UNKNOWN')) return 'UNKNOWN';
  return 'NO_MATCH';
};

const selectorResultBase = {
  ruleId: nonEmptyString,
  field: TenantApplicabilityEventSelectorFieldSchema,
  configuredValues: uniqueBoundedStrings,
  reason: nonEmptyString,
};

const selectorNoMatchResultSchema = z
  .object({
    selectorStatus: z.literal('NO_MATCH'),
    ...selectorResultBase,
    matchedValues: z.array(nonEmptyString).length(0),
  })
  .strict();

const selectorMatchResultSchema = z
  .object({
    selectorStatus: z.literal('MATCH'),
    ...selectorResultBase,
    matchedValues: uniqueBoundedStrings,
    conditionGroupKind: conditionGroupKindSchema,
    conditionGroupStatus: TenantContextConditionStatusSchema,
    conditionResults: uniqueConditionResults,
  })
  .strict()
  .superRefine((result, context) => {
    const configured = new Set(result.configuredValues);
    result.matchedValues.forEach((value, index) => {
      if (!configured.has(value)) {
        context.addIssue({
          code: 'custom',
          path: ['matchedValues', index],
          message: 'matched values must be configured selector values',
        });
      }
    });

    const expectedStatus = aggregateConditionStatus(
      result.conditionGroupKind,
      result.conditionResults,
    );
    if (result.conditionGroupStatus !== expectedStatus) {
      context.addIssue({
        code: 'custom',
        path: ['conditionGroupStatus'],
        message: `conditionGroupStatus must be ${expectedStatus} for the supplied condition results`,
      });
    }
  });

/**
 * Result for one enabled rule. A selector NO_MATCH result is terminal and
 * cannot carry condition results; only a selector MATCH result can carry the
 * tri-state tenant condition results.
 */
export const TenantApplicabilityRuleResultSchema = z.discriminatedUnion(
  'selectorStatus',
  [selectorNoMatchResultSchema, selectorMatchResultSchema],
);
export type TenantApplicabilityRuleResult = z.infer<
  typeof TenantApplicabilityRuleResultSchema
>;

const uniqueRuleResults = z
  .array(TenantApplicabilityRuleResultSchema)
  .refine(
    (results) =>
      new Set(results.map((result) => result.ruleId)).size === results.length,
    { message: 'rule result IDs must be unique' },
  );

const resultBase = {
  policyRulesVersion: nonEmptyString,
  ruleResults: uniqueRuleResults,
  reason: nonEmptyString,
};

const applicableResultSchema = z
  .object({
    status: z.literal('APPLICABLE'),
    ...resultBase,
    /** Paths supporting the applicable conclusion; never an empty list. */
    evidence: uniqueTenantPaths,
    /** Optional mapping gaps retained as non-blocking audit warnings. */
    mappingWarnings: uniqueMappingGaps.optional(),
  })
  .strict()
  .superRefine((result, context) => {
    const matchingSelectorRules = result.ruleResults.filter(
      (ruleResult) => ruleResult.selectorStatus === 'MATCH',
    );
    const matchingConditionRules = matchingSelectorRules.filter(
      (ruleResult) => ruleResult.conditionGroupStatus === 'MATCH',
    );
    if (matchingConditionRules.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['ruleResults'],
        message:
          'APPLICABLE requires a selector MATCH rule with a condition MATCH',
      });
    }

    const evidencePaths = new Set(
      matchingSelectorRules.flatMap((ruleResult) =>
        ruleResult.conditionResults
          .filter((conditionResult) => conditionResult.status !== 'UNKNOWN')
          .map((conditionResult) => conditionResult.path),
      ),
    );
    if (result.evidence.some((path) => !evidencePaths.has(path))) {
      context.addIssue({
        code: 'custom',
        path: ['evidence'],
        message: 'evidence paths must be inspected condition paths',
      });
    }

    const conclusionEvidencePaths = new Set(
      matchingConditionRules.flatMap((ruleResult) =>
        ruleResult.conditionResults
          .filter((conditionResult) => conditionResult.status === 'MATCH')
          .map((conditionResult) => conditionResult.path),
      ),
    );
    if (!result.evidence.some((path) => conclusionEvidencePaths.has(path))) {
      context.addIssue({
        code: 'custom',
        path: ['evidence'],
        message:
          'APPLICABLE evidence must include a MATCH condition path from a MATCH group',
      });
    }
  });

const notApplicableResultSchema = z
  .object({
    status: z.literal('NOT_APPLICABLE'),
    ...resultBase,
    /** Confirmed profile paths supporting non-applicability. */
    evidence: uniqueTenantPaths,
  })
  .strict()
  .superRefine((result, context) => {
    const matchingSelectorRules = result.ruleResults.filter(
      (ruleResult) => ruleResult.selectorStatus === 'MATCH',
    );
    if (matchingSelectorRules.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['ruleResults'],
        message:
          'NOT_APPLICABLE requires at least one selector MATCH rule; selector mismatches alone are insufficient',
      });
      return;
    }

    matchingSelectorRules.forEach((ruleResult) => {
      if (
        ruleResult.conditionGroupStatus !== 'NO_MATCH' ||
        ruleResult.conditionResults.some(
          (conditionResult) => conditionResult.status === 'UNKNOWN',
        )
      ) {
        context.addIssue({
          code: 'custom',
          path: ['ruleResults'],
          message:
            'NOT_APPLICABLE selector MATCH rules must have a NO_MATCH group and no UNKNOWN conditions',
        });
      }
    });

    const evidencePaths = new Set(
      matchingSelectorRules.flatMap((ruleResult) =>
        ruleResult.conditionResults
          .filter((conditionResult) => conditionResult.status !== 'UNKNOWN')
          .map((conditionResult) => conditionResult.path),
      ),
    );
    if (result.evidence.some((path) => !evidencePaths.has(path))) {
      context.addIssue({
        code: 'custom',
        path: ['evidence'],
        message: 'evidence paths must be inspected condition paths',
      });
    }

    const conclusionEvidencePaths = new Set(
      matchingSelectorRules.flatMap((ruleResult) =>
        ruleResult.conditionResults
          .filter((conditionResult) => conditionResult.status === 'NO_MATCH')
          .map((conditionResult) => conditionResult.path),
      ),
    );
    if (!result.evidence.some((path) => conclusionEvidencePaths.has(path))) {
      context.addIssue({
        code: 'custom',
        path: ['evidence'],
        message:
          'NOT_APPLICABLE evidence must include a NO_MATCH condition path from a NO_MATCH group',
      });
    }
  });

const insufficientContextResultSchema = z
  .object({
    status: z.literal('INSUFFICIENT_CONTEXT'),
    ...resultBase,
    /** Missing tenant profile paths; absent when only mapping is missing. */
    missingContext: uniqueTenantPaths.optional(),
    /** Unknown event labels that have no policy mapping. */
    missingMappings: uniqueMappingGaps.optional(),
  })
  .strict()
  .superRefine((result, context) => {
    const hasMissingContext = (result.missingContext?.length ?? 0) > 0;
    const hasMissingMappings = (result.missingMappings?.length ?? 0) > 0;
    const hasMatchingCondition = result.ruleResults.some(
      (ruleResult) =>
        ruleResult.selectorStatus === 'MATCH' &&
        ruleResult.conditionGroupStatus === 'MATCH',
    );
    const unknownConditionPaths = result.ruleResults.flatMap((ruleResult) =>
      ruleResult.selectorStatus === 'MATCH'
        ? ruleResult.conditionResults
            .filter((conditionResult) => conditionResult.status === 'UNKNOWN')
            .map((conditionResult) => conditionResult.path)
        : [],
    );
    const hasUnknownCondition = unknownConditionPaths.length > 0;

    if (hasMatchingCondition) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message:
          'APPLICABLE has precedence whenever a selector MATCH rule has a condition MATCH',
      });
    }
    if (!hasMissingContext && !hasMissingMappings) {
      context.addIssue({
        code: 'custom',
        path: ['missingContext'],
        message:
          'INSUFFICIENT_CONTEXT requires tenant missingContext or missingMappings',
      });
    }
    if (hasMissingContext !== hasUnknownCondition) {
      context.addIssue({
        code: 'custom',
        path: ['missingContext'],
        message:
          'missingContext must correspond to an UNKNOWN condition on a selector MATCH rule',
      });
    }
    if (hasUnknownCondition) {
      const unknownPathSet = new Set(unknownConditionPaths);
      if (
        result.missingContext?.some((path) => !unknownPathSet.has(path)) ||
        result.missingContext?.length !== unknownPathSet.size
      ) {
        context.addIssue({
          code: 'custom',
          path: ['missingContext'],
          message:
            'missingContext must contain exactly the UNKNOWN condition paths',
        });
      }
    }
  });

/**
 * JSON-safe applicability record. Evidence and missing profile paths are
 * structurally separate, and mapping gaps are separate from tenant gaps.
 * Callers include only enabled rule results; disabled policy rules are omitted.
 */
export const TenantApplicabilityResultSchema = z.discriminatedUnion('status', [
  applicableResultSchema,
  notApplicableResultSchema,
  insufficientContextResultSchema,
]);
export type TenantApplicabilityResult = z.infer<
  typeof TenantApplicabilityResultSchema
>;
