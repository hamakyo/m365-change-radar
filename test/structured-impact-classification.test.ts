import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ChangeEventSchema,
  ClassifierEvidenceRecordSchema,
  RiskPolicySchema,
  SourceFactSchema,
  StructuredImpactClassificationOutputSchema,
  StructuredImpactClassificationRequestSchema,
  StructuredImpactClassificationSchema,
  TenantApplicabilityPolicySchema,
  TenantApplicabilityResultSchema,
  TenantFactSchema,
  TenantProfileSchema,
  createDeterministicImpactDecision,
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
const tenantProfile = TenantProfileSchema.parse(
  readJson('test/fixtures/tenant-profile.json'),
);

const classificationEvent = ChangeEventSchema.parse({
  ...baseEvent,
  products: ['Synthetic Teams'],
  severity: 'low',
  signals: {
    ...baseEvent.signals,
    hasAdminImpact: false,
  },
});
const classificationRiskEvaluation = evaluateRiskPolicy(
  riskPolicy,
  classificationEvent,
);
const classificationTenantApplicability = evaluateTenantApplicability(
  tenantPolicy,
  classificationEvent,
  tenantProfile,
);
const classificationDecision = createDeterministicImpactDecision(
  classificationRiskEvaluation,
  classificationTenantApplicability,
);

const guardrailEvent = ChangeEventSchema.parse({
  ...classificationEvent,
  severity: 'high',
  signals: {
    ...classificationEvent.signals,
    isMajorChange: true,
  },
});
const guardrailDecision = createDeterministicImpactDecision(
  evaluateRiskPolicy(riskPolicy, guardrailEvent),
  evaluateTenantApplicability(tenantPolicy, guardrailEvent, tenantProfile),
);

const sourceEvidence = SourceFactSchema.parse({
  kind: 'source_fact',
  evidenceId: 'source.change',
  source: classificationEvent.source,
  externalId: classificationEvent.externalId,
  sourceMessageVersion: 'message-v1',
  path: '/products/0',
  observation: {
    presence: 'present',
    value: classificationEvent.products[0]!,
  },
});
const tenantEvidence = TenantFactSchema.parse({
  kind: 'tenant_fact',
  evidenceId: 'tenant.services.teams',
  tenantProfileVersion: tenantProfile.profileVersion,
  path: '/services/teams',
  observation: {
    presence: 'present',
    value: true,
  },
});
const notApplicableProfile = clone(tenantProfile);
notApplicableProfile.services.teams = false;
const notApplicableTenantApplicability = TenantApplicabilityResultSchema.parse(
  evaluateTenantApplicability(
    tenantPolicy,
    classificationEvent,
    TenantProfileSchema.parse(notApplicableProfile),
  ),
);
const riskDeterministicEvidence = {
  kind: 'deterministic_conclusion' as const,
  evidenceId: 'decision.risk-major-change',
  policyKind: 'risk_policy' as const,
  policyRulesVersion: classificationDecision.riskEvaluation.policyRulesVersion,
  ruleId: 'major-change',
  conclusion: 'The risk policy evaluation retains the classification boundary.',
  dependsOnEvidenceIds: [sourceEvidence.evidenceId],
};
const tenantDeterministicEvidence = {
  kind: 'deterministic_conclusion' as const,
  evidenceId: 'decision.tenant-synthetic-teams',
  policyKind: 'tenant_applicability_policy' as const,
  policyRulesVersion:
    classificationDecision.tenantApplicability.policyRulesVersion,
  ruleId: 'synthetic-teams',
  conclusion:
    'The tenant applicability evaluation retains the Synthetic Teams result.',
  dependsOnEvidenceIds: [tenantEvidence.evidenceId],
};
const evidenceRecords = [
  sourceEvidence,
  tenantEvidence,
  riskDeterministicEvidence,
  tenantDeterministicEvidence,
];

function requestFor(
  decision: typeof classificationDecision = classificationDecision,
): Record<string, unknown> {
  return {
    changeEvent: classificationEvent,
    sourceMessageVersion: 'message-v1',
    tenantProfile,
    decision,
    evidenceRecords,
  };
}

