import { z } from 'zod';

import { ChangeSignalTagSchema, SeveritySchema } from './change-event.js';
import { EvidenceIdSchema } from './provenance.js';

const nonEmptyString = z.string().min(1);

/** Boolean signals whose absence remains distinguishable from false. */
export const RiskBooleanSignalSchema = z.enum([
  'isMajorChange',
  'hasAdminImpact',
  'isRetirementOrDeprecation',
  'hasSecurityImpact',
  'hasPrivacyImpact',
  'hasComplianceImpact',
]);
export type RiskBooleanSignal = z.infer<typeof RiskBooleanSignalSchema>;

/** The threshold values supported by the high-impact severity predicate. */
export const RiskSeverityThresholdSchema = SeveritySchema.extract([
  'high',
  'critical',
]);
export type RiskSeverityThreshold = z.infer<typeof RiskSeverityThresholdSchema>;

export const RiskBooleanConditionSchema = z
  .object({
    kind: z.literal('boolean_signal'),
    signal: RiskBooleanSignalSchema,
    equals: z.boolean(),
  })
  .strict();

export const RiskSeverityConditionSchema = z
  .object({
    kind: z.literal('severity_at_least'),
    level: RiskSeverityThresholdSchema,
  })
  .strict();

export const RiskActionDeadlineConditionSchema = z
  .object({
    kind: z.literal('admin_action_deadline_present'),
  })
  .strict();

export const RiskTagConditionSchema = z
  .object({
    kind: z.literal('normalized_tag'),
    tag: ChangeSignalTagSchema,
  })
  .strict();

const RiskConditionAtomSchema = z.discriminatedUnion('kind', [
  RiskBooleanConditionSchema,
  RiskSeverityConditionSchema,
  RiskActionDeadlineConditionSchema,
  RiskTagConditionSchema,
]);

const boundedConditionAtoms = z.array(RiskConditionAtomSchema).min(1).max(8);

export const RiskAllOfConditionSchema = z
  .object({
    kind: z.literal('all_of'),
    conditions: boundedConditionAtoms,
  })
  .strict();

export const RiskAnyOfConditionSchema = z
  .object({
    kind: z.literal('any_of'),
    conditions: boundedConditionAtoms,
  })
  .strict();

/**
 * Small, bounded condition DSL. Groups contain atoms only, so arbitrary
 * expression trees and provider field paths cannot enter the policy.
 */
export const RiskConditionSchema = z.discriminatedUnion('kind', [
  RiskBooleanConditionSchema,
  RiskSeverityConditionSchema,
  RiskActionDeadlineConditionSchema,
  RiskTagConditionSchema,
  RiskAllOfConditionSchema,
  RiskAnyOfConditionSchema,
]);
export type RiskCondition = z.infer<typeof RiskConditionSchema>;

export const RiskStateFloorSchema = z.enum([
  'REVIEW_REQUIRED',
  'ACTION_REQUIRED',
]);
export type RiskStateFloor = z.infer<typeof RiskStateFloorSchema>;

export const RiskEffectSchema = z
  .object({
    stateFloor: RiskStateFloorSchema,
  })
  .strict();
export type RiskEffect = z.infer<typeof RiskEffectSchema>;

export const RiskRuleSchema = z
  .object({
    ruleId: nonEmptyString,
    enabled: z.boolean(),
    description: nonEmptyString,
    condition: RiskConditionSchema,
    effect: RiskEffectSchema,
  })
  .strict();
export type RiskRule = z.infer<typeof RiskRuleSchema>;

/**
 * This phase intentionally exposes only the safe unknown behavior. A future
 * policy version may add another explicit behavior after its false-negative
 * implications are reviewed.
 */
export const UnknownHandlingSchema = z.literal('REVIEW_REQUIRED');
export type UnknownHandling = z.infer<typeof UnknownHandlingSchema>;

export const RiskPolicySchema = z
  .object({
    policyId: nonEmptyString,
    policyRulesVersion: nonEmptyString,
    description: nonEmptyString,
    unknownHandling: UnknownHandlingSchema,
    rules: z.array(RiskRuleSchema).min(1),
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
  });
