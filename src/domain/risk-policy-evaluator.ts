import type { ChangeEvent, ChangeSignals, Severity } from './change-event.js';
import {
  type RiskAtomEvaluationResult,
  type RiskCondition,
  type RiskConditionEvaluationResult,
  type RiskPolicy,
  type RiskPolicyEvaluationResult,
  type RiskRule,
  type RiskRuleEvaluationResult,
  type RiskRuleEvaluationStatus,
  type RiskStateFloor,
} from './risk-policy.js';

const severityRank: Record<Severity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

type RiskConditionAtom = Extract<
  RiskCondition,
  {
    kind:
      | 'boolean_signal'
      | 'severity_at_least'
      | 'admin_action_deadline_present'
      | 'normalized_tag';
  }
>;

function evidenceIdFor(path: string, predicate: string): string {
  return `source.${path.replaceAll('.', '_')}.${predicate}`;
}

function createAtomResult(
  status: RiskRuleEvaluationStatus,
  reason: string,
  field: string,
  path: string,
  predicate: string,
): RiskAtomEvaluationResult {
  return {
    status,
    reason,
    evidenceId: evidenceIdFor(path, predicate),
    field,
    path,
  };
}

function evaluateBooleanAtom(
  condition: Extract<RiskConditionAtom, { kind: 'boolean_signal' }>,
  signals: ChangeSignals | undefined,
): RiskAtomEvaluationResult {
  const path = `signals.${condition.signal}`;
  const predicate = `equals-${condition.equals ? 'true' : 'false'}`;
  const value = signals?.[condition.signal];

  if (value === undefined) {
    return createAtomResult(
      'UNKNOWN',
      `${path} was not reported; expected ${String(condition.equals)}.`,
      condition.signal,
      path,
      predicate,
    );
  }

  if (value === condition.equals) {
    return createAtomResult(
      'MATCH',
      `${path} is ${String(value)} and matches ${String(condition.equals)}.`,
      condition.signal,
      path,
      predicate,
    );
  }

  return createAtomResult(
    'NO_MATCH',
    `${path} is ${String(value)} and does not match ${String(condition.equals)}.`,
    condition.signal,
    path,
    predicate,
  );
}

function evaluateSeverityAtom(
  condition: Extract<RiskConditionAtom, { kind: 'severity_at_least' }>,
  event: ChangeEvent,
): RiskAtomEvaluationResult {
  const path = 'severity';
  const value = event.severity;

  if (value === undefined) {
    return createAtomResult(
      'UNKNOWN',
      'severity was not reported; a severity value is required.',
      'severity',
      path,
      `at-least-${condition.level}`,
    );
  }

  if (value === null) {
    return createAtomResult(
      'NO_MATCH',
      'severity is confirmed absent; the severity threshold cannot match.',
      'severity',
      path,
      `at-least-${condition.level}`,
    );
  }

  const status: RiskRuleEvaluationStatus =
    severityRank[value] >= severityRank[condition.level] ? 'MATCH' : 'NO_MATCH';
  return createAtomResult(
    status,
    `severity is ${value}; threshold is at least ${condition.level}.`,
    'severity',
    path,
    `at-least-${condition.level}`,
  );
}

function evaluateDeadlineAtom(event: ChangeEvent): RiskAtomEvaluationResult {
  const path = 'signals.actionRequiredBy';
  const value = event.signals?.actionRequiredBy;

  if (value === undefined) {
    return createAtomResult(
      'UNKNOWN',
      `${path} was not reported; a deadline cannot be confirmed.`,
      'actionRequiredBy',
      path,
      'present',
    );
  }

  if (value === null) {
    return createAtomResult(
      'NO_MATCH',
      `${path} is confirmed absent.`,
      'actionRequiredBy',
      path,
      'present',
    );
  }

  return createAtomResult(
    'MATCH',
    `${path} contains a deadline (${value}).`,
    'actionRequiredBy',
    path,
    'present',
  );
}

function evaluateTagAtom(
  condition: Extract<RiskConditionAtom, { kind: 'normalized_tag' }>,
  signals: ChangeSignals | undefined,
): RiskAtomEvaluationResult {
  const path = 'signals.tags';
  const tags = signals?.tags;
  const predicate = `contains-${condition.tag}`;

  if (tags === undefined) {
    return createAtomResult(
      'UNKNOWN',
      `${path} was not reported; tag ${condition.tag} cannot be confirmed.`,
      'tags',
      path,
      predicate,
    );
  }

  if (tags.includes(condition.tag)) {
    return createAtomResult(
      'MATCH',
      `${path} contains the normalized tag ${condition.tag}.`,
      'tags',
      path,
      predicate,
    );
  }

  return createAtomResult(
    'NO_MATCH',
    `${path} does not contain the normalized tag ${condition.tag}.`,
    'tags',
    path,
    predicate,
  );
}

function evaluateAtom(
  condition: RiskConditionAtom,
  event: ChangeEvent,
): RiskAtomEvaluationResult {
  switch (condition.kind) {
    case 'boolean_signal':
      return evaluateBooleanAtom(condition, event.signals);
    case 'severity_at_least':
      return evaluateSeverityAtom(condition, event);
    case 'admin_action_deadline_present':
      return evaluateDeadlineAtom(event);
    case 'normalized_tag':
      return evaluateTagAtom(condition, event.signals);
  }
}

