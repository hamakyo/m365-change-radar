import { describe, expect, it } from 'vitest';

import {
  TenantApplicabilityConditionResultSchema,
  TenantApplicabilityConditionSchema,
  TenantApplicabilityEventSelectorSchema,
  TenantApplicabilityMappingGapSchema,
  TenantApplicabilityPolicySchema,
  TenantApplicabilityResultSchema,
  TenantApplicabilityRuleResultSchema,
  TenantApplicabilityStatusSchema,
  TenantContextConditionSchema,
  TenantContextConditionStatusSchema,
} from '../src/index.js';

const baseRule = {
  ruleId: 'teams-enabled',
  enabled: true,
  selector: {
    field: 'products' as const,
    values: ['Microsoft Teams'],
  },
  condition: {
    kind: 'all_of' as const,
    conditions: [
      {
        section: 'services' as const,
        key: 'teams',
        equals: true,
      },
    ],
  },
};

const basePolicy = {
  policyId: 'tenant-applicability-default',
  policyRulesVersion: 'tenant-policy-2026-08',
  description: 'Applicability rules for normalized Microsoft 365 events.',
  rules: [baseRule],
};

const matchingConditionResult = {
  status: 'MATCH' as const,
  section: 'services' as const,
  key: 'teams',
  expected: true,
  observed: true,
  path: 'services.teams',
  reason: 'services.teams is true and matches true.',
};

const noMatchConditionResult = {
  ...matchingConditionResult,
  status: 'NO_MATCH' as const,
  key: 'intune',
  observed: false,
  path: 'services.intune',
  reason: 'services.intune is explicitly false.',
};

const unknownConditionResult = {
  status: 'UNKNOWN' as const,
  section: 'capabilities' as const,
  key: 'viva',
  expected: true,
  observed: null,
  path: 'capabilities.viva',
  reason: 'capabilities.viva is absent from the profile.',
};

const matchingRuleResult = {
  selectorStatus: 'MATCH' as const,
  ruleId: 'teams-enabled',
  field: 'products' as const,
  configuredValues: ['Microsoft Teams'],
  matchedValues: ['Microsoft Teams'],
  reason: 'The event selected the enabled tenant rule.',
  conditionGroupKind: 'all_of' as const,
  conditionGroupStatus: 'MATCH' as const,
  conditionResults: [matchingConditionResult],
};

const noMatchRuleResult = {
  selectorStatus: 'NO_MATCH' as const,
  ruleId: 'teams-enabled',
  field: 'products' as const,
  configuredValues: ['Microsoft Teams'],
  matchedValues: [],
  reason: 'The event has no configured product value.',
};

const otherNoMatchRuleResult = {
  ...noMatchRuleResult,
  ruleId: 'viva-enabled',
};

describe('TenantContextCondition', () => {
  it('accepts only the three inspectable TenantProfile sections', () => {
    for (const section of [
      'services',
      'environment',
      'capabilities',
    ] as const) {
      expect(
        TenantContextConditionSchema.parse({
          section,
          key: 'teams',
          equals: true,
        }),
      ).toEqual({ section, key: 'teams', equals: true });
    }

    for (const section of [
      'organization',
      'ownership',
      'changePolicy',
      'maintenance',
    ]) {
      expect(
        TenantContextConditionSchema.safeParse({
          section,
          key: 'teams',
          equals: true,
        }).success,
      ).toBe(false);
    }
  });

  it('requires a non-empty key and a boolean expectation', () => {
    expect(
      TenantContextConditionSchema.safeParse({
        section: 'services',
        key: '',
        equals: true,
      }).success,
    ).toBe(false);
    expect(
      TenantContextConditionSchema.safeParse({
        section: 'services',
        key: 'teams',
        equals: 'true',
      }).success,
    ).toBe(false);
    expect(
      TenantContextConditionSchema.safeParse({
        section: 'services',
        key: 'teams',
        equals: true,
        path: 'sourceMetadata.services.teams',
      }).success,
    ).toBe(false);
  });
});