export type RiskPolicy = z.infer<typeof RiskPolicySchema>;

export const RiskRuleEvaluationStatusSchema = z.enum([
  'MATCH',
  'NO_MATCH',
  'UNKNOWN',
]);
export type RiskRuleEvaluationStatus = z.infer<
  typeof RiskRuleEvaluationStatusSchema
>;

/**
 * The result of evaluating one bounded condition atom. The normalized field
 * and JSON path are retained so a later adapter can turn the result into a
 * SourceFact without guessing which input was inspected.
 */
export const RiskAtomEvaluationResultSchema = z
  .object({
    status: RiskRuleEvaluationStatusSchema,
    reason: nonEmptyString,
    evidenceId: EvidenceIdSchema,
    field: nonEmptyString,
    path: nonEmptyString,
  })
  .strict();
export type RiskAtomEvaluationResult = z.infer<
  typeof RiskAtomEvaluationResultSchema
>;

/** The combined result for an atom or an all_of/any_of condition. */
export const RiskConditionEvaluationResultSchema = z
  .object({
    status: RiskRuleEvaluationStatusSchema,
    reason: nonEmptyString,
    atomResults: z.array(RiskAtomEvaluationResultSchema).min(1).max(8),
  })
  .strict();
export type RiskConditionEvaluationResult = z.infer<
  typeof RiskConditionEvaluationResultSchema
>;

const optionalAtomResults = {
  /** Detailed atom evidence is optional for backwards-compatible results. */
  atomResults: z.array(RiskAtomEvaluationResultSchema).min(1).max(8).optional(),
};

const evaluationBase = {
  policyRulesVersion: nonEmptyString,
  reason: nonEmptyString,
};

const RiskRuleMatchResultSchema = z
  .object({
    status: z.literal('MATCH'),
    ...evaluationBase,
    ruleId: nonEmptyString,
    stateFloor: RiskStateFloorSchema,
    ...optionalAtomResults,
    evidenceIds: z
      .array(EvidenceIdSchema)
      .min(1)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: 'evidence IDs must be unique within an evaluation result',
      }),
  })
  .strict();

const RiskRuleNoMatchResultSchema = z
  .object({
    status: z.literal('NO_MATCH'),
    ...evaluationBase,
    ruleId: nonEmptyString,
    ...optionalAtomResults,
  })
  .strict();

const RiskRuleUnknownResultSchema = z
  .object({
    status: z.literal('UNKNOWN'),
    ...evaluationBase,
    ruleId: nonEmptyString,
    stateFloor: z.literal('REVIEW_REQUIRED'),
    ...optionalAtomResults,
    evidenceIds: z
      .array(EvidenceIdSchema)
      .min(1)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: 'evidence IDs must be unique within an evaluation result',
      })
      .optional(),
  })
  .strict();

/**
 * Result shape for one enabled rule. Every status retains the rule and policy
 * version needed to create a deterministic_conclusion record when applicable;
 * UNKNOWN is structurally pinned to the safe review floor.
 */
export const RiskRuleEvaluationResultSchema = z.discriminatedUnion('status', [
  RiskRuleMatchResultSchema,
  RiskRuleNoMatchResultSchema,
  RiskRuleUnknownResultSchema,
]);
export type RiskRuleEvaluationResult = z.infer<
  typeof RiskRuleEvaluationResultSchema
>;

/**
 * Policy-wide deterministic output. `null` explicitly represents that no
 * enabled rule established a risk floor, including a policy with zero enabled
 * rules.
 */
export const RiskPolicyEvaluationResultSchema = z
  .object({
    policyRulesVersion: nonEmptyString,
    ruleResults: z.array(RiskRuleEvaluationResultSchema),
    finalStateFloor: RiskStateFloorSchema.nullable(),
  })
  .strict();
export type RiskPolicyEvaluationResult = z.infer<
  typeof RiskPolicyEvaluationResultSchema
>;
