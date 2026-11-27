import { z } from 'zod';

import type { ImpactState } from '../domain/impact-assessment.js';
import { isRiskFloorAtLeast } from '../domain/risk-policy-evaluator.js';
import {
  type RiskPolicyEvaluationResult,
  type RiskStateFloor,
} from '../domain/risk-policy.js';
import {
  CorpusCollectionSchema,
  type CorpusCollection,
  type CorpusCoverageTag,
  type GoldenCase,
} from './golden-corpus.js';

export const REQUIRED_CORPUS_STATES = [
  'ACTION_REQUIRED',
  'REVIEW_REQUIRED',
  'INFORMATIONAL',
  'NOT_APPLICABLE',
  'INSUFFICIENT_CONTEXT',
] as const satisfies readonly ImpactState[];

export const REQUIRED_CORPUS_COVERAGE_TAGS = [
  'major-change',
  'admin-deadline',
  'admin-impact',
  'high-severity',
  'critical-severity',
  'retirement',
  'deprecation',
  'security',
  'privacy',
  'compliance',
  'unknown-tenant-context',
  'clearly-non-applicable',
  'informational',
  'tenant-variation',
  'confirmed-absence',
  'unknown-signal',
  'ambiguous-scope',
  'contradictory-source-signals',
  'user-communication',
  'ownership',
  'maintenance-window',
  'platform-difference',
  'endpoint-difference',
  'teams',
  'exchange-online',
  'sharepoint-onedrive',
  'intune',
  'entra-id',
  'defender-security',
  'purview-compliance',
  'power-platform',
  'viva',
] as const satisfies readonly CorpusCoverageTag[];

export const MIN_CORPUS_CHANGE_FIXTURES = 50;
export const MIN_CORPUS_TENANT_PROFILE_FIXTURES = 10;
export const MIN_CORPUS_GOLDEN_CASES = 55;

const HIGH_IMPACT_COVERAGE_TAGS = new Set<CorpusCoverageTag>([
  'major-change',
  'admin-deadline',
  'admin-impact',
  'high-severity',
  'critical-severity',
  'retirement',
  'deprecation',
  'security',
  'privacy',
  'compliance',
]);

export interface CorpusValidationSummary {
  changeFixtureCount: number;
  tenantProfileFixtureCount: number;
  goldenCaseCount: number;
  highImpactCaseCount: number;
  stateCounts: Record<ImpactState, number>;
  /** Coverage tags represented by at least one expected golden case. */
  coverageTags: CorpusCoverageTag[];
}

export interface CorpusValidationResult {
  valid: boolean;
  errors: string[];
  summary?: CorpusValidationSummary;
}

export interface GoldenCaseRiskFloorCheck {
  valid: boolean;
  actualRiskFloor: RiskStateFloor | null;
  minimumRiskFloor?: RiskStateFloor;
}

/**
 * Check the policy floor against a golden case's declared minimum. A golden
 * case without a minimum floor is intentionally accepted because its expected
 * state may be informational, not applicable, or context-insufficient for a
 * policy-only assertion.
 */
export function checkGoldenCaseMinimumRiskFloor(
  goldenCase: GoldenCase,
  evaluation: RiskPolicyEvaluationResult,
): GoldenCaseRiskFloorCheck {
  const expected = goldenCase.expected;
  const minimumRiskFloor =
    'minimumRiskFloor' in expected ? expected.minimumRiskFloor : undefined;

  return {
    valid:
      minimumRiskFloor === undefined ||
      isRiskFloorAtLeast(evaluation.finalStateFloor, minimumRiskFloor),
    actualRiskFloor: evaluation.finalStateFloor,
    ...(minimumRiskFloor === undefined ? {} : { minimumRiskFloor }),
  };
}

/** Boolean convenience form for corpus gates and table-driven tests. */
export function validateGoldenCaseMinimumRiskFloor(
  goldenCase: GoldenCase,
  evaluation: RiskPolicyEvaluationResult,
): boolean {
  return checkGoldenCaseMinimumRiskFloor(goldenCase, evaluation).valid;
}

function formatSchemaIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
    return `${path}: ${issue.message}`;
  });
}

function addDuplicateIssues(
  ids: readonly string[],
  label: string,
  errors: string[],
): Set<string> {
  const seen = new Set<string>();
  ids.forEach((id) => {
    if (seen.has(id)) {
      errors.push(`${label} contains duplicate ID: ${id}`);
    }
    seen.add(id);
  });
  return seen;
}

