import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ChangeEventSchema,
  DeterministicImpactDecisionSchema,
  GoldenCaseSchema,
  RiskPolicyEvaluationResultSchema,
  RiskPolicySchema,
  TenantApplicabilityPolicySchema,
  TenantApplicabilityResultSchema,
  TenantProfileSchema,
  createDeterministicImpactDecision,
  evaluateRiskPolicy,
  evaluateTenantApplicability,
  isRiskFloorAtLeast,
  type ChangeEvent,
  type GoldenCase,
  type TenantProfile,
} from '../src/index.js';

function readJson(path: string): unknown {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), path), 'utf8'),
  ) as unknown;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const riskPolicy = RiskPolicySchema.parse(
  readJson('test/fixtures/risk-policy.json'),
);
const tenantPolicy = TenantApplicabilityPolicySchema.parse(
  readJson('test/fixtures/tenant-applicability-policy.json'),
);
const baseEvent = ChangeEventSchema.parse(
  readJson('test/fixtures/change-event.json'),
);
const baseProfile = TenantProfileSchema.parse(
  readJson('test/fixtures/tenant-profile.json'),
);

const applicableEvent = ChangeEventSchema.parse({
  ...baseEvent,
  products: ['Synthetic Teams'],
  severity: 'low',
  signals: {
    ...baseEvent.signals,
    hasAdminImpact: false,
  },
});
const reviewFloorEvent = ChangeEventSchema.parse({
  ...applicableEvent,
  severity: 'high',
  signals: {
    ...applicableEvent.signals,
    isMajorChange: true,
    hasAdminImpact: false,
  },
});
const actionFloorEvent = ChangeEventSchema.parse({
  ...applicableEvent,
  severity: 'high',
  signals: {
    ...applicableEvent.signals,
    isMajorChange: true,
    hasAdminImpact: true,
  },
});
const noFloorRiskEvaluation = RiskPolicyEvaluationResultSchema.parse(
  evaluateRiskPolicy(riskPolicy, applicableEvent),
);
const reviewFloorRiskEvaluation = RiskPolicyEvaluationResultSchema.parse(
  evaluateRiskPolicy(riskPolicy, reviewFloorEvent),
);
const actionFloorRiskEvaluation = RiskPolicyEvaluationResultSchema.parse(
  evaluateRiskPolicy(riskPolicy, actionFloorEvent),
);

const applicableTenantApplicability = TenantApplicabilityResultSchema.parse(
  evaluateTenantApplicability(tenantPolicy, applicableEvent, baseProfile),
);
const notApplicableProfile = clone(baseProfile);
notApplicableProfile.services.teams = false;
const notApplicableTenantApplicability = TenantApplicabilityResultSchema.parse(
  evaluateTenantApplicability(
    tenantPolicy,
    applicableEvent,
    TenantProfileSchema.parse(notApplicableProfile),
  ),
);
const insufficientProfile = clone(baseProfile);
delete insufficientProfile.services.teams;
const insufficientTenantApplicability = TenantApplicabilityResultSchema.parse(
  evaluateTenantApplicability(
    tenantPolicy,
    applicableEvent,
    TenantProfileSchema.parse(insufficientProfile),
  ),
);

function loadCorpusChanges(): Map<string, ChangeEvent> {
  const directory = resolve(process.cwd(), 'corpus/changes');
  return new Map(
    readdirSync(directory)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => {
        const fixture = readJson(join('corpus/changes', name)) as {
          fixtureId: string;
          event: unknown;
        };
        return [fixture.fixtureId, ChangeEventSchema.parse(fixture.event)];
      }),
  );
}

function loadCorpusProfiles(): Map<string, TenantProfile> {
  const directory = resolve(process.cwd(), 'corpus/tenant-profiles');
  return new Map(
    readdirSync(directory)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => {
        const fixture = readJson(join('corpus/tenant-profiles', name)) as {
          fixtureId: string;
          profile: unknown;
        };
        return [fixture.fixtureId, TenantProfileSchema.parse(fixture.profile)];
      }),
  );
}

