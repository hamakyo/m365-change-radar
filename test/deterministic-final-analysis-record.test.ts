import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AnalysisRecordSchema,
  ChangeEventSchema,
  DeterministicImpactDecisionSchema,
  ProvenanceRecordSchema,
  RiskPolicySchema,
  TenantApplicabilityPolicySchema,
  TenantProfileSchema,
  createDeterministicEvidenceRecords,
  createDeterministicFinalAnalysisRecord,
  createDeterministicImpactDecision,
  evaluateRiskPolicy,
  evaluateTenantApplicability,
  type AnalysisRecord,
  type ChangeEvent,
  type DeterministicFinalAnalysisMetadata,
  type DeterministicImpactDecision,
  type TenantProfile,
} from '../src/index.js';

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function readFixture(name: string, directory: string): unknown {
  return readJson(join(resolve(process.cwd(), directory), name));
}

const metadata: DeterministicFinalAnalysisMetadata = {
  analysisId: 'analysis-deterministic-final-001',
  tenantId: 'tenant-under-test',
  createdAt: '2026-08-27T09:30:00+09:00',
};

const riskPolicy = RiskPolicySchema.parse(
  readJson(join(resolve(process.cwd(), 'test/fixtures'), 'risk-policy.json')),
);
const tenantApplicabilityPolicy = TenantApplicabilityPolicySchema.parse(
  readJson(
    join(
      resolve(process.cwd(), 'test/fixtures'),
      'tenant-applicability-policy.json',
    ),
  ),
);
const baseEvent = ChangeEventSchema.parse(
  readFixture('change-event.json', 'test/fixtures'),
);
const baseProfile = TenantProfileSchema.parse(
  readFixture('tenant-profile.json', 'test/fixtures'),
);

type FinalDecision = Extract<
  DeterministicImpactDecision,
  { kind: 'DETERMINISTIC_FINAL' }
>;

