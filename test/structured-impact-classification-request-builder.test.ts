import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ChangeEventSchema,
  DeterministicImpactDecisionSchema,
  FactObservationSchema,
  RiskPolicySchema,
  StructuredImpactClassificationRequestSchema,
  TenantApplicabilityPolicySchema,
  TenantProfileSchema,
  createDeterministicImpactDecision,
  createStructuredImpactClassificationRequest,
  evaluateRiskPolicy,
  evaluateTenantApplicability,
  type ChangeEvent,
  type DeterministicImpactDecision,
  type StructuredImpactClassificationRequest,
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
  profile: TenantProfile,
): DeterministicImpactDecision {
  return createDeterministicImpactDecision(
    evaluateRiskPolicy(riskPolicy, event),
    evaluateTenantApplicability(tenantPolicy, event, profile),
  );
}

function buildFor(
  event: ChangeEvent,
  profile: TenantProfile,
  decision = decisionFor(event, profile),
): StructuredImpactClassificationRequest {
  return createStructuredImpactClassificationRequest(
    event,
    'message-v1',
    profile,
    decision,
  );
}

function recordById(
  request: StructuredImpactClassificationRequest,
  evidenceId: string,
) {
  const record = request.evidenceRecords.find(
    (candidate) => candidate.evidenceId === evidenceId,
  );
  if (record === undefined) {
    throw new Error(`missing evidence record: ${evidenceId}`);
  }
  return record;
}

function corpusChanges(): ChangeEvent[] {
  return readdirSync(resolve(process.cwd(), 'corpus/changes'))
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const fixture = readJson(
        join(resolve(process.cwd(), 'corpus/changes'), name),
      ) as {
        event: unknown;
      };
      return ChangeEventSchema.parse(fixture.event);
    });
}

function corpusProfiles(): TenantProfile[] {
  return readdirSync(resolve(process.cwd(), 'corpus/tenant-profiles'))
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const fixture = readJson(
        join(resolve(process.cwd(), 'corpus/tenant-profiles'), name),
      ) as { profile: unknown };
      return TenantProfileSchema.parse(fixture.profile);
    });
}

