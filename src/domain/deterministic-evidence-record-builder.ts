import { z } from 'zod';

import { ChangeEventSchema, type ChangeEvent } from './change-event.js';
import { JsonValueSchema } from './json-value.js';
import {
  DeterministicImpactDecisionSchema,
  type DeterministicImpactDecision,
} from './deterministic-impact-decision.js';
import {
  DeterministicConclusionSchema,
  FactObservationSchema,
  SourceFactSchema,
  TenantFactSchema,
  type DeterministicConclusion,
  type FactObservation,
  type SourceFact,
  type TenantFact,
} from './provenance.js';
import {
  TenantApplicabilityMappingGapSchema,
  type TenantApplicabilityEventSelectorField,
  type TenantApplicabilityMappingGap,
  type TenantApplicabilityResult,
  type TenantApplicabilityRuleResult,
} from './tenant-applicability.js';
import { TenantProfileSchema, type TenantProfile } from './tenant-profile.js';

const nonEmptyString = z.string().min(1);

const sourceEventFields = [
  'title',
  'body',
  'publishedAt',
  'updatedAt',
  'products',
  'categories',
  'severity',
  'signals',
  'sourceMetadata',
] as const;

const tenantProfileSections = [
  'organization',
  'services',
  'environment',
  'capabilities',
  'ownership',
  'changePolicy',
  'maintenance',
] as const;

const riskSignalFields = new Set([
  'isMajorChange',
  'actionRequiredBy',
  'hasAdminImpact',
  'isRetirementOrDeprecation',
  'hasSecurityImpact',
  'hasPrivacyImpact',
  'hasComplianceImpact',
  'tags',
]);

const selectorFields = ['products', 'categories'] as const;

export type DeterministicEvidenceRecord =
  SourceFact | TenantFact | DeterministicConclusion;

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function observationFor(value: object, key: string): FactObservation {
  if (!hasOwn(value, key)) {
    return { presence: 'absent' };
  }

  return FactObservationSchema.parse({
    presence: 'present',
    value: JsonValueSchema.parse((value as Record<string, unknown>)[key]),
  });
}

function jsonDeepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right || left === null || right === null) {
    return false;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return (
      left.length === right.length &&
      left.every((value, index) => jsonDeepEqual(value, right[index]))
    );
  }

  if (typeof left !== 'object' || typeof right !== 'object') return false;

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        jsonDeepEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

function sameObservation(
  left: FactObservation,
  right: FactObservation,
): boolean {
  return jsonDeepEqual(left, right);
}

function sourceFactsForEvent(
  event: ChangeEvent,
  sourceMessageVersion: string,
): SourceFact[] {
  const eventRecord = event as unknown as Record<string, unknown>;
  return sourceEventFields.map((field) =>
    SourceFactSchema.parse({
      kind: 'source_fact',
      evidenceId: `source.event.${field}`,
      source: event.source,
      externalId: event.externalId,
      sourceMessageVersion,
      path: field,
      observation: observationFor(eventRecord, field),
    }),
  );
}

function tenantFactsForProfile(profile: TenantProfile): TenantFact[] {
  const profileRecord = profile as unknown as Record<string, unknown>;
  return tenantProfileSections.map((section) =>
    TenantFactSchema.parse({
      kind: 'tenant_fact',
      evidenceId: `tenant.profile.${section}`,
      tenantProfileVersion: profile.profileVersion,
      path: section,
      observation: observationFor(profileRecord, section),
    }),
  );
}

function riskAtomObservation(
  event: ChangeEvent,
  field: string,
  path: string,
): FactObservation {
  const eventRecord = event as unknown as Record<string, unknown>;
  if (path === 'severity') {
    if (field !== 'severity') {
      throw new Error('risk atom field must match the severity path');
    }
    return observationFor(eventRecord, 'severity');
  }

  const pathParts = path.split('.');
  const signal = pathParts[1];
  if (
    pathParts.length !== 2 ||
    pathParts[0] !== 'signals' ||
    signal === undefined ||
    !riskSignalFields.has(signal) ||
    field !== signal
  ) {
    throw new Error(`unsupported risk atom path: ${path}`);
  }

  if (!hasOwn(eventRecord, 'signals')) {
    return { presence: 'absent' };
  }

  const signals = eventRecord.signals;
  if (
    typeof signals !== 'object' ||
    signals === null ||
    Array.isArray(signals)
  ) {
    throw new Error('change event signals must be an object');
  }
  return observationFor(signals as Record<string, unknown>, signal);
}

