import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  AnalysisRecordSchema,
  DeterministicConclusionSchema,
  DeterministicPolicyKindSchema,
  FactObservationSchema,
  PolicyVersionBundleSchema,
  ProvenanceRecordSchema,
  SourceFactSchema,
  TenantFactSchema,
  VersionBundleSchema,
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

function recordsFrom(analysis: Record<string, unknown>): unknown[] {
  const records = analysis.provenanceRecords;
  if (!Array.isArray(records)) {
    throw new Error('analysis fixture has no provenance records');
  }
  return records;
}

describe('ProvenanceRecord and VersionBundle', () => {
  it('parses all four provenance kinds and both AI usage forms', () => {
    const withAI = asRecord(readFixture('analysis-record-ai.json'));
    const withoutAI = asRecord(readFixture('analysis-record-no-ai.json'));
    const records = recordsFrom(withAI);
    const deterministic = asRecord(records[2]);

    expect(
      ProvenanceRecordSchema.array()
        .parse(records)
        .map((record) => record.kind),
    ).toEqual([
      'source_fact',
      'tenant_fact',
      'deterministic_conclusion',
      'ai_inference',
    ]);
    expect(AnalysisRecordSchema.parse(withAI).versionBundle.ai.used).toBe(true);
    expect(AnalysisRecordSchema.parse(withoutAI).versionBundle.ai.used).toBe(
      false,
    );
    const noAIParsed = AnalysisRecordSchema.parse(withoutAI);
    const noAIConclusion = noAIParsed.provenanceRecords.find(
      (record) => record.kind === 'deterministic_conclusion',
    );
    expect(noAIParsed.impactAssessment.state).toBe('NOT_APPLICABLE');
    if (noAIParsed.impactAssessment.state !== 'NOT_APPLICABLE') {
      throw new Error('no-AI fixture must be NOT_APPLICABLE');
    }
    expect(noAIParsed.impactAssessment.evidence).toEqual(['rule.no-impact']);
    expect(noAIConclusion).toMatchObject({
      evidenceId: 'rule.no-impact',
      policyKind: 'tenant_applicability_policy',
      policyRulesVersion: 'tenant-applicability-2026-08',
      dependsOnEvidenceIds: ['source.no-impact', 'tenant.services.stream'],
    });
    expect(deterministic).toMatchObject({
      policyKind: 'tenant_applicability_policy',
      policyRulesVersion: 'tenant-applicability-2026-08',
    });
  });

  it('distinguishes present JSON values from an absent observation', () => {
    const presentValues: unknown[] = [null, false, 0, '', [], {}];
    presentValues.forEach((value) => {
      expect(
        FactObservationSchema.parse({ presence: 'present', value }),
      ).toEqual({ presence: 'present', value });
    });

    const presentNull = FactObservationSchema.parse({
      presence: 'present',
      value: null,
    });
    const absent = FactObservationSchema.parse({ presence: 'absent' });
    expect(presentNull).not.toEqual(absent);
    expect(JSON.stringify(presentNull)).not.toBe(JSON.stringify(absent));
    expect(
      FactObservationSchema.safeParse({
        presence: 'present',
      }).success,
    ).toBe(false);
    expect(
      FactObservationSchema.safeParse({
        presence: 'absent',
        value: null,
      }).success,
    ).toBe(false);
    expect(
      FactObservationSchema.safeParse({
        presence: 'unknown',
        value: null,
      }).success,
    ).toBe(false);
    expect(
      FactObservationSchema.safeParse({
        presence: 'present',
        value: null,
        extra: true,
      }).success,
    ).toBe(false);

    const sourceFact = {
      kind: 'source_fact',
      evidenceId: 'source.observation',
      source: 'test-source',
      externalId: 'external-1',
      sourceMessageVersion: 'message-v1',
      path: '/field',
    };
    const tenantFact = {
      kind: 'tenant_fact',
      evidenceId: 'tenant.observation',
      tenantProfileVersion: 'profile-v1',
      path: '/services/test',
    };
    expect(
      SourceFactSchema.parse({
        ...sourceFact,
        observation: presentNull,
      }).observation,
    ).toEqual(presentNull);
    expect(
      TenantFactSchema.parse({
        ...tenantFact,
        observation: absent,
      }).observation,
    ).toEqual(absent);
    expect(
      SourceFactSchema.safeParse({
        ...sourceFact,
        value: null,
      }).success,
    ).toBe(false);
    expect(
      SourceFactSchema.safeParse({
        ...sourceFact,
        observation: presentNull,
        value: null,
      }).success,
    ).toBe(false);
    expect(SourceFactSchema.safeParse(sourceFact).success).toBe(false);
    expect(
      TenantFactSchema.safeParse({
        ...tenantFact,
        value: false,
      }).success,
    ).toBe(false);
    expect(
      TenantFactSchema.safeParse({
        ...tenantFact,
        observation: absent,
        value: false,
      }).success,
    ).toBe(false);
    expect(TenantFactSchema.safeParse(tenantFact).success).toBe(false);
  });

  it('requires an owned policy kind and keeps both policy versions strict', () => {
    const withAI = asRecord(readFixture('analysis-record-ai.json'));
    const versionBundle = asRecord(withAI.versionBundle);
    const deterministic = asRecord(recordsFrom(withAI)[2]);
    const policyVersions = asRecord(versionBundle.policyVersions);

    expect(DeterministicPolicyKindSchema.options).toEqual([
      'risk_policy',
      'tenant_applicability_policy',
    ]);
    expect(PolicyVersionBundleSchema.parse(policyVersions)).toEqual({
      riskPolicyRulesVersion: 'policy-2026-08',
      tenantApplicabilityPolicyRulesVersion: 'tenant-applicability-2026-08',
    });

    const riskConclusion = DeterministicConclusionSchema.parse({
      ...deterministic,
      evidenceId: 'rule.risk-review',
      policyKind: 'risk_policy',
      policyRulesVersion: policyVersions.riskPolicyRulesVersion,
    });
    const tenantConclusion = DeterministicConclusionSchema.parse({
      ...deterministic,
      evidenceId: 'rule.tenant-review',
      policyKind: 'tenant_applicability_policy',
      policyRulesVersion: policyVersions.tenantApplicabilityPolicyRulesVersion,
    });
    expect(riskConclusion.policyKind).toBe('risk_policy');
    expect(tenantConclusion.policyKind).toBe('tenant_applicability_policy');
    expect(
      ProvenanceRecordSchema.parse(JSON.parse(JSON.stringify(riskConclusion))),
    ).toEqual(riskConclusion);
    expect(
      ProvenanceRecordSchema.parse(
        JSON.parse(JSON.stringify(tenantConclusion)),
      ),
    ).toEqual(tenantConclusion);

    const withoutPolicyKind = Object.fromEntries(
      Object.entries(deterministic).filter(([key]) => key !== 'policyKind'),
    );
    expect(
      DeterministicConclusionSchema.safeParse(withoutPolicyKind).success,
    ).toBe(false);
    expect(
      DeterministicConclusionSchema.safeParse({
        ...deterministic,
        policyKind: 'other_policy',
      }).success,
    ).toBe(false);
    expect(
      VersionBundleSchema.safeParse({
        ...versionBundle,
        policyRulesVersion: 'legacy-policy-version',
      }).success,
    ).toBe(false);
    expect(
      VersionBundleSchema.safeParse({
        ...versionBundle,
        policyVersions: {
          riskPolicyRulesVersion: policyVersions.riskPolicyRulesVersion,
        },
      }).success,
    ).toBe(false);
    expect(
      VersionBundleSchema.safeParse({
        ...versionBundle,
        policyVersions: {
          ...policyVersions,
          extra: 'unsupported',
        },
      }).success,
    ).toBe(false);
  });

  it('rejects partial AI execution metadata and invalid confidence', () => {
    const withAI = asRecord(readFixture('analysis-record-ai.json'));
    const versionBundle = asRecord(withAI.versionBundle);
    const aiRecord = asRecord(recordsFrom(withAI)[3]);

    expect(
      VersionBundleSchema.safeParse({
        ...versionBundle,
        ai: { used: true, promptVersion: 'prompt-only', model: 'model-only' },
      }).success,
    ).toBe(false);
    expect(
      VersionBundleSchema.safeParse({
        ...versionBundle,
        ai: { used: false, model: 'must-not-be-present' },
      }).success,
    ).toBe(false);
    expect(
      ProvenanceRecordSchema.safeParse({
        ...aiRecord,
        confidence: 1.01,
      }).success,
    ).toBe(false);
  });
});

