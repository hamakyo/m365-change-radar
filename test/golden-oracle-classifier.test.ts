import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ChangeEventSchema,
  CorpusCollectionSchema,
  GoldenCaseSchema,
  RiskPolicySchema,
  StructuredClassificationAIInferenceSchema,
  StructuredImpactClassificationRequestSchema,
  TenantApplicabilityPolicySchema,
  TenantProfileSchema,
  createImpactAnalysisRecord,
  createStructuredImpactClassificationRequest,
  createDeterministicImpactDecision,
  evaluateRiskPolicy,
  evaluateTenantApplicability,
  type GoldenCase,
  type ImpactAnalysisMetadata,
  type StructuredImpactClassificationRequest,
} from '../src/index.js';
import { createGoldenCorpusImpactClassifier } from '../src/corpus/golden-oracle-classifier.js';

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
  return {
    manifest,
    changeFixtures: (manifest.changeFixtures as { path: string }[]).map(
      (entry) => readJson(join(corpusRoot, entry.path)),
    ),
    tenantProfileFixtures: (
      manifest.tenantProfileFixtures as { path: string }[]
    ).map((entry) => readJson(join(corpusRoot, entry.path))),
    goldenCases: (manifest.goldenCases as { path: string }[]).map((entry) =>
      readJson(join(corpusRoot, entry.path)),
    ),
  };
}

const seedCorpus = loadSeedCorpus();
const parsedSeedCorpus = CorpusCollectionSchema.parse(seedCorpus);

const riskPolicy = RiskPolicySchema.parse(
  readJson(resolve(process.cwd(), 'test/fixtures/risk-policy.json')),
);
const tenantPolicy = TenantApplicabilityPolicySchema.parse(
  readJson(
    resolve(process.cwd(), 'test/fixtures/tenant-applicability-policy.json'),
  ),
);

const metadata: ImpactAnalysisMetadata = {
  analysisId: 'oracle-analysis-001',
  tenantId: 'tenant-under-test',
  createdAt: '2026-08-28T09:30:00+09:00',
};

const fixtureByCase = new Map<string, GoldenCase>(
  parsedSeedCorpus.goldenCases.map((goldenCase) => [
    goldenCase.caseId,
    goldenCase,
  ]),
);
const changeFixtureByFixtureId = new Map(
  parsedSeedCorpus.changeFixtures.map((fixture) => [
    fixture.fixtureId,
    fixture,
  ]),
);
const profileFixtureByFixtureId = new Map(
  parsedSeedCorpus.tenantProfileFixtures.map((fixture) => [
    fixture.fixtureId,
    fixture,
  ]),
);

function decisionForGoldenCase(goldenCase: GoldenCase) {
  const changeFixture = changeFixtureByFixtureId.get(
    goldenCase.changeFixtureId,
  );
  const profileFixture = profileFixtureByFixtureId.get(
    goldenCase.tenantProfileFixtureId,
  );
  if (changeFixture === undefined || profileFixture === undefined) {
    throw new Error(`golden case ${goldenCase.caseId} has dangling fixtures`);
  }
  const event = ChangeEventSchema.parse(changeFixture.event);
  const profile = TenantProfileSchema.parse(profileFixture.profile);
  return {
    event,
    profile,
    decision: createDeterministicImpactDecision(
      evaluateRiskPolicy(riskPolicy, event),
      evaluateTenantApplicability(tenantPolicy, event, profile),
    ),
  };
}

function requestForGoldenCase(
  goldenCase: GoldenCase,
): StructuredImpactClassificationRequest {
  const { event, profile, decision } = decisionForGoldenCase(goldenCase);
  return createStructuredImpactClassificationRequest(
    event,
    'message-v1',
    profile,
    decision,
  );
}

/** Cases whose deterministic decision routes through the classifier: the
 * runner (and the existing request builder) never handle the
 * `DETERMINISTIC_FINAL` kind. */
function nonFinalGoldenCases(): GoldenCase[] {
  return parsedSeedCorpus.goldenCases.filter((goldenCase) => {
    return (
      decisionForGoldenCase(goldenCase).decision.kind !== 'DETERMINISTIC_FINAL'
    );
  });
}