function riskAtomFact(
  event: ChangeEvent,
  sourceMessageVersion: string,
  atom: {
    evidenceId: string;
    field: string;
    path: string;
  },
): SourceFact {
  return SourceFactSchema.parse({
    kind: 'source_fact',
    evidenceId: atom.evidenceId,
    source: event.source,
    externalId: event.externalId,
    sourceMessageVersion,
    path: atom.path,
    observation: riskAtomObservation(event, atom.field, atom.path),
  });
}

function tenantConditionFact(
  profile: TenantProfile,
  evidenceId: string,
  result: {
    section: 'services' | 'environment' | 'capabilities';
    key: string;
    expected: boolean;
    observed: boolean | null;
    path: string;
    status: 'MATCH' | 'NO_MATCH' | 'UNKNOWN';
  },
): TenantFact {
  const expectedPath = `${result.section}.${result.key}`;
  if (result.path !== expectedPath) {
    throw new Error('tenant condition path does not match its section and key');
  }

  const profileRecord = profile as unknown as Record<string, unknown>;
  const section = profileRecord[result.section];
  if (
    typeof section !== 'object' ||
    section === null ||
    Array.isArray(section)
  ) {
    throw new Error(
      `tenant profile section is not an object: ${result.section}`,
    );
  }

  const sectionRecord = section as Record<string, unknown>;
  const keyExists = hasOwn(sectionRecord, result.key);
  const actualObservation = observationFor(sectionRecord, result.key);
  const actualObserved = keyExists ? sectionRecord[result.key] : null;
  const actualStatus = !keyExists
    ? 'UNKNOWN'
    : actualObserved === result.expected
      ? 'MATCH'
      : 'NO_MATCH';

  if (
    !jsonDeepEqual(actualObserved, result.observed) ||
    actualStatus !== result.status
  ) {
    throw new Error(
      `tenant condition result does not match the tenant profile at ${result.path}`,
    );
  }

  return TenantFactSchema.parse({
    kind: 'tenant_fact',
    evidenceId,
    tenantProfileVersion: profile.profileVersion,
    path: result.path,
    observation: actualObservation,
  });
}

function addRiskAtomFact(
  facts: SourceFact[],
  byEvidenceId: Map<string, SourceFact>,
  fact: SourceFact,
): void {
  const existing = byEvidenceId.get(fact.evidenceId);
  if (existing !== undefined) {
    if (
      existing.path !== fact.path ||
      !sameObservation(existing.observation, fact.observation)
    ) {
      throw new Error(
        `risk atom evidence ID has conflicting path or observation: ${fact.evidenceId}`,
      );
    }
    return;
  }

  byEvidenceId.set(fact.evidenceId, fact);
  facts.push(fact);
}

function uniqueEvidenceIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function tenantConclusionText(result: {
  selectorStatus: 'MATCH' | 'NO_MATCH';
  conditionGroupStatus?: 'MATCH' | 'NO_MATCH' | 'UNKNOWN';
  reason: string;
}): string {
  if (result.selectorStatus === 'NO_MATCH') {
    return `selector NO_MATCH: ${result.reason}`;
  }
  return `selector MATCH; condition group ${result.conditionGroupStatus}: ${result.reason}`;
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameMappingGaps(
  left: readonly TenantApplicabilityMappingGap[],
  right: readonly TenantApplicabilityMappingGap[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (gap, index) =>
        gap.field === right[index]?.field && gap.value === right[index]?.value,
    )
  );
}

function expectedMatchedValues(
  event: ChangeEvent,
  result: TenantApplicabilityRuleResult,
): string[] {
  return result.configuredValues.filter((value) =>
    event[result.field].includes(value),
  );
}

function assertTenantSelectorResults(
  event: ChangeEvent,
  ruleResults: readonly TenantApplicabilityRuleResult[],
): void {
  ruleResults.forEach((ruleResult, index) => {
    const matchedValues = expectedMatchedValues(event, ruleResult);
    const expectedSelectorStatus =
      matchedValues.length > 0 ? 'MATCH' : 'NO_MATCH';
    if (ruleResult.selectorStatus !== expectedSelectorStatus) {
      throw new Error(
        `tenant selector status does not match event values at rule result ${index}`,
      );
    }
    if (!sameStrings(ruleResult.matchedValues, matchedValues)) {
      throw new Error(
        `tenant selector matchedValues do not match event values at rule result ${index}`,
      );
    }
  });
}

