import { ChangeEventSchema, type ChangeEvent } from './change-event.js';
import {
  TenantApplicabilityConditionResultSchema,
  TenantApplicabilityMappingGapSchema,
  TenantApplicabilityPolicySchema,
  TenantApplicabilityResultSchema,
  type TenantApplicabilityCondition,
  type TenantApplicabilityConditionResult,
  type TenantApplicabilityEventSelectorField,
  type TenantApplicabilityMappingGap,
  type TenantApplicabilityPolicy,
  type TenantApplicabilityResult,
  type TenantApplicabilityRuleResult,
  type TenantContextCondition,
  type TenantContextConditionStatus,
} from './tenant-applicability.js';
import { TenantProfileSchema, type TenantProfile } from './tenant-profile.js';

const selectorFields = ['products', 'categories'] as const;

function aggregateConditionStatus(
  kind: 'all_of' | 'any_of',
  statuses: readonly TenantContextConditionStatus[],
): TenantContextConditionStatus {
  if (kind === 'all_of') {
    if (statuses.includes('NO_MATCH')) return 'NO_MATCH';
    if (statuses.includes('UNKNOWN')) return 'UNKNOWN';
    return 'MATCH';
  }

  if (statuses.includes('MATCH')) return 'MATCH';
  if (statuses.includes('UNKNOWN')) return 'UNKNOWN';
  return 'NO_MATCH';
}

function conditionReason(
  path: string,
  expected: boolean,
  observed: boolean | null,
  status: TenantContextConditionStatus,
): string {
  if (status === 'UNKNOWN') {
    return `${path} is absent from the tenant profile; expected ${String(expected)}.`;
  }

  if (status === 'MATCH') {
    return `${path} is ${String(observed)} and matches ${String(expected)}.`;
  }

  return `${path} is ${String(observed)} and does not match ${String(expected)}.`;
}

function evaluateCondition(
  condition: TenantContextCondition,
  profile: TenantProfile,
): TenantApplicabilityConditionResult {
  const path = `${condition.section}.${condition.key}`;
  const section = profile[condition.section];
  const keyExists = Object.prototype.hasOwnProperty.call(
    section,
    condition.key,
  );
  const observed = keyExists ? (section[condition.key] ?? null) : null;
  const status: TenantContextConditionStatus =
    observed === null
      ? 'UNKNOWN'
      : observed === condition.equals
        ? 'MATCH'
        : 'NO_MATCH';

  return TenantApplicabilityConditionResultSchema.parse({
    status,
    section: condition.section,
    key: condition.key,
    expected: condition.equals,
    observed,
    path,
    reason: conditionReason(path, condition.equals, observed, status),
  });
}

function evaluateConditionGroup(
  condition: TenantApplicabilityCondition,
  profile: TenantProfile,
): {
  conditionGroupKind: 'all_of' | 'any_of';
  conditionGroupStatus: TenantContextConditionStatus;
  conditionResults: TenantApplicabilityConditionResult[];
} {
  const conditionResults = condition.conditions.map((item) =>
    evaluateCondition(item, profile),
  );
  const conditionGroupStatus = aggregateConditionStatus(
    condition.kind,
    conditionResults.map((result) => result.status),
  );

  return {
    conditionGroupKind: condition.kind,
    conditionGroupStatus,
    conditionResults,
  };
}

function evaluateRule(
  rule: TenantApplicabilityPolicy['rules'][number],
  event: ChangeEvent,
  profile: TenantProfile,
): TenantApplicabilityRuleResult {
  const eventValues = event[rule.selector.field];
  const matchedValues = rule.selector.values.filter((value) =>
    eventValues.includes(value),
  );
  const common = {
    ruleId: rule.ruleId,
    field: rule.selector.field,
    configuredValues: [...rule.selector.values],
  };

  if (matchedValues.length === 0) {
    return {
      selectorStatus: 'NO_MATCH',
      ...common,
      matchedValues: [],
      reason: `No configured ${rule.selector.field} value matched the event.`,
    };
  }

  const conditionGroup = evaluateConditionGroup(rule.condition, profile);
  return {
    selectorStatus: 'MATCH',
    ...common,
    matchedValues: [...matchedValues],
    reason: `Configured ${rule.selector.field} value(s) matched the event.`,
    ...conditionGroup,
  };
}

