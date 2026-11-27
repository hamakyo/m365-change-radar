import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  ChangeEventSchema,
  ImpactAssessmentSchema,
  ImpactStateSchema,
  JsonValueSchema,
  TenantProfileSchema,
} from '../src/index.js';

function readFixture(name: string): unknown {
  const url = new URL(`./fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as unknown;
}

describe('ChangeEvent', () => {
  it('parses a source-neutral JSON fixture and survives a JSON round trip', () => {
    const fixture = readFixture('change-event.json');
    const parsed = ChangeEventSchema.parse(fixture);

    expect(parsed.source).toBe('microsoft-message-center');
    expect(parsed.sourceMetadata).toEqual({
      messageType: 'serviceAnnouncement',
      tags: ['policy', 'teams'],
    });
    expect(parsed.severity).toBeNull();
    expect(parsed.signals?.isMajorChange).toBe(false);
    expect(parsed.signals?.actionRequiredBy).toBeNull();
    expect(parsed.signals?.hasSecurityImpact).toBe(false);
    expect(parsed.signals?.tags).toEqual([]);
    expect(ChangeEventSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(
      parsed,
    );
  });

  it('keeps omitted, false, and true normalized booleans distinct', () => {
    const fixture = readFixture('change-event.json') as Record<string, unknown>;
    const signals = fixture.signals as Record<string, unknown>;
    const withoutSecurity = ChangeEventSchema.parse({
      ...fixture,
      signals: Object.fromEntries(
        Object.entries(signals).filter(([key]) => key !== 'hasSecurityImpact'),
      ),
    });

    expect(withoutSecurity.signals?.hasSecurityImpact).toBeUndefined();
    expect('hasSecurityImpact' in (withoutSecurity.signals ?? {})).toBe(false);
    expect(ChangeEventSchema.parse(fixture).signals?.hasSecurityImpact).toBe(
      false,
    );
    const withSecurity = ChangeEventSchema.parse({
      ...fixture,
      signals: {
        ...signals,
        hasSecurityImpact: true,
      },
    });
    expect(withSecurity.signals?.hasSecurityImpact).toBe(true);
  });

  it('distinguishes confirmed absence, present values, and unknown values', () => {
    const fixture = readFixture('change-event.json') as Record<string, unknown>;
    const signals = fixture.signals as Record<string, unknown>;
    const withDeadline = ChangeEventSchema.parse({
      ...fixture,
      signals: {
        ...signals,
        actionRequiredBy: '2026-10-01T00:00:00Z',
      },
    });
    const withoutDeadline = ChangeEventSchema.parse({
      ...fixture,
      signals: Object.fromEntries(
        Object.entries(signals).filter(([key]) => key !== 'actionRequiredBy'),
      ),
    });
    const withSeverity = ChangeEventSchema.parse({
      ...fixture,
      severity: 'high',
    });
    const withoutSeverity = ChangeEventSchema.parse(
      Object.fromEntries(
        Object.entries(fixture).filter(([key]) => key !== 'severity'),
      ),
    );
    const withTags = ChangeEventSchema.parse({
      ...fixture,
      signals: {
        ...signals,
        tags: ['security'],
      },
    });
    const withoutTags = ChangeEventSchema.parse({
      ...fixture,
      signals: Object.fromEntries(
        Object.entries(signals).filter(([key]) => key !== 'tags'),
      ),
    });

    expect(withDeadline.signals?.actionRequiredBy).toBe('2026-10-01T00:00:00Z');
    expect(ChangeEventSchema.parse(fixture).signals?.actionRequiredBy).toBe(
      null,
    );
    expect(withoutDeadline.signals?.actionRequiredBy).toBeUndefined();
    expect('actionRequiredBy' in (withoutDeadline.signals ?? {})).toBe(false);
    expect(withSeverity.severity).toBe('high');
    expect(ChangeEventSchema.parse(fixture).severity).toBeNull();
    expect(withoutSeverity.severity).toBeUndefined();
    expect('severity' in withoutSeverity).toBe(false);
    expect(withTags.signals?.tags).toEqual(['security']);
    expect(ChangeEventSchema.parse(fixture).signals?.tags).toEqual([]);
    expect(withoutTags.signals?.tags).toBeUndefined();
    expect('tags' in (withoutTags.signals ?? {})).toBe(false);
  });

  it('rejects invalid datetimes and non-JSON metadata values', () => {
    const fixture = readFixture('change-event.json');

    expect(
      ChangeEventSchema.safeParse({
        ...(fixture as Record<string, unknown>),
        publishedAt: '2026-02-30T09:00:00Z',
      }).success,
    ).toBe(false);
    expect(
      ChangeEventSchema.safeParse({
        ...(fixture as Record<string, unknown>),
        publishedAt: '2026-08-26T12:00:00+09:00',
        updatedAt: '2026-08-26T02:59:59Z',
      }).success,
    ).toBe(false);
    expect(JsonValueSchema.safeParse({ unsupported: undefined }).success).toBe(
      false,
    );
    expect(JsonValueSchema.safeParse(Number.POSITIVE_INFINITY).success).toBe(
      false,
    );
    const fixtureRecord = fixture as Record<string, unknown>;
    expect(
      ChangeEventSchema.safeParse({
        ...fixtureRecord,
        signals: {
          ...(fixtureRecord.signals as Record<string, unknown>),
          tags: ['provider-specific-tag'],
        },
      }).success,
    ).toBe(false);
    expect(
      ChangeEventSchema.safeParse({
        ...fixtureRecord,
        signals: {
          ...(fixtureRecord.signals as Record<string, unknown>),
          actionRequiredBy: 'not-a-date',
        },
      }).success,
    ).toBe(false);
    expect(
      ChangeEventSchema.safeParse({
        ...fixtureRecord,
        signals: {
          ...(fixtureRecord.signals as Record<string, unknown>),
          tags: ['security', 'security'],
        },
      }).success,
    ).toBe(false);
  });
});

describe('TenantProfile', () => {
  it('parses the declarative profile shape from JSON', () => {
    const parsed = TenantProfileSchema.parse(
      readFixture('tenant-profile.json'),
    );

    expect(parsed.schemaVersion).toBe('1.0');
    expect(parsed.profileVersion).toBe('2026-08-26.1');
    expect(parsed.services.intune).toBe(true);
    expect(parsed.services.defender_for_endpoint).toBe(false);
  });

  it('distinguishes an omitted flag from an explicit false flag', () => {
    const parsed = TenantProfileSchema.parse(
      readFixture('tenant-profile.json'),
    );
    const environmentWithoutMacos = Object.fromEntries(
      Object.entries(parsed.environment).filter(([key]) => key !== 'macos'),
    );
    const withoutMacos = TenantProfileSchema.parse({
      ...parsed,
      environment: environmentWithoutMacos,
    });

    expect(withoutMacos.environment.macos).toBeUndefined();
    expect('macos' in withoutMacos.environment).toBe(false);
    expect(parsed.environment.macos).toBe(false);
    expect('macos' in parsed.environment).toBe(true);
  });

  it('rejects invalid versions and non-boolean context flags', () => {
    const fixture = readFixture('tenant-profile.json') as Record<
      string,
      unknown
    >;

    expect(
      TenantProfileSchema.safeParse({ ...fixture, schemaVersion: 'v1' })
        .success,
    ).toBe(false);
    expect(
      TenantProfileSchema.safeParse({
        ...fixture,
        services: { microsoft_365: 'false' },
      }).success,
    ).toBe(false);
  });
});

describe('ImpactAssessment', () => {
  it('accepts exactly the five defined states', () => {
    const fixture = readFixture('impact-assessments.json');
    const parsed = ImpactAssessmentSchema.array().parse(fixture);
    const states = parsed.map((assessment) => assessment.state);

    expect(new Set(states)).toEqual(
      new Set([
        'ACTION_REQUIRED',
        'REVIEW_REQUIRED',
        'INFORMATIONAL',
        'NOT_APPLICABLE',
        'INSUFFICIENT_CONTEXT',
      ]),
    );
    expect(ImpactStateSchema.options).toHaveLength(5);
  });

  it('requires state-specific evidence for every impact state', () => {
    for (const state of [
      'ACTION_REQUIRED',
      'REVIEW_REQUIRED',
      'INFORMATIONAL',
    ] as const) {
      expect(ImpactAssessmentSchema.safeParse({ state }).success).toBe(false);
      expect(
        ImpactAssessmentSchema.safeParse({
          state,
          reason: 'has a reason but no evidence',
        }).success,
      ).toBe(false);
      expect(
        ImpactAssessmentSchema.safeParse({
          state,
          evidence: ['has-evidence-but-no-reason'],
        }).success,
      ).toBe(false);
    }
    expect(
      ImpactAssessmentSchema.safeParse({ state: 'NOT_APPLICABLE' }).success,
    ).toBe(false);
    expect(
      ImpactAssessmentSchema.safeParse({
        state: 'NOT_APPLICABLE',
        reason: 'not applicable',
        evidence: ['service-disabled'],
        missingContext: ['services.teams'],
      }).success,
    ).toBe(false);
    expect(
      ImpactAssessmentSchema.safeParse({
        state: 'INSUFFICIENT_CONTEXT',
        reason: 'has a reason but no missing context',
      }).success,
    ).toBe(false);
    expect(
      ImpactAssessmentSchema.safeParse({
        state: 'INSUFFICIENT_CONTEXT',
        missingContext: ['missing-context-but-no-reason'],
      }).success,
    ).toBe(false);
  });

  it('accepts path-only, mapping-only, and combined INSUFFICIENT_CONTEXT variants', () => {
    const pathOnly = ImpactAssessmentSchema.parse({
      state: 'INSUFFICIENT_CONTEXT',
      reason: 'tenant profile paths are absent',
      missingContext: ['services.teams'],
    });
    const mappingOnly = ImpactAssessmentSchema.parse({
      state: 'INSUFFICIENT_CONTEXT',
      reason: 'event values have no policy mapping',
      missingMappings: [
        { field: 'products', value: 'Unknown product' },
        { field: 'categories', value: null },
      ],
    });
    const combined = ImpactAssessmentSchema.parse({
      state: 'INSUFFICIENT_CONTEXT',
      reason: 'both tenant context and policy mapping are missing',
      missingContext: ['services.teams', 'environment.windows'],
      missingMappings: [{ field: 'products', value: null }],
    });

    expect('missingMappings' in pathOnly).toBe(false);
    if (pathOnly.state !== 'INSUFFICIENT_CONTEXT') {
      throw new Error('expected an INSUFFICIENT_CONTEXT assessment');
    }
    expect(pathOnly.missingContext).toEqual(['services.teams']);
    expect(mappingOnly).not.toHaveProperty('missingContext');
    if (mappingOnly.state !== 'INSUFFICIENT_CONTEXT') {
      throw new Error('expected an INSUFFICIENT_CONTEXT assessment');
    }
    expect(mappingOnly.missingMappings).toEqual([
      { field: 'products', value: 'Unknown product' },
      { field: 'categories', value: null },
    ]);
    for (const assessment of [pathOnly, mappingOnly, combined]) {
      expect(
        ImpactAssessmentSchema.parse(JSON.parse(JSON.stringify(assessment))),
      ).toEqual(assessment);
    }
  });

  it('rejects INSUFFICIENT_CONTEXT without either insufficiency field or with empty arrays', () => {
    expect(
      ImpactAssessmentSchema.safeParse({
        state: 'INSUFFICIENT_CONTEXT',
        reason: 'no insufficiency recorded at all',
      }).success,
    ).toBe(false);
    expect(
      ImpactAssessmentSchema.safeParse({
        state: 'INSUFFICIENT_CONTEXT',
        reason: 'empty missingContext list',
        missingContext: [],
      }).success,
    ).toBe(false);
    expect(
      ImpactAssessmentSchema.safeParse({
        state: 'INSUFFICIENT_CONTEXT',
        reason: 'empty missingMappings list',
        missingMappings: [],
      }).success,
    ).toBe(false);
    expect(
      ImpactAssessmentSchema.safeParse({
        state: 'INSUFFICIENT_CONTEXT',
        reason: 'two empty lists still carry no insufficiency',
        missingContext: [],
        missingMappings: [],
      }).success,
    ).toBe(false);
  });

  it('keeps a null mapping gap value distinct from the string "null" and rejects duplicates', () => {
    const withNullSentinel = {
      state: 'INSUFFICIENT_CONTEXT' as const,
      reason: 'empty selector array and unmapped label',
      missingMappings: [{ field: 'products', value: null }],
    };
    const withStringNull = {
      state: 'INSUFFICIENT_CONTEXT' as const,
      reason: 'literal null label has no mapping',
      missingMappings: [{ field: 'products', value: 'null' }],
    };

    expect(ImpactAssessmentSchema.safeParse(withNullSentinel).success).toBe(
      true,
    );
    expect(ImpactAssessmentSchema.safeParse(withStringNull).success).toBe(true);
    expect(JSON.stringify(withStringNull.missingMappings)).not.toBe(
      JSON.stringify(withNullSentinel.missingMappings),
    );
    expect(withNullSentinel.missingMappings[0]!.value).toBeNull();
    expect(withStringNull.missingMappings[0]!.value).toBe('null');
    expect(
      ImpactAssessmentSchema.safeParse({
        ...withNullSentinel,
        missingMappings: [
          { field: 'products', value: null },
          { field: 'products', value: null },
        ],
      }).success,
    ).toBe(false);
    expect(
      ImpactAssessmentSchema.safeParse({
        ...withStringNull,
        missingMappings: [
          { field: 'categories', value: 'a' },
          { field: 'categories', value: 'a' },
        ],
      }).success,
    ).toBe(false);
    expect(
      ImpactAssessmentSchema.safeParse({
        ...withStringNull,
        missingMappings: [{ field: 'products', value: '' }],
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields and duplicate missingContext on every variant', () => {
    expect(
      ImpactAssessmentSchema.safeParse({
        state: 'INSUFFICIENT_CONTEXT',
        reason: 'extra fields are rejected',
        missingContext: ['services.teams'],
        evidence: ['rule.teams-review'],
      }).success,
    ).toBe(false);
    expect(
      ImpactAssessmentSchema.safeParse({
        state: 'INSUFFICIENT_CONTEXT',
        reason: 'unknown field on the mapping-only form',
        missingMappings: [{ field: 'categories', value: 'unmapped' }],
        affectedComponents: ['Teams'],
      }).success,
    ).toBe(false);
    expect(
      ImpactAssessmentSchema.safeParse({
        state: 'ACTION_REQUIRED',
        reason: 'evidence states must not grow mapping fields',
        evidence: ['admin-action-deadline'],
        missingMappings: [{ field: 'products', value: null }],
      }).success,
    ).toBe(false);
    expect(
      ImpactAssessmentSchema.safeParse({
        state: 'REVIEW_REQUIRED',
        reason: 'evidence states must not grow missingContext either',
        evidence: ['affected-service:teams'],
        missingContext: ['services.teams'],
      }).success,
    ).toBe(false);
    expect(
      ImpactAssessmentSchema.safeParse({
        state: 'INSUFFICIENT_CONTEXT',
        reason: 'duplicate paths are rejected',
        missingContext: ['services.teams', 'services.teams'],
      }).success,
    ).toBe(false);
    expect(
      ImpactAssessmentSchema.safeParse({
        state: 'NOT_APPLICABLE',
        reason: 'confirmed non-applicability',
        evidence: ['tenant.services.exchange_online=false'],
        missingMappings: [{ field: 'products', value: null }],
      }).success,
    ).toBe(false);
  });

  it('does not accept a boolean relevance replacement or an unknown state', () => {
    expect(
      ImpactAssessmentSchema.safeParse({
        state: 'ACTION_REQUIRED',
        relevant: true,
      }).success,
    ).toBe(false);
    expect(
      ImpactAssessmentSchema.safeParse({
        state: 'RELEVANT',
      }).success,
    ).toBe(false);
  });
});