function mappingGapsForTenantResults(
  event: ChangeEvent,
  ruleResults: readonly TenantApplicabilityRuleResult[],
): TenantApplicabilityMappingGap[] {
  const configuredValues = new Map<
    TenantApplicabilityEventSelectorField,
    Set<string>
  >();

  ruleResults.forEach((ruleResult) => {
    const configured =
      configuredValues.get(ruleResult.field) ?? new Set<string>();
    ruleResult.configuredValues.forEach((value) => configured.add(value));
    configuredValues.set(ruleResult.field, configured);
  });

  const gaps: TenantApplicabilityMappingGap[] = [];
  selectorFields.forEach((field) => {
    const configured = configuredValues.get(field);
    if (configured === undefined) return;

    const values = event[field];
    if (values.length === 0) {
      gaps.push(
        TenantApplicabilityMappingGapSchema.parse({ field, value: null }),
      );
      return;
    }

    const seenValues = new Set<string>();
    values.forEach((value) => {
      if (seenValues.has(value)) return;
      seenValues.add(value);
      if (!configured.has(value)) {
        gaps.push(TenantApplicabilityMappingGapSchema.parse({ field, value }));
      }
    });
  });
  return gaps;
}

function assertTenantApplicabilityMatchesEvent(
  event: ChangeEvent,
  applicability: TenantApplicabilityResult,
): void {
  assertTenantSelectorResults(event, applicability.ruleResults);
  const mappingGaps = mappingGapsForTenantResults(
    event,
    applicability.ruleResults,
  );

  if (applicability.status === 'APPLICABLE') {
    if (mappingGaps.length === 0) {
      if (hasOwn(applicability, 'mappingWarnings')) {
        throw new Error(
          'APPLICABLE must omit mappingWarnings when no mapping gaps exist',
        );
      }
      return;
    }
    if (
      !hasOwn(applicability, 'mappingWarnings') ||
      applicability.mappingWarnings === undefined ||
      !sameMappingGaps(mappingGaps, applicability.mappingWarnings)
    ) {
      throw new Error(
        'APPLICABLE mappingWarnings must exactly match recomputed mapping gaps',
      );
    }
    return;
  }

  if (applicability.status === 'INSUFFICIENT_CONTEXT') {
    if (mappingGaps.length === 0) {
      if (hasOwn(applicability, 'missingMappings')) {
        throw new Error(
          'INSUFFICIENT_CONTEXT must omit missingMappings when no mapping gaps exist',
        );
      }
      return;
    }
    if (
      !hasOwn(applicability, 'missingMappings') ||
      applicability.missingMappings === undefined ||
      !sameMappingGaps(mappingGaps, applicability.missingMappings)
    ) {
      throw new Error(
        'INSUFFICIENT_CONTEXT missingMappings must exactly match recomputed mapping gaps',
      );
    }
    return;
  }

  if (mappingGaps.length > 0) {
    throw new Error('NOT_APPLICABLE cannot contain event mapping gaps');
  }
}

function validateEvidenceRecords(
  records: readonly DeterministicEvidenceRecord[],
  event: ChangeEvent,
  sourceMessageVersion: string,
  profile: TenantProfile,
  decision: DeterministicImpactDecision,
): void {
  const evidenceIds = new Set<string>();
  records.forEach((record, index) => {
    if (evidenceIds.has(record.evidenceId)) {
      throw new Error(`duplicate evidence ID: ${record.evidenceId}`);
    }
    evidenceIds.add(record.evidenceId);

    if (record.kind === 'source_fact') {
      if (
        record.source !== event.source ||
        record.externalId !== event.externalId ||
        record.sourceMessageVersion !== sourceMessageVersion
      ) {
        throw new Error(
          `source fact ownership mismatch at evidence record ${index}`,
        );
      }
    } else if (record.kind === 'tenant_fact') {
      if (record.tenantProfileVersion !== profile.profileVersion) {
        throw new Error(
          `tenant fact ownership mismatch at evidence record ${index}`,
        );
      }
    } else if (
      record.policyRulesVersion !==
      (record.policyKind === 'risk_policy'
        ? decision.riskEvaluation.policyRulesVersion
        : decision.tenantApplicability.policyRulesVersion)
    ) {
      throw new Error(
        `deterministic conclusion policy ownership mismatch at evidence record ${index}`,
      );
    }
  });

  records.forEach((record) => {
    if (record.kind !== 'deterministic_conclusion') return;
    record.dependsOnEvidenceIds.forEach((dependencyId) => {
      if (!evidenceIds.has(dependencyId)) {
        throw new Error(`dangling evidence dependency: ${dependencyId}`);
      }
    });
  });
}

