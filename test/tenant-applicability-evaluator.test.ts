import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ChangeEventSchema,
  GoldenCaseSchema,
  TenantApplicabilityConditionSchema,
  TenantApplicabilityEventSelectorSchema,
  TenantApplicabilityPolicySchema,
  TenantApplicabilityResultSchema,
  TenantProfileSchema,
  evaluateTenantApplicability,
  type ChangeEvent,
  type TenantApplicabilityCondition,
  type TenantApplicabilityEventSelector,
  type TenantApplicabilityPolicy,
  type TenantContextCondition,
  type TenantProfile,
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
const representativePolicy = TenantApplicabilityPolicySchema.parse(
  readJson(
    resolve(process.cwd(), 'test/fixtures/tenant-applicability-policy.json'),
  ),
);
const baseProfile = TenantProfileSchema.parse(
  readJson(resolve(process.cwd(), 'test/fixtures/tenant-profile.json')),
);

function eventWith(
  overrides: Partial<
    Pick<ChangeEvent, 'products' | 'categories' | 'sourceMetadata'>
  >,
): ChangeEvent {
  return ChangeEventSchema.parse({
    ...baseEvent,
    ...overrides,
  });
}

function profileWith(
  section: 'services' | 'environment' | 'capabilities',
  key: string,
  value: boolean | undefined,
): TenantProfile {
  const profile = clone(baseProfile);
  const flags = profile[section];
  if (value === undefined) {
    delete flags[key];
  } else {
    flags[key] = value;
  }
  return TenantProfileSchema.parse(profile);
}

function policyWith(
  condition: TenantApplicabilityCondition,
  selector: TenantApplicabilityEventSelector = {
    field: 'products',
    values: ['Microsoft Teams'],
  },
): TenantApplicabilityPolicy {
  return TenantApplicabilityPolicySchema.parse({
    policyId: 'tenant-applicability-test',
    policyRulesVersion: 'test-1',
    description: 'Test tenant applicability policy.',
    rules: [
      {
        ruleId: 'test-rule',
        enabled: true,
        selector,
        condition,
      },
    ],
  });
}

function allOf(
  ...conditions: TenantContextCondition[]
): TenantApplicabilityCondition {
  return TenantApplicabilityConditionSchema.parse({
    kind: 'all_of',
    conditions,
  });
}

function anyOf(
  ...conditions: TenantContextCondition[]
): TenantApplicabilityCondition {
  return TenantApplicabilityConditionSchema.parse({
    kind: 'any_of',
    conditions,
  });
}

function loadCorpusChanges(): Map<string, ChangeEvent> {
  const directory = resolve(process.cwd(), 'corpus/changes');
  return new Map(
    readdirSync(directory)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => {
        const fixture = readJson(join(directory, name)) as {
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
        const fixture = readJson(join(directory, name)) as {
          fixtureId: string;
          profile: unknown;
        };
        return [fixture.fixtureId, TenantProfileSchema.parse(fixture.profile)];
      }),
  );
}

function loadGoldenCases(): ReturnType<typeof GoldenCaseSchema.parse>[] {
  const directory = resolve(process.cwd(), 'corpus/cases');
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => GoldenCaseSchema.parse(readJson(join(directory, name))));
}

