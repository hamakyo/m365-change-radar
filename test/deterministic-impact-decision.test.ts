import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ChangeEventSchema,
  DeterministicImpactDecisionKindSchema,
  DeterministicImpactDecisionSchema,
  RiskPolicyEvaluationResultSchema,
  RiskPolicySchema,
  TenantApplicabilityPolicySchema,
  TenantApplicabilityResultSchema,
  TenantProfileSchema,
  evaluateRiskPolicy,
  evaluateTenantApplicability,
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
const noFloorRiskEvaluation = RiskPolicyEvaluationResultSchema.parse(
  evaluateRiskPolicy(riskPolicy, applicableEvent),
);
const floorRiskEvaluation = RiskPolicyEvaluationResultSchema.parse(
  evaluateRiskPolicy(
    riskPolicy,
    ChangeEventSchema.parse({
      ...applicableEvent,
      severity: 'high',
      signals: {
        ...applicableEvent.signals,
        isMajorChange: true,
      },
    }),
  ),
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

function guardrailDecision(): Record<string, unknown> {
  if (floorRiskEvaluation.finalStateFloor === null) {
    throw new Error('expected a risk floor for the guardrail fixture');
  }
  return {
    kind: 'GUARDRAIL_FLOOR',
    riskEvaluation: floorRiskEvaluation,
    tenantApplicability: applicableTenantApplicability,
    stateFloor: floorRiskEvaluation.finalStateFloor,
    reason: 'A deterministic risk floor must be retained.',
  };
}

function classificationDecision(): Record<string, unknown> {
  return {
    kind: 'CLASSIFICATION_REQUIRED',
    riskEvaluation: noFloorRiskEvaluation,
    tenantApplicability: applicableTenantApplicability,
    stateFloor: null,
    reason: 'The applicable change needs structured classification.',
  };
}

function deterministicFinalDecision(
  tenantApplicability = notApplicableTenantApplicability,
): Record<string, unknown> {
  if (
    tenantApplicability.status !== 'NOT_APPLICABLE' &&
    tenantApplicability.status !== 'INSUFFICIENT_CONTEXT'
  ) {
    throw new Error('expected a deterministic final tenant result');
  }
  return {
    kind: 'DETERMINISTIC_FINAL',
    riskEvaluation: noFloorRiskEvaluation,
    tenantApplicability,
    stateFloor: null,
    state: tenantApplicability.status,
    reason: 'Tenant applicability determines the final state.',
  };
}

describe('DeterministicImpactDecision', () => {
  it('exposes exactly the three decision kinds and parses each valid variant', () => {
    expect(DeterministicImpactDecisionKindSchema.options).toEqual([
      'GUARDRAIL_FLOOR',
      'CLASSIFICATION_REQUIRED',
      'DETERMINISTIC_FINAL',
    ]);

    const guardrail =
      DeterministicImpactDecisionSchema.parse(guardrailDecision());
    const classification = DeterministicImpactDecisionSchema.parse(
      classificationDecision(),
    );
    const deterministicFinal = DeterministicImpactDecisionSchema.parse(
      deterministicFinalDecision(),
    );

    expect(guardrail.kind).toBe('GUARDRAIL_FLOOR');
    expect(guardrail.stateFloor).toBe(floorRiskEvaluation.finalStateFloor);
    expect(classification).toMatchObject({
      kind: 'CLASSIFICATION_REQUIRED',
      stateFloor: null,
    });
    expect(deterministicFinal).toMatchObject({
      kind: 'DETERMINISTIC_FINAL',
      state: 'NOT_APPLICABLE',
      stateFloor: null,
    });
  });

  it('accepts insufficient context as a deterministic final state without a risk floor', () => {
    const decision = DeterministicImpactDecisionSchema.parse(
      deterministicFinalDecision(insufficientTenantApplicability),
    );

    expect(decision).toMatchObject({
      kind: 'DETERMINISTIC_FINAL',
      state: 'INSUFFICIENT_CONTEXT',
      stateFloor: null,
    });
  });

  it('rejects every cross-field combination that could produce another kind', () => {
    const guardrail = guardrailDecision();
    const classification = classificationDecision();
    const deterministicFinal = deterministicFinalDecision();

    const invalidDecisions: unknown[] = [
      {
        ...guardrail,
        riskEvaluation: noFloorRiskEvaluation,
        stateFloor: null,
      },
      {
        ...guardrail,
        stateFloor:
          floorRiskEvaluation.finalStateFloor === 'ACTION_REQUIRED'
            ? 'REVIEW_REQUIRED'
            : 'ACTION_REQUIRED',
      },
      {
        ...classification,
        riskEvaluation: floorRiskEvaluation,
      },
      {
        ...classification,
        tenantApplicability: notApplicableTenantApplicability,
      },
      {
        ...classification,
        tenantApplicability: insufficientTenantApplicability,
      },
      {
        ...deterministicFinal,
        riskEvaluation: floorRiskEvaluation,
      },
      {
        ...deterministicFinal,
        tenantApplicability: applicableTenantApplicability,
      },
      {
        ...deterministicFinal,
        state: 'INSUFFICIENT_CONTEXT',
      },
    ];

    invalidDecisions.forEach((decision) => {
      expect(
        DeterministicImpactDecisionSchema.safeParse(decision).success,
      ).toBe(false);
    });
  });

  it('allows only one kind for each complete risk and tenant input pair', () => {
    const pairs = [
      {
        riskEvaluation: floorRiskEvaluation,
        tenantApplicability: applicableTenantApplicability,
        validKind: 'GUARDRAIL_FLOOR',
      },
      {
        riskEvaluation: noFloorRiskEvaluation,
        tenantApplicability: applicableTenantApplicability,
        validKind: 'CLASSIFICATION_REQUIRED',
      },
      {
        riskEvaluation: noFloorRiskEvaluation,
        tenantApplicability: notApplicableTenantApplicability,
        validKind: 'DETERMINISTIC_FINAL',
      },
      {
        riskEvaluation: noFloorRiskEvaluation,
        tenantApplicability: insufficientTenantApplicability,
        validKind: 'DETERMINISTIC_FINAL',
      },
    ] as const;

    pairs.forEach((pair) => {
      const decisions = [
        {
          kind: 'GUARDRAIL_FLOOR',
          riskEvaluation: pair.riskEvaluation,
          tenantApplicability: pair.tenantApplicability,
          stateFloor:
            pair.riskEvaluation.finalStateFloor === null
              ? 'REVIEW_REQUIRED'
              : pair.riskEvaluation.finalStateFloor,
          reason: 'candidate guardrail',
        },
        {
          kind: 'CLASSIFICATION_REQUIRED',
          riskEvaluation: pair.riskEvaluation,
          tenantApplicability: pair.tenantApplicability,
          stateFloor: null,
          reason: 'candidate classification',
        },
        {
          kind: 'DETERMINISTIC_FINAL',
          riskEvaluation: pair.riskEvaluation,
          tenantApplicability: pair.tenantApplicability,
          stateFloor: null,
          state:
            pair.tenantApplicability.status === 'APPLICABLE'
              ? 'NOT_APPLICABLE'
              : pair.tenantApplicability.status,
          reason: 'candidate final',
        },
      ];
      const acceptedKinds = decisions
        .filter(
          (decision) =>
            DeterministicImpactDecisionSchema.safeParse(decision).success,
        )
        .map((decision) => decision.kind);
      expect(acceptedKinds).toEqual([pair.validKind]);
    });
  });

  it('round-trips all variants and rejects extra or missing state fields', () => {
    const validDecisions = [
      guardrailDecision(),
      classificationDecision(),
      deterministicFinalDecision(),
    ];
    validDecisions.forEach((decision) => {
      const parsed = DeterministicImpactDecisionSchema.parse(decision);
      expect(
        DeterministicImpactDecisionSchema.parse(
          JSON.parse(JSON.stringify(parsed)),
        ),
      ).toEqual(parsed);
    });

    expect(
      DeterministicImpactDecisionSchema.safeParse({
        ...guardrailDecision(),
        state: 'REVIEW_REQUIRED',
      }).success,
    ).toBe(false);
    expect(
      DeterministicImpactDecisionSchema.safeParse({
        ...classificationDecision(),
        state: 'INFORMATIONAL',
      }).success,
    ).toBe(false);
    expect(
      DeterministicImpactDecisionSchema.safeParse({
        ...deterministicFinalDecision(),
        stateFloor: undefined,
      }).success,
    ).toBe(false);
    expect(
      DeterministicImpactDecisionSchema.safeParse({
        ...deterministicFinalDecision(),
        state: undefined,
      }).success,
    ).toBe(false);
    expect(
      DeterministicImpactDecisionSchema.safeParse({
        ...classificationDecision(),
        unexpected: true,
      }).success,
    ).toBe(false);
    expect(
      DeterministicImpactDecisionSchema.safeParse({
        ...classificationDecision(),
        reason: '',
      }).success,
    ).toBe(false);
    expect(
      DeterministicImpactDecisionSchema.safeParse({
        ...classificationDecision(),
        riskEvaluation: {
          ...noFloorRiskEvaluation,
          unexpected: true,
        },
      }).success,
    ).toBe(false);
    expect(
      DeterministicImpactDecisionSchema.safeParse({
        ...classificationDecision(),
        kind: 'UNKNOWN',
      }).success,
    ).toBe(false);
  });
});