function mappingGaps(
  policy: TenantApplicabilityPolicy,
  event: ChangeEvent,
): TenantApplicabilityMappingGap[] {
  const configuredValues = new Map<
    TenantApplicabilityEventSelectorField,
    Set<string>
  >();

  policy.rules.forEach((rule) => {
    if (!rule.enabled) return;

    const configured =
      configuredValues.get(rule.selector.field) ?? new Set<string>();
    rule.selector.values.forEach((value) => configured.add(value));
    configuredValues.set(rule.selector.field, configured);
  });

  const gaps: TenantApplicabilityMappingGap[] = [];
  selectorFields.forEach((field) => {
    const configured = configuredValues.get(field);
    if (configured === undefined) return;

    const values = event[field];
    if (values.length === 0) {
      gaps.push(
        TenantApplicabilityMappingGapSchema.parse({ field, value: null }),
      );
      return;
    }

    const seenValues = new Set<string>();
    values.forEach((value) => {
      if (seenValues.has(value)) return;
      seenValues.add(value);
      if (!configured.has(value)) {
        gaps.push(TenantApplicabilityMappingGapSchema.parse({ field, value }));
      }
    });
  });

  return gaps;
}

function unknownContextPaths(
  ruleResults: readonly TenantApplicabilityRuleResult[],
): string[] {
  const paths = new Set<string>();
  ruleResults.forEach((ruleResult) => {
    if (ruleResult.selectorStatus !== 'MATCH') return;
    ruleResult.conditionResults.forEach((conditionResult) => {
      if (conditionResult.status === 'UNKNOWN') {
        paths.add(conditionResult.path);
      }
    });
  });
  return [...paths];
}

function matchingEvidence(
  ruleResults: readonly TenantApplicabilityRuleResult[],
): string[] {
  return [
    ...new Set(
      ruleResults.flatMap((ruleResult) =>
        ruleResult.selectorStatus === 'MATCH' &&
        ruleResult.conditionGroupStatus === 'MATCH'
          ? ruleResult.conditionResults
              .filter((conditionResult) => conditionResult.status === 'MATCH')
              .map((conditionResult) => conditionResult.path)
          : [],
      ),
    ),
  ];
}

function notApplicableEvidence(
  ruleResults: readonly TenantApplicabilityRuleResult[],
): string[] {
  return [
    ...new Set(
      ruleResults.flatMap((ruleResult) =>
        ruleResult.selectorStatus === 'MATCH' &&
        ruleResult.conditionGroupStatus === 'NO_MATCH'
          ? ruleResult.conditionResults
              .filter(
                (conditionResult) => conditionResult.status === 'NO_MATCH',
              )
              .map((conditionResult) => conditionResult.path)
          : [],
      ),
    ),
  ];
}

/**
 * Evaluate a normalized change event against a declarative tenant policy.
 * Inputs are schema-validated, enabled rules are evaluated in policy order,
 * and the returned result is validated before it leaves the domain boundary.
 */
export function evaluateTenantApplicability(
  policy: TenantApplicabilityPolicy,
  event: ChangeEvent,
  profile: TenantProfile,
): TenantApplicabilityResult {
  const parsedPolicy = TenantApplicabilityPolicySchema.parse(policy);
  const parsedEvent = ChangeEventSchema.parse(event);
  const parsedProfile = TenantProfileSchema.parse(profile);

  const ruleResults = parsedPolicy.rules.flatMap((rule) =>
    rule.enabled ? [evaluateRule(rule, parsedEvent, parsedProfile)] : [],
  );
  const gaps = mappingGaps(parsedPolicy, parsedEvent);
  const hasMatchingCondition = ruleResults.some(
    (ruleResult) =>
      ruleResult.selectorStatus === 'MATCH' &&
      ruleResult.conditionGroupStatus === 'MATCH',
  );

  if (hasMatchingCondition) {
    return TenantApplicabilityResultSchema.parse({
      policyRulesVersion: parsedPolicy.policyRulesVersion,
      status: 'APPLICABLE',
      ruleResults,
      reason: 'At least one enabled selector rule matched the tenant context.',
      evidence: matchingEvidence(ruleResults),
      ...(gaps.length > 0 ? { mappingWarnings: gaps } : {}),
    });
  }

  const missingContext = unknownContextPaths(ruleResults);
  if (missingContext.length > 0 || gaps.length > 0) {
    return TenantApplicabilityResultSchema.parse({
      policyRulesVersion: parsedPolicy.policyRulesVersion,
      status: 'INSUFFICIENT_CONTEXT',
      ruleResults,
      reason:
        missingContext.length > 0
          ? 'One or more tenant context keys are absent.'
          : 'One or more event values have no policy mapping.',
      ...(missingContext.length > 0 ? { missingContext } : {}),
      ...(gaps.length > 0 ? { missingMappings: gaps } : {}),
    });
  }

  return TenantApplicabilityResultSchema.parse({
    policyRulesVersion: parsedPolicy.policyRulesVersion,
    status: 'NOT_APPLICABLE',
    ruleResults,
    reason: 'The selected event rules do not apply to this tenant.',
    evidence: notApplicableEvidence(ruleResults),
  });
}
