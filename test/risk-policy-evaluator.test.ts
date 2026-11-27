import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ChangeEventSchema,
  ChangeSignalsSchema,
  GoldenCaseSchema,
  RiskConditionEvaluationResultSchema,
  RiskPolicyEvaluationResultSchema,
  RiskPolicySchema,
  RiskRuleEvaluationResultSchema,
  checkGoldenCaseMinimumRiskFloor,
  evaluateRiskCondition,
  evaluateRiskPolicy,
  type ChangeEvent,
  type ChangeSignals,
  type GoldenCase,
  type RiskCondition,
  type RiskPolicy,
} from '../src/index.js';

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const baseEvent = ChangeEventSchema.parse(
  readJson(resolve(process.cwd(), 'test/fixtures/change-event.json')),
);
const representativePolicy = RiskPolicySchema.parse(
  readJson(resolve(process.cwd(), 'test/fixtures/risk-policy.json')),
);

function eventWith(
  overrides: Partial<Pick<ChangeEvent, 'severity' | 'signals'>>,
): ChangeEvent {
  return ChangeEventSchema.parse({
    ...baseEvent,
    ...overrides,
  });
}

function eventWithSignals(overrides: Partial<ChangeSignals>): ChangeEvent {
  return eventWith({
    signals: ChangeSignalsSchema.parse({
      ...baseEvent.signals,
      ...overrides,
    }),
  });
}

function atomOf(
  condition: RiskCondition,
  event: ChangeEvent,
): ReturnType<typeof evaluateRiskCondition>['atomResults'][number] {
  const result = evaluateRiskCondition(condition, event);
  const atom = result.atomResults[0];
  if (atom === undefined) throw new Error('expected one atom result');
  return atom;
}

function booleanCondition(
  signal: 'isMajorChange' | 'hasAdminImpact',
  equals = true,
): Extract<RiskCondition, { kind: 'boolean_signal' }> {
  return { kind: 'boolean_signal', signal, equals };
}

function policyWithRules(rules: RiskPolicy['rules']): RiskPolicy {
  return RiskPolicySchema.parse({
    ...representativePolicy,
    rules,
  });
}

function loadCorpusChanges(): Array<{
  fixtureId: string;
  event: ChangeEvent;
  coverageTags: string[];
}> {
  const directory = resolve(process.cwd(), 'corpus/changes');
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const record = readJson(join(directory, name));
      const fixture = record as {
        fixtureId: string;
        event: unknown;
        coverageTags: string[];
      };
      return {
        fixtureId: fixture.fixtureId,
        event: ChangeEventSchema.parse(fixture.event),
        coverageTags: fixture.coverageTags,
      };
    });
}

function loadGoldenCases(): GoldenCase[] {
  const directory = resolve(process.cwd(), 'corpus/cases');
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => GoldenCaseSchema.parse(readJson(join(directory, name))));
}