function compareManifestIds(
  manifestIds: readonly string[],
  loadedIds: ReadonlySet<string>,
  label: string,
  errors: string[],
): void {
  manifestIds.forEach((id) => {
    if (!loadedIds.has(id)) {
      errors.push(`${label} manifest reference has no loaded record: ${id}`);
    }
  });
  const manifestSet = new Set(manifestIds);
  loadedIds.forEach((id) => {
    if (!manifestSet.has(id)) {
      errors.push(`loaded ${label} is missing from the manifest: ${id}`);
    }
  });
}

function validateCrossFileReferences(
  corpus: CorpusCollection,
  errors: string[],
): void {
  const changeIds = addDuplicateIssues(
    corpus.changeFixtures.map((fixture) => fixture.fixtureId),
    'change fixture IDs',
    errors,
  );
  const profileIds = addDuplicateIssues(
    corpus.tenantProfileFixtures.map((fixture) => fixture.fixtureId),
    'tenant profile fixture IDs',
    errors,
  );
  const caseIds = addDuplicateIssues(
    corpus.goldenCases.map((goldenCase) => goldenCase.caseId),
    'golden case IDs',
    errors,
  );

  const allFixtureIds = new Set<string>();
  changeIds.forEach((id) => allFixtureIds.add(id));
  profileIds.forEach((id) => {
    if (allFixtureIds.has(id)) {
      errors.push(
        `change/profile fixture ID is reused across collections: ${id}`,
      );
    }
    allFixtureIds.add(id);
  });

  const manifestChangeIds = addDuplicateIssues(
    corpus.manifest.changeFixtures.map((entry) => entry.fixtureId),
    'change fixture manifest references',
    errors,
  );
  const manifestProfileIds = addDuplicateIssues(
    corpus.manifest.tenantProfileFixtures.map((entry) => entry.fixtureId),
    'tenant profile manifest references',
    errors,
  );
  const manifestCaseIds = addDuplicateIssues(
    corpus.manifest.goldenCases.map((entry) => entry.caseId),
    'golden case manifest references',
    errors,
  );

  compareManifestIds(
    [...manifestChangeIds],
    changeIds,
    'change fixture',
    errors,
  );
  compareManifestIds(
    [...manifestProfileIds],
    profileIds,
    'tenant profile fixture',
    errors,
  );
  compareManifestIds([...manifestCaseIds], caseIds, 'golden case', errors);

  corpus.goldenCases.forEach((goldenCase) => {
    if (!changeIds.has(goldenCase.changeFixtureId)) {
      errors.push(
        `golden case ${goldenCase.caseId} references missing change fixture: ${goldenCase.changeFixtureId}`,
      );
    }
    if (!profileIds.has(goldenCase.tenantProfileFixtureId)) {
      errors.push(
        `golden case ${goldenCase.caseId} references missing tenant profile fixture: ${goldenCase.tenantProfileFixtureId}`,
      );
    }
  });

  const referencedChangeIds = new Set(
    corpus.goldenCases.map((goldenCase) => goldenCase.changeFixtureId),
  );
  corpus.changeFixtures.forEach((fixture) => {
    if (!referencedChangeIds.has(fixture.fixtureId)) {
      errors.push(
        `change fixture is not referenced by any golden case: ${fixture.fixtureId}`,
      );
    }
  });
}

