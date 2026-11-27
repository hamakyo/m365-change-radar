import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  RiskConditionSchema,
  RiskPolicySchema,
  RiskRuleSchema,
  RiskRuleEvaluationResultSchema,
} from '../src/index.js';

function readFixture(name: string): unknown {
  const url = new URL(`./fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('fixture value is not an object');
  }
  return value as Record<string, unknown>;
}

function rulesFrom(policy: Record<string, unknown>): unknown[] {
  const rules = policy.rules;
  if (!Array.isArray(rules)) {
    throw new Error('policy fixture has no rules');
  }
  return rules;
}

describe('RiskPolicy', () => {
  it('parses the representative guardrail policy and survives a JSON round trip', () => {
    const fixture = readFixture('risk-policy.json');
    const parsed = RiskPolicySchema.parse(fixture);

    expect(parsed.policyRulesVersion).toBe('policy-2026-08');
    expect(parsed.unknownHandling).toBe('REVIEW_REQUIRED');
    expect(parsed.rules.map((rule) => rule.condition.kind)).toEqual([
      'boolean_signal',
      'admin_action_deadline_present',
      'severity_at_least',
      'all_of',
      'any_of',
      'any_of',
      'any_of',
    ]);
    expect(parsed.rules.map((rule) => rule.effect.stateFloor)).toContain(
      'ACTION_REQUIRED',
    );
    expect(RiskPolicySchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(
      parsed,
    );
  });

  it('requires unique rule IDs, non-empty conditions, and the safe unknown policy', () => {
    const fixture = asRecord(readFixture('risk-policy.json'));
    const rules = rulesFrom(fixture);
    const firstRule = asRecord(rules[0]);

    expect(
      RiskPolicySchema.safeParse({
        ...fixture,
        rules: [...rules, firstRule],
      }).success,
    ).toBe(false);
    expect(
      RiskRuleSchema.safeParse({
        ...firstRule,
        condition: { kind: 'all_of', conditions: [] },
      }).success,
    ).toBe(false);
    expect(
      RiskPolicySchema.safeParse({
        ...fixture,
        unknownHandling: undefined,
      }).success,
    ).toBe(false);
    expect(
      RiskPolicySchema.safeParse({
        ...fixture,
        unknownHandling: 'NO_MATCH',
      }).success,
    ).toBe(false);
  });

  it('bounds the DSL and rejects provider-specific field expressions or unsafe effects', () => {
    const fixture = asRecord(readFixture('risk-policy.json'));
    const rules = rulesFrom(fixture);
    const firstRule = asRecord(rules[0]);

    expect(
      RiskConditionSchema.parse({
        kind: 'severity_at_least',
        level: 'critical',
      }),
    ).toMatchObject({ kind: 'severity_at_least', level: 'critical' });
    expect(
      RiskConditionSchema.safeParse({
        kind: 'severity_at_least',
        level: 'medium',
      }).success,
    ).toBe(false);

    expect(
      RiskConditionSchema.safeParse({
        kind: 'all_of',
        conditions: [
          {
            kind: 'all_of',
            conditions: [firstRule.condition],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      RiskConditionSchema.safeParse({
        kind: 'any_of',
        conditions: Array.from({ length: 9 }, () => firstRule.condition),
      }).success,
    ).toBe(false);
    expect(
      RiskConditionSchema.safeParse({
        kind: 'field_path',
        path: '/resource/graphField',
      }).success,
    ).toBe(false);
    expect(
      RiskRuleSchema.safeParse({
        ...firstRule,
        effect: { stateFloor: 'INFORMATIONAL' },
      }).success,
    ).toBe(false);
    expect(
      RiskRuleSchema.safeParse({
        ...firstRule,
        effect: { stateFloor: 'NOT_APPLICABLE' },
      }).success,
    ).toBe(false);
    expect(
      RiskRuleSchema.safeParse({
        ...firstRule,
        unsupported: true,
      }).success,
    ).toBe(false);
  });
});

describe('RiskRuleEvaluationResult', () => {
  it('keeps MATCH, NO_MATCH, and UNKNOWN distinct and carries provenance inputs', () => {
    const match = RiskRuleEvaluationResultSchema.parse({
      status: 'MATCH',
      policyRulesVersion: 'policy-2026-08',
      ruleId: 'major-change',
      stateFloor: 'REVIEW_REQUIRED',
      reason: 'The normalized major-change signal is true.',
      evidenceIds: ['source.major-change'],
    });
    const noMatch = RiskRuleEvaluationResultSchema.parse({
      status: 'NO_MATCH',
      policyRulesVersion: 'policy-2026-08',
      ruleId: 'major-change',
      reason: 'The rule did not match the normalized signals.',
    });
    const unknown = RiskRuleEvaluationResultSchema.parse({
      status: 'UNKNOWN',
      policyRulesVersion: 'policy-2026-08',
      ruleId: 'security-impact',
      stateFloor: 'REVIEW_REQUIRED',
      reason: 'The security-impact signal was not reported.',
    });

    expect(match.status).toBe('MATCH');
    expect(noMatch.status).toBe('NO_MATCH');
    expect(noMatch.ruleId).toBe('major-change');
    if (unknown.status !== 'UNKNOWN') {
      throw new Error('expected an UNKNOWN evaluation result');
    }
    expect(unknown.stateFloor).toBe('REVIEW_REQUIRED');
    expect(
      RiskRuleEvaluationResultSchema.parse(
        JSON.parse(JSON.stringify({ match, noMatch, unknown })).match,
      ),
    ).toEqual(match);
  });

  it('rejects malformed result metadata and a downgraded UNKNOWN floor', () => {
    expect(
      RiskRuleEvaluationResultSchema.safeParse({
        status: 'NO_MATCH',
        policyRulesVersion: 'policy-2026-08',
        reason: 'no match',
      }).success,
    ).toBe(false);
    expect(
      RiskRuleEvaluationResultSchema.safeParse({
        status: 'NO_MATCH',
        policyRulesVersion: 'policy-2026-08',
        ruleId: 'major-change',
        reason: 'no match',
        stateFloor: 'REVIEW_REQUIRED',
      }).success,
    ).toBe(false);
    expect(
      RiskRuleEvaluationResultSchema.safeParse({
        status: 'MATCH',
        policyRulesVersion: 'policy-2026-08',
        ruleId: 'major-change',
        stateFloor: 'REVIEW_REQUIRED',
        reason: 'matched',
        evidenceIds: ['duplicate', 'duplicate'],
      }).success,
    ).toBe(false);
    expect(
      RiskRuleEvaluationResultSchema.safeParse({
        status: 'UNKNOWN',
        policyRulesVersion: 'policy-2026-08',
        ruleId: 'major-change',
        stateFloor: 'INFORMATIONAL',
        reason: 'unknown',
      }).success,
    ).toBe(false);
    expect(
      RiskRuleEvaluationResultSchema.safeParse({
        status: 'UNKNOWN',
        policyRulesVersion: 'policy-2026-08',
        ruleId: 'major-change',
        stateFloor: 'REVIEW_REQUIRED',
        reason: '',
        evidenceIds: ['not valid id/with slash'],
      }).success,
    ).toBe(false);
  });
});