function outputFor(
  proposedState:
    | 'ACTION_REQUIRED'
    | 'REVIEW_REQUIRED'
    | 'INFORMATIONAL'
    | 'NOT_APPLICABLE'
    | 'INSUFFICIENT_CONTEXT',
): Record<string, unknown> {
  return {
    proposedState,
    confidence: 0.75,
    reason: 'The structured classifier returned a bounded proposal.',
    affectedComponents: ['Teams'],
    supportingEvidenceIds: [sourceEvidence.evidenceId],
    ...(proposedState === 'INSUFFICIENT_CONTEXT'
      ? { missingContext: ['services.teams'] }
      : {}),
  };
}

describe('Structured impact classification schemas', () => {
  it('parses a complete request and all five output states through a JSON round trip', () => {
    const request =
      StructuredImpactClassificationRequestSchema.parse(requestFor());
    expect(request.changeEvent).toEqual(classificationEvent);
    expect(request.tenantProfile).toEqual(tenantProfile);
    expect(request.evidenceRecords).toHaveLength(4);
    expect(request.decision.kind).toBe('CLASSIFICATION_REQUIRED');

    const states = [
      'ACTION_REQUIRED',
      'REVIEW_REQUIRED',
      'INFORMATIONAL',
      'NOT_APPLICABLE',
      'INSUFFICIENT_CONTEXT',
    ] as const;
    states.forEach((proposedState) => {
      const output = StructuredImpactClassificationOutputSchema.parse(
        outputFor(proposedState),
      );
      const classification = StructuredImpactClassificationSchema.parse({
        request,
        output,
      });
      expect(
        StructuredImpactClassificationSchema.parse(
          JSON.parse(JSON.stringify(classification)),
        ),
      ).toEqual(classification);
    });
  });

  it('retains absent source and tenant observations through request and classification round trips', () => {
    const absentEvidenceRecords = evidenceRecords.map((record) => {
      if (record.kind === 'source_fact' || record.kind === 'tenant_fact') {
        return {
          ...record,
          observation: { presence: 'absent' as const },
        };
      }
      return record;
    });
    const request = StructuredImpactClassificationRequestSchema.parse({
      ...requestFor(),
      evidenceRecords: absentEvidenceRecords,
    });
    const classification = StructuredImpactClassificationSchema.parse({
      request,
      output: outputFor('INSUFFICIENT_CONTEXT'),
    });
    const roundTripped = StructuredImpactClassificationSchema.parse(
      JSON.parse(JSON.stringify(classification)),
    );

    expect(roundTripped).toEqual(classification);
    expect(
      request.evidenceRecords
        .filter(
          (record) =>
            record.kind === 'source_fact' || record.kind === 'tenant_fact',
        )
        .every((record) => record.observation.presence === 'absent'),
    ).toBe(true);
    expect(
      request.evidenceRecords.find(
        (record) => record.kind === 'deterministic_conclusion',
      ),
    ).toMatchObject({
      dependsOnEvidenceIds: ['source.change'],
    });
  });

  it('accepts complete GUARDRAIL_FLOOR input and retains a proposal below its floor', () => {
    const request = StructuredImpactClassificationRequestSchema.parse(
      requestFor(guardrailDecision),
    );
    const output = StructuredImpactClassificationOutputSchema.parse(
      outputFor('INFORMATIONAL'),
    );
    const classification = StructuredImpactClassificationSchema.parse({
      request,
      output,
    });

    expect(classification.request.decision.kind).toBe('GUARDRAIL_FLOOR');
    expect(classification.output.proposedState).toBe('INFORMATIONAL');
  });

  it('keeps classifier evidence to the three provenance kinds and rejects AI inference', () => {
    expect(
      evidenceRecords.map((record) =>
        ClassifierEvidenceRecordSchema.parse(record),
      ),
    ).toHaveLength(4);
    expect(
      ClassifierEvidenceRecordSchema.safeParse({
        kind: 'ai_inference',
        evidenceId: 'ai.result',
        promptVersion: 'prompt-v1',
        model: 'model-v1',
        modelVersion: 'model-v1',
        confidence: 0.5,
        inference: 'unsupported claim',
        dependsOnEvidenceIds: [sourceEvidence.evidenceId],
      }).success,
    ).toBe(false);

    const deterministicFinal = createDeterministicImpactDecision(
      classificationRiskEvaluation,
      notApplicableTenantApplicability,
    );
    expect(
      StructuredImpactClassificationRequestSchema.safeParse(
        requestFor(deterministicFinal),
      ).success,
    ).toBe(false);
  });

  it('accepts deterministic conclusions from either decision policy version only', () => {
    const request =
      StructuredImpactClassificationRequestSchema.parse(requestFor());
    const riskOnly = StructuredImpactClassificationRequestSchema.parse({
      ...requestFor(),
      evidenceRecords: [
        sourceEvidence,
        tenantEvidence,
        riskDeterministicEvidence,
      ],
    });
    const tenantOnly = StructuredImpactClassificationRequestSchema.parse({
      ...requestFor(),
      evidenceRecords: [
        sourceEvidence,
        tenantEvidence,
        tenantDeterministicEvidence,
      ],
    });

    expect(request.evidenceRecords).toHaveLength(4);
    expect(riskOnly.evidenceRecords).toHaveLength(3);
    expect(tenantOnly.evidenceRecords).toHaveLength(3);
    expect(riskOnly.evidenceRecords).toContainEqual(riskDeterministicEvidence);
    expect(tenantOnly.evidenceRecords).toContainEqual(
      tenantDeterministicEvidence,
    );
    expect(
      StructuredImpactClassificationRequestSchema.safeParse({
        ...requestFor(),
        evidenceRecords: [
          sourceEvidence,
          tenantEvidence,
          {
            ...riskDeterministicEvidence,
            policyKind: 'tenant_applicability_policy',
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      StructuredImpactClassificationRequestSchema.safeParse({
        ...requestFor(),
        evidenceRecords: [
          sourceEvidence,
          tenantEvidence,
          {
            ...tenantDeterministicEvidence,
            policyRulesVersion: 'third-policy-version',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects duplicate records, references, versions, and strict fields', () => {
    expect(
      StructuredImpactClassificationRequestSchema.safeParse({
        ...requestFor(),
        evidenceRecords: [
          ...evidenceRecords,
          { ...sourceEvidence, evidenceId: tenantEvidence.evidenceId },
        ],
      }).success,
    ).toBe(false);
    expect(
      StructuredImpactClassificationRequestSchema.safeParse({
        ...requestFor(),
        evidenceRecords: [
          sourceEvidence,
          tenantEvidence,
          {
            ...riskDeterministicEvidence,
            dependsOnEvidenceIds: ['missing.id'],
          },
          tenantDeterministicEvidence,
        ],
      }).success,
    ).toBe(false);
    expect(
      StructuredImpactClassificationRequestSchema.safeParse({
        ...requestFor(),
        evidenceRecords: [
          sourceEvidence,
          tenantEvidence,
          {
            ...riskDeterministicEvidence,
            dependsOnEvidenceIds: [
              sourceEvidence.evidenceId,
              sourceEvidence.evidenceId,
            ],
          },
          tenantDeterministicEvidence,
        ],
      }).success,
    ).toBe(false);

    const sourceMismatches = [
      { source: 'different-source' },
      { externalId: 'different-external-id' },
      { sourceMessageVersion: 'different-message-version' },
    ];
    sourceMismatches.forEach((mismatch) => {
      expect(
        StructuredImpactClassificationRequestSchema.safeParse({
          ...requestFor(),
          evidenceRecords: [
            { ...sourceEvidence, ...mismatch },
            tenantEvidence,
            riskDeterministicEvidence,
            tenantDeterministicEvidence,
          ],
        }).success,
      ).toBe(false);
    });
    expect(
      StructuredImpactClassificationRequestSchema.safeParse({
        ...requestFor(),
        evidenceRecords: [
          sourceEvidence,
          {
            ...tenantEvidence,
            tenantProfileVersion: 'different-profile-version',
          },
          riskDeterministicEvidence,
          tenantDeterministicEvidence,
        ],
      }).success,
    ).toBe(false);
    expect(
      StructuredImpactClassificationRequestSchema.safeParse({
        ...requestFor(),
        evidenceRecords: [
          sourceEvidence,
          tenantEvidence,
          {
            ...riskDeterministicEvidence,
            policyRulesVersion: 'different-policy-version',
          },
          tenantDeterministicEvidence,
        ],
      }).success,
    ).toBe(false);
    expect(
      StructuredImpactClassificationRequestSchema.safeParse({
        ...requestFor(),
        extra: true,
      }).success,
    ).toBe(false);
  });

  it('validates output bounds, references, missing context, and strictness', () => {
    expect(
      StructuredImpactClassificationOutputSchema.parse({
        ...outputFor('REVIEW_REQUIRED'),
        confidence: 0,
        affectedComponents: [],
      }),
    ).toMatchObject({ confidence: 0, affectedComponents: [] });
    expect(
      StructuredImpactClassificationOutputSchema.parse({
        ...outputFor('ACTION_REQUIRED'),
        confidence: 1,
      }),
    ).toMatchObject({ confidence: 1 });

    expect(
      StructuredImpactClassificationOutputSchema.safeParse({
        ...outputFor('REVIEW_REQUIRED'),
        confidence: 1.01,
      }).success,
    ).toBe(false);
    expect(
      StructuredImpactClassificationOutputSchema.safeParse({
        ...outputFor('REVIEW_REQUIRED'),
        confidence: Number.NaN,
      }).success,
    ).toBe(false);
    expect(
      StructuredImpactClassificationOutputSchema.safeParse({
        ...outputFor('REVIEW_REQUIRED'),
        affectedComponents: ['Teams', 'Teams'],
      }).success,
    ).toBe(false);
    expect(
      StructuredImpactClassificationOutputSchema.safeParse({
        ...outputFor('INSUFFICIENT_CONTEXT'),
        missingContext: ['services.teams', 'services.teams'],
      }).success,
    ).toBe(false);
    expect(
      StructuredImpactClassificationOutputSchema.safeParse({
        ...outputFor('REVIEW_REQUIRED'),
        missingContext: ['services.teams'],
      }).success,
    ).toBe(false);
    expect(
      StructuredImpactClassificationOutputSchema.safeParse({
        ...outputFor('INSUFFICIENT_CONTEXT'),
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      StructuredImpactClassificationOutputSchema.safeParse({
        ...outputFor('REVIEW_REQUIRED'),
        supportingEvidenceIds: [
          sourceEvidence.evidenceId,
          sourceEvidence.evidenceId,
        ],
      }).success,
    ).toBe(false);

    expect(
      StructuredImpactClassificationSchema.safeParse({
        request: requestFor(),
        output: {
          ...outputFor('REVIEW_REQUIRED'),
          supportingEvidenceIds: ['missing.evidence'],
        },
      }).success,
    ).toBe(false);
    expect(
      StructuredImpactClassificationSchema.safeParse({
        request: requestFor(),
        output: outputFor('REVIEW_REQUIRED'),
        extra: true,
      }).success,
    ).toBe(false);
  });

  it('rejects -0 confidence in all five states while accepting +0 stably', () => {
    const states = [
      'ACTION_REQUIRED',
      'REVIEW_REQUIRED',
      'INFORMATIONAL',
      'NOT_APPLICABLE',
      'INSUFFICIENT_CONTEXT',
    ] as const;
    states.forEach((proposedState) => {
      expect(
        StructuredImpactClassificationOutputSchema.safeParse({
          ...outputFor(proposedState),
          confidence: -0,
        }).success,
      ).toBe(false);
    });

    // Why -0 is rejected: it passes every numeric bound (`-0 === 0`) but
    // JSON serializes it as `0`, silently changing the value across a JSON
    // round trip and breaking the output's JSON-safe contract.
    expect(Object.is(-0, 0)).toBe(false);
    expect(JSON.stringify({ confidence: -0 })).toBe('{"confidence":0}');

    // Positive zero is accepted unchanged and stays stable through a JSON
    // round trip in every state.
    states.forEach((proposedState) => {
      const output = StructuredImpactClassificationOutputSchema.parse({
        ...outputFor(proposedState),
        confidence: 0,
      });
      expect(Object.is(output.confidence, 0)).toBe(true);

      const classification = StructuredImpactClassificationSchema.parse({
        request:
          StructuredImpactClassificationRequestSchema.parse(requestFor()),
        output,
      });
      expect(Object.is(classification.output.confidence, 0)).toBe(true);
      const revived = StructuredImpactClassificationSchema.parse(
        JSON.parse(JSON.stringify(classification)),
      );
      expect(revived).toEqual(classification);
      expect(Object.is(revived.output.confidence, 0)).toBe(true);
    });
  });
});