function statusForGroup(
  kind: 'all_of' | 'any_of',
  statuses: readonly RiskRuleEvaluationStatus[],
): RiskRuleEvaluationStatus {
  if (kind === 'all_of') {
    if (statuses.includes('NO_MATCH')) return 'NO_MATCH';
    if (statuses.includes('UNKNOWN')) return 'UNKNOWN';
    return 'MATCH';
  }

  if (statuses.includes('MATCH')) return 'MATCH';
  if (statuses.includes('UNKNOWN')) return 'UNKNOWN';
  return 'NO_MATCH';
}

function reasonForCondition(
  condition: RiskCondition,
  status: RiskRuleEvaluationStatus,
  atomResults: readonly RiskAtomEvaluationResult[],
): string {
  if (
    condition.kind !== 'all_of' &&
    condition.kind !== 'any_of' &&
    atomResults.length === 1
  ) {
    return atomResults[0]?.reason ?? `condition evaluated as ${status}.`;
  }

  const details = atomResults.map((result) => result.reason).join(' ');
  return `${condition.kind} evaluated as ${status}: ${details}`;
}

/** Evaluate a single atom or bounded atom group. */
export function evaluateRiskCondition(
  condition: RiskCondition,
  event: ChangeEvent,
): RiskConditionEvaluationResult {
  const atomResults =
    condition.kind === 'all_of' || condition.kind === 'any_of'
      ? condition.conditions.map((atom) => evaluateAtom(atom, event))
      : [evaluateAtom(condition, event)];
  const status =
    condition.kind === 'all_of' || condition.kind === 'any_of'
      ? statusForGroup(
          condition.kind,
          atomResults.map((result) => result.status),
        )
      : (atomResults[0]?.status ?? 'UNKNOWN');

  return {
    status,
    reason: reasonForCondition(condition, status, atomResults),
    atomResults,
  };
}

function evidenceIdsFor(
  conditionResult: RiskConditionEvaluationResult,
): string[] {
  return [
    ...new Set(
      conditionResult.atomResults
        .filter((result) => result.status !== 'UNKNOWN')
        .map((result) => result.evidenceId),
    ),
  ];
}

function evaluateRule(
  policy: RiskPolicy,
  rule: RiskRule,
  event: ChangeEvent,
): RiskRuleEvaluationResult {
  const conditionResult = evaluateRiskCondition(rule.condition, event);
  const common = {
    policyRulesVersion: policy.policyRulesVersion,
    ruleId: rule.ruleId,
    reason: conditionResult.reason,
    atomResults: conditionResult.atomResults,
  };

  if (conditionResult.status === 'MATCH') {
    return {
      ...common,
      status: 'MATCH',
      stateFloor: rule.effect.stateFloor,
      evidenceIds: evidenceIdsFor(conditionResult),
    };
  }

  if (conditionResult.status === 'UNKNOWN') {
    // The Phase 1C schema admits only REVIEW_REQUIRED. Keep the explicit
    // policy check so a future unknown handling mode cannot lower this floor
    // accidentally without changing the evaluator contract.
    const stateFloor: RiskStateFloor = policy.unknownHandling;
    const evidenceIds = evidenceIdsFor(conditionResult);
    return {
      ...common,
      status: 'UNKNOWN',
      stateFloor,
      ...(evidenceIds.length > 0 ? { evidenceIds } : {}),
    };
  }

  return {
    ...common,
    status: 'NO_MATCH',
  };
}

function floorRank(floor: RiskStateFloor | null): number {
  switch (floor) {
    case 'ACTION_REQUIRED':
      return 2;
    case 'REVIEW_REQUIRED':
      return 1;
    case null:
      return 0;
  }
}

function maxFloor(
  current: RiskStateFloor | null,
  candidate: RiskStateFloor | undefined,
): RiskStateFloor | null {
  if (candidate === undefined) return current;
  return floorRank(candidate) > floorRank(current) ? candidate : current;
}

/**
 * Evaluate only enabled rules against one normalized ChangeEvent. The
 * evaluator reads its inputs but never mutates them, and preserves policy
 * order and evidence order for deterministic output.
 */
export function evaluateRiskPolicy(
  policy: RiskPolicy,
  event: ChangeEvent,
): RiskPolicyEvaluationResult {
  const ruleResults: RiskRuleEvaluationResult[] = [];
  let finalStateFloor: RiskStateFloor | null = null;

  policy.rules.forEach((rule) => {
    if (!rule.enabled) return;
    const result = evaluateRule(policy, rule, event);
    ruleResults.push(result);
    finalStateFloor = maxFloor(
      finalStateFloor,
      result.status === 'NO_MATCH' ? undefined : result.stateFloor,
    );
  });

  return {
    policyRulesVersion: policy.policyRulesVersion,
    ruleResults,
    finalStateFloor,
  };
}

/** Expose the floor comparison for corpus and evaluator tests. */
export function isRiskFloorAtLeast(
  actual: RiskStateFloor | null,
  minimum: RiskStateFloor,
): boolean {
  return floorRank(actual) >= floorRank(minimum);
}