function loadGoldenCases(): GoldenCase[] {
  const directory = resolve(process.cwd(), 'corpus/cases');
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) =>
      GoldenCaseSchema.parse(readJson(join('corpus/cases', name))),
    );
}

describe('Deterministic impact decision evaluator', () => {
  it('maps both non-null risk floors and all tenant statuses to GUARDRAIL_FLOOR', () => {
    expect(reviewFloorRiskEvaluation.finalStateFloor).toBe('REVIEW_REQUIRED');
    expect(actionFloorRiskEvaluation.finalStateFloor).toBe('ACTION_REQUIRED');

    const floorEvaluations = [
      reviewFloorRiskEvaluation,
      actionFloorRiskEvaluation,
    ];
    const tenantResults = [
      applicableTenantApplicability,
      notApplicableTenantApplicability,
      insufficientTenantApplicability,
    ];

    floorEvaluations.forEach((riskEvaluation) => {
      tenantResults.forEach((tenantApplicability) => {
        const decision = createDeterministicImpactDecision(
          riskEvaluation,
          tenantApplicability,
        );
        expect(decision).toMatchObject({
          kind: 'GUARDRAIL_FLOOR',
          riskEvaluation,
          tenantApplicability,
          stateFloor: riskEvaluation.finalStateFloor,
        });
        expect(decision).not.toHaveProperty('state');
        expect(DeterministicImpactDecisionSchema.parse(decision)).toEqual(
          decision,
        );
      });
    });
  });

  it('selects CLASSIFICATION_REQUIRED only for a null floor and APPLICABLE tenant result', () => {
    const decision = createDeterministicImpactDecision(
      noFloorRiskEvaluation,
      applicableTenantApplicability,
    );

    expect(decision).toMatchObject({
      kind: 'CLASSIFICATION_REQUIRED',
      riskEvaluation: noFloorRiskEvaluation,
      tenantApplicability: applicableTenantApplicability,
      stateFloor: null,
    });
    expect(decision).not.toHaveProperty('state');
    expect(decision.reason).toBeTruthy();
  });

  it('selects DETERMINISTIC_FINAL with the matching NOT_APPLICABLE or INSUFFICIENT_CONTEXT state', () => {
    const notApplicable = createDeterministicImpactDecision(
      noFloorRiskEvaluation,
      notApplicableTenantApplicability,
    );
    const insufficientContext = createDeterministicImpactDecision(
      noFloorRiskEvaluation,
      insufficientTenantApplicability,
    );

    expect(notApplicable).toMatchObject({
      kind: 'DETERMINISTIC_FINAL',
      state: 'NOT_APPLICABLE',
      stateFloor: null,
    });
    expect(insufficientContext).toMatchObject({
      kind: 'DETERMINISTIC_FINAL',
      state: 'INSUFFICIENT_CONTEXT',
      stateFloor: null,
    });
  });

  it('is schema-valid with one expected kind for all nine risk and tenant combinations', () => {
    const riskEvaluations = [
      {
        evaluation: reviewFloorRiskEvaluation,
        expectedKind: 'GUARDRAIL_FLOOR',
      },
      {
        evaluation: actionFloorRiskEvaluation,
        expectedKind: 'GUARDRAIL_FLOOR',
      },
      {
        evaluation: noFloorRiskEvaluation,
        expectedKind: undefined,
      },
    ] as const;
    const tenantResults = [
      applicableTenantApplicability,
      notApplicableTenantApplicability,
      insufficientTenantApplicability,
    ];

    expect(riskEvaluations).toHaveLength(3);
    expect(tenantResults).toHaveLength(3);
    riskEvaluations.forEach(({ evaluation, expectedKind }) => {
      tenantResults.forEach((tenantApplicability) => {
        const decision = createDeterministicImpactDecision(
          evaluation,
          tenantApplicability,
        );
        const parsed = DeterministicImpactDecisionSchema.parse(decision);
        expect(parsed).toEqual(decision);
        if (expectedKind !== undefined) {
          expect(decision.kind).toBe(expectedKind);
        } else if (tenantApplicability.status === 'APPLICABLE') {
          expect(decision.kind).toBe('CLASSIFICATION_REQUIRED');
        } else {
          expect(decision.kind).toBe('DETERMINISTIC_FINAL');
        }
      });
    });
  });

  it('retains nested inputs, preserves input objects, and is deterministic', () => {
    const riskBefore = clone(reviewFloorRiskEvaluation);
    const tenantBefore = clone(insufficientTenantApplicability);
    const first = createDeterministicImpactDecision(
      reviewFloorRiskEvaluation,
      insufficientTenantApplicability,
    );
    const second = createDeterministicImpactDecision(
      reviewFloorRiskEvaluation,
      insufficientTenantApplicability,
    );

    expect(first).toEqual(second);
    expect(first.riskEvaluation).toEqual(reviewFloorRiskEvaluation);
    expect(first.tenantApplicability).toEqual(insufficientTenantApplicability);
    expect(reviewFloorRiskEvaluation).toEqual(riskBefore);
    expect(insufficientTenantApplicability).toEqual(tenantBefore);
    expect(
      DeterministicImpactDecisionSchema.parse(
        JSON.parse(JSON.stringify(first)),
      ),
    ).toEqual(first);
  });

  it('keeps a risk floor when the tenant result is unknown and handles source unknown safely', () => {
    const sourceUnknownEvent = ChangeEventSchema.parse({
      ...applicableEvent,
      severity: undefined,
      signals: {
        ...applicableEvent.signals,
        isMajorChange: true,
      },
    });
    const riskEvaluation = RiskPolicyEvaluationResultSchema.parse(
      evaluateRiskPolicy(riskPolicy, sourceUnknownEvent),
    );
    const tenantApplicability = TenantApplicabilityResultSchema.parse(
      evaluateTenantApplicability(
        tenantPolicy,
        sourceUnknownEvent,
        baseProfile,
      ),
    );
    const decision = createDeterministicImpactDecision(
      riskEvaluation,
      tenantApplicability,
    );

    expect(riskEvaluation.ruleResults).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'UNKNOWN' })]),
    );
    expect(riskEvaluation.finalStateFloor).toBe('REVIEW_REQUIRED');
    expect(tenantApplicability.status).toBe('APPLICABLE');
    expect(decision.kind).toBe('GUARDRAIL_FLOOR');
    expect(decision.stateFloor).toBe('REVIEW_REQUIRED');
  });
});