describe('Risk policy atom evaluator', () => {
  it('distinguishes boolean true, false, and omitted signals', () => {
    const condition = booleanCondition('isMajorChange');
    const match = atomOf(condition, eventWithSignals({ isMajorChange: true }));
    const noMatch = atomOf(
      condition,
      eventWithSignals({ isMajorChange: false }),
    );
    const unknown = atomOf(
      condition,
      eventWith({
        signals: {
          ...baseEvent.signals,
          isMajorChange: undefined,
        },
      }),
    );

    expect(match.status).toBe('MATCH');
    expect(noMatch.status).toBe('NO_MATCH');
    expect(unknown.status).toBe('UNKNOWN');
    expect(match.reason).toBeTruthy();
    expect(match.evidenceId).toBe('source.signals_isMajorChange.equals-true');
    expect(match.field).toBe('isMajorChange');
    expect(match.path).toBe('signals.isMajorChange');
    expect(
      atomOf(condition, eventWithSignals({ isMajorChange: true })),
    ).toEqual(match);
  });

  it('orders severity values and distinguishes null from omitted severity', () => {
    const condition: RiskCondition = {
      kind: 'severity_at_least',
      level: 'high',
    };

    expect(atomOf(condition, eventWith({ severity: 'low' })).status).toBe(
      'NO_MATCH',
    );
    expect(atomOf(condition, eventWith({ severity: 'medium' })).status).toBe(
      'NO_MATCH',
    );
    expect(atomOf(condition, eventWith({ severity: 'high' })).status).toBe(
      'MATCH',
    );
    expect(atomOf(condition, eventWith({ severity: 'critical' })).status).toBe(
      'MATCH',
    );
    expect(atomOf(condition, eventWith({ severity: null })).status).toBe(
      'NO_MATCH',
    );
    expect(atomOf(condition, eventWith({ severity: undefined })).status).toBe(
      'UNKNOWN',
    );
  });

  it('distinguishes deadline presence, confirmed absence, and omission', () => {
    const condition: RiskCondition = {
      kind: 'admin_action_deadline_present',
    };

    expect(
      atomOf(
        condition,
        eventWithSignals({ actionRequiredBy: '2026-10-01T00:00:00Z' }),
      ).status,
    ).toBe('MATCH');
    expect(
      atomOf(condition, eventWithSignals({ actionRequiredBy: null })).status,
    ).toBe('NO_MATCH');
    expect(
      atomOf(
        condition,
        eventWith({
          signals: {
            ...baseEvent.signals,
            actionRequiredBy: undefined,
          },
        }),
      ).status,
    ).toBe('UNKNOWN');
  });

  it('distinguishes normalized tag presence, absence, and omission', () => {
    const condition: RiskCondition = {
      kind: 'normalized_tag',
      tag: 'security',
    };

    expect(
      atomOf(condition, eventWithSignals({ tags: ['security'] })).status,
    ).toBe('MATCH');
    expect(atomOf(condition, eventWithSignals({ tags: [] })).status).toBe(
      'NO_MATCH',
    );
    expect(
      atomOf(
        condition,
        eventWith({
          signals: {
            ...baseEvent.signals,
            tags: undefined,
          },
        }),
      ).status,
    ).toBe('UNKNOWN');
  });
});