const ORACLE_IDENTITY = 'golden-label-oracle';
const ORACLE_EVIDENCE_ID = 'ai.golden-label-oracle';

describe('createGoldenCorpusImpactClassifier — golden case lookup', () => {
  it('resolves exactly one case per pair and copies every non-final golden label', async () => {
    const oracle = createGoldenCorpusImpactClassifier(parsedSeedCorpus);
    const cases = nonFinalGoldenCases();
    expect(cases.length).toBeGreaterThan(0);

    const coveredStates = new Set<string>();
    for (const goldenCase of cases) {
      const request = requestForGoldenCase(goldenCase);
      const inference = await oracle(request);

      expect(inference.classificationOutput.proposedState).toBe(
        goldenCase.expected.state,
      );
      expect(inference.classificationOutput.reason).toBe(
        goldenCase.expected.reason,
      );
      if (goldenCase.expected.state === 'INSUFFICIENT_CONTEXT') {
        const output = inference.classificationOutput;
        if (output.proposedState !== 'INSUFFICIENT_CONTEXT') {
          throw new Error('oracle must copy the INSUFFICIENT_CONTEXT label');
        }
        expect(output.missingContext).toEqual(
          goldenCase.expected.missingContext,
        );
      } else {
        expect('missingContext' in inference.classificationOutput).toBe(false);
      }
      expect(
        StructuredClassificationAIInferenceSchema.safeParse(inference).success,
      ).toBe(true);
      coveredStates.add(goldenCase.expected.state);
    }
    // With golden labels aligned to the applicability boundary, every
    // expected INSUFFICIENT_CONTEXT pair is a DETERMINISTIC_FINAL
    // tenant-only gap (the evaluator resolves it without the classifier),
    // so only the three classifier-reachable states appear on non-final
    // cases. NOT_APPLICABLE is likewise final-only (asserted below).
    expect(coveredStates).toEqual(
      new Set(['ACTION_REQUIRED', 'REVIEW_REQUIRED', 'INFORMATIONAL']),
    );
  });

  it('reaches every NOT_APPLICABLE golden case only through the deterministic final branch', async () => {
    // Every NOT_APPLICABLE label in the seed corpus sits on a pair whose
    // test-fixture decision is DETERMINISTIC_FINAL: the runner resolves the
    // state from the tenant applicability evaluator and never calls the
    // classifier, so the oracle must never observe these requests. The test
    // pins that boundary instead of silently dropping the state.
    const notApplicableCases = parsedSeedCorpus.goldenCases.filter(
      (goldenCase) => goldenCase.expected.state === 'NOT_APPLICABLE',
    );
    expect(notApplicableCases.length).toBeGreaterThan(0);
    for (const goldenCase of notApplicableCases) {
      expect(decisionForGoldenCase(goldenCase).decision.kind).toBe(
        'DETERMINISTIC_FINAL',
      );
      expect(goldenCase.expected.state).toBe('NOT_APPLICABLE');
    }
    // The oracle still copies a NOT_APPLICABLE label when its pair routes
    // through the classifier: a seed-shaped collection whose non-final
    // SYNTH-CASE-001 label reads NOT_APPLICABLE (the case schema permits any
    // five-state label; only the seed coverage validator ties labels to
    // floors) drives the same existing-schema path end to end.
    const notApplicableLabelCorpus = clone(seedCorpus);
    const firstCase = asRecord(
      (notApplicableLabelCorpus.goldenCases as unknown[])[0],
    );
    firstCase.expected = {
      state: 'NOT_APPLICABLE',
      reason: 'pinned synthetic not-applicable label',
    };
    const oracle = createGoldenCorpusImpactClassifier(
      CorpusCollectionSchema.parse(notApplicableLabelCorpus),
    );
    const request = requestForGoldenCase(fixtureByCase.get('SYNTH-CASE-001')!);
    const inference = await oracle(request);
    expect(inference.classificationOutput.proposedState).toBe('NOT_APPLICABLE');
    expect(inference.classificationOutput.reason).toBe(
      'pinned synthetic not-applicable label',
    );
  });

  it('rejects a request whose pair has no golden case', async () => {
    const oracle = createGoldenCorpusImpactClassifier(parsedSeedCorpus);
    const anyCase = nonFinalGoldenCases()[0];
    if (anyCase === undefined) throw new Error('expected a non-final case');
    const request = StructuredImpactClassificationRequestSchema.parse(
      clone(requestForGoldenCase(anyCase)),
    );
    const tampered = StructuredImpactClassificationRequestSchema.parse({
      ...request,
      changeEvent: {
        ...request.changeEvent,
        externalId: 'SYNTH-MC-NO-SUCH-EXTERNAL-ID',
      },
      // The source facts carry the event's externalId by request invariant,
      // so retargeting the pair also retargets every fact that owns it.
      evidenceRecords: request.evidenceRecords.map((record) =>
        record.kind === 'source_fact'
          ? { ...record, externalId: 'SYNTH-MC-NO-SUCH-EXTERNAL-ID' }
          : record,
      ),
    });

    await expect(oracle(tampered)).rejects.toThrow(
      /golden corpus has no case for change externalId/,
    );
  });
});