describe('AnalysisRecord', () => {
  it('validates references and survives a JSON round trip', () => {
    const fixture = asRecord(readFixture('analysis-record-ai.json'));
    const parsed = AnalysisRecordSchema.parse(fixture);

    expect(
      AnalysisRecordSchema.parse(JSON.parse(JSON.stringify(parsed))),
    ).toEqual(parsed);
  });

  it('allows deterministic conclusions to depend on absent facts and round trips them', () => {
    const fixture = asRecord(readFixture('analysis-record-ai.json'));
    const records = recordsFrom(fixture);
    const absentRecords = records.map((record) => {
      const parsed = asRecord(record);
      if (parsed.kind === 'source_fact' || parsed.kind === 'tenant_fact') {
        return {
          ...parsed,
          observation: { presence: 'absent' },
        };
      }
      return parsed;
    });

    const parsed = AnalysisRecordSchema.parse({
      ...fixture,
      provenanceRecords: absentRecords,
    });
    const roundTripped = AnalysisRecordSchema.parse(
      JSON.parse(JSON.stringify(parsed)),
    );

    expect(roundTripped).toEqual(parsed);
    expect(
      parsed.provenanceRecords
        .filter(
          (record) =>
            record.kind === 'source_fact' || record.kind === 'tenant_fact',
        )
        .every((record) => record.observation.presence === 'absent'),
    ).toBe(true);
    const conclusion = parsed.provenanceRecords.find(
      (record) => record.kind === 'deterministic_conclusion',
    );
    expect(conclusion).toMatchObject({
      dependsOnEvidenceIds: ['source.deadline', 'tenant.services.teams'],
    });
  });

  it('rejects missing evidence references and missing dependencies', () => {
    const fixture = asRecord(readFixture('analysis-record-ai.json'));
    const assessment = asRecord(fixture.impactAssessment);
    const records = recordsFrom(fixture);
    const deterministic = asRecord(records[2]);

    expect(
      AnalysisRecordSchema.safeParse({
        ...fixture,
        impactAssessment: {
          ...assessment,
          evidence: ['does-not-exist'],
        },
      }).success,
    ).toBe(false);
    expect(
      AnalysisRecordSchema.safeParse({
        ...fixture,
        provenanceRecords: records.map((record, index) =>
          index === 2
            ? {
                ...deterministic,
                dependsOnEvidenceIds: ['missing-dependency'],
              }
            : record,
        ),
      }).success,
    ).toBe(false);
  });

  it('rejects a ChangeEvent reference version that differs from the bundle', () => {
    const fixture = asRecord(readFixture('analysis-record-ai.json'));

    expect(
      AnalysisRecordSchema.safeParse({
        ...fixture,
        changeEventRef: {
          ...asRecord(fixture.changeEventRef),
          sourceMessageVersion: 'different-message-version',
        },
      }).success,
    ).toBe(false);
  });

  it('rejects duplicate IDs, unsupported fields, bad dates, and AI mismatches', () => {
    const fixture = asRecord(readFixture('analysis-record-ai.json'));
    const records = recordsFrom(fixture);
    const firstRecord = records[0];
    const aiRecord = asRecord(records[3]);
    if (firstRecord === undefined) {
      throw new Error('analysis fixture has no first provenance record');
    }

    expect(
      AnalysisRecordSchema.safeParse({
        ...fixture,
        provenanceRecords: [...records, firstRecord],
      }).success,
    ).toBe(false);
    expect(
      AnalysisRecordSchema.safeParse({ ...fixture, unsupported: true }).success,
    ).toBe(false);
    expect(
      AnalysisRecordSchema.safeParse({ ...fixture, createdAt: 'not-a-date' })
        .success,
    ).toBe(false);
    expect(
      ProvenanceRecordSchema.safeParse({
        ...aiRecord,
        unsupported: true,
      }).success,
    ).toBe(false);
    expect(
      ProvenanceRecordSchema.safeParse({
        ...asRecord(firstRecord),
        inference: 'unattributed generated claim',
      }).success,
    ).toBe(false);
    expect(
      AnalysisRecordSchema.safeParse({
        ...fixture,
        versionBundle: {
          ...asRecord(fixture.versionBundle),
          ai: {
            used: true,
            promptVersion: 'different-prompt',
            model: 'gpt-5.6-luna',
            modelVersion: 'gpt-5.6-luna-2026-08-01',
          },
        },
      }).success,
    ).toBe(false);
  });

  it('rejects AI provenance when the bundle says AI was not used', () => {
    const noAI = asRecord(readFixture('analysis-record-no-ai.json'));
    const withAI = asRecord(readFixture('analysis-record-ai.json'));
    const aiRecord = recordsFrom(withAI)[3];
    if (aiRecord === undefined) {
      throw new Error('AI fixture has no AI inference record');
    }

    expect(
      AnalysisRecordSchema.safeParse({
        ...noAI,
        provenanceRecords: [...recordsFrom(noAI), aiRecord],
      }).success,
    ).toBe(false);
  });

  it('round-trips mapping-only, path-only, and combined INSUFFICIENT_CONTEXT assessments', () => {
    const noAI = asRecord(readFixture('analysis-record-no-ai.json'));
    const existingAssessment = asRecord(noAI.impactAssessment);

    const variants = [
      {
        label: 'mapping-only',
        assessment: {
          state: 'INSUFFICIENT_CONTEXT',
          reason: 'One or more event values have no policy mapping.',
          missingMappings: [
            { field: 'products', value: 'Unmapped Product' },
            { field: 'categories', value: null },
          ],
        },
      },
      {
        label: 'path-only',
        assessment: {
          state: 'INSUFFICIENT_CONTEXT',
          reason: 'One or more tenant context keys are absent.',
          missingContext: ['services.stream'],
        },
      },
      {
        label: 'combined',
        assessment: {
          state: 'INSUFFICIENT_CONTEXT',
          reason:
            'Tenant context keys and policy mappings are both incomplete.',
          missingContext: ['services.stream', 'capabilities.viva'],
          missingMappings: [{ field: 'products', value: null }],
        },
      },
    ] as const;

    variants.forEach(({ label, assessment }) => {
      const parsed = AnalysisRecordSchema.parse({
        ...noAI,
        impactAssessment: assessment,
      });
      expect(parsed.impactAssessment.state).toBe('INSUFFICIENT_CONTEXT');

      const roundTripped = AnalysisRecordSchema.parse(
        JSON.parse(JSON.stringify(parsed)),
      );
      expect(roundTripped).toEqual(parsed);
      expect(roundTripped.impactAssessment).toEqual(assessment);

      // Mapping gaps stay structurally separate from evidence IDs and are
      // never interpreted as provenance references.
      expect(
        'evidence' in roundTripped.impactAssessment,
        `${label} variant must not carry an evidence list`,
      ).toBe(false);
    });

    // Reverting to the original assessment keeps the record valid, so the
    // new states do not disturb the existing contract.
    expect(
      AnalysisRecordSchema.parse({
        ...noAI,
        impactAssessment: existingAssessment,
      }),
    ).toMatchObject({
      impactAssessment: { state: 'NOT_APPLICABLE' },
    });
  });

  it('rejects an AI-enabled analysis when its AI record is missing', () => {
    const withAI = asRecord(readFixture('analysis-record-ai.json'));
    const recordsWithoutAI = recordsFrom(withAI).filter(
      (record) => asRecord(record).kind !== 'ai_inference',
    );

    expect(
      AnalysisRecordSchema.safeParse({
        ...withAI,
        provenanceRecords: recordsWithoutAI,
      }).success,
    ).toBe(false);
  });

  it('rejects tenant and policy version mismatches', () => {
    const fixture = asRecord(readFixture('analysis-record-ai.json'));
    const records = recordsFrom(fixture);

    expect(
      AnalysisRecordSchema.safeParse({
        ...fixture,
        provenanceRecords: records.map((record, index) =>
          index === 1
            ? {
                ...asRecord(record),
                tenantProfileVersion: 'different-profile-version',
              }
            : record,
        ),
      }).success,
    ).toBe(false);
    expect(
      AnalysisRecordSchema.safeParse({
        ...fixture,
        provenanceRecords: records.map((record, index) =>
          index === 2
            ? {
                ...asRecord(record),
                policyRulesVersion: 'different-policy-version',
              }
            : record,
        ),
      }).success,
    ).toBe(false);
  });

  it('validates deterministic conclusions against their owning policy kind', () => {
    const fixture = asRecord(readFixture('analysis-record-ai.json'));
    const records = recordsFrom(fixture);
    const deterministic = asRecord(records[2]);
    const versionBundle = asRecord(fixture.versionBundle);
    const policyVersions = asRecord(versionBundle.policyVersions);

    expect(
      AnalysisRecordSchema.safeParse({
        ...fixture,
        provenanceRecords: records.map((record, index) =>
          index === 2
            ? {
                ...deterministic,
                policyKind: 'risk_policy',
              }
            : record,
        ),
      }).success,
    ).toBe(false);
    expect(
      AnalysisRecordSchema.safeParse({
        ...fixture,
        provenanceRecords: records.map((record, index) =>
          index === 2
            ? {
                ...deterministic,
                policyRulesVersion: 'third-policy-version',
              }
            : record,
        ),
      }).success,
    ).toBe(false);

    const riskOwned = AnalysisRecordSchema.parse({
      ...fixture,
      provenanceRecords: records.map((record, index) =>
        index === 2
          ? {
              ...deterministic,
              policyKind: 'risk_policy',
              policyRulesVersion: policyVersions.riskPolicyRulesVersion,
            }
          : record,
      ),
    });
    expect(riskOwned.provenanceRecords[2]).toMatchObject({
      policyKind: 'risk_policy',
      policyRulesVersion: 'policy-2026-08',
    });
  });
});