describe('Deterministic impact decision corpus integration', () => {
  it('evaluates all 50 changes across all 10 profiles as complete schema records', () => {
    const changes = loadCorpusChanges();
    const profiles = loadCorpusProfiles();
    const decisions = [...changes.values()].flatMap((event) =>
      [...profiles.values()].map((profile) =>
        createDeterministicImpactDecision(
          evaluateRiskPolicy(riskPolicy, event),
          evaluateTenantApplicability(tenantPolicy, event, profile),
        ),
      ),
    );

    expect(changes).toHaveLength(50);
    expect(profiles).toHaveLength(10);
    expect(decisions).toHaveLength(500);
    decisions.forEach((decision) => {
      expect(DeterministicImpactDecisionSchema.parse(decision)).toEqual(
        decision,
      );
    });
  });

  it('turns every golden minimumRiskFloor case into GUARDRAIL_FLOOR at or above its declared floor', () => {
    const changes = loadCorpusChanges();
    const profiles = loadCorpusProfiles();
    const cases = loadGoldenCases().filter(
      (goldenCase) =>
        'minimumRiskFloor' in goldenCase.expected &&
        goldenCase.expected.minimumRiskFloor !== undefined,
    );

    expect(cases).toHaveLength(39);
    cases.forEach((goldenCase) => {
      const event = changes.get(goldenCase.changeFixtureId);
      const profile = profiles.get(goldenCase.tenantProfileFixtureId);
      if (event === undefined || profile === undefined) {
        throw new Error(`missing fixture for ${goldenCase.caseId}`);
      }
      const riskEvaluation = evaluateRiskPolicy(riskPolicy, event);
      const tenantApplicability = evaluateTenantApplicability(
        tenantPolicy,
        event,
        profile,
      );
      const decision = createDeterministicImpactDecision(
        riskEvaluation,
        tenantApplicability,
      );
      if (
        !('minimumRiskFloor' in goldenCase.expected) ||
        goldenCase.expected.minimumRiskFloor === undefined
      ) {
        throw new Error(`missing minimum floor for ${goldenCase.caseId}`);
      }
      expect(decision.kind).toBe('GUARDRAIL_FLOOR');
      expect(decision.stateFloor).not.toBeNull();
      expect(
        isRiskFloorAtLeast(
          riskEvaluation.finalStateFloor,
          goldenCase.expected.minimumRiskFloor,
        ),
      ).toBe(true);
    });
  });

  it('turns the six NOT_APPLICABLE golden cases into deterministic final results with a null risk floor', () => {
    const changes = loadCorpusChanges();
    const profiles = loadCorpusProfiles();
    const cases = loadGoldenCases().filter(
      (goldenCase) => goldenCase.expected.state === 'NOT_APPLICABLE',
    );

    expect(cases).toHaveLength(6);
    cases.forEach((goldenCase) => {
      const event = changes.get(goldenCase.changeFixtureId);
      const profile = profiles.get(goldenCase.tenantProfileFixtureId);
      if (event === undefined || profile === undefined) {
        throw new Error(`missing fixture for ${goldenCase.caseId}`);
      }
      const riskEvaluation = evaluateRiskPolicy(riskPolicy, event);
      const tenantApplicability = evaluateTenantApplicability(
        tenantPolicy,
        event,
        profile,
      );
      const decision = createDeterministicImpactDecision(
        riskEvaluation,
        tenantApplicability,
      );

      expect(riskEvaluation.finalStateFloor).toBeNull();
      expect(tenantApplicability.status).toBe('NOT_APPLICABLE');
      expect(decision).toMatchObject({
        kind: 'DETERMINISTIC_FINAL',
        state: 'NOT_APPLICABLE',
        stateFloor: null,
      });
    });
  });

  it('turns tenant-only INSUFFICIENT_CONTEXT cases into deterministic final results with a null risk floor', () => {
    const changes = loadCorpusChanges();
    const profiles = loadCorpusProfiles();
    const candidates = loadGoldenCases().filter(
      (goldenCase) => goldenCase.expected.state === 'INSUFFICIENT_CONTEXT',
    );
    const tenantOnlyCases = candidates.filter((goldenCase) => {
      const event = changes.get(goldenCase.changeFixtureId);
      const profile = profiles.get(goldenCase.tenantProfileFixtureId);
      if (event === undefined || profile === undefined) return false;
      return (
        evaluateRiskPolicy(riskPolicy, event).finalStateFloor === null &&
        evaluateTenantApplicability(tenantPolicy, event, profile).status ===
          'INSUFFICIENT_CONTEXT'
      );
    });

    expect(tenantOnlyCases.length).toBeGreaterThanOrEqual(5);
    tenantOnlyCases.forEach((goldenCase) => {
      const event = changes.get(goldenCase.changeFixtureId);
      const profile = profiles.get(goldenCase.tenantProfileFixtureId);
      if (event === undefined || profile === undefined) {
        throw new Error(`missing fixture for ${goldenCase.caseId}`);
      }
      const riskEvaluation = evaluateRiskPolicy(riskPolicy, event);
      const tenantApplicability = evaluateTenantApplicability(
        tenantPolicy,
        event,
        profile,
      );
      const decision = createDeterministicImpactDecision(
        riskEvaluation,
        tenantApplicability,
      );

      expect(decision).toMatchObject({
        kind: 'DETERMINISTIC_FINAL',
        state: 'INSUFFICIENT_CONTEXT',
        stateFloor: null,
      });
    });
  });
});
