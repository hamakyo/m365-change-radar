import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ChangeEventSchema,
  ClassifierEvidenceRecordSchema,
  DeterministicImpactDecisionSchema,
  FactObservationSchema,
  RiskPolicySchema,
  StructuredImpactClassificationRequestSchema,
  TenantApplicabilityPolicySchema,
  TenantProfileSchema,
  createDeterministicEvidenceRecords,
  createDeterministicImpactDecision,
  createStructuredImpactClassificationRequest,
  evaluateRiskPolicy,
  evaluateTenantApplicability,
  type ChangeEvent,
  type DeterministicImpactDecision,
  type DeterministicEvidenceRecord,
  type TenantProfile,
} from '../src/index.js';

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const riskPolicy = RiskPolicySchema.parse(
  readJson(resolve(process.cwd(), 'test/fixtures/risk-policy.json')),
);
const tenantPolicy = TenantApplicabilityPolicySchema.parse(
  readJson(
    resolve(process.cwd(), 'test/fixtures/tenant-applicability-policy.json'),
  ),
);
const baseEvent = ChangeEventSchema.parse(
  readJson(resolve(process.cwd(), 'test/fixtures/change-event.json')),
);
const baseProfile = TenantProfileSchema.parse(
  readJson(resolve(process.cwd(), 'test/fixtures/tenant-profile.json')),
);

function eventWith(overrides: Record<string, unknown>): ChangeEvent {
  return ChangeEventSchema.parse({
    ...baseEvent,
    products: ['Synthetic Teams'],
    ...overrides,
  });
}

function decisionFor(
  event: ChangeEvent,
  profile: TenantProfile = baseProfile,
): DeterministicImpactDecision {
  return DeterministicImpactDecisionSchema.parse(
    createDeterministicImpactDecision(
      evaluateRiskPolicy(riskPolicy, event),
      evaluateTenantApplicability(tenantPolicy, event, profile),
    ),
  );
}

function assertRecordArray(records: DeterministicEvidenceRecord[]): void {
  const ids = new Set(records.map((record) => record.evidenceId));
  expect(ids.size).toBe(records.length);
  records.forEach((record) => {
    expect(ClassifierEvidenceRecordSchema.parse(record)).toEqual(record);
    if (record.kind === 'deterministic_conclusion') {
      record.dependsOnEvidenceIds.forEach((dependencyId) => {
        expect(ids.has(dependencyId)).toBe(true);
      });
    }
    expect(record.kind).not.toBe('ai_inference');
  });
}

function corpusChanges(): ChangeEvent[] {
  const directory = resolve(process.cwd(), 'corpus/changes');
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const fixture = readJson(join(directory, name)) as { event: unknown };
      return ChangeEventSchema.parse(fixture.event);
    });
}

function corpusProfiles(): TenantProfile[] {
  const directory = resolve(process.cwd(), 'corpus/tenant-profiles');
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const fixture = readJson(join(directory, name)) as {
        profile: unknown;
      };
      return TenantProfileSchema.parse(fixture.profile);
    });
}

const classificationEvent = eventWith({
  severity: 'low',
  signals: { ...baseEvent.signals, hasAdminImpact: false },
});
const reviewFloorEvent = eventWith({
  severity: 'high',
  signals: {
    ...baseEvent.signals,
    isMajorChange: true,
    hasAdminImpact: false,
  },
});
const classificationDecision = decisionFor(classificationEvent);
const reviewFloorDecision = decisionFor(reviewFloorEvent);
const finalProfile = TenantProfileSchema.parse({
  ...baseProfile,
  services: { ...baseProfile.services, teams: false },
});
const finalDecision = decisionFor(classificationEvent, finalProfile);