function validateSeedCoverage(
  corpus: CorpusCollection,
  errors: string[],
): CorpusValidationSummary {
  const stateCounts: Record<ImpactState, number> = {
    ACTION_REQUIRED: 0,
    REVIEW_REQUIRED: 0,
    INFORMATIONAL: 0,
    NOT_APPLICABLE: 0,
    INSUFFICIENT_CONTEXT: 0,
  };
  const caseCoverage = new Set<CorpusCoverageTag>();
  const changeFixtureById = new Map(
    corpus.changeFixtures.map((fixture) => [fixture.fixtureId, fixture]),
  );

  let highImpactCaseCount = 0;
  const statesByChange = new Map<string, Set<ImpactState>>();

  corpus.goldenCases.forEach((goldenCase) => {
    const { state } = goldenCase.expected;
    stateCounts[state] += 1;
    goldenCase.coverageTags.forEach((tag) => caseCoverage.add(tag));

    const states = statesByChange.get(goldenCase.changeFixtureId) ?? new Set();
    states.add(state);
    statesByChange.set(goldenCase.changeFixtureId, states);

    const hasHighImpactTag = goldenCase.coverageTags.some((tag) =>
      HIGH_IMPACT_COVERAGE_TAGS.has(tag),
    );
    if (hasHighImpactTag && !goldenCase.highImpact) {
      errors.push(
        `golden case ${goldenCase.caseId} has a high-impact coverage tag but highImpact=false`,
      );
    }
    const referencedChangeFixture = changeFixtureById.get(
      goldenCase.changeFixtureId,
    );
    const referencedHighImpactTags =
      referencedChangeFixture?.coverageTags.filter((tag) =>
        HIGH_IMPACT_COVERAGE_TAGS.has(tag),
      ) ?? [];
    const hasReferencedHighImpact = referencedHighImpactTags.length > 0;
    if (hasReferencedHighImpact && !goldenCase.highImpact) {
      errors.push(
        `golden case ${goldenCase.caseId} references high-impact change fixture ${goldenCase.changeFixtureId} but highImpact=false`,
      );
    }
    const isHighImpactCase = goldenCase.highImpact || hasReferencedHighImpact;
    if (isHighImpactCase) {
      highImpactCaseCount += 1;
      if (state !== 'ACTION_REQUIRED' && state !== 'REVIEW_REQUIRED') {
        errors.push(
          `high-impact golden case ${goldenCase.caseId} must expect REVIEW_REQUIRED or ACTION_REQUIRED`,
        );
      }
      if (
        !('minimumRiskFloor' in goldenCase.expected) ||
        goldenCase.expected.minimumRiskFloor === undefined
      ) {
        errors.push(
          `high-impact golden case ${goldenCase.caseId} must declare minimumRiskFloor`,
        );
      }
    }

    const hasReferencedUnknownSignal =
      referencedChangeFixture?.coverageTags.includes('unknown-signal') ?? false;
    const hasReviewFloor =
      'minimumRiskFloor' in goldenCase.expected &&
      goldenCase.expected.minimumRiskFloor === 'REVIEW_REQUIRED';
    if (
      hasReferencedUnknownSignal &&
      (state !== 'REVIEW_REQUIRED' || !hasReviewFloor)
    ) {
      errors.push(
        `golden case ${goldenCase.caseId} references a change fixture with unknown-signal and must expect REVIEW_REQUIRED with minimumRiskFloor=REVIEW_REQUIRED`,
      );
    }
  });

  REQUIRED_CORPUS_STATES.forEach((state) => {
    if (stateCounts[state] === 0) {
      errors.push(`seed corpus is missing expected state: ${state}`);
    }
  });
  REQUIRED_CORPUS_COVERAGE_TAGS.forEach((tag) => {
    if (!caseCoverage.has(tag)) {
      errors.push(`seed corpus is missing coverage tag: ${tag}`);
    }
  });
  if (highImpactCaseCount === 0) {
    errors.push('seed corpus must identify at least one high-impact case');
  }
  if (![...statesByChange.values()].some((states) => states.size > 1)) {
    errors.push(
      'seed corpus must include one change fixture with different expected states across tenant profiles',
    );
  }

  return {
    changeFixtureCount: corpus.changeFixtures.length,
    tenantProfileFixtureCount: corpus.tenantProfileFixtures.length,
    goldenCaseCount: corpus.goldenCases.length,
    highImpactCaseCount,
    stateCounts,
    coverageTags: [...caseCoverage].sort(),
  };
}

export function validateCorpusCollection(
  input: unknown,
): CorpusValidationResult {
  const parsed = CorpusCollectionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      valid: false,
      errors: formatSchemaIssues(parsed.error),
    };
  }

  const errors: string[] = [];
  validateCrossFileReferences(parsed.data, errors);
  const summary = validateSeedCoverage(parsed.data, errors);

  if (parsed.data.changeFixtures.length < MIN_CORPUS_CHANGE_FIXTURES) {
    errors.push(
      `corpus must contain at least ${MIN_CORPUS_CHANGE_FIXTURES} change fixtures`,
    );
  }
  if (
    parsed.data.tenantProfileFixtures.length <
    MIN_CORPUS_TENANT_PROFILE_FIXTURES
  ) {
    errors.push(
      `corpus must contain at least ${MIN_CORPUS_TENANT_PROFILE_FIXTURES} tenant profile fixtures`,
    );
  }
  if (parsed.data.goldenCases.length < MIN_CORPUS_GOLDEN_CASES) {
    errors.push(
      `corpus must contain at least ${MIN_CORPUS_GOLDEN_CASES} golden cases`,
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    summary,
  };
}