describe('Tenant applicability evaluator', () => {
  it('matches products and categories exactly, preserving configured order', () => {
    const selector = TenantApplicabilityEventSelectorSchema.parse({
      field: 'products',
      values: ['Beta', 'Alpha'],
    });
    const result = evaluateTenantApplicability(
      policyWith(
        allOf({ section: 'services', key: 'teams', equals: true }),
        selector,
      ),
      eventWith({ products: ['Alpha', 'Beta', 'Alpha'] }),
      baseProfile,
    );

    expect(result.status).toBe('APPLICABLE');
    expect(result.ruleResults).toMatchObject([
      {
        selectorStatus: 'MATCH',
        matchedValues: ['Beta', 'Alpha'],
      },
    ]);

    const categoryResult = evaluateTenantApplicability(
      policyWith(allOf({ section: 'services', key: 'teams', equals: true }), {
        field: 'categories',
        values: ['Admin', 'Security'],
      }),
      eventWith({ categories: ['Security', 'Admin'] }),
      baseProfile,
    );
    expect(categoryResult.ruleResults).toMatchObject([
      { field: 'categories', matchedValues: ['Admin', 'Security'] },
    ]);

    const caseSensitive = evaluateTenantApplicability(
      policyWith(allOf({ section: 'services', key: 'teams', equals: true }), {
        field: 'products',
        values: ['Synthetic Teams'],
      }),
      eventWith({ products: ['synthetic teams'] }),
      baseProfile,
    );
    expect(caseSensitive.status).toBe('INSUFFICIENT_CONTEXT');
    expect(caseSensitive.ruleResults[0]?.selectorStatus).toBe('NO_MATCH');
    if (caseSensitive.status !== 'INSUFFICIENT_CONTEXT') {
      throw new Error('expected insufficient context result');
    }
    expect(caseSensitive.missingMappings).toEqual([
      { field: 'products', value: 'synthetic teams' },
    ]);
  });

  it('does not evaluate conditions for selector NO_MATCH and ignores metadata', () => {
    const policy = policyWith(
      allOf({ section: 'services', key: 'not-present', equals: true }),
      { field: 'products', values: ['Synthetic Teams'] },
    );
    const result = evaluateTenantApplicability(
      policy,
      eventWith({ products: ['Synthetic Other'] }),
      baseProfile,
    );

    expect(result.ruleResults[0]).toMatchObject({
      selectorStatus: 'NO_MATCH',
      matchedValues: [],
    });
    expect(result.ruleResults[0]).not.toHaveProperty('conditionResults');

    const eventWithProviderMetadata = eventWith({
      products: ['Synthetic Teams'],
      sourceMetadata: {
        providerPath: '$.provider.service',
        regex: 'teams',
        code: 'return true',
      },
    });
    const eventWithOtherMetadata = eventWith({
      products: ['Synthetic Teams'],
      sourceMetadata: { unrelated: ['metadata'] },
    });
    expect(
      evaluateTenantApplicability(
        policyWith(allOf({ section: 'services', key: 'teams', equals: true }), {
          field: 'products',
          values: ['Synthetic Teams'],
        }),
        eventWithProviderMetadata,
        baseProfile,
      ),
    ).toEqual(
      evaluateTenantApplicability(
        policyWith(allOf({ section: 'services', key: 'teams', equals: true }), {
          field: 'products',
          values: ['Synthetic Teams'],
        }),
        eventWithOtherMetadata,
        baseProfile,
      ),
    );
  });

  it('records MATCH, explicit false NO_MATCH, and absent UNKNOWN conditions', () => {
    const condition = allOf(
      { section: 'services', key: 'teams', equals: true },
      { section: 'environment', key: 'windows', equals: true },
    );
    const match = evaluateTenantApplicability(
      policyWith(condition),
      baseEvent,
      baseProfile,
    );
    expect(match.status).toBe('APPLICABLE');
    expect(match.ruleResults).toMatchObject([
      {
        conditionGroupStatus: 'MATCH',
        conditionResults: [
          { path: 'services.teams', status: 'MATCH', observed: true },
          { path: 'environment.windows', status: 'MATCH', observed: true },
        ],
      },
    ]);

    const noMatch = evaluateTenantApplicability(
      policyWith(condition),
      baseEvent,
      profileWith('environment', 'windows', false),
    );
    expect(noMatch.status).toBe('NOT_APPLICABLE');
    expect(noMatch.ruleResults).toMatchObject([
      {
        conditionGroupStatus: 'NO_MATCH',
        conditionResults: [
          { path: 'services.teams', status: 'MATCH' },
          { path: 'environment.windows', status: 'NO_MATCH', observed: false },
        ],
      },
    ]);

    const unknown = evaluateTenantApplicability(
      policyWith(condition),
      baseEvent,
      profileWith('environment', 'windows', undefined),
    );
    expect(unknown.status).toBe('INSUFFICIENT_CONTEXT');
    if (unknown.status !== 'INSUFFICIENT_CONTEXT') {
      throw new Error('expected insufficient context result');
    }
    expect(unknown.missingContext).toEqual(['environment.windows']);
    expect(unknown.ruleResults).toMatchObject([
      {
        conditionGroupStatus: 'UNKNOWN',
        conditionResults: [
          { path: 'services.teams', status: 'MATCH', observed: true },
          { path: 'environment.windows', status: 'UNKNOWN', observed: null },
        ],
      },
    ]);
  });

  it('applies the all_of and any_of three-valued truth tables', () => {
    const allOfNoMatchUnknown = evaluateTenantApplicability(
      policyWith(
        allOf(
          { section: 'services', key: 'teams', equals: false },
          { section: 'capabilities', key: 'missing', equals: true },
        ),
      ),
      baseEvent,
      baseProfile,
    );
    expect(allOfNoMatchUnknown.ruleResults).toMatchObject([
      { conditionGroupStatus: 'NO_MATCH' },
    ]);
    expect(allOfNoMatchUnknown.status).toBe('INSUFFICIENT_CONTEXT');

    const anyOfMatchUnknown = evaluateTenantApplicability(
      policyWith(
        anyOf(
          { section: 'services', key: 'teams', equals: true },
          { section: 'capabilities', key: 'missing', equals: true },
        ),
      ),
      baseEvent,
      baseProfile,
    );
    expect(anyOfMatchUnknown.status).toBe('APPLICABLE');
    expect(anyOfMatchUnknown.ruleResults).toMatchObject([
      { conditionGroupStatus: 'MATCH' },
    ]);

    const anyOfNoMatchUnknown = evaluateTenantApplicability(
      policyWith(
        anyOf(
          { section: 'services', key: 'teams', equals: false },
          { section: 'capabilities', key: 'missing', equals: true },
        ),
      ),
      baseEvent,
      baseProfile,
    );
    expect(anyOfNoMatchUnknown.status).toBe('INSUFFICIENT_CONTEXT');
    expect(anyOfNoMatchUnknown.ruleResults).toMatchObject([
      { conditionGroupStatus: 'UNKNOWN' },
    ]);

    const anyOfNoMatch = evaluateTenantApplicability(
      policyWith(
        anyOf(
          { section: 'services', key: 'teams', equals: false },
          { section: 'environment', key: 'windows', equals: false },
        ),
      ),
      baseEvent,
      baseProfile,
    );
    expect(anyOfNoMatch.status).toBe('NOT_APPLICABLE');
    expect(anyOfNoMatch.ruleResults).toMatchObject([
      { conditionGroupStatus: 'NO_MATCH' },
    ]);
  });

  it('uses final precedence and retains only contributing evidence paths', () => {
    const anyOfMatchUnknown = evaluateTenantApplicability(
      policyWith(
        anyOf(
          { section: 'services', key: 'teams', equals: true },
          { section: 'capabilities', key: 'missing', equals: true },
        ),
      ),
      baseEvent,
      baseProfile,
    );
    expect(anyOfMatchUnknown).toMatchObject({
      status: 'APPLICABLE',
      evidence: ['services.teams'],
    });
    expect(anyOfMatchUnknown).not.toHaveProperty('missingContext');

    const separateMatchAndUnknown = TenantApplicabilityPolicySchema.parse({
      policyId: 'separate-rules',
      policyRulesVersion: 'test-1',
      description: 'Separate matching and unknown rules.',
      rules: [
        {
          ruleId: 'matching-rule',
          enabled: true,
          selector: { field: 'products', values: ['Synthetic Teams'] },
          condition: allOf({
            section: 'services',
            key: 'teams',
            equals: true,
          }),
        },
        {
          ruleId: 'unknown-rule',
          enabled: true,
          selector: { field: 'products', values: ['Synthetic Unknown'] },
          condition: allOf({
            section: 'capabilities',
            key: 'missing',
            equals: true,
          }),
        },
      ],
    });
    const separateResult = evaluateTenantApplicability(
      separateMatchAndUnknown,
      eventWith({ products: ['Synthetic Teams', 'Synthetic Unknown'] }),
      baseProfile,
    );
    expect(separateResult).toMatchObject({
      status: 'APPLICABLE',
      evidence: ['services.teams'],
    });
    expect(separateResult).not.toHaveProperty('missingContext');

    const matchWithGap = evaluateTenantApplicability(
      policyWith(allOf({ section: 'services', key: 'teams', equals: true }), {
        field: 'products',
        values: ['Synthetic Teams'],
      }),
      eventWith({ products: ['Synthetic Teams', 'Unmapped Product'] }),
      baseProfile,
    );
    expect(matchWithGap).toMatchObject({
      status: 'APPLICABLE',
      evidence: ['services.teams'],
      mappingWarnings: [{ field: 'products', value: 'Unmapped Product' }],
    });

    const noMatchEvidence = evaluateTenantApplicability(
      policyWith(
        allOf(
          { section: 'services', key: 'teams', equals: true },
          { section: 'environment', key: 'windows', equals: true },
        ),
      ),
      baseEvent,
      profileWith('services', 'teams', false),
    );
    expect(noMatchEvidence).toMatchObject({
      status: 'NOT_APPLICABLE',
      evidence: ['services.teams'],
    });
  });

  it('emits mapping gaps in first-occurrence order, including empty arrays', () => {
    const policy = TenantApplicabilityPolicySchema.parse({
      policyId: 'mapping-order',
      policyRulesVersion: 'test-1',
      description: 'Mapping order policy.',
      rules: [
        {
          ruleId: 'mapped-a',
          enabled: true,
          selector: { field: 'products', values: ['Mapped A'] },
          condition: allOf({
            section: 'services',
            key: 'teams',
            equals: true,
          }),
        },
        {
          ruleId: 'mapped-b',
          enabled: true,
          selector: { field: 'products', values: ['Mapped B'] },
          condition: allOf({
            section: 'services',
            key: 'teams',
            equals: true,
          }),
        },
      ],
    });
    const result = evaluateTenantApplicability(
      policy,
      eventWith({ products: ['Gap B', 'Gap A', 'Gap B', 'Mapped A'] }),
      profileWith('services', 'teams', false),
    );
    expect(result.status).toBe('INSUFFICIENT_CONTEXT');
    if (result.status !== 'INSUFFICIENT_CONTEXT') {
      throw new Error('expected insufficient context result');
    }
    expect(result.missingMappings).toEqual([
      { field: 'products', value: 'Gap B' },
      { field: 'products', value: 'Gap A' },
    ]);
    expect(result).not.toHaveProperty('missingContext');

    const empty = evaluateTenantApplicability(
      policy,
      eventWith({ products: [], categories: ['Unreferenced Category'] }),
      baseProfile,
    );
    expect(empty).toMatchObject({
      status: 'INSUFFICIENT_CONTEXT',
      missingMappings: [{ field: 'products', value: null }],
    });
    if (empty.status !== 'INSUFFICIENT_CONTEXT') {
      throw new Error('expected insufficient context result');
    }
    expect(empty.missingMappings).toHaveLength(1);
  });

  it('omits disabled rules and preserves deterministic order without mutation', () => {
    const policy = TenantApplicabilityPolicySchema.parse({
      ...representativePolicy,
      rules: [
        representativePolicy.rules[0]!,
        { ...representativePolicy.rules[1]!, enabled: false },
        representativePolicy.rules[2]!,
      ],
    });
    const event = eventWith({
      products: ['Synthetic Teams', 'Synthetic SharePoint'],
    });
    const profile = clone(baseProfile);
    const policyBefore = clone(policy);
    const eventBefore = clone(event);
    const profileBefore = clone(profile);

    const first = evaluateTenantApplicability(policy, event, profile);
    const second = evaluateTenantApplicability(policy, event, profile);

    expect(first).toEqual(second);
    expect(first.ruleResults.map((rule) => rule.ruleId)).toEqual([
      policy.rules[0]?.ruleId,
      policy.rules[2]?.ruleId,
    ]);
    expect(policy).toEqual(policyBefore);
    expect(event).toEqual(eventBefore);
    expect(profile).toEqual(profileBefore);
    expect(
      TenantApplicabilityResultSchema.parse(JSON.parse(JSON.stringify(first))),
    ).toEqual(first);
  });
});