describe('createGoldenCorpusImpactClassifier — synthetic identity', () => {
  it('stamps the fixed evaluation-only identity and confidence on every record', async () => {
    const oracle = createGoldenCorpusImpactClassifier(parsedSeedCorpus);
    for (const goldenCase of nonFinalGoldenCases()) {
      const inference = await oracle(requestForGoldenCase(goldenCase));

      expect(inference.kind).toBe('ai_inference');
      expect(inference.evidenceId).toBe(ORACLE_EVIDENCE_ID);
      expect(inference.promptVersion).toBe(ORACLE_IDENTITY);
      expect(inference.model).toBe(ORACLE_IDENTITY);
      expect(inference.modelVersion).toBe(ORACLE_IDENTITY);
      expect(inference.confidence).toBe(1);
      expect(inference.dependsOnEvidenceIds).toEqual([
        'source.event.title',
        'source.event.body',
      ]);
    }
  });
});

describe('createGoldenCorpusImpactClassifier — evidence ownership', () => {
  it('cites only evidence that exists in the same request and fails closed on its loss', async () => {
    const oracle = createGoldenCorpusImpactClassifier(parsedSeedCorpus);
    const anyCase = nonFinalGoldenCases()[0];
    if (anyCase === undefined) throw new Error('expected a non-final case');
    const request = requestForGoldenCase(anyCase);
    const inference = await oracle(request);
    const evidenceIds = new Set(
      request.evidenceRecords.map((record) => record.evidenceId),
    );
    for (const id of ['source.event.title', 'source.event.body']) {
      expect(evidenceIds.has(id)).toBe(true);
      expect(inference.dependsOnEvidenceIds).toContain(id);
    }

    // A request whose deterministic evidence lost the cited title fact must
    // be rejected instead of answered with dangling evidence.
    const stripped = StructuredImpactClassificationRequestSchema.parse({
      ...request,
      evidenceRecords: request.evidenceRecords.filter(
        (record) => record.evidenceId !== 'source.event.title',
      ),
    });
    await expect(oracle(stripped)).rejects.toThrow(
      /supporting evidence does not exist in this request: source\.event\.title/,
    );
  });
});