interface FinalScenario {
  event: ChangeEvent;
  profile: TenantProfile;
  decision: FinalDecision;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function decisionFor(
  event: ChangeEvent,
  profile: TenantProfile = baseProfile,
): DeterministicImpactDecision {
  return DeterministicImpactDecisionSchema.parse(
    createDeterministicImpactDecision(
      evaluateRiskPolicy(riskPolicy, event),
      evaluateTenantApplicability(tenantApplicabilityPolicy, event, profile),
    ),
  );
}

function finalFor(
  event: ChangeEvent,
  profile: TenantProfile = baseProfile,
): FinalDecision {
  const decision = decisionFor(event, profile);
  if (decision.kind !== 'DETERMINISTIC_FINAL') {
    throw new Error(
      `expected a DETERMINISTIC_FINAL decision, got ${decision.kind}`,
    );
  }
  return decision;
}

/** Fully reported, clearly negative signals keep the risk policy from
 * establishing any floor so tenant-side finals can be isolated. */
const calmSignals = {
  isMajorChange: false,
  actionRequiredBy: null,
  hasAdminImpact: false,
  isRetirementOrDeprecation: false,
  hasSecurityImpact: false,
  hasPrivacyImpact: false,
  hasComplianceImpact: false,
  tags: [],
} as const;

function eventWith(overrides: Record<string, unknown>): ChangeEvent {
  return ChangeEventSchema.parse({
    ...baseEvent,
    severity: 'low',
    signals: calmSignals,
    ...overrides,
  });
}

function profileWithoutServiceKey(
  profile: TenantProfile,
  key: string,
): TenantProfile {
  return TenantProfileSchema.parse({
    ...profile,
    services: Object.fromEntries(
      Object.entries(profile.services).filter(([entry]) => entry !== key),
    ),
  });
}

function scenarioFor(
  event: ChangeEvent,
  profile: TenantProfile,
): FinalScenario {
  return { event, profile, decision: finalFor(event, profile) };
}

function notApplicableScenario(): FinalScenario {
  return scenarioFor(
    eventWith({
      products: ['Synthetic Teams'],
      categories: ['collaboration'],
    }),
    TenantProfileSchema.parse({
      ...baseProfile,
      services: { ...baseProfile.services, teams: false },
    }),
  );
}

function insufficientContextScenario(): FinalScenario {
  return scenarioFor(
    eventWith({ products: ['Synthetic Teams'], categories: [] }),
    profileWithoutServiceKey(baseProfile, 'teams'),
  );
}

function mappingOnlyScenario(): FinalScenario {
  return scenarioFor(
    eventWith({ products: ['Unmapped Product'], categories: [] }),
    baseProfile,
  );
}

function pathOnlyScenario(): FinalScenario {
  return scenarioFor(
    eventWith({ products: ['Synthetic Stream'], categories: [] }),
    profileWithoutServiceKey(baseProfile, 'stream'),
  );
}

function combinedScenario(): FinalScenario {
  return scenarioFor(
    eventWith({
      products: ['Synthetic Teams', 'Unmapped Product'],
      categories: [],
    }),
    profileWithoutServiceKey(baseProfile, 'teams'),
  );
}

function buildRecord(scenario: FinalScenario): AnalysisRecord {
  return createDeterministicFinalAnalysisRecord(
    scenario.event,
    'message-v1',
    scenario.profile,
    scenario.decision,
    metadata,
  );
}

describe('createDeterministicFinalAnalysisRecord', () => {
  it('builds a schema-valid NOT_APPLICABLE record with exact evidence selection and order', () => {
    const { decision } = notApplicableScenario();
    const record = buildRecord(notApplicableScenario());

    expect(record.impactAssessment.state).toBe('NOT_APPLICABLE');
    expect(record.impactAssessment.reason).toBe(
      decision.tenantApplicability.reason,
    );
    expect(AnalysisRecordSchema.safeParse(record).success).toBe(true);

    const expectedIds = decision.tenantApplicability.ruleResults.flatMap(
      (ruleResult, ruleIndex) =>
        ruleResult.selectorStatus === 'MATCH' &&
        ruleResult.conditionGroupStatus === 'NO_MATCH'
          ? [`decision.tenant.${ruleIndex}`]
          : [],
    );
    expect(expectedIds.length).toBeGreaterThan(0);

    if (record.impactAssessment.state !== 'NOT_APPLICABLE') {
      throw new Error('expected NOT_APPLICABLE assessment');
    }
    const finalEvidence = record.impactAssessment.evidence;
    expect(finalEvidence).toEqual(expectedIds);
    expect(finalEvidence.every((id) => id.startsWith('decision.tenant.'))).toBe(
      true,
    );

    record.provenanceRecords.forEach((provenance) => {
      if (
        provenance.kind === 'deterministic_conclusion' &&
        provenance.policyKind === 'risk_policy'
      ) {
        expect(
          finalEvidence.includes(provenance.evidenceId),
          `risk conclusion ${provenance.evidenceId} must stay out of the final evidence`,
        ).toBe(false);
      }
      if (
        provenance.kind === 'deterministic_conclusion' &&
        provenance.policyKind === 'tenant_applicability_policy' &&
        provenance.conclusion.startsWith('selector NO_MATCH')
      ) {
        expect(
          finalEvidence.includes(provenance.evidenceId),
          'selector-only NO_MATCH conclusions must stay out of the final evidence',
        ).toBe(false);
      }
    });
  });

  it('requires at least one supporting rule behind the NOT_APPLICABLE evidence', () => {
    const { decision } = notApplicableScenario();
    const applicability = decision.tenantApplicability;
    if (applicability.status !== 'NOT_APPLICABLE') {
      throw new Error('expected NOT_APPLICABLE applicability status');
    }

    const record = buildRecord(notApplicableScenario());
    if (record.impactAssessment.state !== 'NOT_APPLICABLE') {
      throw new Error('expected NOT_APPLICABLE assessment');
    }
    expect(record.impactAssessment.state).toBe(applicability.status);
    expect(applicability.reason.length).toBeGreaterThan(0);
    expect(
      applicability.ruleResults.some((ruleResult) => {
        return (
          ruleResult.selectorStatus === 'MATCH' &&
          ruleResult.conditionGroupStatus === 'NO_MATCH'
        );
      }),
    ).toBe(true);
    expect(record.impactAssessment.evidence.length).toBeGreaterThan(0);
  });

  it('losslessly copies a mapping-only INSUFFICIENT_CONTEXT variant without evidence', () => {
    const { decision } = mappingOnlyScenario();
    const { event, profile } = mappingOnlyScenario();
    const applicability = decision.tenantApplicability;
    if (applicability.status !== 'INSUFFICIENT_CONTEXT') {
      throw new Error('expected INSUFFICIENT_CONTEXT applicability status');
    }
    if (applicability.missingMappings === undefined) {
      throw new Error('expected a non-empty missingMappings list');
    }
    if (applicability.missingContext !== undefined) {
      throw new Error(
        'mapping-only fixture unexpectedly carries missingContext',
      );
    }

    const record = createDeterministicFinalAnalysisRecord(
      event,
      'message-v1',
      profile,
      decision,
      metadata,
    );

    if (record.impactAssessment.state !== 'INSUFFICIENT_CONTEXT') {
      throw new Error('expected INSUFFICIENT_CONTEXT assessment');
    }
    expect(record.impactAssessment.reason).toBe(applicability.reason);
    expect(Object.hasOwn(record.impactAssessment, 'evidence')).toBe(false);
    expect(Object.hasOwn(record.impactAssessment, 'missingContext')).toBe(
      false,
    );
    expect(record.impactAssessment.missingMappings ?? []).toEqual(
      applicability.missingMappings,
    );
    expect(
      Object.keys(record.impactAssessment).filter((key) =>
        key.startsWith('missing'),
      ),
    ).toEqual(['missingMappings']);
  });

  it('losslessly copies a path-only INSUFFICIENT_CONTEXT variant without evidence', () => {
    const { decision } = pathOnlyScenario();
    const { event, profile } = pathOnlyScenario();
    const applicability = decision.tenantApplicability;
    if (applicability.status !== 'INSUFFICIENT_CONTEXT') {
      throw new Error('expected INSUFFICIENT_CONTEXT applicability status');
    }
    if (applicability.missingContext === undefined) {
      throw new Error('expected a non-empty missingContext list');
    }
    if (applicability.missingMappings !== undefined) {
      throw new Error('path-only fixture unexpectedly carries missingMappings');
    }

    const record = createDeterministicFinalAnalysisRecord(
      event,
      'message-v1',
      profile,
      decision,
      metadata,
    );

    if (record.impactAssessment.state !== 'INSUFFICIENT_CONTEXT') {
      throw new Error('expected INSUFFICIENT_CONTEXT assessment');
    }
    expect(record.impactAssessment.missingContext ?? []).toEqual(
      applicability.missingContext,
    );
    expect(
      (record.impactAssessment.missingContext ?? []).length,
    ).toBeGreaterThan(0);
    expect(Object.hasOwn(record.impactAssessment, 'missingMappings')).toBe(
      false,
    );
    expect(Object.hasOwn(record.impactAssessment, 'evidence')).toBe(false);
    expect(
      Object.keys(record.impactAssessment).filter((key) =>
        key.startsWith('missing'),
      ),
    ).toEqual(['missingContext']);
  });

  it('losslessly copies the combined path-and-mapping variant preserving order and null sentinels', () => {
    const { decision } = combinedScenario();
    const { event, profile } = combinedScenario();
    const applicability = decision.tenantApplicability;
    if (applicability.status !== 'INSUFFICIENT_CONTEXT') {
      throw new Error('expected INSUFFICIENT_CONTEXT applicability status');
    }
    if (applicability.missingContext === undefined) {
      throw new Error('expected a non-empty missingContext list');
    }
    if (applicability.missingMappings === undefined) {
      throw new Error('expected a non-empty missingMappings list');
    }

    const record = createDeterministicFinalAnalysisRecord(
      event,
      'message-v1',
      profile,
      decision,
      metadata,
    );

    if (record.impactAssessment.state !== 'INSUFFICIENT_CONTEXT') {
      throw new Error('expected INSUFFICIENT_CONTEXT assessment');
    }
    const copiedContext = record.impactAssessment.missingContext;
    const copiedMappings = record.impactAssessment.missingMappings;
    if (copiedContext === undefined || copiedMappings === undefined) {
      throw new Error('combined copy lost one of its insufficiency fields');
    }
    expect(copiedContext).toEqual(applicability.missingContext);
    expect(copiedMappings).toEqual(applicability.missingMappings);
    expect(copiedContext).toEqual(['services.teams']);
    expect(copiedMappings).toContainEqual({
      field: 'products',
      value: 'Unmapped Product',
    });
    expect(copiedMappings.map((gap) => gap.field)).toEqual(
      applicability.missingMappings.map((gap) => gap.field),
    );
    expect(Object.hasOwn(record.impactAssessment, 'evidence')).toBe(false);
  });

  it('keeps the null empty-selector sentinel distinct from the literal "null" string', () => {
    const emptySelectorEvent = eventWith({ products: [], categories: [] });
    const emptySelectorDecision = finalFor(emptySelectorEvent);
    if (
      emptySelectorDecision.tenantApplicability.status !==
      'INSUFFICIENT_CONTEXT'
    ) {
      throw new Error('expected an empty-selector insufficiency decision');
    }
    const emptyGaps =
      emptySelectorDecision.tenantApplicability.missingMappings ?? [];
    if (!emptyGaps.some((gap) => gap.value === null)) {
      throw new Error('expected a null sentinel for an empty selector field');
    }

    const record = createDeterministicFinalAnalysisRecord(
      emptySelectorEvent,
      'message-v1',
      baseProfile,
      emptySelectorDecision,
      metadata,
    );

    if (record.impactAssessment.state !== 'INSUFFICIENT_CONTEXT') {
      throw new Error('expected INSUFFICIENT_CONTEXT assessment');
    }
    const copiedMappings = record.impactAssessment.missingMappings;
    if (copiedMappings === undefined) {
      throw new Error('the copy lost missingMappings');
    }
    expect(copiedMappings).toEqual(emptyGaps);
    expect(copiedMappings.some((gap) => gap.value === null)).toBe(true);
    expect(copiedMappings.some((gap) => gap.value === 'null')).toBe(false);
  });

  it('delegates provenance to createDeterministicEvidenceRecords without reordering', () => {
    const scenario = notApplicableScenario();
    const expectedProvenance = createDeterministicEvidenceRecords(
      scenario.event,
      'message-v1',
      scenario.profile,
      scenario.decision,
    );
    const record = buildRecord(scenario);

    expect(record.provenanceRecords).toEqual(expectedProvenance);
    expect(record.provenanceRecords.length).toBeGreaterThan(10);

    const evidenceIds = new Set(
      record.provenanceRecords.map((provenance) => provenance.evidenceId),
    );
    record.provenanceRecords.forEach((provenance) => {
      expect(ProvenanceRecordSchema.parse(provenance)).toEqual(provenance);
      if (provenance.kind === 'deterministic_conclusion') {
        provenance.dependsOnEvidenceIds.forEach((dependencyId) => {
          expect(evidenceIds.has(dependencyId)).toBe(true);
        });
      }
    });
  });

  it('never emits AIInference records and pins ai.used to false', () => {
    const record = buildRecord(insufficientContextScenario());

    expect(record.versionBundle.ai).toEqual({ used: false });
    expect(
      record.provenanceRecords.some(
        (provenance) => provenance.kind === 'ai_inference',
      ),
    ).toBe(false);
  });

  it('derives every version bundle entry and changeEventRef from its input', () => {
    const scenario = notApplicableScenario();
    const record = buildRecord(scenario);

    expect(record.versionBundle).toEqual({
      sourceMessageVersion: 'message-v1',
      tenantProfileVersion: scenario.profile.profileVersion,
      policyVersions: {
        riskPolicyRulesVersion:
          scenario.decision.riskEvaluation.policyRulesVersion,
        tenantApplicabilityPolicyRulesVersion:
          scenario.decision.tenantApplicability.policyRulesVersion,
      },
      ai: { used: false },
    });
    expect(record.changeEventRef).toEqual({
      source: scenario.event.source,
      externalId: scenario.event.externalId,
      sourceMessageVersion: 'message-v1',
    });
  });

  it('uses the caller-supplied metadata verbatim', () => {
    const record = buildRecord(notApplicableScenario());
    expect(record.analysisId).toBe(metadata.analysisId);
    expect(record.tenantId).toBe(metadata.tenantId);
    expect(record.createdAt).toBe(metadata.createdAt);
  });

  it('reproduces deep-equal records from cloned inputs and round-trips through JSON', () => {
    const scenario = insufficientContextScenario();
    const first = buildRecord(scenario);
    const second = createDeterministicFinalAnalysisRecord(
      clone(scenario.event),
      'message-v1',
      clone(scenario.profile),
      clone(scenario.decision),
      clone(metadata),
    );

    expect(second).toEqual(first);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });

  it('does not mutate any of its inputs while building the record', () => {
    const scenario = notApplicableScenario();
    const eventSnapshot = JSON.stringify(scenario.event);
    const profileSnapshot = JSON.stringify(scenario.profile);
    const decisionSnapshot = JSON.stringify(scenario.decision);
    const metadataSnapshot = JSON.stringify(metadata);

    buildRecord(scenario);

    expect(JSON.stringify(scenario.event)).toBe(eventSnapshot);
    expect(JSON.stringify(scenario.profile)).toBe(profileSnapshot);
    expect(JSON.stringify(scenario.decision)).toBe(decisionSnapshot);
    expect(JSON.stringify(metadata)).toBe(metadataSnapshot);
  });

  it('rejects GUARDRAIL_FLOOR and CLASSIFICATION_REQUIRED decisions by identity', () => {
    const reviewFloorEvent = eventWith({
      severity: 'high',
      signals: { isMajorChange: true },
    });
    const guardrail = decisionFor(reviewFloorEvent);
    expect(guardrail.kind).toBe('GUARDRAIL_FLOOR');
    expect(() =>
      createDeterministicFinalAnalysisRecord(
        reviewFloorEvent,
        'message-v1',
        baseProfile,
        guardrail,
        metadata,
      ),
    ).toThrow(/DETERMINISTIC_FINAL/);

    // The base fixture leaves the tenant applicable under its Synthetic Teams
    // selector, so its floor-free decision routes to the classifier instead
    // of a final state.
    const classificationEvent = eventWith({ products: ['Synthetic Teams'] });
    const classification = decisionFor(classificationEvent);
    expect(classification.kind).toBe('CLASSIFICATION_REQUIRED');
    expect(() =>
      createDeterministicFinalAnalysisRecord(
        classificationEvent,
        'message-v1',
        baseProfile,
        classification,
        metadata,
      ),
    ).toThrow(/DETERMINISTIC_FINAL/);
  });

  it('rejects structurally invalid decisions before building evidence', () => {
    const scenario = notApplicableScenario();

    const tamperedState = clone(scenario.decision) as unknown as Record<
      string,
      unknown
    >;
    tamperedState.state = 'NOT_THE_FINAL_YOU_ARE_LOOKING_FOR';
    expect(() =>
      createDeterministicFinalAnalysisRecord(
        scenario.event,
        'message-v1',
        scenario.profile,
        tamperedState as unknown as DeterministicImpactDecision,
        metadata,
      ),
    ).toThrow();

    const tamperedReason = clone(scenario.decision) as unknown as Record<
      string,
      unknown
    >;
    delete tamperedReason.reason;
    expect(() =>
      createDeterministicFinalAnalysisRecord(
        scenario.event,
        'message-v1',
        scenario.profile,
        tamperedReason as unknown as DeterministicImpactDecision,
        metadata,
      ),
    ).toThrow();

    expect(() =>
      createDeterministicFinalAnalysisRecord(
        scenario.event,
        'message-v1',
        scenario.profile,
        'DETERMINISTIC_FINAL' as unknown as DeterministicImpactDecision,
        metadata,
      ),
    ).toThrow(TypeError);

    expect(() =>
      createDeterministicFinalAnalysisRecord(
        scenario.event,
        'message-v1',
        scenario.profile,
        null as unknown as DeterministicImpactDecision,
        metadata,
      ),
    ).toThrow(TypeError);

    expect(() =>
      createDeterministicFinalAnalysisRecord(
        scenario.event,
        'message-v1',
        scenario.profile,
        undefined as unknown as DeterministicImpactDecision,
        metadata,
      ),
    ).toThrow(TypeError);
  });

  it('rejects decisions that disagree with their inputs', () => {
    // Scenario A: a teams=false tenant produced the decision; a teams=true
    // tenant makes the recorded NO_MATCH verdict disagree with the profile.
    const scenario = notApplicableScenario();
    const mismatchedProfile = TenantProfileSchema.parse({
      ...baseProfile,
      services: { ...baseProfile.services, teams: true },
    });
    expect(() =>
      createDeterministicFinalAnalysisRecord(
        scenario.event,
        'message-v1',
        mismatchedProfile,
        scenario.decision,
        metadata,
      ),
    ).toThrow();

    // Scenario B: a risk evaluation that actually established a floor cannot
    // be spliced into a DETERMINISTIC_FINAL decision.
    const floorEvent = eventWith({ severity: 'high' });
    const floorEvaluation = evaluateRiskPolicy(riskPolicy, floorEvent);
    expect(floorEvaluation.finalStateFloor).not.toBeNull();
    const swappedEvaluation = clone(scenario.decision) as {
      riskEvaluation: unknown;
    };
    swappedEvaluation.riskEvaluation = JSON.parse(
      JSON.stringify(floorEvaluation),
    );
    expect(() =>
      createDeterministicFinalAnalysisRecord(
        scenario.event,
        'message-v1',
        scenario.profile,
        swappedEvaluation as unknown as DeterministicImpactDecision,
        metadata,
      ),
    ).toThrow(/floor/i);

    // Scenario C: the same decision paired with an event whose products do
    // not satisfy the recorded selector match.
    const otherEvent = ChangeEventSchema.parse({
      ...scenario.event,
      products: ['Synthetic Stream'],
    });
    expect(() =>
      createDeterministicFinalAnalysisRecord(
        otherEvent,
        'message-v1',
        scenario.profile,
        scenario.decision,
        metadata,
      ),
    ).toThrow(/selector|matchedValues|mapping gaps|NOT_APPLICABLE/);
  });

  it('derives the changeEventRef strictly from the single sourceMessageVersion argument', () => {
    const scenario = notApplicableScenario();

    // Empty version strings fail their own parse before anything else.
    expect(() =>
      createDeterministicFinalAnalysisRecord(
        scenario.event,
        '',
        scenario.profile,
        scenario.decision,
        metadata,
      ),
    ).toThrow();

    const record = buildRecord(scenario);
    expect(record.changeEventRef.sourceMessageVersion).toBe(
      record.versionBundle.sourceMessageVersion,
    );
    expect(record.changeEventRef.source).toBe(scenario.event.source);
    expect(record.changeEventRef.externalId).toBe(scenario.event.externalId);
  });

  it('rejects tampered evidence inputs through delegated evidence validation', () => {
    const scenario = notApplicableScenario();

    interface MutableRuleResult {
      ruleId: string;
      matchedValues?: string[];
      conditionResults?: Array<Record<string, unknown>>;
      [key: string]: unknown;
    }

    const tamperedMatchedValues = clone(scenario.decision) as {
      tenantApplicability: { ruleResults: MutableRuleResult[] };
    };
    const teamsRule =
      tamperedMatchedValues.tenantApplicability.ruleResults.find(
        (ruleResult) => ruleResult.ruleId === 'synthetic-teams',
      );
    if (teamsRule === undefined || !Array.isArray(teamsRule.matchedValues)) {
      throw new Error('expected a synthetic-teams MATCH rule result');
    }
    teamsRule.matchedValues = ['Wrong Product'];
    expect(() =>
      createDeterministicFinalAnalysisRecord(
        scenario.event,
        'message-v1',
        scenario.profile,
        tamperedMatchedValues as unknown as DeterministicImpactDecision,
        metadata,
      ),
    ).toThrow(/matchedValues/);

    const tamperedCondition = clone(scenario.decision) as {
      tenantApplicability: { ruleResults: MutableRuleResult[] };
    };
    const firstMatchRule =
      tamperedCondition.tenantApplicability.ruleResults.find(
        (ruleResult) =>
          Array.isArray(ruleResult.conditionResults) &&
          ruleResult.ruleId === 'synthetic-teams',
      );
    const firstCondition = firstMatchRule?.conditionResults?.[0];
    if (firstCondition === undefined) {
      throw new Error('expected a condition result to tamper with');
    }
    // An internally inconsistent condition result is rejected by the strict
    // decision schema before any evidence work happens.
    firstCondition.status = 'MATCH';
    expect(() =>
      createDeterministicFinalAnalysisRecord(
        scenario.event,
        'message-v1',
        scenario.profile,
        tamperedCondition as unknown as DeterministicImpactDecision,
        metadata,
      ),
    ).toThrow(/observed to equal expected/);

    // A plausible-looking but wrong observation survives the strict schema
    // (status stays NO_MATCH, so expected flips with observed) and is caught
    // by the delegated re-check against the actual tenant profile.
    const tamperedObserved = clone(scenario.decision) as {
      tenantApplicability: { ruleResults: MutableRuleResult[] };
    };
    const observedRule = tamperedObserved.tenantApplicability.ruleResults.find(
      (ruleResult) =>
        Array.isArray(ruleResult.conditionResults) &&
        ruleResult.ruleId === 'synthetic-teams',
    );
    const observedCondition = observedRule?.conditionResults?.[0];
    if (
      observedCondition === undefined ||
      typeof observedCondition.observed !== 'boolean'
    ) {
      throw new Error('expected an observed value to tamper with');
    }
    observedCondition.observed = true;
    observedCondition.expected = false;
    expect(() =>
      createDeterministicFinalAnalysisRecord(
        scenario.event,
        'message-v1',
        scenario.profile,
        tamperedObserved as unknown as DeterministicImpactDecision,
        metadata,
      ),
    ).toThrow(/tenant profile|tenant condition/);
  });

  it('rejects strict-extra metadata keys and empty metadata values', () => {
    const scenario = notApplicableScenario();

    expect(() =>
      createDeterministicFinalAnalysisRecord(
        scenario.event,
        'message-v1',
        scenario.profile,
        scenario.decision,
        { ...metadata, runId: 'extra' } as DeterministicFinalAnalysisMetadata,
      ),
    ).toThrow();

    expect(() =>
      createDeterministicFinalAnalysisRecord(
        scenario.event,
        'message-v1',
        scenario.profile,
        scenario.decision,
        {
          analysisId: '',
          tenantId: metadata.tenantId,
          createdAt: metadata.createdAt,
        },
      ),
    ).toThrow();

    expect(() =>
      createDeterministicFinalAnalysisRecord(
        scenario.event,
        'message-v1',
        scenario.profile,
        scenario.decision,
        {
          analysisId: metadata.analysisId,
          tenantId: '',
          createdAt: metadata.createdAt,
        },
      ),
    ).toThrow();

    expect(() =>
      createDeterministicFinalAnalysisRecord(
        scenario.event,
        'message-v1',
        scenario.profile,
        scenario.decision,
        null as unknown as DeterministicFinalAnalysisMetadata,
      ),
    ).toThrow();

    expect(() =>
      createDeterministicFinalAnalysisRecord(
        scenario.event,
        'message-v1',
        scenario.profile,
        scenario.decision,
        undefined as unknown as DeterministicFinalAnalysisMetadata,
      ),
    ).toThrow();
  });

  it('accepts caller-supplied offset ISO datetimes and rejects malformed createdAt values', () => {
    const scenario = notApplicableScenario();

    const accepted = createDeterministicFinalAnalysisRecord(
      scenario.event,
      'message-v1',
      scenario.profile,
      scenario.decision,
      { ...metadata, createdAt: '2026-01-02T03:04:05+00:00' },
    );
    expect(accepted.createdAt).toBe('2026-01-02T03:04:05+00:00');

    expect(() =>
      createDeterministicFinalAnalysisRecord(
        scenario.event,
        'message-v1',
        scenario.profile,
        scenario.decision,
        { ...metadata, createdAt: '' },
      ),
    ).toThrow();

    expect(() =>
      createDeterministicFinalAnalysisRecord(
        scenario.event,
        'message-v1',
        scenario.profile,
        scenario.decision,
        { ...metadata, createdAt: '-06:00-without-a-time' },
      ),
    ).toThrow();

    expect(() =>
      createDeterministicFinalAnalysisRecord(
        scenario.event,
        'message-v1',
        scenario.profile,
        scenario.decision,
        { ...metadata, createdAt: 1756000000000 as unknown as string },
      ),
    ).toThrow();

    expect(() =>
      createDeterministicFinalAnalysisRecord(
        scenario.event,
        'message-v1',
        scenario.profile,
        scenario.decision,
        { ...metadata, createdAt: '2026-08-27T09:30:00' },
      ),
    ).toThrow();
  });

  it('generates schema-valid records for all DETERMINISTIC_FINAL corpus pairs across both states', () => {
    const events = readdirSync(resolve(process.cwd(), 'corpus/changes'))
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map(
        (name) =>
          (
            readJson(join(resolve(process.cwd(), 'corpus/changes'), name)) as {
              event: unknown;
            }
          ).event,
      )
      .map((event) => ChangeEventSchema.parse(event));
    const profiles = readdirSync(
      resolve(process.cwd(), 'corpus/tenant-profiles'),
    )
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map(
        (name) =>
          (
            readJson(
              join(resolve(process.cwd(), 'corpus/tenant-profiles'), name),
            ) as { profile: unknown }
          ).profile,
      )
      .map((profile) => TenantProfileSchema.parse(profile));

    expect(events.length).toBe(50);
    expect(profiles.length).toBe(10);

    let finalCount = 0;
    let notApplicableCount = 0;
    let insufficientCount = 0;
    let notApplicableGolden: AnalysisRecord | undefined;
    let insufficientGolden: AnalysisRecord | undefined;

    events.forEach((event, eventIndex) => {
      profiles.forEach((profile, profileIndex) => {
        const decision = decisionFor(event, profile);
        if (decision.kind !== 'DETERMINISTIC_FINAL') return;

        finalCount += 1;
        const analysisId = `analysis-corpus-${String(eventIndex + 1).padStart(3, '0')}-${String(profileIndex + 1).padStart(2, '0')}`;
        const record = createDeterministicFinalAnalysisRecord(
          event,
          'message-v1',
          profile,
          decision,
          { ...metadata, analysisId },
        );

        expect(AnalysisRecordSchema.safeParse(record).success).toBe(true);
        expect(record.analysisId).toBe(analysisId);
        expect(record.versionBundle.ai).toEqual({ used: false });
        expect(
          record.provenanceRecords.every(
            (provenance) => provenance.kind !== 'ai_inference',
          ),
        ).toBe(true);

        if (decision.state === 'NOT_APPLICABLE') {
          notApplicableCount += 1;
          if (notApplicableGolden === undefined) notApplicableGolden = record;
        } else {
          insufficientCount += 1;
          if (
            insufficientGolden === undefined &&
            Object.hasOwn(record.impactAssessment, 'missingContext')
          ) {
            insufficientGolden = record;
          }
        }
      });
    });

    expect(finalCount).toBeGreaterThan(0);
    expect(notApplicableCount).toBeGreaterThan(0);
    expect(insufficientCount).toBeGreaterThan(0);

    const naGolden = notApplicableGolden;
    if (naGolden === undefined) {
      throw new Error('no NOT_APPLICABLE golden representative was generated');
    }
    if (naGolden.impactAssessment.state !== 'NOT_APPLICABLE') {
      throw new Error('golden representative lost its state');
    }
    expect(naGolden.impactAssessment.evidence.length).toBeGreaterThan(0);
    naGolden.impactAssessment.evidence.forEach((id) => {
      expect(id.startsWith('decision.tenant.')).toBe(true);
      expect(
        naGolden.provenanceRecords.some(
          (provenance) => provenance.evidenceId === id,
        ),
      ).toBe(true);
    });

    if (insufficientGolden === undefined) {
      throw new Error(
        'no path-insufficient golden representative was generated',
      );
    }
    expect(insufficientGolden.impactAssessment.state).toBe(
      'INSUFFICIENT_CONTEXT',
    );
    expect(Object.hasOwn(insufficientGolden.impactAssessment, 'evidence')).toBe(
      false,
    );
  });
});