describe('TenantApplicabilityEventSelector', () => {
  it('accepts products and categories as exact-match selector variants', () => {
    const products = TenantApplicabilityEventSelectorSchema.parse({
      field: 'products',
      values: ['Microsoft Teams', 'Microsoft Viva'],
    });
    const categories = TenantApplicabilityEventSelectorSchema.parse({
      field: 'categories',
      values: ['retirement'],
    });

    expect(products).toEqual({
      field: 'products',
      values: ['Microsoft Teams', 'Microsoft Viva'],
    });
    expect(categories).toEqual({
      field: 'categories',
      values: ['retirement'],
    });
    expect(
      TenantApplicabilityEventSelectorSchema.parse(
        JSON.parse(JSON.stringify(products)),
      ),
    ).toEqual(products);
  });

  it('bounds labels to one through eight unique non-empty strings', () => {
    const selector = (values: unknown) =>
      TenantApplicabilityEventSelectorSchema.safeParse({
        field: 'products',
        values,
      }).success;

    expect(selector([])).toBe(false);
    expect(
      selector(Array.from({ length: 9 }, (_, index) => `p-${index}`)),
    ).toBe(false);
    expect(selector([''])).toBe(false);
    expect(selector(['teams', 1])).toBe(false);
    expect(selector(['teams', 'teams'])).toBe(false);
    expect(selector(['teams'])).toBe(true);
  });

  it('rejects provider/source expressions and unsupported selector fields', () => {
    for (const selector of [
      { field: 'sourceMetadata', values: ['teams'] },
      { field: 'providerPath', values: ['$.resource.service'] },
      { field: 'products', regex: 'teams', values: ['teams'] },
      { field: 'products', code: 'return true', values: ['teams'] },
      { field: 'products', values: ['teams'], sourceMetadata: 'x' },
    ]) {
      expect(
        TenantApplicabilityEventSelectorSchema.safeParse(selector).success,
      ).toBe(false);
    }
  });
});