describe('Tenant applicability representative policy', () => {
  it('maps every synthetic product label and uses bounded Purview any_of rules', () => {
    const changes = loadCorpusChanges();
    const productLabels = new Set(
      [...changes.values()].flatMap((event) => event.products),
    );
    const configuredLabels = new Set(
      representativePolicy.rules.flatMap((rule) =>
        rule.selector.field === 'products' ? rule.selector.values : [],
      ),
    );

    expect(productLabels.size).toBe(17);
    expect(
      [...productLabels].every((label) => configuredLabels.has(label)),
    ).toBe(true);
    expect(
      representativePolicy.rules.filter(
        (rule) =>
          rule.selector.values.includes('Synthetic Purview') &&
          rule.condition.kind === 'any_of',
      ),
    ).not.toHaveLength(0);
    expect(
      representativePolicy.rules.filter(
        (rule) =>
          rule.selector.values.includes('Synthetic Purview Compliance') &&
          rule.condition.kind === 'any_of',
      ),
    ).not.toHaveLength(0);
  });

  it('evaluates all 50 changes across all 10 profiles with no mapping gaps', () => {
    const changes = loadCorpusChanges();
    const profiles = loadCorpusProfiles();
    const results = [...changes.values()].flatMap((event) =>
      [...profiles.values()].map((profile) =>
        evaluateTenantApplicability(representativePolicy, event, profile),
      ),
    );

    expect(changes).toHaveLength(50);
    expect(profiles).toHaveLength(10);
    expect(results).toHaveLength(500);
    results.forEach((result) => {
      expect(TenantApplicabilityResultSchema.parse(result)).toEqual(result);
      if (result.status === 'INSUFFICIENT_CONTEXT') {
        expect(result.missingMappings ?? []).toEqual([]);
      }
      if (result.status === 'APPLICABLE') {
        expect(result.mappingWarnings ?? []).toEqual([]);
      }
    });
  });

  it('matches all six NOT_APPLICABLE golden cases and retains known missing paths', () => {
    const changes = loadCorpusChanges();
    const profiles = loadCorpusProfiles();
    const cases = loadGoldenCases();
    const notApplicableCases = cases.filter(
      (goldenCase) => goldenCase.expected.state === 'NOT_APPLICABLE',
    );

    expect(notApplicableCases).toHaveLength(6);
    notApplicableCases.forEach((goldenCase) => {
      const event = changes.get(goldenCase.changeFixtureId);
      const profile = profiles.get(goldenCase.tenantProfileFixtureId);
      if (event === undefined || profile === undefined) {
        throw new Error(`missing fixture for ${goldenCase.caseId}`);
      }
      expect(
        evaluateTenantApplicability(representativePolicy, event, profile)
          .status,
      ).toBe('NOT_APPLICABLE');
    });

    const missingCases = cases.filter(
      (goldenCase) =>
        goldenCase.expected.state === 'INSUFFICIENT_CONTEXT' &&
        goldenCase.expected.missingContext.some((path) =>
          /^(services|environment|capabilities)\./.test(path),
        ),
    );
    expect(missingCases.length).toBeGreaterThanOrEqual(5);
    missingCases.forEach((goldenCase) => {
      const event = changes.get(goldenCase.changeFixtureId);
      const profile = profiles.get(goldenCase.tenantProfileFixtureId);
      if (event === undefined || profile === undefined) {
        throw new Error(`missing fixture for ${goldenCase.caseId}`);
      }
      const result = evaluateTenantApplicability(
        representativePolicy,
        event,
        profile,
      );
      expect(result.status).toBe('INSUFFICIENT_CONTEXT');
      if (result.status !== 'INSUFFICIENT_CONTEXT') return;
      if (goldenCase.expected.state !== 'INSUFFICIENT_CONTEXT') return;
      const allowedPaths = new Set(
        goldenCase.expected.missingContext.filter((path) =>
          /^(services|environment|capabilities)\./.test(path),
        ),
      );
      const missingContext = result.missingContext ?? [];
      expect(missingContext.length).toBeGreaterThan(0);
      expect(missingContext.every((path) => allowedPaths.has(path))).toBe(true);
      if (goldenCase.caseId === 'SYNTH-CASE-064') {
        expect(missingContext).toContain('services.intune');
      }
    });
  });

  it('maps the general Intune product to service applicability', () => {
    const changes = loadCorpusChanges();
    const profiles = loadCorpusProfiles();
    const event = changes.get('SYNTH-MC-024');
    const profile = profiles.get('SYNTH-TENANT-009');
    if (event === undefined || profile === undefined) {
      throw new Error('missing Intune regression fixture');
    }

    const autopilotFalse = evaluateTenantApplicability(
      representativePolicy,
      event,
      profile,
    );
    expect(autopilotFalse).toMatchObject({
      status: 'APPLICABLE',
      evidence: ['services.intune'],
    });

    const withoutAutopilot = clone(profile);
    delete withoutAutopilot.capabilities.autopilot;
    const autopilotUnlisted = evaluateTenantApplicability(
      representativePolicy,
      event,
      TenantProfileSchema.parse(withoutAutopilot),
    );
    expect(autopilotUnlisted).toMatchObject({
      status: 'APPLICABLE',
      evidence: ['services.intune'],
    });
  });
});