const mixedTenantPolicy = TenantApplicabilityPolicySchema.parse({
  ...tenantPolicy,
  rules: [
    ...tenantPolicy.rules,
    {
      ruleId: 'synthetic-collaboration-category',
      enabled: true,
      selector: {
        field: 'categories',
        values: ['admin-impact', 'collaboration'],
      },
      condition: {
        kind: 'all_of',
        conditions: [{ section: 'services', key: 'teams', equals: true }],
      },
    },
  ],
});

function mixedDecisionFor(
  event: ChangeEvent,
  profile: TenantProfile = baseProfile,
): DeterministicImpactDecision {
  return DeterministicImpactDecisionSchema.parse(
    createDeterministicImpactDecision(
      evaluateRiskPolicy(riskPolicy, event),
      evaluateTenantApplicability(mixedTenantPolicy, event, profile),
    ),
  );
}

describe('deterministic evidence record builder', () => {
  it('builds schema-valid provider-neutral evidence for all three decision kinds', () => {
    const cases = [
      {
        event: classificationEvent,
        profile: baseProfile,
        decision: classificationDecision,
      },
      {
        event: reviewFloorEvent,
        profile: baseProfile,
        decision: reviewFloorDecision,
      },
      {
        event: classificationEvent,
        profile: finalProfile,
        decision: finalDecision,
      },
    ];

    expect(finalDecision.kind).toBe('DETERMINISTIC_FINAL');
    cases.forEach(({ event, profile, decision }) => {
      const records = createDeterministicEvidenceRecords(
        event,
        'message-v1',
        profile,
        decision,
      );
      assertRecordArray(records);
      expect(records.map((record) => record.evidenceId).slice(0, 16)).toEqual([
        'source.event.title',
        'source.event.body',
        'source.event.publishedAt',
        'source.event.updatedAt',
        'source.event.products',
        'source.event.categories',
        'source.event.severity',
        'source.event.signals',
        'source.event.sourceMetadata',
        'tenant.profile.organization',
        'tenant.profile.services',
        'tenant.profile.environment',
        'tenant.profile.capabilities',
        'tenant.profile.ownership',
        'tenant.profile.changePolicy',
        'tenant.profile.maintenance',
      ]);
      expect(
        records.some(
          (record) =>
            record.kind === 'deterministic_conclusion' &&
            record.policyKind === 'risk_policy',
        ),
      ).toBe(true);
      expect(
        records.some(
          (record) =>
            record.kind === 'deterministic_conclusion' &&
            record.policyKind === 'tenant_applicability_policy',
        ),
      ).toBe(true);
      expect(
        records.filter(
          (record) => record.evidenceId === 'source.severity.at-least-high',
        ),
      ).toHaveLength(1);
      expect(
        records.map((record) =>
          ClassifierEvidenceRecordSchema.parse(
            JSON.parse(JSON.stringify(record)),
          ),
        ),
      ).toEqual(records);
    });
  });

  it('keeps non-final request evidence byte/deep equal to the reusable builder', () => {
    const cases = [
      { event: classificationEvent, decision: classificationDecision },
      { event: reviewFloorEvent, decision: reviewFloorDecision },
    ];

    cases.forEach(({ event, decision }) => {
      const records = createDeterministicEvidenceRecords(
        event,
        'message-v1',
        baseProfile,
        decision,
      );
      const request = createStructuredImpactClassificationRequest(
        event,
        'message-v1',
        baseProfile,
        decision,
      );
      expect(request.evidenceRecords).toEqual(records);
      expect(JSON.stringify(request.evidenceRecords)).toBe(
        JSON.stringify(records),
      );
      expect(
        StructuredImpactClassificationRequestSchema.parse(request),
      ).toEqual(request);
    });
  });

  it('builds all 500 corpus decision records without AIInference or dangling dependencies', () => {
    const changes = corpusChanges();
    const profiles = corpusProfiles();
    expect(changes).toHaveLength(50);
    expect(profiles).toHaveLength(10);

    let count = 0;
    changes.forEach((event) =>
      profiles.forEach((profile) => {
        const decision = decisionFor(event, profile);
        const records = createDeterministicEvidenceRecords(
          event,
          'message-v1',
          profile,
          decision,
        );
        assertRecordArray(records);
        count += 1;
      }),
    );
    expect(count).toBe(500);
  });

  it('is non-mutating, deterministic, and JSON-round-trippable', () => {
    const event = clone(reviewFloorEvent);
    const profile = clone(baseProfile);
    const decision = clone(reviewFloorDecision);
    const eventBefore = clone(event);
    const profileBefore = clone(profile);
    const decisionBefore = clone(decision);

    const first = createDeterministicEvidenceRecords(
      event,
      'message-v1',
      profile,
      decision,
    );
    const second = createDeterministicEvidenceRecords(
      event,
      'message-v1',
      profile,
      decision,
    );

    expect(first).toEqual(second);
    expect(event).toEqual(eventBefore);
    expect(profile).toEqual(profileBefore);
    expect(decision).toEqual(decisionBefore);
    expect(
      first.map((record) =>
        ClassifierEvidenceRecordSchema.parse(
          JSON.parse(JSON.stringify(record)),
        ),
      ),
    ).toEqual(first);
  });

  it('accepts an empty source-message version only when non-empty and keeps final request boundary separate', () => {
    expect(() =>
      createDeterministicEvidenceRecords(
        classificationEvent,
        '',
        baseProfile,
        classificationDecision,
      ),
    ).toThrow();

    const finalRecords = createDeterministicEvidenceRecords(
      classificationEvent,
      'message-v1',
      finalProfile,
      finalDecision,
    );
    expect(finalRecords.length).toBeGreaterThan(16);
    expect(() =>
      createStructuredImpactClassificationRequest(
        classificationEvent,
        'message-v1',
        finalProfile,
        finalDecision,
      ),
    ).toThrow();
  });

  it('rejects incomplete, unsafe, conflicting, or empty evaluator results', () => {
    const missingAtoms = clone(reviewFloorDecision) as unknown as {
      riskEvaluation: {
        ruleResults: Array<Record<string, unknown>>;
      };
    };
    delete missingAtoms.riskEvaluation.ruleResults[0]?.atomResults;
    expect(() =>
      createDeterministicEvidenceRecords(
        reviewFloorEvent,
        'message-v1',
        baseProfile,
        missingAtoms as unknown as DeterministicImpactDecision,
      ),
    ).toThrow(/missing atomResults/);

    const unsafePath = clone(reviewFloorDecision) as unknown as {
      riskEvaluation: {
        ruleResults: Array<Record<string, unknown>>;
      };
    };
    const unsafeAtomResults = unsafePath.riskEvaluation.ruleResults[0]
      ?.atomResults as Array<Record<string, unknown>> | undefined;
    if (unsafeAtomResults === undefined)
      throw new Error('missing atom results');
    unsafeAtomResults[0]!.field = 'metadata';
    unsafeAtomResults[0]!.path = 'sourceMetadata.foo';
    expect(() =>
      createDeterministicEvidenceRecords(
        reviewFloorEvent,
        'message-v1',
        baseProfile,
        unsafePath as unknown as DeterministicImpactDecision,
      ),
    ).toThrow(/unsupported risk atom path/);

    const conflicting = clone(reviewFloorDecision) as unknown as {
      riskEvaluation: {
        ruleResults: Array<Record<string, unknown>>;
      };
    };
    const atomResult = conflicting.riskEvaluation.ruleResults[0]
      ?.atomResults as Array<Record<string, unknown>> | undefined;
    if (atomResult === undefined) throw new Error('missing atom results');
    const secondAtomResults = conflicting.riskEvaluation.ruleResults[1]
      ?.atomResults as Array<Record<string, unknown>> | undefined;
    if (secondAtomResults === undefined)
      throw new Error('missing atom results');
    secondAtomResults[0]!.evidenceId = atomResult[0]!.evidenceId;
    secondAtomResults[0]!.field = 'severity';
    secondAtomResults[0]!.path = 'severity';
    expect(() =>
      createDeterministicEvidenceRecords(
        reviewFloorEvent,
        'message-v1',
        baseProfile,
        conflicting as unknown as DeterministicImpactDecision,
      ),
    ).toThrow(/conflicting path or observation/);

    const noRiskRules = clone(reviewFloorDecision) as unknown as {
      riskEvaluation: { ruleResults: Array<Record<string, unknown>> };
    };
    noRiskRules.riskEvaluation.ruleResults = [];
    expect(() =>
      createDeterministicEvidenceRecords(
        reviewFloorEvent,
        'message-v1',
        baseProfile,
        noRiskRules as unknown as DeterministicImpactDecision,
      ),
    ).toThrow(/state floor must include rule results/);

    const noTenantRules = clone(reviewFloorDecision) as unknown as {
      tenantApplicability: { ruleResults: Array<Record<string, unknown>> };
    };
    noTenantRules.tenantApplicability.ruleResults = [];
    expect(() =>
      createDeterministicEvidenceRecords(
        reviewFloorEvent,
        'message-v1',
        baseProfile,
        noTenantRules as unknown as DeterministicImpactDecision,
      ),
    ).toThrow();

    const multiEvent = ChangeEventSchema.parse({
      ...reviewFloorEvent,
      products: ['Synthetic Teams', 'Synthetic Exchange'],
    });
    const multiDecision = decisionFor(multiEvent);
    const mismatchedTenant = clone(multiDecision) as unknown as {
      tenantApplicability: {
        ruleResults: Array<Record<string, unknown>>;
      };
    };
    const matchedTenantRule =
      mismatchedTenant.tenantApplicability.ruleResults[0];
    if (matchedTenantRule === undefined) {
      throw new Error('missing tenant rule result');
    }
    const conditionResults = matchedTenantRule?.conditionResults as
      Array<Record<string, unknown>> | undefined;
    if (conditionResults === undefined) {
      throw new Error('missing tenant condition results');
    }
    conditionResults[0]!.observed = false;
    conditionResults[0]!.status = 'NO_MATCH';
    matchedTenantRule.conditionGroupStatus = 'NO_MATCH';
    expect(() =>
      createDeterministicEvidenceRecords(
        multiEvent,
        'message-v1',
        baseProfile,
        mismatchedTenant as unknown as DeterministicImpactDecision,
      ),
    ).toThrow(/does not match the tenant profile/);
  });

  it('rejects duplicate global IDs and keeps present-null distinct from absent observations', () => {
    const duplicateId = clone(reviewFloorDecision) as unknown as {
      riskEvaluation: {
        ruleResults: Array<Record<string, unknown>>;
      };
    };
    const atoms = duplicateId.riskEvaluation.ruleResults[0]?.atomResults as
      Array<Record<string, unknown>> | undefined;
    if (atoms === undefined) throw new Error('missing atom results');
    atoms[0]!.evidenceId = 'source.event.title';
    expect(() =>
      createDeterministicEvidenceRecords(
        reviewFloorEvent,
        'message-v1',
        baseProfile,
        duplicateId as unknown as DeterministicImpactDecision,
      ),
    ).toThrow(/duplicate evidence ID/);

    const present = FactObservationSchema.parse({
      presence: 'present',
      value: null,
    });
    const absent = FactObservationSchema.parse({ presence: 'absent' });
    expect(present).not.toEqual(absent);
    expect(JSON.stringify(present)).not.toBe(JSON.stringify(absent));
  });

  it('recomputes selector matches and mapping gaps from products and categories', () => {
    const mixedEvent = ChangeEventSchema.parse({
      ...baseEvent,
      products: ['Synthetic Teams', 'Synthetic Exchange'],
      categories: ['collaboration', 'admin-impact'],
      severity: 'low',
      signals: { ...baseEvent.signals, hasAdminImpact: false },
    });
    const mixedDecision = mixedDecisionFor(mixedEvent);
    expect(mixedDecision.tenantApplicability.status).toBe('APPLICABLE');
    const mixedRecords = createDeterministicEvidenceRecords(
      mixedEvent,
      'message-v1',
      baseProfile,
      mixedDecision,
    );
    expect(mixedRecords.length).toBeGreaterThan(16);

    const categoryRule = mixedDecision.tenantApplicability.ruleResults.find(
      (result) => result.ruleId === 'synthetic-collaboration-category',
    );
    if (categoryRule === undefined || categoryRule.selectorStatus !== 'MATCH') {
      throw new Error('missing category selector match');
    }
    expect(categoryRule.matchedValues).toEqual([
      'admin-impact',
      'collaboration',
    ]);

    const reversedMatchedValues = clone(mixedDecision) as unknown as {
      tenantApplicability: {
        ruleResults: Array<Record<string, unknown>>;
      };
    };
    const reversedCategoryRule =
      reversedMatchedValues.tenantApplicability.ruleResults.find(
        (result) => result.ruleId === 'synthetic-collaboration-category',
      );
    if (reversedCategoryRule === undefined) {
      throw new Error('missing category selector result');
    }
    (reversedCategoryRule.matchedValues as string[]).reverse();
    expect(() =>
      createDeterministicEvidenceRecords(
        mixedEvent,
        'message-v1',
        baseProfile,
        reversedMatchedValues as unknown as DeterministicImpactDecision,
      ),
    ).toThrow(/matchedValues/);

    const categoryOnlyEvent = ChangeEventSchema.parse({
      ...mixedEvent,
      categories: ['collaboration'],
    });
    const categoryOnlyDecision = mixedDecisionFor(categoryOnlyEvent);
    const missingMatchedValue = clone(categoryOnlyDecision) as unknown as {
      tenantApplicability: {
        ruleResults: Array<Record<string, unknown>>;
      };
    };
    const categoryOnlyRule =
      missingMatchedValue.tenantApplicability.ruleResults.find(
        (result) => result.ruleId === 'synthetic-collaboration-category',
      );
    if (categoryOnlyRule === undefined) {
      throw new Error('missing category selector result');
    }
    categoryOnlyRule.matchedValues = ['admin-impact'];
    expect(() =>
      createDeterministicEvidenceRecords(
        categoryOnlyEvent,
        'message-v1',
        baseProfile,
        missingMatchedValue as unknown as DeterministicImpactDecision,
      ),
    ).toThrow(/matchedValues/);

    const wrongSelectorField = clone(mixedDecision) as unknown as {
      tenantApplicability: {
        ruleResults: Array<Record<string, unknown>>;
      };
    };
    const productRule = wrongSelectorField.tenantApplicability.ruleResults[0];
    if (productRule === undefined) throw new Error('missing product selector');
    productRule.field = 'categories';
    expect(() =>
      createDeterministicEvidenceRecords(
        mixedEvent,
        'message-v1',
        baseProfile,
        wrongSelectorField as unknown as DeterministicImpactDecision,
      ),
    ).toThrow(/selector status/);

    const withGaps = ChangeEventSchema.parse({
      ...mixedEvent,
      products: ['Synthetic Teams', 'null'],
      categories: ['collaboration', 'null'],
    });
    const gapDecision = mixedDecisionFor(withGaps);
    if (gapDecision.tenantApplicability.status !== 'APPLICABLE') {
      throw new Error('expected applicable mapping warnings');
    }
    expect(gapDecision.tenantApplicability.mappingWarnings).toEqual([
      { field: 'products', value: 'null' },
      { field: 'categories', value: 'null' },
    ]);
    createDeterministicEvidenceRecords(
      withGaps,
      'message-v1',
      baseProfile,
      gapDecision,
    );

    const missingWarnings = clone(gapDecision) as unknown as {
      tenantApplicability: {
        mappingWarnings?: Array<{
          field: 'products' | 'categories';
          value: string | null;
        }>;
      };
    };
    delete missingWarnings.tenantApplicability.mappingWarnings;
    expect(() =>
      createDeterministicEvidenceRecords(
        withGaps,
        'message-v1',
        baseProfile,
        missingWarnings as unknown as DeterministicImpactDecision,
      ),
    ).toThrow(/mappingWarnings/);
    expect(() =>
      createStructuredImpactClassificationRequest(
        withGaps,
        'message-v1',
        baseProfile,
        missingWarnings as unknown as DeterministicImpactDecision,
      ),
    ).toThrow(/mappingWarnings/);

    const extraWarning = clone(gapDecision) as unknown as {
      tenantApplicability: {
        mappingWarnings: Array<{
          field: 'products' | 'categories';
          value: string | null;
        }>;
      };
    };
    extraWarning.tenantApplicability.mappingWarnings.push({
      field: 'products',
      value: 'extra',
    });
    expect(() =>
      createDeterministicEvidenceRecords(
        withGaps,
        'message-v1',
        baseProfile,
        extraWarning as unknown as DeterministicImpactDecision,
      ),
    ).toThrow(/mappingWarnings/);

    const reversedWarnings = clone(gapDecision) as unknown as {
      tenantApplicability: {
        mappingWarnings: Array<{
          field: 'products' | 'categories';
          value: string | null;
        }>;
      };
    };
    reversedWarnings.tenantApplicability.mappingWarnings.reverse();
    expect(() =>
      createDeterministicEvidenceRecords(
        withGaps,
        'message-v1',
        baseProfile,
        reversedWarnings as unknown as DeterministicImpactDecision,
      ),
    ).toThrow(/mappingWarnings/);

    const emptyProducts = ChangeEventSchema.parse({
      ...mixedEvent,
      products: [],
      categories: ['collaboration'],
    });
    const emptyDecision = mixedDecisionFor(emptyProducts);
    if (emptyDecision.tenantApplicability.status !== 'APPLICABLE') {
      throw new Error('expected category applicability for empty products');
    }
    expect(emptyDecision.tenantApplicability.mappingWarnings).toEqual([
      { field: 'products', value: null },
    ]);
    createDeterministicEvidenceRecords(
      emptyProducts,
      'message-v1',
      baseProfile,
      emptyDecision,
    );

    const duplicateValues = ChangeEventSchema.parse({
      ...mixedEvent,
      products: ['Synthetic Teams', 'Synthetic Teams', 'null', 'null'],
      categories: ['collaboration', 'collaboration', 'null'],
    });
    const duplicateDecision = mixedDecisionFor(duplicateValues);
    if (duplicateDecision.tenantApplicability.status !== 'APPLICABLE') {
      throw new Error(
        'expected duplicate selector values to remain applicable',
      );
    }
    expect(duplicateDecision.tenantApplicability.mappingWarnings).toEqual([
      { field: 'products', value: 'null' },
      { field: 'categories', value: 'null' },
    ]);
    const duplicateProductRule =
      duplicateDecision.tenantApplicability.ruleResults.find(
        (result) => result.ruleId === 'synthetic-teams',
      );
    if (
      duplicateProductRule === undefined ||
      duplicateProductRule.selectorStatus !== 'MATCH'
    ) {
      throw new Error('missing duplicate product selector match');
    }
    expect(duplicateProductRule.matchedValues).toEqual(['Synthetic Teams']);
    const duplicateRecords = createDeterministicEvidenceRecords(
      duplicateValues,
      'message-v1',
      baseProfile,
      duplicateDecision,
    );
    expect(duplicateRecords.length).toBeGreaterThan(16);
  });

  it('requires exact missingMappings for insufficient context and no gaps for NOT_APPLICABLE', () => {
    const missingProfile = TenantProfileSchema.parse({
      ...baseProfile,
      services: Object.fromEntries(
        Object.entries(baseProfile.services).filter(([key]) => key !== 'teams'),
      ),
    });
    const event = ChangeEventSchema.parse({
      ...baseEvent,
      products: ['Synthetic Teams', 'null'],
      categories: ['collaboration', 'null'],
      severity: 'low',
      signals: { ...baseEvent.signals, hasAdminImpact: false },
    });
    const insufficientDecision = mixedDecisionFor(event, missingProfile);
    expect(insufficientDecision.tenantApplicability.status).toBe(
      'INSUFFICIENT_CONTEXT',
    );
    if (
      insufficientDecision.tenantApplicability.status !== 'INSUFFICIENT_CONTEXT'
    ) {
      throw new Error('expected insufficient context');
    }
    expect(insufficientDecision.tenantApplicability.missingMappings).toEqual([
      { field: 'products', value: 'null' },
      { field: 'categories', value: 'null' },
    ]);
    createDeterministicEvidenceRecords(
      event,
      'message-v1',
      missingProfile,
      insufficientDecision,
    );

    const missingMapping = clone(insufficientDecision) as unknown as {
      tenantApplicability: {
        missingMappings?: Array<{
          field: 'products' | 'categories';
          value: string | null;
        }>;
      };
    };
    delete missingMapping.tenantApplicability.missingMappings;
    expect(() =>
      createDeterministicEvidenceRecords(
        event,
        'message-v1',
        missingProfile,
        missingMapping as unknown as DeterministicImpactDecision,
      ),
    ).toThrow(/missingMappings/);

    const extraMapping = clone(insufficientDecision) as unknown as {
      tenantApplicability: {
        missingMappings: Array<{
          field: 'products' | 'categories';
          value: string | null;
        }>;
      };
    };
    extraMapping.tenantApplicability.missingMappings.push({
      field: 'products',
      value: 'extra',
    });
    expect(() =>
      createDeterministicEvidenceRecords(
        event,
        'message-v1',
        missingProfile,
        extraMapping as unknown as DeterministicImpactDecision,
      ),
    ).toThrow(/missingMappings/);

    const reversedMapping = clone(insufficientDecision) as unknown as {
      tenantApplicability: {
        missingMappings: Array<{
          field: 'products' | 'categories';
          value: string | null;
        }>;
      };
    };
    reversedMapping.tenantApplicability.missingMappings.reverse();
    expect(() =>
      createDeterministicEvidenceRecords(
        event,
        'message-v1',
        missingProfile,
        reversedMapping as unknown as DeterministicImpactDecision,
      ),
    ).toThrow(/missingMappings/);

    const notApplicableEvent = ChangeEventSchema.parse({
      ...baseEvent,
      products: ['Synthetic Teams'],
      categories: ['collaboration'],
    });
    const notApplicableProfile = TenantProfileSchema.parse({
      ...baseProfile,
      services: { ...baseProfile.services, teams: false },
    });
    const notApplicableDecision = mixedDecisionFor(
      notApplicableEvent,
      notApplicableProfile,
    );
    expect(notApplicableDecision.tenantApplicability.status).toBe(
      'NOT_APPLICABLE',
    );
    createDeterministicEvidenceRecords(
      notApplicableEvent,
      'message-v1',
      notApplicableProfile,
      notApplicableDecision,
    );

    const notApplicableWithGapEvent = ChangeEventSchema.parse({
      ...notApplicableEvent,
      products: ['Synthetic Teams', 'unmapped'],
    });
    expect(() =>
      createDeterministicEvidenceRecords(
        notApplicableWithGapEvent,
        'message-v1',
        notApplicableProfile,
        notApplicableDecision,
      ),
    ).toThrow(/NOT_APPLICABLE/);
  });
});