describe('structured classification request builder', () => {
  it('builds and round-trips CLASSIFICATION_REQUIRED and GUARDRAIL_FLOOR requests', () => {
    const classificationEvent = eventWith({
      severity: 'low',
      signals: { ...baseEvent.signals, hasAdminImpact: false },
    });
    const classificationDecision = decisionFor(
      classificationEvent,
      baseProfile,
    );
    expect(classificationDecision.kind).toBe('CLASSIFICATION_REQUIRED');

    const classificationRequest = buildFor(
      classificationEvent,
      baseProfile,
      classificationDecision,
    );
    expect(
      StructuredImpactClassificationRequestSchema.parse(
        JSON.parse(JSON.stringify(classificationRequest)),
      ),
    ).toEqual(classificationRequest);

    const guardrailEvent = eventWith({
      severity: 'high',
      signals: { ...baseEvent.signals, isMajorChange: true },
    });
    const guardrailDecision = decisionFor(guardrailEvent, baseProfile);
    expect(guardrailDecision.kind).toBe('GUARDRAIL_FLOOR');
    const guardrailDecisionBefore = clone(guardrailDecision);
    const guardrailRequest = buildFor(
      guardrailEvent,
      baseProfile,
      guardrailDecision,
    );
    expect(guardrailRequest.decision.kind).toBe('GUARDRAIL_FLOOR');
    expect(
      StructuredImpactClassificationRequestSchema.parse(
        JSON.parse(JSON.stringify(guardrailRequest)),
      ),
    ).toEqual(guardrailRequest);
    expect(guardrailDecision).toEqual(guardrailDecisionBefore);
  });

  it('uses fixed evidence order and policy-owned conclusion dependencies', () => {
    const event = eventWith({
      severity: 'high',
      signals: { ...baseEvent.signals, isMajorChange: true },
    });
    const request = buildFor(event, baseProfile);
    const ids = request.evidenceRecords.map((record) => record.evidenceId);

    expect(ids.slice(0, 9)).toEqual([
      'source.event.title',
      'source.event.body',
      'source.event.publishedAt',
      'source.event.updatedAt',
      'source.event.products',
      'source.event.categories',
      'source.event.severity',
      'source.event.signals',
      'source.event.sourceMetadata',
    ]);
    expect(ids.slice(9, 16)).toEqual([
      'tenant.profile.organization',
      'tenant.profile.services',
      'tenant.profile.environment',
      'tenant.profile.capabilities',
      'tenant.profile.ownership',
      'tenant.profile.changePolicy',
      'tenant.profile.maintenance',
    ]);
    expect(new Set(ids).size).toBe(ids.length);

    const riskConclusions = request.evidenceRecords.filter(
      (record) =>
        record.kind === 'deterministic_conclusion' &&
        record.policyKind === 'risk_policy',
    );
    const tenantConclusions = request.evidenceRecords.filter(
      (record) =>
        record.kind === 'deterministic_conclusion' &&
        record.policyKind === 'tenant_applicability_policy',
    );
    expect(riskConclusions.length).toBe(riskPolicy.rules.length);
    expect(tenantConclusions.length).toBe(tenantPolicy.rules.length);
    expect(riskConclusions[0]).toMatchObject({
      evidenceId: 'decision.risk.0',
      policyRulesVersion: riskPolicy.policyRulesVersion,
      ruleId: 'major-change',
    });
    expect(tenantConclusions[0]).toMatchObject({
      evidenceId: 'decision.tenant.0',
      policyRulesVersion: tenantPolicy.policyRulesVersion,
      ruleId: 'synthetic-teams',
      dependsOnEvidenceIds: ['source.event.products', 'tenant.condition.0.0'],
    });

    const riskAtomIds = request.evidenceRecords
      .filter(
        (record) =>
          record.kind === 'source_fact' &&
          record.evidenceId === 'source.severity.at-least-high',
      )
      .map((record) => record.evidenceId);
    expect(riskAtomIds).toEqual(['source.severity.at-least-high']);
  });

  it('preserves absent versus present-null source fields and tenant false values', () => {
    const nullEvent = eventWith({ severity: null });
    const nullRequest = buildFor(
      eventWith({
        severity: 'high',
        signals: { ...baseEvent.signals, isMajorChange: true },
      }),
      baseProfile,
    );
    expect(recordById(nullRequest, 'source.event.severity')).toMatchObject({
      observation: { presence: 'present', value: 'high' },
    });

    const explicitNullRequest = buildFor(
      nullEvent,
      baseProfile,
      decisionFor(nullEvent, baseProfile),
    );
    expect(
      recordById(explicitNullRequest, 'source.event.severity'),
    ).toMatchObject({
      observation: { presence: 'present', value: null },
    });

    const absentRaw: Record<string, unknown> = {
      ...baseEvent,
      products: ['Synthetic Teams'],
    };
    delete absentRaw.severity;
    delete absentRaw.signals;
    const absentEvent = ChangeEventSchema.parse(absentRaw);
    const absentRequest = buildFor(absentEvent, baseProfile);
    expect(recordById(absentRequest, 'source.event.severity')).toMatchObject({
      observation: { presence: 'absent' },
    });
    expect(recordById(absentRequest, 'source.event.signals')).toMatchObject({
      observation: { presence: 'absent' },
    });

    const falseProfile = TenantProfileSchema.parse({
      ...baseProfile,
      services: { ...baseProfile.services, teams: false },
    });
    const falseDecision = decisionFor(
      eventWith({
        severity: 'high',
        signals: { ...baseEvent.signals, isMajorChange: true },
      }),
      falseProfile,
    );
    const falseRequest = buildFor(
      eventWith({
        severity: 'high',
        signals: { ...baseEvent.signals, isMajorChange: true },
      }),
      falseProfile,
      falseDecision,
    );
    expect(recordById(falseRequest, 'tenant.condition.0.0')).toMatchObject({
      observation: { presence: 'present', value: false },
    });

    const missingProfile = TenantProfileSchema.parse({
      ...baseProfile,
      services: Object.fromEntries(
        Object.entries(baseProfile.services).filter(([key]) => key !== 'teams'),
      ),
    });
    const missingDecision = decisionFor(
      eventWith({
        severity: 'high',
        signals: { ...baseEvent.signals, isMajorChange: true },
      }),
      missingProfile,
    );
    const missingRequest = buildFor(
      eventWith({
        severity: 'high',
        signals: { ...baseEvent.signals, isMajorChange: true },
      }),
      missingProfile,
      missingDecision,
    );
    expect(recordById(missingRequest, 'tenant.condition.0.0')).toMatchObject({
      observation: { presence: 'absent' },
    });
  });

  it('rejects final decisions and incomplete or unsafe evaluated paths', () => {
    const event = eventWith({
      severity: 'low',
      signals: { ...baseEvent.signals, hasAdminImpact: false },
    });
    const finalDecision = decisionFor(
      event,
      TenantProfileSchema.parse({
        ...baseProfile,
        services: { ...baseProfile.services, teams: false },
      }),
    );
    expect(finalDecision.kind).toBe('DETERMINISTIC_FINAL');
    expect(() => buildFor(event, baseProfile, finalDecision)).toThrow();
    expect(() =>
      createStructuredImpactClassificationRequest(
        event,
        '',
        baseProfile,
        decisionFor(event, baseProfile),
      ),
    ).toThrow();

    const guardrailEvent = eventWith({
      severity: 'high',
      signals: { ...baseEvent.signals, isMajorChange: true },
    });
    const decision = decisionFor(guardrailEvent, baseProfile);
    const missingAtoms = clone(decision) as unknown as Record<string, unknown>;
    const missingRisk = missingAtoms.riskEvaluation as Record<string, unknown>;
    const missingRules = missingRisk.ruleResults as Array<
      Record<string, unknown>
    >;
    const firstRule = missingRules[0];
    if (firstRule === undefined) throw new Error('risk rule result missing');
    const withoutAtoms = { ...firstRule };
    delete withoutAtoms.atomResults;
    missingRisk.ruleResults = [withoutAtoms, ...missingRules.slice(1)];
    expect(() =>
      buildFor(
        guardrailEvent,
        baseProfile,
        DeterministicImpactDecisionSchema.parse(missingAtoms),
      ),
    ).toThrow();

    const unsafePath = clone(decision) as unknown as Record<string, unknown>;
    const unsafeRisk = unsafePath.riskEvaluation as Record<string, unknown>;
    const unsafeRules = unsafeRisk.ruleResults as Array<
      Record<string, unknown>
    >;
    const unsafeFirst = unsafeRules[0];
    if (unsafeFirst === undefined || !Array.isArray(unsafeFirst.atomResults)) {
      throw new Error('risk atom result missing');
    }
    unsafeFirst.atomResults = [
      {
        ...unsafeFirst.atomResults[0],
        field: 'metadata',
        path: 'sourceMetadata.foo',
      },
      ...unsafeFirst.atomResults.slice(1),
    ];
    expect(() =>
      buildFor(
        guardrailEvent,
        baseProfile,
        DeterministicImpactDecisionSchema.parse(unsafePath),
      ),
    ).toThrow();

    const conflicting = clone(decision) as unknown as Record<string, unknown>;
    const conflictingRisk = conflicting.riskEvaluation as Record<
      string,
      unknown
    >;
    const conflictingRules = conflictingRisk.ruleResults as Array<
      Record<string, unknown>
    >;
    const severityRule = conflictingRules.find(
      (rule) =>
        Array.isArray(rule.atomResults) &&
        rule.atomResults.some(
          (atom: Record<string, unknown>) =>
            atom.evidenceId === 'source.severity.at-least-high',
        ),
    );
    if (
      severityRule === undefined ||
      !Array.isArray(severityRule.atomResults)
    ) {
      throw new Error('severity atom result missing');
    }
    const conflictingAtom = severityRule.atomResults.find(
      (atom: Record<string, unknown>) =>
        atom.evidenceId === 'source.severity.at-least-high',
    ) as Record<string, unknown> | undefined;
    if (conflictingAtom === undefined) throw new Error('severity atom missing');
    conflictingAtom.field = 'hasAdminImpact';
    conflictingAtom.path = 'signals.hasAdminImpact';
    expect(() =>
      buildFor(
        guardrailEvent,
        baseProfile,
        DeterministicImpactDecisionSchema.parse(conflicting),
      ),
    ).toThrow();
  });

  it('rejects tenant condition results that disagree with the actual profile', () => {
    const event = eventWith({
      severity: 'high',
      signals: { ...baseEvent.signals, isMajorChange: true },
      products: ['Synthetic Teams', 'Synthetic Exchange'],
    });
    const decision = decisionFor(event, baseProfile);
    if (decision.tenantApplicability.status !== 'APPLICABLE') {
      throw new Error('expected multiple matched tenant selectors');
    }

    const mutated = clone(decision) as unknown as Record<string, unknown>;
    const tenantResult = mutated.tenantApplicability as Record<string, unknown>;
    const ruleResults = tenantResult.ruleResults as Array<
      Record<string, unknown>
    >;
    const firstRule = ruleResults[0];
    if (firstRule === undefined || !Array.isArray(firstRule.conditionResults)) {
      throw new Error('matched tenant condition missing');
    }
    firstRule.conditionGroupStatus = 'NO_MATCH';
    firstRule.conditionResults = [
      {
        ...firstRule.conditionResults[0],
        status: 'NO_MATCH',
        observed: false,
        reason: 'mutated result',
      },
    ];
    tenantResult.evidence = ['services.exchange_online'];
    expect(() =>
      buildFor(
        event,
        baseProfile,
        DeterministicImpactDecisionSchema.parse(mutated),
      ),
    ).toThrow();
  });

  it('is non-mutating and deterministic for all 50 changes x 10 profiles', () => {
    const changes = corpusChanges();
    const profiles = corpusProfiles();
    expect(changes).toHaveLength(50);
    expect(profiles).toHaveLength(10);

    let built = 0;
    let rejectedFinal = 0;
    changes.forEach((event) => {
      profiles.forEach((profile) => {
        const inputEvent = clone(event);
        const inputProfile = clone(profile);
        const decision = decisionFor(inputEvent, inputProfile);
        if (decision.kind === 'DETERMINISTIC_FINAL') {
          expect(() => buildFor(inputEvent, inputProfile, decision)).toThrow();
          rejectedFinal += 1;
          return;
        }

        const eventBefore = clone(inputEvent);
        const profileBefore = clone(inputProfile);
        const first = buildFor(inputEvent, inputProfile, decision);
        const second = buildFor(inputEvent, inputProfile, decision);
        expect(first).toEqual(second);
        expect(inputEvent).toEqual(eventBefore);
        expect(inputProfile).toEqual(profileBefore);
        expect(
          StructuredImpactClassificationRequestSchema.parse(first),
        ).toEqual(first);
        built += 1;
      });
    });

    expect(built + rejectedFinal).toBe(500);
    expect(built).toBeGreaterThan(0);
    expect(rejectedFinal).toBeGreaterThan(0);
  });

  it('keeps FactObservation JSON forms distinct', () => {
    const present = FactObservationSchema.parse({
      presence: 'present',
      value: null,
    });
    const absent = FactObservationSchema.parse({ presence: 'absent' });
    expect(present).not.toEqual(absent);
    expect(JSON.stringify(present)).not.toBe(JSON.stringify(absent));
  });
});