describe('TenantApplicabilityPolicy', () => {
  it('parses a policy and preserves its JSON representation', () => {
    const parsed = TenantApplicabilityPolicySchema.parse(basePolicy);

    expect(parsed.rules[0]?.selector.field).toBe('products');
    expect(
      TenantApplicabilityPolicySchema.parse(JSON.parse(JSON.stringify(parsed))),
    ).toEqual(parsed);
  });

  it('supports bounded all_of/any_of groups without recursive expressions', () => {
    expect(
      TenantApplicabilityConditionSchema.parse({
        kind: 'any_of',
        conditions: Array.from({ length: 8 }, (_, index) => ({
          section: 'capabilities',
          key: `capability-${index}`,
          equals: false,
        })),
      }),
    ).toMatchObject({ kind: 'any_of' });

    expect(
      TenantApplicabilityConditionSchema.safeParse({
        kind: 'all_of',
        conditions: [],
      }).success,
    ).toBe(false);
    expect(
      TenantApplicabilityConditionSchema.safeParse({
        kind: 'any_of',
        conditions: Array.from({ length: 9 }, () => ({
          section: 'services',
          key: 'teams',
          equals: true,
        })),
      }).success,
    ).toBe(false);
    expect(
      TenantApplicabilityConditionSchema.safeParse({
        kind: 'all_of',
        conditions: [
          {
            kind: 'any_of',
            conditions: [{ section: 'services', key: 'teams', equals: true }],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('accepts multiple distinct tenant paths in each group kind', () => {
    for (const kind of ['all_of', 'any_of'] as const) {
      expect(
        TenantApplicabilityPolicySchema.safeParse({
          ...basePolicy,
          rules: [
            {
              ...baseRule,
              condition: {
                kind,
                conditions: [
                  {
                    section: 'services' as const,
                    key: 'teams',
                    equals: true,
                  },
                  {
                    section: 'capabilities' as const,
                    key: 'viva',
                    equals: false,
                  },
                ],
              },
            },
          ],
        }).success,
      ).toBe(true);
    }
  });

  it('rejects duplicate tenant paths regardless of expected boolean', () => {
    for (const kind of ['all_of', 'any_of'] as const) {
      for (const equals of [
        [true, true],
        [true, false],
      ] as const) {
        expect(
          TenantApplicabilityPolicySchema.safeParse({
            ...basePolicy,
            rules: [
              {
                ...baseRule,
                condition: {
                  kind,
                  conditions: [
                    {
                      section: 'services' as const,
                      key: 'teams',
                      equals: equals[0],
                    },
                    {
                      section: 'services' as const,
                      key: 'teams',
                      equals: equals[1],
                    },
                  ],
                },
              },
            ],
          }).success,
        ).toBe(false);
      }
    }
  });

  it('requires policy metadata, an enabled flag, and unique rule IDs', () => {
    expect(
      TenantApplicabilityPolicySchema.safeParse({
        ...basePolicy,
        rules: [],
      }).success,
    ).toBe(false);
    expect(
      TenantApplicabilityPolicySchema.safeParse({
        ...basePolicy,
        rules: [baseRule, { ...baseRule }],
      }).success,
    ).toBe(false);
    expect(
      TenantApplicabilityPolicySchema.safeParse({
        ...basePolicy,
        rules: [{ ...baseRule, enabled: undefined }],
      }).success,
    ).toBe(false);
    expect(
      TenantApplicabilityPolicySchema.safeParse({
        ...basePolicy,
        policyRulesVersion: '',
      }).success,
    ).toBe(false);
  });

  it('allows disabled rules when at least one rule remains enabled', () => {
    const parsed = TenantApplicabilityPolicySchema.parse({
      ...basePolicy,
      rules: [
        baseRule,
        { ...baseRule, ruleId: 'disabled-rule', enabled: false },
      ],
    });

    expect(parsed.rules[1]?.enabled).toBe(false);
    expect(
      TenantApplicabilityPolicySchema.safeParse({
        ...basePolicy,
        rules: [{ ...baseRule, enabled: false }],
      }).success,
    ).toBe(false);
  });
});

describe('TenantApplicabilityConditionResult', () => {
  it('keeps false and absent values distinct and ties path to section/key', () => {
    const noMatch = TenantApplicabilityConditionResultSchema.parse({
      ...matchingConditionResult,
      status: 'NO_MATCH',
      observed: false,
      reason: 'services.teams is explicitly false.',
    });
    const unknown = TenantApplicabilityConditionResultSchema.parse({
      ...matchingConditionResult,
      status: 'UNKNOWN',
      observed: null,
      reason: 'services.teams is absent from the profile.',
    });

    expect(noMatch.observed).toBe(false);
    expect(noMatch.status).toBe('NO_MATCH');
    expect(unknown.observed).toBeNull();
    expect(unknown.status).toBe('UNKNOWN');
    expect(
      TenantApplicabilityConditionResultSchema.safeParse({
        ...matchingConditionResult,
        path: 'services.intune',
      }).success,
    ).toBe(false);
    expect(
      TenantApplicabilityConditionResultSchema.safeParse({
        ...matchingConditionResult,
        status: 'UNKNOWN',
        observed: false,
      }).success,
    ).toBe(false);
    expect(
      TenantApplicabilityConditionResultSchema.safeParse({
        ...matchingConditionResult,
        status: 'MATCH',
        observed: false,
      }).success,
    ).toBe(false);
    expect(
      TenantApplicabilityConditionResultSchema.safeParse({
        ...matchingConditionResult,
        status: 'NO_MATCH',
        observed: true,
      }).success,
    ).toBe(false);
  });
});

describe('TenantApplicabilityRuleResult', () => {
  it('separates selector NO_MATCH from selector MATCH condition results', () => {
    expect(
      TenantApplicabilityRuleResultSchema.parse(matchingRuleResult),
    ).toEqual(matchingRuleResult);
    expect(
      TenantApplicabilityRuleResultSchema.parse(noMatchRuleResult),
    ).toEqual(noMatchRuleResult);
    expect(
      TenantApplicabilityRuleResultSchema.safeParse({
        ...noMatchRuleResult,
        conditionResults: [matchingConditionResult],
      }).success,
    ).toBe(false);
    expect(
      TenantApplicabilityRuleResultSchema.safeParse({
        ...matchingRuleResult,
        matchedValues: [],
      }).success,
    ).toBe(false);
    expect(
      TenantApplicabilityRuleResultSchema.safeParse({
        ...matchingRuleResult,
        matchedValues: ['Unknown product'],
      }).success,
    ).toBe(false);
  });

  it('rejects duplicate configured or matched values', () => {
    expect(
      TenantApplicabilityRuleResultSchema.safeParse({
        ...matchingRuleResult,
        configuredValues: ['Microsoft Teams', 'Microsoft Teams'],
      }).success,
    ).toBe(false);
    expect(
      TenantApplicabilityRuleResultSchema.safeParse({
        ...matchingRuleResult,
        matchedValues: ['Microsoft Teams', 'Microsoft Teams'],
      }).success,
    ).toBe(false);
  });

  it('validates the group-level tri-state result for bounded all_of/any_of', () => {
    const anyOfUnknown = {
      ...matchingRuleResult,
      conditionGroupKind: 'any_of' as const,
      conditionGroupStatus: 'UNKNOWN' as const,
      conditionResults: [unknownConditionResult],
    };

    expect(TenantApplicabilityRuleResultSchema.parse(anyOfUnknown)).toEqual(
      anyOfUnknown,
    );
    expect(
      TenantApplicabilityRuleResultSchema.safeParse({
        ...anyOfUnknown,
        conditionGroupStatus: 'MATCH',
      }).success,
    ).toBe(false);
  });
});

describe('TenantApplicabilityResult', () => {
  it('exposes only the three applicability states', () => {
    expect(TenantContextConditionStatusSchema.options).toEqual([
      'MATCH',
      'NO_MATCH',
      'UNKNOWN',
    ]);
    expect(TenantApplicabilityStatusSchema.options).toEqual([
      'APPLICABLE',
      'NOT_APPLICABLE',
      'INSUFFICIENT_CONTEXT',
    ]);
  });

  it('requires a matching selector and matching condition for APPLICABLE', () => {
    const result = TenantApplicabilityResultSchema.parse({
      policyRulesVersion: basePolicy.policyRulesVersion,
      status: 'APPLICABLE',
      ruleResults: [matchingRuleResult, otherNoMatchRuleResult],
      reason: 'The tenant has the selected service enabled.',
      evidence: ['services.teams'],
    });

    expect(result.status).toBe('APPLICABLE');
    expect(
      TenantApplicabilityResultSchema.safeParse({
        ...result,
        ruleResults: [noMatchRuleResult],
      }).success,
    ).toBe(false);
    expect(
      TenantApplicabilityResultSchema.safeParse({
        ...result,
        ruleResults: [
          {
            ...matchingRuleResult,
            conditionResults: [
              {
                ...matchingConditionResult,
                status: 'NO_MATCH',
                observed: false,
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      TenantApplicabilityResultSchema.safeParse({
        policyRulesVersion: basePolicy.policyRulesVersion,
        status: 'NOT_APPLICABLE',
        ruleResults: [noMatchRuleResult],
        reason: 'An unmapped product must not be treated as confirmed absence.',
        evidence: ['services.teams'],
        missingMappings: [
          { field: 'products' as const, value: 'Unknown product' },
        ],
      }).success,
    ).toBe(false);
    expect(
      TenantApplicabilityResultSchema.safeParse({
        ...result,
        evidence: ['services.intune'],
      }).success,
    ).toBe(false);
    expect(
      TenantApplicabilityResultSchema.safeParse({
        ...result,
        ruleResults: [
          {
            ...matchingRuleResult,
            conditionGroupKind: 'any_of' as const,
            conditionGroupStatus: 'MATCH' as const,
            conditionResults: [matchingConditionResult, unknownConditionResult],
          },
        ],
        evidence: ['capabilities.viva'],
      }).success,
    ).toBe(false);
  });

  it('requires a selector MATCH rule with a confirmed NO_MATCH group for NOT_APPLICABLE', () => {
    const selectedButNotApplicable = {
      ...matchingRuleResult,
      conditionGroupStatus: 'NO_MATCH' as const,
      conditionResults: [noMatchConditionResult, matchingConditionResult],
    };
    const result = TenantApplicabilityResultSchema.parse({
      policyRulesVersion: basePolicy.policyRulesVersion,
      status: 'NOT_APPLICABLE',
      ruleResults: [otherNoMatchRuleResult, selectedButNotApplicable],
      reason: 'The selected rule does not apply to this tenant.',
      evidence: ['services.intune'],
    });

    expect(result.status).toBe('NOT_APPLICABLE');
    expect(
      TenantApplicabilityResultSchema.safeParse({
        ...result,
        ruleResults: [noMatchRuleResult],
      }).success,
    ).toBe(false);
    expect(
      TenantApplicabilityResultSchema.safeParse({
        ...result,
        ruleResults: [matchingRuleResult],
      }).success,
    ).toBe(false);
    expect(
      TenantApplicabilityResultSchema.safeParse({
        ...result,
        ruleResults: [
          {
            ...selectedButNotApplicable,
            conditionResults: [noMatchConditionResult, unknownConditionResult],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      TenantApplicabilityResultSchema.safeParse({
        ...result,
        evidence: ['services.teams'],
      }).success,
    ).toBe(false);

    const anyOfNotApplicable = {
      ...selectedButNotApplicable,
      conditionGroupKind: 'any_of' as const,
      conditionResults: [noMatchConditionResult],
    };
    expect(
      TenantApplicabilityResultSchema.parse({
        policyRulesVersion: basePolicy.policyRulesVersion,
        status: 'NOT_APPLICABLE',
        ruleResults: [anyOfNotApplicable],
        reason: 'Every condition in the any_of group is a confirmed no-match.',
        evidence: ['services.intune'],
      }).status,
    ).toBe('NOT_APPLICABLE');
  });

  it('uses mutually exclusive final status precedence', () => {
    const anyOfMatchUnknown = {
      ...matchingRuleResult,
      ruleId: 'teams-or-viva',
      conditionGroupKind: 'any_of' as const,
      conditionGroupStatus: 'MATCH' as const,
      conditionResults: [matchingConditionResult, unknownConditionResult],
    };
    const unknownRule = {
      ...matchingRuleResult,
      ruleId: 'viva-context',
      conditionGroupKind: 'all_of' as const,
      conditionGroupStatus: 'UNKNOWN' as const,
      conditionResults: [unknownConditionResult],
    };

    const anyOfApplicable = TenantApplicabilityResultSchema.parse({
      policyRulesVersion: basePolicy.policyRulesVersion,
      status: 'APPLICABLE',
      ruleResults: [anyOfMatchUnknown],
      reason: 'A matching condition is sufficient for applicability.',
      evidence: ['services.teams'],
    });
    expect(anyOfApplicable.status).toBe('APPLICABLE');
    const anyOfMatchNoMatch = {
      ...matchingRuleResult,
      ruleId: 'teams-or-intune',
      conditionGroupKind: 'any_of' as const,
      conditionGroupStatus: 'MATCH' as const,
      conditionResults: [matchingConditionResult, noMatchConditionResult],
    };
    expect(
      TenantApplicabilityResultSchema.safeParse({
        policyRulesVersion: basePolicy.policyRulesVersion,
        status: 'APPLICABLE',
        ruleResults: [anyOfMatchNoMatch],
        reason: 'The matching condition establishes applicability.',
        evidence: ['services.intune'],
      }).success,
    ).toBe(false);
    expect(
      TenantApplicabilityResultSchema.safeParse({
        policyRulesVersion: basePolicy.policyRulesVersion,
        status: 'INSUFFICIENT_CONTEXT',
        ruleResults: [anyOfMatchUnknown],
        reason: 'The UNKNOWN branch cannot override a matching any_of branch.',
        missingContext: ['capabilities.viva'],
      }).success,
    ).toBe(false);

    const separateMatchAndUnknown = TenantApplicabilityResultSchema.parse({
      policyRulesVersion: basePolicy.policyRulesVersion,
      status: 'APPLICABLE',
      ruleResults: [matchingRuleResult, unknownRule],
      reason:
        'A known matching rule wins over another rule with unknown context.',
      evidence: ['services.teams'],
    });
    expect(separateMatchAndUnknown.status).toBe('APPLICABLE');
    expect(
      TenantApplicabilityResultSchema.safeParse({
        policyRulesVersion: basePolicy.policyRulesVersion,
        status: 'INSUFFICIENT_CONTEXT',
        ruleResults: [matchingRuleResult, unknownRule],
        reason: 'The matching rule prevents an insufficient final status.',
        missingContext: ['capabilities.viva'],
      }).success,
    ).toBe(false);

    const mappingWarning = TenantApplicabilityResultSchema.parse({
      policyRulesVersion: basePolicy.policyRulesVersion,
      status: 'APPLICABLE',
      ruleResults: [matchingRuleResult],
      reason:
        'The known matching rule is applicable; the gap is retained as a warning.',
      evidence: ['services.teams'],
      mappingWarnings: [
        { field: 'products' as const, value: 'Unmapped product' },
      ],
    });
    if (mappingWarning.status !== 'APPLICABLE') {
      throw new Error('expected applicable result with mapping warning');
    }
    expect(mappingWarning.mappingWarnings).toEqual([
      { field: 'products', value: 'Unmapped product' },
    ]);
    expect(
      TenantApplicabilityResultSchema.parse(
        JSON.parse(JSON.stringify(mappingWarning)),
      ),
    ).toEqual(mappingWarning);
    expect(
      TenantApplicabilityResultSchema.safeParse({
        policyRulesVersion: basePolicy.policyRulesVersion,
        status: 'INSUFFICIENT_CONTEXT',
        ruleResults: [matchingRuleResult],
        reason: 'A known matching rule cannot be downgraded by a gap.',
        missingMappings: [
          { field: 'products' as const, value: 'Unmapped product' },
        ],
      }).success,
    ).toBe(false);
  });

  it('represents tenant missing context and mapping gaps separately', () => {
    const tenantMissing = TenantApplicabilityResultSchema.parse({
      policyRulesVersion: basePolicy.policyRulesVersion,
      status: 'INSUFFICIENT_CONTEXT',
      ruleResults: [
        {
          ...matchingRuleResult,
          conditionGroupStatus: 'UNKNOWN' as const,
          conditionResults: [
            {
              ...matchingConditionResult,
              status: 'UNKNOWN',
              observed: null,
              reason: 'services.teams is absent from the profile.',
            },
          ],
        },
      ],
      reason: 'A required tenant profile key is absent.',
      missingContext: ['services.teams'],
    });
    const mappingMissing = TenantApplicabilityResultSchema.parse({
      policyRulesVersion: basePolicy.policyRulesVersion,
      status: 'INSUFFICIENT_CONTEXT',
      ruleResults: [noMatchRuleResult],
      reason: 'The event product has no policy mapping.',
      missingMappings: [{ field: 'products', value: 'Unknown product' }],
    });

    expect(tenantMissing.status).toBe('INSUFFICIENT_CONTEXT');
    expect(mappingMissing.status).toBe('INSUFFICIENT_CONTEXT');
    if (tenantMissing.status !== 'INSUFFICIENT_CONTEXT') {
      throw new Error('expected tenant missing result');
    }
    if (mappingMissing.status !== 'INSUFFICIENT_CONTEXT') {
      throw new Error('expected mapping missing result');
    }
    expect(tenantMissing.missingContext).toEqual(['services.teams']);
    expect(mappingMissing.missingMappings).toEqual([
      { field: 'products', value: 'Unknown product' },
    ]);
    expect(tenantMissing).toMatchObject({
      ruleResults: [
        { selectorStatus: 'MATCH', conditionGroupStatus: 'UNKNOWN' },
      ],
    });
    expect(
      TenantApplicabilityResultSchema.safeParse({
        ...tenantMissing,
        missingContext: ['services.intune'],
      }).success,
    ).toBe(false);
    expect(
      TenantApplicabilityResultSchema.parse(
        JSON.parse(JSON.stringify(tenantMissing)),
      ),
    ).toEqual(tenantMissing);
    expect(
      TenantApplicabilityResultSchema.parse(
        JSON.parse(JSON.stringify(mappingMissing)),
      ),
    ).toEqual(mappingMissing);
    expect(
      TenantApplicabilityMappingGapSchema.safeParse({
        field: 'ownership',
        value: 'owner-team',
      }).success,
    ).toBe(false);
  });

  it('distinguishes an empty selector array from the literal string null', () => {
    const emptyProducts = { field: 'products' as const, value: null };
    const literalNullProducts = {
      field: 'products' as const,
      value: 'null',
    };

    expect(TenantApplicabilityMappingGapSchema.parse(emptyProducts)).toEqual(
      emptyProducts,
    );
    expect(
      TenantApplicabilityMappingGapSchema.parse(literalNullProducts),
    ).toEqual(literalNullProducts);
    expect(
      TenantApplicabilityMappingGapSchema.safeParse({
        field: 'products',
        value: '',
      }).success,
    ).toBe(false);

    const result = TenantApplicabilityResultSchema.parse({
      policyRulesVersion: basePolicy.policyRulesVersion,
      status: 'INSUFFICIENT_CONTEXT',
      ruleResults: [noMatchRuleResult],
      reason: 'The products event array is empty.',
      missingMappings: [emptyProducts, literalNullProducts],
    });

    expect(
      TenantApplicabilityResultSchema.parse(JSON.parse(JSON.stringify(result))),
    ).toEqual(result);
    expect(
      TenantApplicabilityResultSchema.safeParse({
        ...result,
        missingMappings: [emptyProducts, emptyProducts],
      }).success,
    ).toBe(false);
  });

  it('does not hide an UNKNOWN condition behind an all_of NO_MATCH', () => {
    const explicitlyFalse = {
      ...matchingConditionResult,
      status: 'NO_MATCH' as const,
      observed: false,
      reason: 'services.teams is explicitly false.',
    };
    const unknownCapability = {
      status: 'UNKNOWN' as const,
      section: 'capabilities' as const,
      key: 'viva',
      expected: true,
      observed: null,
      path: 'capabilities.viva',
      reason: 'capabilities.viva is absent from the profile.',
    };
    const result = TenantApplicabilityResultSchema.parse({
      policyRulesVersion: basePolicy.policyRulesVersion,
      status: 'INSUFFICIENT_CONTEXT',
      ruleResults: [
        {
          ...matchingRuleResult,
          conditionGroupStatus: 'NO_MATCH' as const,
          conditionResults: [explicitlyFalse, unknownCapability],
        },
      ],
      reason: 'One tenant condition is explicitly false and another is absent.',
      missingContext: ['capabilities.viva'],
    });

    expect(result.status).toBe('INSUFFICIENT_CONTEXT');
    if (result.status !== 'INSUFFICIENT_CONTEXT') {
      throw new Error('expected insufficient context result');
    }
    expect(result.missingContext).toEqual(['capabilities.viva']);
  });

  it('requires non-empty, duplicate-free evidence, missing paths, and mappings', () => {
    const applicable = {
      policyRulesVersion: basePolicy.policyRulesVersion,
      status: 'APPLICABLE' as const,
      ruleResults: [matchingRuleResult],
      reason: 'The selected rule applies.',
      evidence: ['services.teams'],
    };
    expect(
      TenantApplicabilityResultSchema.safeParse({
        ...applicable,
        evidence: [],
      }).success,
    ).toBe(false);
    expect(
      TenantApplicabilityResultSchema.safeParse({
        ...applicable,
        evidence: ['services.teams', 'services.teams'],
      }).success,
    ).toBe(false);
    expect(
      TenantApplicabilityResultSchema.safeParse({
        ...applicable,
        mappingWarnings: [
          { field: 'products' as const, value: 'Unmapped product' },
          { field: 'products' as const, value: 'Unmapped product' },
        ],
      }).success,
    ).toBe(false);

    const unknown = {
      policyRulesVersion: basePolicy.policyRulesVersion,
      status: 'INSUFFICIENT_CONTEXT' as const,
      ruleResults: [
        {
          ...matchingRuleResult,
          conditionGroupStatus: 'UNKNOWN' as const,
          conditionResults: [
            {
              ...matchingConditionResult,
              status: 'UNKNOWN' as const,
              observed: null,
            },
          ],
        },
      ],
      reason: 'The tenant key is absent.',
      missingContext: ['services.teams'],
    };
    expect(
      TenantApplicabilityResultSchema.safeParse({
        ...unknown,
        missingContext: ['services.teams', 'services.teams'],
      }).success,
    ).toBe(false);
    expect(
      TenantApplicabilityResultSchema.safeParse({
        ...unknown,
        missingMappings: [
          { field: 'products', value: 'Unknown product' },
          { field: 'products', value: 'Unknown product' },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects structurally inconsistent insufficient and disabled-rule outcomes', () => {
    const mappingOnly = {
      policyRulesVersion: basePolicy.policyRulesVersion,
      status: 'INSUFFICIENT_CONTEXT' as const,
      ruleResults: [noMatchRuleResult],
      reason: 'The event has an unmapped product.',
      missingMappings: [
        { field: 'products' as const, value: 'Unknown product' },
      ],
    };
    expect(
      TenantApplicabilityResultSchema.safeParse({
        ...mappingOnly,
        missingContext: ['services.teams'],
      }).success,
    ).toBe(false);
    expect(
      TenantApplicabilityResultSchema.safeParse({
        policyRulesVersion: basePolicy.policyRulesVersion,
        status: 'INSUFFICIENT_CONTEXT',
        ruleResults: [],
        reason: 'No missing cause was supplied.',
      }).success,
    ).toBe(false);
    expect(
      TenantApplicabilityResultSchema.safeParse({
        ...mappingOnly,
        ruleResults: [
          {
            ...noMatchRuleResult,
            enabled: false,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects duplicate rule result IDs', () => {
    expect(
      TenantApplicabilityResultSchema.safeParse({
        policyRulesVersion: basePolicy.policyRulesVersion,
        status: 'APPLICABLE',
        ruleResults: [matchingRuleResult, { ...matchingRuleResult }],
        reason: 'Duplicate rule result IDs are ambiguous.',
        evidence: ['services.teams'],
      }).success,
    ).toBe(false);
  });
});
