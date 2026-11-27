import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CorpusCollectionSchema,
  GoldenCaseSchema,
  MIN_CORPUS_CHANGE_FIXTURES,
  MIN_CORPUS_GOLDEN_CASES,
  MIN_CORPUS_TENANT_PROFILE_FIXTURES,
  REQUIRED_CORPUS_COVERAGE_TAGS,
  REQUIRED_CORPUS_STATES,
  validateCorpusCollection,
} from '../src/index.js';

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected object');
  }
  return value as Record<string, unknown>;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function loadSeedCorpus(): Record<string, unknown> {
  const corpusRoot = resolve(process.cwd(), 'corpus');
  const manifest = asRecord(readJson(join(corpusRoot, 'manifest.json')));
  const changeEntries = manifest.changeFixtures;
  const profileEntries = manifest.tenantProfileFixtures;
  const caseEntries = manifest.goldenCases;
  if (
    !Array.isArray(changeEntries) ||
    !Array.isArray(profileEntries) ||
    !Array.isArray(caseEntries)
  ) {
    throw new Error('seed manifest has invalid entry arrays');
  }

  return {
    manifest,
    changeFixtures: changeEntries.map((entry) => {
      const reference = asRecord(entry);
      return readJson(join(corpusRoot, String(reference.path)));
    }),
    tenantProfileFixtures: profileEntries.map((entry) => {
      const reference = asRecord(entry);
      return readJson(join(corpusRoot, String(reference.path)));
    }),
    goldenCases: caseEntries.map((entry) => {
      const reference = asRecord(entry);
      return readJson(join(corpusRoot, String(reference.path)));
    }),
  };
}