describe('Risk policy condition and policy evaluator', () => {
  it('applies the all_of and any_of three-valued truth tables', () => {
    const all = (
      left: true | false | undefined,
      right: true | false | undefined,
    ) =>
      evaluateRiskCondition(
        {
          kind: 'all_of',
          conditions: [
            booleanCondition('isMajorChange'),
            booleanCondition('hasAdminImpact'),
          ],
        },
        eventWithSignals({
          isMajorChange: left,
          hasAdminImpact: right,
        }),
      ).status;
    const any = (
      left: true | false | undefined,
      right: true | false | undefined,
    ) =>
      evaluateRiskCondition(
        {
          kind: 'any_of',
          conditions: [
            booleanCondition('isMajorChange'),
            booleanCondition('hasAdminImpact'),
          ],
        },
        eventWithSignals({
          isMajorChange: left,
          hasAdminImpact: right,
        }),
      ).status;

    expect(all(true, true)).toBe('MATCH');
    expect(all(true, false)).toBe('NO_MATCH');
    expect(all(true, undefined)).toBe('UNKNOWN');
    expect(all(false, undefined)).toBe('NO_MATCH');
    expect(all(undefined, undefined)).toBe('UNKNOWN');

    expect(any(true, false)).toBe('MATCH');
    expect(any(true, undefined)).toBe('MATCH');
    expect(any(false, undefined)).toBe('UNKNOWN');
    expect(any(false, false)).toBe('NO_MATCH');
    expect(any(undefined, undefined)).toBe('UNKNOWN');

    const grouped = evaluateRiskCondition(
      {
        kind: 'all_of',
        conditions: [
          booleanCondition('isMajorChange'),
          booleanCondition('hasAdminImpact'),
        ],
      },
      eventWithSignals({ isMajorChange: true, hasAdminImpact: true }),
    );
    expect(grouped.atomResults).toHaveLength(2);
    expect(RiskConditionEvaluationResultSchema.parse(grouped)).toEqual(grouped);
  });

  it('evaluates enabled rules only, keeps all statuses, and aggregates the max floor', () => {
    const policy = policyWithRules([
      {
        ruleId: 'review-match',
        enabled: true,
        description: 'review match',
        condition: booleanCondition('isMajorChange'),
        effect: { stateFloor: 'REVIEW_REQUIRED' },
      },
      {
        ruleId: 'action-match',
        enabled: true,
        description: 'action match',
        condition: booleanCondition('hasAdminImpact'),
        effect: { stateFloor: 'ACTION_REQUIRED' },
      },
      {
        ruleId: 'unknown-rule',
        enabled: true,
        description: 'unknown rule',
        condition: booleanCondition('isMajorChange'),
        effect: { stateFloor: 'REVIEW_REQUIRED' },
      },
      {
        ruleId: 'disabled-rule',
        enabled: false,
        description: 'must not run',
        condition: booleanCondition('hasAdminImpact'),
        effect: { stateFloor: 'ACTION_REQUIRED' },
      },
    ]);
    const event = eventWithSignals({
      isMajorChange: true,
      hasAdminImpact: true,
    });
    const result = evaluateRiskPolicy(policy, event);

    expect(result.ruleResults.map((rule) => rule.ruleId)).toEqual([
      'review-match',
      'action-match',
      'unknown-rule',
    ]);
    expect(result.ruleResults.map((rule) => rule.status)).toEqual([
      'MATCH',
      'MATCH',
      'MATCH',
    ]);
    expect(result.finalStateFloor).toBe('ACTION_REQUIRED');
    expect(
      result.ruleResults.every((rule) => rule.atomResults?.[0]?.path),
    ).toBe(true);
    expect(
      RiskRuleEvaluationResultSchema.array().parse(result.ruleResults),
    ).toEqual(result.ruleResults);

    const duplicateEvidencePolicy = policyWithRules([
      {
        ruleId: 'duplicate-evidence',
        enabled: true,
        description: 'duplicate atom evidence is deduplicated',
        condition: {
          kind: 'all_of',
          conditions: [
            booleanCondition('isMajorChange'),
            booleanCondition('isMajorChange'),
          ],
        },
        effect: { stateFloor: 'REVIEW_REQUIRED' },
      },
    ]);
    const duplicateEvidence = evaluateRiskPolicy(
      duplicateEvidencePolicy,
      eventWithSignals({ isMajorChange: true }),
    ).ruleResults[0];
    expect(duplicateEvidence?.status).toBe('MATCH');
    if (duplicateEvidence?.status === 'MATCH') {
      expect(duplicateEvidence.evidenceIds).toEqual([
        'source.signals_isMajorChange.equals-true',
      ]);
    }
  });

  it('returns UNKNOWN with review floor and no floor for all NO_MATCH', () => {
    const policy = policyWithRules([
      {
        ruleId: 'unknown-rule',
        enabled: true,
        description: 'unknown rule',
        condition: booleanCondition('isMajorChange'),
        effect: { stateFloor: 'ACTION_REQUIRED' },
      },
    ]);
    const unknownResult = evaluateRiskPolicy(
      policy,
      eventWith({
        signals: {
          ...baseEvent.signals,
          isMajorChange: undefined,
        },
      }),
    );
    expect(unknownResult.ruleResults[0]).toMatchObject({
      status: 'UNKNOWN',
      stateFloor: 'REVIEW_REQUIRED',
    });
    expect(unknownResult.finalStateFloor).toBe('REVIEW_REQUIRED');

    const noMatchResult = evaluateRiskPolicy(
      policy,
      eventWithSignals({ isMajorChange: false }),
    );
    expect(noMatchResult.ruleResults[0]?.status).toBe('NO_MATCH');
    expect(noMatchResult.ruleResults[0]).not.toHaveProperty('stateFloor');
    expect(noMatchResult.finalStateFloor).toBeNull();
  });

  it('represents zero enabled rules as an explicit no-floor result', () => {
    const policy = policyWithRules(
      representativePolicy.rules.map((rule) => ({ ...rule, enabled: false })),
    );
    const result = evaluateRiskPolicy(policy, baseEvent);

    expect(result).toEqual({
      policyRulesVersion: representativePolicy.policyRulesVersion,
      ruleResults: [],
      finalStateFloor: null,
    });
    expect(RiskPolicyEvaluationResultSchema.parse(result)).toEqual(result);
  });

  it('does not mutate policy or event and survives JSON round trips', () => {
    const policy = clone(representativePolicy);
    const event = clone(baseEvent);
    const policyBefore = clone(policy);
    const eventBefore = clone(event);
    const result = evaluateRiskPolicy(policy, event);

    expect(policy).toEqual(policyBefore);
    expect(event).toEqual(eventBefore);
    expect(
      RiskPolicyEvaluationResultSchema.parse(
        JSON.parse(JSON.stringify(result)),
      ),
    ).toEqual(result);
  });
});