/**
 * Build provider-neutral deterministic evidence for every decision kind.
 * The returned records contain no AIInference and are newly constructed from
 * schema-validated inputs in a stable evidence order.
 */
export function createDeterministicEvidenceRecords(
  changeEvent: ChangeEvent,
  sourceMessageVersion: string,
  tenantProfile: TenantProfile,
  decision: DeterministicImpactDecision,
): DeterministicEvidenceRecord[] {
  const parsedEvent = ChangeEventSchema.parse(changeEvent);
  const parsedSourceMessageVersion = nonEmptyString.parse(sourceMessageVersion);
  const parsedProfile = TenantProfileSchema.parse(tenantProfile);
  const parsedDecision = DeterministicImpactDecisionSchema.parse(decision);

  if (parsedDecision.tenantApplicability.ruleResults.length === 0) {
    throw new Error(
      'tenant applicability evaluator output must include enabled rule results',
    );
  }
  if (
    parsedDecision.riskEvaluation.finalStateFloor !== null &&
    parsedDecision.riskEvaluation.ruleResults.length === 0
  ) {
    throw new Error(
      'risk evaluator output with a state floor must include rule results',
    );
  }
  assertTenantApplicabilityMatchesEvent(
    parsedEvent,
    parsedDecision.tenantApplicability,
  );

  const sourceFacts = sourceFactsForEvent(
    parsedEvent,
    parsedSourceMessageVersion,
  );
  const tenantFacts = tenantFactsForProfile(parsedProfile);
  const riskAtomFacts: SourceFact[] = [];
  const riskAtomFactsByEvidenceId = new Map<string, SourceFact>();
  const tenantConditionFacts: TenantFact[] = [];
  const riskConclusions: DeterministicConclusion[] = [];
  const tenantConclusions: DeterministicConclusion[] = [];

  parsedDecision.riskEvaluation.ruleResults.forEach((ruleResult, ruleIndex) => {
    if (ruleResult.atomResults === undefined) {
      throw new Error(
        `risk rule result is missing atomResults: ${ruleResult.ruleId}`,
      );
    }

    const atomEvidenceIds: string[] = [];
    ruleResult.atomResults.forEach((atom) => {
      const fact = riskAtomFact(parsedEvent, parsedSourceMessageVersion, atom);
      addRiskAtomFact(riskAtomFacts, riskAtomFactsByEvidenceId, fact);
      atomEvidenceIds.push(atom.evidenceId);
    });

    riskConclusions.push(
      DeterministicConclusionSchema.parse({
        kind: 'deterministic_conclusion',
        evidenceId: `decision.risk.${ruleIndex}`,
        policyKind: 'risk_policy',
        policyRulesVersion: parsedDecision.riskEvaluation.policyRulesVersion,
        ruleId: ruleResult.ruleId,
        conclusion: ruleResult.reason,
        dependsOnEvidenceIds: uniqueEvidenceIds(atomEvidenceIds),
      }),
    );
  });

  parsedDecision.tenantApplicability.ruleResults.forEach(
    (ruleResult, ruleIndex) => {
      const conditionEvidenceIds: string[] = [];
      if (ruleResult.selectorStatus === 'MATCH') {
        ruleResult.conditionResults.forEach(
          (conditionResult, conditionIndex) => {
            const evidenceId = `tenant.condition.${ruleIndex}.${conditionIndex}`;
            tenantConditionFacts.push(
              tenantConditionFact(parsedProfile, evidenceId, conditionResult),
            );
            conditionEvidenceIds.push(evidenceId);
          },
        );
      }

      tenantConclusions.push(
        DeterministicConclusionSchema.parse({
          kind: 'deterministic_conclusion',
          evidenceId: `decision.tenant.${ruleIndex}`,
          policyKind: 'tenant_applicability_policy',
          policyRulesVersion:
            parsedDecision.tenantApplicability.policyRulesVersion,
          ruleId: ruleResult.ruleId,
          conclusion: tenantConclusionText(ruleResult),
          dependsOnEvidenceIds: uniqueEvidenceIds([
            `source.event.${ruleResult.field}`,
            ...conditionEvidenceIds,
          ]),
        }),
      );
    },
  );

  const records: DeterministicEvidenceRecord[] = [
    ...sourceFacts,
    ...tenantFacts,
    ...riskAtomFacts,
    ...tenantConditionFacts,
    ...riskConclusions,
    ...tenantConclusions,
  ];
  validateEvidenceRecords(
    records,
    parsedEvent,
    parsedSourceMessageVersion,
    parsedProfile,
    parsedDecision,
  );
  return records;
}