describe('golden corpus contracts', () => {
  it('parses the complete synthetic seed and reports expected coverage', () => {
    const collection = loadSeedCorpus();
    const parsed = CorpusCollectionSchema.parse(collection);
    const result = validateCorpusCollection(parsed);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.summary).toMatchObject({
      changeFixtureCount: 50,
      tenantProfileFixtureCount: 10,
      goldenCaseCount: 65,
      highImpactCaseCount: 28,
      stateCounts: {
        ACTION_REQUIRED: 12,
        REVIEW_REQUIRED: 27,
        INFORMATIONAL: 15,
        NOT_APPLICABLE: 6,
        INSUFFICIENT_CONTEXT: 5,
      },
    });
    expect(result.summary?.coverageTags).toEqual(
      [...REQUIRED_CORPUS_COVERAGE_TAGS].sort(),
    );
    expect(REQUIRED_CORPUS_STATES).toHaveLength(5);
    expect(
      CorpusCollectionSchema.parse(JSON.parse(JSON.stringify(parsed))),
    ).toEqual(parsed);
  });

  it('keeps NOT_APPLICABLE and INSUFFICIENT_CONTEXT expected values incompatible', () => {
    const collection = loadSeedCorpus();
    const cases = collection.goldenCases as unknown[];
    const notApplicable = asRecord(cases[12]);
    const insufficient = asRecord(cases[13]);

    expect(
      GoldenCaseSchema.safeParse({
        ...notApplicable,
        expected: {
          state: 'NOT_APPLICABLE',
          reason: 'confirmed absence',
          missingContext: ['services.stream'],
        },
      }).success,
    ).toBe(false);
    expect(
      GoldenCaseSchema.safeParse({
        ...insufficient,
        expected: {
          state: 'INSUFFICIENT_CONTEXT',
          reason: 'missing context',
          missingContext: ['services.stream'],
        },
      }).success,
    ).toBe(true);
  });

  it('rejects duplicate IDs, dangling references, and missing coverage', () => {
    const collection = loadSeedCorpus();
    const changes = collection.changeFixtures as unknown[];
    const cases = collection.goldenCases as unknown[];
    const duplicate = clone(changes[0]);
    const withDuplicate = clone(collection);
    (withDuplicate.changeFixtures as unknown[]).push(duplicate);
    expect(validateCorpusCollection(withDuplicate).valid).toBe(false);
    expect(validateCorpusCollection(withDuplicate).errors.join('\n')).toContain(
      'duplicate ID',
    );

    const withDanglingReference = clone(collection);
    const firstCase = asRecord(
      (withDanglingReference.goldenCases as unknown[])[0],
    );
    firstCase.changeFixtureId = 'SYNTH-MC-MISSING';
    expect(validateCorpusCollection(withDanglingReference).valid).toBe(false);
    expect(
      validateCorpusCollection(withDanglingReference).errors.join('\n'),
    ).toContain('references missing change fixture');

    const withMissingCoverage = clone(collection);
    (withMissingCoverage.goldenCases as unknown[]).forEach((goldenCase) => {
      const record = asRecord(goldenCase);
      record.coverageTags = (record.coverageTags as unknown[]).filter(
        (tag) => tag !== 'unknown-signal',
      );
    });
    const unknownSignalFixture = asRecord(
      (withMissingCoverage.changeFixtures as unknown[])[9],
    );
    unknownSignalFixture.coverageTags = ['unknown-tenant-context'];
    expect(validateCorpusCollection(withMissingCoverage).valid).toBe(false);
    expect(
      validateCorpusCollection(withMissingCoverage).errors.join('\n'),
    ).toContain('missing coverage tag');

    const withoutInformationalState = clone(collection);
    withoutInformationalState.goldenCases = (
      withoutInformationalState.goldenCases as unknown[]
    ).filter(
      (goldenCase) =>
        asRecord(asRecord(goldenCase).expected).state !== 'INFORMATIONAL',
    );
    expect(validateCorpusCollection(withoutInformationalState).valid).toBe(
      false,
    );
    expect(
      validateCorpusCollection(withoutInformationalState).errors.join('\n'),
    ).toContain('missing expected state: INFORMATIONAL');

    expect(cases).toHaveLength(65);
  });

  it('requires REVIEW_REQUIRED for a source change with unknown-signal', () => {
    const collection = loadSeedCorpus();
    const tenantOnlyCase = asRecord(
      (collection.goldenCases as unknown[]).find(
        (goldenCase) => asRecord(goldenCase).caseId === 'SYNTH-CASE-014',
      ),
    );
    expect(asRecord(tenantOnlyCase.expected).state).toBe(
      'INSUFFICIENT_CONTEXT',
    );
    expect(tenantOnlyCase.coverageTags).not.toContain('unknown-signal');

    const unknownSourceCase = asRecord(
      (collection.goldenCases as unknown[]).find(
        (goldenCase) => asRecord(goldenCase).changeFixtureId === 'SYNTH-MC-014',
      ),
    );
    unknownSourceCase.coverageTags = (
      unknownSourceCase.coverageTags as unknown[]
    ).filter((tag) => tag !== 'unknown-signal');
    unknownSourceCase.expected = {
      state: 'INFORMATIONAL',
      reason: 'intentionally omitting the source-unknown escalation',
    };

    const result = validateCorpusCollection(collection);

    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain(
      'references a change fixture with unknown-signal and must expect REVIEW_REQUIRED with minimumRiskFloor=REVIEW_REQUIRED',
    );
  });

  it('rejects collections below the Phase 1B dataset thresholds', () => {
    const collection = loadSeedCorpus();

    const tooFewChanges = clone(collection);
    tooFewChanges.changeFixtures = (
      tooFewChanges.changeFixtures as unknown[]
    ).slice(0, -1);
    expect(validateCorpusCollection(tooFewChanges).errors.join('\n')).toContain(
      `at least ${MIN_CORPUS_CHANGE_FIXTURES} change fixtures`,
    );

    const tooFewProfiles = clone(collection);
    tooFewProfiles.tenantProfileFixtures = (
      tooFewProfiles.tenantProfileFixtures as unknown[]
    ).slice(0, -1);
    expect(
      validateCorpusCollection(tooFewProfiles).errors.join('\n'),
    ).toContain(
      `at least ${MIN_CORPUS_TENANT_PROFILE_FIXTURES} tenant profile fixtures`,
    );

    const tooFewCases = clone(collection);
    tooFewCases.goldenCases = (tooFewCases.goldenCases as unknown[]).slice(
      0,
      MIN_CORPUS_GOLDEN_CASES - 1,
    );
    expect(validateCorpusCollection(tooFewCases).errors.join('\n')).toContain(
      `at least ${MIN_CORPUS_GOLDEN_CASES} golden cases`,
    );
  });

  it('derives the high-impact denominator from referenced change fixtures', () => {
    const collection = loadSeedCorpus();
    const undeclared = clone(collection);
    const firstCase = asRecord((undeclared.goldenCases as unknown[])[0]);
    firstCase.highImpact = false;
    firstCase.coverageTags = ['tenant-variation'];
    firstCase.expected = {
      state: 'INFORMATIONAL',
      reason: 'intentionally undeclared high-impact change',
    };

    const result = validateCorpusCollection(undeclared);

    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain(
      'references high-impact change fixture',
    );
    expect(result.errors.join('\n')).toContain(
      'must expect REVIEW_REQUIRED or ACTION_REQUIRED',
    );
    expect(result.errors.join('\n')).toContain('must declare minimumRiskFloor');
  });

  it('rejects an orphan change fixture even when fixture tags provide coverage', () => {
    const collection = loadSeedCorpus();
    const orphaned = clone(collection);
    orphaned.goldenCases = (orphaned.goldenCases as unknown[]).filter(
      (goldenCase) => asRecord(goldenCase).changeFixtureId !== 'SYNTH-MC-010',
    );

    const result = validateCorpusCollection(orphaned);

    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain(
      'change fixture is not referenced by any golden case: SYNTH-MC-010',
    );
  });

  it('rejects domain-invalid or non-synthetic records and unsafe high-impact labels', () => {
    const collection = loadSeedCorpus();
    const invalidDomain = clone(collection);
    const firstChange = asRecord(
      (invalidDomain.changeFixtures as unknown[])[0],
    );
    const event = asRecord(firstChange.event);
    event.severity = 'urgent';
    expect(validateCorpusCollection(invalidDomain).valid).toBe(false);

    const nonSynthetic = clone(collection);
    const nonSyntheticEvent = asRecord(
      asRecord((nonSynthetic.changeFixtures as unknown[])[0]).event,
    );
    const metadata = asRecord(nonSyntheticEvent.sourceMetadata);
    metadata.synthetic = false;
    expect(validateCorpusCollection(nonSynthetic).valid).toBe(false);

    const unsafeExpected = clone(collection);
    const unsafeCase = asRecord((unsafeExpected.goldenCases as unknown[])[0]);
    unsafeCase.expected = {
      state: 'INFORMATIONAL',
      reason: 'unsafe high-impact downgrade',
    };
    expect(validateCorpusCollection(unsafeExpected).valid).toBe(false);
    expect(
      validateCorpusCollection(unsafeExpected).errors.join('\n'),
    ).toContain('must expect REVIEW_REQUIRED or ACTION_REQUIRED');

    const unsupportedField = clone(collection);
    asRecord((unsupportedField.goldenCases as unknown[])[0]).measuredResult =
      'must not be part of a golden case';
    expect(validateCorpusCollection(unsupportedField).valid).toBe(false);
  });

  it('aligns the Phase 1L-3 insufficient-context golden labels with the applicability boundary', () => {
    const collection = loadSeedCorpus();
    const cases = collection.goldenCases as unknown[];

    // SYNTH-CASE-061: services.teams=true makes the matched rule decidable,
    // so the ownership-only gap must not expect INSUFFICIENT_CONTEXT.
    const case061 = asRecord(
      cases.find(
        (goldenCase) => asRecord(goldenCase).caseId === 'SYNTH-CASE-061',
      ),
    );
    expect(asRecord(case061.expected).state).toBe('INFORMATIONAL');
    expect(asRecord(case061.expected)).not.toHaveProperty('missingContext');
    expect(case061.evaluationTags).toContain('informational');
    expect(case061.evaluationTags).not.toContain('insufficient-context');
    expect(case061.evaluationTags).not.toContain('tenant-only-gap');

    // SYNTH-CASE-062/063/065: the expected gap is exactly the missing
    // services path the matched policy rule requests; ownership paths are
    // outside the Phase 1 applicability input.
    const serviceGapExpectations: Record<string, string> = {
      'SYNTH-CASE-062': 'services.exchange_online',
      'SYNTH-CASE-063': 'services.sharepoint_online',
      'SYNTH-CASE-065': 'services.power_platform',
    };
    for (const [caseId, servicePath] of Object.entries(
      serviceGapExpectations,
    )) {
      const goldenCase = asRecord(
        cases.find((entry) => asRecord(entry).caseId === caseId),
      );
      const expected = asRecord(goldenCase.expected);
      expect(expected.state).toBe('INSUFFICIENT_CONTEXT');
      expect(expected.missingContext).toEqual([servicePath]);
    }

    // SYNTH-CASE-064: the product-level Intune mapping looks only at
    // services.intune; capabilities.autopilot is not an applicability input
    // for that mapping.
    const case064 = asRecord(
      cases.find(
        (goldenCase) => asRecord(goldenCase).caseId === 'SYNTH-CASE-064',
      ),
    );
    expect(asRecord(case064.expected).missingContext).toEqual([
      'services.intune',
    ]);
  });
});