describe('Risk policy evaluator against the Phase 1 corpus', () => {
  it('evaluates all 50 change fixtures and has zero declared floor false negatives', () => {
    const changes = loadCorpusChanges();
    const goldenCases = loadGoldenCases();
    const evaluations = new Map(
      changes.map((change) => [
        change.fixtureId,
        evaluateRiskPolicy(representativePolicy, change.event),
      ]),
    );
    const minimumFloorCases = goldenCases.filter(
      (goldenCase) =>
        'minimumRiskFloor' in goldenCase.expected &&
        goldenCase.expected.minimumRiskFloor !== undefined,
    );
    const failures = minimumFloorCases.filter((goldenCase) => {
      const evaluation = evaluations.get(goldenCase.changeFixtureId);
      if (evaluation === undefined) return true;
      return !checkGoldenCaseMinimumRiskFloor(goldenCase, evaluation).valid;
    });
    const highImpactFloorCases = goldenCases.filter(
      (goldenCase) =>
        goldenCase.highImpact &&
        'minimumRiskFloor' in goldenCase.expected &&
        goldenCase.expected.minimumRiskFloor !== undefined,
    );
    const highImpactFailures = highImpactFloorCases.filter((goldenCase) => {
      const evaluation = evaluations.get(goldenCase.changeFixtureId);
      if (evaluation === undefined) return true;
      return !checkGoldenCaseMinimumRiskFloor(goldenCase, evaluation).valid;
    });

    expect(changes).toHaveLength(50);
    expect(minimumFloorCases).not.toHaveLength(0);
    expect(failures).toEqual([]);
    expect(highImpactFloorCases).not.toHaveLength(0);
    expect(highImpactFailures).toEqual([]);
  });

  it('keeps unknown-signal changes at review and confirmed absence free of UNKNOWN', () => {
    const changes = loadCorpusChanges();
    const evaluations = changes.map((change) => ({
      ...change,
      evaluation: evaluateRiskPolicy(representativePolicy, change.event),
    }));
    const unknownSignals = evaluations.filter((change) =>
      change.coverageTags.includes('unknown-signal'),
    );
    const confirmedAbsence = evaluations.filter((change) =>
      change.coverageTags.includes('confirmed-absence'),
    );

    expect(unknownSignals.length).toBeGreaterThan(0);
    expect(
      unknownSignals.every(
        (change) => change.evaluation.finalStateFloor === 'REVIEW_REQUIRED',
      ),
    ).toBe(true);
    expect(
      confirmedAbsence.every(
        (change) =>
          change.evaluation.finalStateFloor === null &&
          change.evaluation.ruleResults.every(
            (rule) => rule.status === 'NO_MATCH',
          ),
      ),
    ).toBe(true);
  });
});