describe('createGoldenCorpusImpactClassifier — fail-closed corpus', () => {
  it('rejects a golden case referencing a missing change or profile fixture', () => {
    const withMissingChange = clone(seedCorpus);
    const firstCase = asRecord((withMissingChange.goldenCases as unknown[])[0]);
    firstCase.changeFixtureId = 'SYNTH-MC-MISSING';
    expect(() =>
      createGoldenCorpusImpactClassifier(
        CorpusCollectionSchema.parse(withMissingChange),
      ),
    ).toThrow(/references missing change fixture/);

    const withMissingProfile = clone(seedCorpus);
    const profileCase = asRecord(
      (withMissingProfile.goldenCases as unknown[])[0],
    );
    profileCase.tenantProfileFixtureId = 'SYNTH-TENANT-MISSING';
    expect(() =>
      createGoldenCorpusImpactClassifier(
        CorpusCollectionSchema.parse(withMissingProfile),
      ),
    ).toThrow(/references missing tenant profile fixture/);
  });

  it('rejects two golden cases resolving to the same pair', () => {
    const withDuplicatePair = clone(seedCorpus);
    const duplicate = clone(
      (withDuplicatePair.goldenCases as unknown[])[0],
    ) as Record<string, unknown>;
    duplicate.caseId = 'SYNTH-CASE-DUP-PAIR';
    duplicate.evaluationTags = ['duplicate-pair-probe'];
    (withDuplicatePair.goldenCases as unknown[]).push(duplicate);

    expect(() =>
      createGoldenCorpusImpactClassifier(
        CorpusCollectionSchema.parse(withDuplicatePair),
      ),
    ).toThrow(/duplicate pairs: .*SYNTH-CASE-001 and SYNTH-CASE-DUP-PAIR/);
  });

  it('rejects a tampered golden label whose expected state is unsupported', () => {
    const withBadLabel = clone(seedCorpus);
    const badCase = asRecord((withBadLabel.goldenCases as unknown[])[0]);
    badCase.expected = { state: 'NOT_A_STATE', reason: 'broken label' };
    expect(GoldenCaseSchema.safeParse(badCase).success).toBe(false);
    expect(() =>
      createGoldenCorpusImpactClassifier(
        CorpusCollectionSchema.parse(withBadLabel),
      ),
    ).toThrow();
  });
});

describe('createGoldenCorpusImpactClassifier — determinism and purity', () => {
  it('returns deep-equal records for repeated calls and round-trips through JSON', async () => {
    const oracle = createGoldenCorpusImpactClassifier(parsedSeedCorpus);
    const anyCase = nonFinalGoldenCases()[0];
    if (anyCase === undefined) throw new Error('expected a non-final case');
    const request = requestForGoldenCase(anyCase);

    const first = await oracle(request);
    const second = await oracle(request);
    expect(second).toEqual(first);

    const roundTripped = StructuredClassificationAIInferenceSchema.parse(
      JSON.parse(JSON.stringify(first)) as unknown,
    );
    expect(roundTripped).toEqual(first);
  });

  it('accepts a JSON-parsed collection argument without mutating it', async () => {
    const collectionBefore = clone(seedCorpus);
    // The factory re-parses its argument through CorpusCollectionSchema, so
    // the raw JSON tree is accepted and never mutated.
    const oracle = createGoldenCorpusImpactClassifier(
      CorpusCollectionSchema.parse(seedCorpus),
    );
    const anyCase = nonFinalGoldenCases()[0];
    if (anyCase === undefined) throw new Error('expected a non-final case');
    const requestBefore = clone(requestForGoldenCase(anyCase));
    await oracle(requestForGoldenCase(anyCase));

    expect(clone(seedCorpus)).toEqual(collectionBefore);
    expect(clone(requestForGoldenCase(anyCase))).toEqual(requestBefore);
  });

  it('is callable through the structured request boundary as an injected classifier', async () => {
    const oracle = createGoldenCorpusImpactClassifier(parsedSeedCorpus);
    const record = await createImpactAnalysisRecord(
      ChangeEventSchema.parse(
        changeFixtureByFixtureId.get('SYNTH-MC-001')!.event,
      ),
      'message-v1',
      TenantProfileSchema.parse(
        profileFixtureByFixtureId.get('SYNTH-TENANT-001')!.profile,
      ),
      riskPolicy,
      tenantPolicy,
      metadata,
      oracle,
    );
    const expected = fixtureByCase.get('SYNTH-CASE-001')!;

    // SYNTH-CASE-001 carries a REVIEW_REQUIRED floor, so the runner's
    // guardrail merge may override the copied label — the final state is
    // either the label or the floor, never anything else.
    expect(
      ['REVIEW_REQUIRED', 'ACTION_REQUIRED'].includes(
        record.impactAssessment.state,
      ),
    ).toBe(true);
    expect(record.versionBundle.ai).toEqual({
      used: true,
      promptVersion: ORACLE_IDENTITY,
      model: ORACLE_IDENTITY,
      modelVersion: ORACLE_IDENTITY,
    });
    expect(record.changeEventRef).toEqual({
      source: 'synthetic-message-center',
      externalId: 'SYNTH-MC-001',
      sourceMessageVersion: 'message-v1',
    });
    expect(expected.expected.state).toBe('REVIEW_REQUIRED');
  });
});
