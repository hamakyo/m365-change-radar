import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AnalysisRecordSchema,
  ChangeEventSchema,
  CorpusCollectionSchema,
  RiskPolicySchema,
  TenantApplicabilityPolicySchema,
  TenantProfileSchema,
  createDeterministicImpactDecision,
  evaluateRiskPolicy,
  evaluateTenantApplicability,
  type ChangeEvent,
  type StructuredClassificationAIInference,
  type StructuredImpactClassificationOutput,
  type StructuredImpactClassifier,
  type SuggestedChangeAction,
  type SuggestedChangeActionGenerationRequest,
  type SuggestedChangeActionGenerator,
  type TenantProfile,
} from '../src/index.js';
import {
  runImpactAnalysisMatrix,
  type ImpactAnalysisMatrixMetadataFactory,
  type ImpactAnalysisMatrixPairIdentity,
  type ImpactAnalysisMatrixResult,
} from '../src/corpus/impact-analysis-matrix-runner.js';

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

const CREATED_AT = '2026-08-28T09:30:00+09:00';

/** Deterministic, collision-free metadata: one analysisId per pair, so every
 * accepted run stays reproducible and the collision rule stays exercisable
 * by overriding the factory. */
const metadataFor: ImpactAnalysisMatrixMetadataFactory = (pair) => ({
  analysisId: `analysis.${pair.changeFixtureId}.${pair.tenantProfileFixtureId}`,
  tenantId: 'tenant-under-test',
  createdAt: CREATED_AT,
});

function eventWith(overrides: Record<string, unknown>): ChangeEvent {
  return ChangeEventSchema.parse({
    ...baseEvent,
    products: ['Synthetic Teams'],
    sourceMetadata: {
      ...(baseEvent.sourceMetadata as Record<string, unknown>),
      synthetic: true,
    },
    ...overrides,
  });
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

/** No risk floor: the tenant side decides the branch. */
const finalEvent = eventWith({
  severity: 'low',
  signals: calmSignals,
  categories: [],
});

/** ACTION_REQUIRED guardrail floor (major + admin impact at high severity). */
const actionFloorEvent = eventWith({
  severity: 'high',
  signals: {
    ...baseEvent.signals,
    isMajorChange: true,
    hasAdminImpact: true,
  },
});

/** No risk floor, applicable tenant: the classification path with an
 * INFORMATIONAL proposal. */
const classificationEvent = eventWith({
  severity: 'low',
  signals: { ...baseEvent.signals, hasAdminImpact: false },
});

const teamsOffProfile: TenantProfile = TenantProfileSchema.parse({
  ...baseProfile,
  profileVersion: 'profile-teams-off',
  services: { ...baseProfile.services, teams: false },
});

const missingTeamsProfile: TenantProfile = TenantProfileSchema.parse({
  ...baseProfile,
  profileVersion: 'profile-missing-teams',
  services: Object.fromEntries(
    Object.entries(baseProfile.services).filter(([key]) => key !== 'teams'),
  ),
});

type ChangeFixtureSpec = {
  readonly fixtureId: string;
  readonly event: ChangeEvent;
};

type ProfileFixtureSpec = {
  readonly fixtureId: string;
  readonly profile: TenantProfile;
};

function changeFixtureOf(spec: ChangeFixtureSpec) {
  return {
    fixtureId: spec.fixtureId,
    synthetic: true,
    event: spec.event,
    coverageTags: ['teams'],
  };
}

function profileFixtureOf(spec: ProfileFixtureSpec) {
  return {
    fixtureId: spec.fixtureId,
    synthetic: true,
    profile: spec.profile,
    coverageTags: ['teams'],
  };
}

function manifestFor(
  changes: readonly ChangeFixtureSpec[],
  profiles: readonly ProfileFixtureSpec[],
) {
  const firstChange = changes[0];
  const firstProfile = profiles[0];
  if (firstChange === undefined || firstProfile === undefined) {
    throw new Error(
      'matrix test collections need at least one change and one profile fixture',
    );
  }
  return {
    schemaVersion: '1.0',
    corpusId: 'synthetic-matrix',
    corpusVersion: '1.0.0',
    synthetic: true,
    changeFixtures: changes.map((entry) => ({
      fixtureId: entry.fixtureId,
      path: `changes/${entry.fixtureId.toLowerCase()}.json`,
    })),
    tenantProfileFixtures: profiles.map((entry) => ({
      fixtureId: entry.fixtureId,
      path: `tenant-profiles/${entry.fixtureId.toLowerCase()}.json`,
    })),
    goldenCases: [
      {
        caseId: 'MATRIX-CASE-000',
        path: 'cases/matrix-case-000.json',
      },
    ],
  };
}

function collectionOf(
  changes: readonly ChangeFixtureSpec[],
  profiles: readonly ProfileFixtureSpec[],
) {
  const firstChange = changes[0];
  const firstProfile = profiles[0];
  if (firstChange === undefined || firstProfile === undefined) {
    throw new Error(
      'matrix test collections need at least one change and one profile fixture',
    );
  }
  return CorpusCollectionSchema.parse({
    manifest: manifestFor(changes, profiles),
    changeFixtures: changes.map(changeFixtureOf),
    tenantProfileFixtures: profiles.map(profileFixtureOf),
    goldenCases: [
      {
        caseId: 'MATRIX-CASE-000',
        synthetic: true,
        changeFixtureId: firstChange.fixtureId,
        tenantProfileFixtureId: firstProfile.fixtureId,
        expected: { state: 'INFORMATIONAL', reason: 'matrix placeholder' },
        importance: 'low',
        highImpact: false,
        coverageTags: ['teams'],
        evaluationTags: ['matrix'],
      },
    ],
  });
}

/** Deterministic action citing only evidence every analysis record holds:
 * the source fact for the change title. */
const deterministicAction: SuggestedChangeAction = {
  origin: 'deterministic',
  actionId: 'action.notify-owner-001',
  kind: 'COMMUNICATE',
  title: 'Notify service owners of the upcoming deadline',
  description:
    'Send the deadline notice derived from the policy conclusion to every listed owner.',
  ownerKey: 'teams-service-owners',
  dueAt: '2026-10-01T00:00:00+09:00',
  supportingEvidenceIds: ['source.event.title'],
};

type GeneratorOptions = {
  readonly failOnCallNumber?: number;
};

function generatorFor(
  options: GeneratorOptions = {},
): SuggestedChangeActionGenerator & {
  calls: SuggestedChangeActionGenerationRequest[];
} {
  const calls: SuggestedChangeActionGenerationRequest[] = [];
  const generator: SuggestedChangeActionGenerator = async (received) => {
    calls.push(received);
    if (
      options.failOnCallNumber !== undefined &&
      calls.length === options.failOnCallNumber
    ) {
      throw new Error('action generator unavailable');
    }
    return { actions: [{ ...deterministicAction }] };
  };
  return Object.assign(generator, { calls });
}

/** Throwing classifier stub whose call log proves zero-call bounds. */
function throwingClassifier(): StructuredImpactClassifier & {
  calls: unknown[];
} {
  const calls: unknown[] = [];
  const classifier: StructuredImpactClassifier = async () => {
    throw new Error('must never be called');
  };
  return Object.assign(classifier, { calls });
}

/** Faithful INFORMATIONAL stub classifier mirroring the existing runner
 * tests: the execution identity lives on the returned AI record and the
 * ownership triple mirrors the bundled raw proposal. */
function informationalClassifier(): StructuredImpactClassifier & {
  calls: unknown[];
} {
  const output: StructuredImpactClassificationOutput = {
    proposedState: 'INFORMATIONAL',
    confidence: 0.75,
    reason: 'Classifier proposed INFORMATIONAL.',
    affectedComponents: ['Synthetic Teams'],
    supportingEvidenceIds: ['source.event.title'],
  };
  const inference: StructuredClassificationAIInference = {
    kind: 'ai_inference',
    evidenceId: 'ai.classification-proposal',
    promptVersion: 'prompt-2026-08',
    model: 'gpt-5.6-luna',
    modelVersion: 'gpt-5.6-luna-2026-08-01',
    confidence: 0.75,
    inference: 'Classifier proposed INFORMATIONAL.',
    dependsOnEvidenceIds: ['source.event.title'],
    classificationOutput: output,
  };
  const calls: unknown[] = [];
  const classifier: StructuredImpactClassifier = async () => {
    calls.push(1);
    return inference;
  };
  return Object.assign(classifier, { calls });
}

/** Always-throwing classifier for pair-attribution tests. */
function failingClassifier(): StructuredImpactClassifier {
  return async () => {
    throw new Error('classification provider unavailable');
  };
}

/** The canonical small matrix: two change fixtures × three tenant profiles,
 * covering the classification path, both deterministic finals, and the
 * guardrail floor path. */
const smallChanges: readonly ChangeFixtureSpec[] = [
  { fixtureId: 'FINAL-CHANGE', event: finalEvent },
  { fixtureId: 'ACTION-CHANGE', event: actionFloorEvent },
];

const smallProfiles: readonly ProfileFixtureSpec[] = [
  { fixtureId: 'BASE-TENANT', profile: baseProfile },
  { fixtureId: 'TEAMS-OFF-TENANT', profile: teamsOffProfile },
  { fixtureId: 'MISSING-TEAMS-TENANT', profile: missingTeamsProfile },
];

const SMALL_PAIR_ORDER = [
  'FINAL-CHANGE|BASE-TENANT',
  'FINAL-CHANGE|TEAMS-OFF-TENANT',
  'FINAL-CHANGE|MISSING-TEAMS-TENANT',
  'ACTION-CHANGE|BASE-TENANT',
  'ACTION-CHANGE|TEAMS-OFF-TENANT',
  'ACTION-CHANGE|MISSING-TEAMS-TENANT',
] as const;

type SmallRunOptions = {
  readonly changes?: readonly ChangeFixtureSpec[];
  readonly profiles?: readonly ProfileFixtureSpec[];
  readonly classifier?: StructuredImpactClassifier;
  readonly actionGenerator?: SuggestedChangeActionGenerator;
  /** When true, no action generator is handed to the matrix at all
   * (JS cannot distinguish an absent key from an explicit undefined). */
  readonly omitGenerator?: boolean;
  readonly metadataFactory?: ImpactAnalysisMatrixMetadataFactory;
};

type SmallRun = {
  readonly result: ImpactAnalysisMatrixResult;
  /** Every request handed to the effective action generator, in call
   * order — recorded by a wrapper, so it works for provided generators
   * too. */
  readonly generatorCalls: SuggestedChangeActionGenerationRequest[];
  /** Every request handed to the effective classifier, in call order. */
  readonly classifierCalls: unknown[];
  readonly metadataCalls: ImpactAnalysisMatrixPairIdentity[];
};

async function runSmallMatrix(
  options: SmallRunOptions = {},
): Promise<SmallRun> {
  const changes = options.changes ?? smallChanges;
  const profiles = options.profiles ?? smallProfiles;
  // The wrapper is installed whenever a generator should exist (default or
  // provided); `omitGenerator: true` hands the matrix no generator at all.
  const generatorCalls: SuggestedChangeActionGenerationRequest[] = [];
  let actionGenerator: SuggestedChangeActionGenerator | undefined;
  if (options.omitGenerator === true) {
    actionGenerator = undefined;
  } else {
    const effectiveGenerator: SuggestedChangeActionGenerator =
      options.actionGenerator ?? generatorFor();
    actionGenerator = async (received) => {
      generatorCalls.push(received);
      return effectiveGenerator(received);
    };
  }

  const classifierCalls: unknown[] = [];
  const classifier: StructuredImpactClassifier = async (request) => {
    classifierCalls.push(request);
    return (options.classifier ?? informationalClassifier())(request);
  };

  const metadataCalls: ImpactAnalysisMatrixPairIdentity[] = [];
  const metadataFactory: ImpactAnalysisMatrixMetadataFactory =
    options.metadataFactory ??
    ((pair) => {
      metadataCalls.push(pair);
      return metadataFor(pair);
    });

  const result = await runImpactAnalysisMatrix({
    collection: collectionOf(changes, profiles),
    sourceMessageVersion: 'message-v1',
    riskPolicy,
    tenantApplicabilityPolicy: tenantPolicy,
    metadataFactory,
    classifier,
    actionGenerator,
  });
  return { result, generatorCalls, classifierCalls, metadataCalls };
}

const actionableStates: readonly string[] = [
  'ACTION_REQUIRED',
  'REVIEW_REQUIRED',
];

function isActionable(pair: {
  analysisRecord: { impactAssessment: { state: string } };
}): boolean {
  return actionableStates.includes(pair.analysisRecord.impactAssessment.state);
}

describe('runImpactAnalysisMatrix — fixed order and counts', () => {
  it('processes every pair exactly once in change-major/profile-minor order', async () => {
    const { result, metadataCalls, generatorCalls } = await runSmallMatrix();

    expect(result.processedCount).toBe(6);
    expect(
      result.pairs.map(
        (pair) => `${pair.changeFixtureId}|${pair.tenantProfileFixtureId}`,
      ),
    ).toEqual([...SMALL_PAIR_ORDER]);
    expect(
      metadataCalls.map(
        (pair) => `${pair.changeFixtureId}|${pair.tenantProfileFixtureId}`,
      ),
    ).toEqual([...SMALL_PAIR_ORDER]);

    // Three actionable floor pairs, one classification-path pair, one
    // NOT_APPLICABLE final, one INSUFFICIENT_CONTEXT final.
    expect(result.stateCounts).toEqual({
      ACTION_REQUIRED: 3,
      REVIEW_REQUIRED: 0,
      INFORMATIONAL: 1,
      NOT_APPLICABLE: 1,
      INSUFFICIENT_CONTEXT: 1,
    });
    expect(result.actionCount).toBe(3);
    expect(generatorCalls.length).toBe(3);

    // Actions exist exactly on the actionable pairs and every record is a
    // valid existing AnalysisRecord.
    for (const pair of result.pairs) {
      expect(AnalysisRecordSchema.safeParse(pair.analysisRecord).success).toBe(
        true,
      );
      if (isActionable(pair)) {
        expect(pair.suggestedChangeActionResult).toBeDefined();
      } else {
        expect('suggestedChangeActionResult' in pair).toBe(false);
      }
    }
  });

  it('hands each actionable pair its own analysis record and counts its actions', async () => {
    const { result, generatorCalls } = await runSmallMatrix();

    const actionableOutcomes = result.pairs.filter(
      (pair) => pair.suggestedChangeActionResult !== undefined,
    );
    expect(actionableOutcomes.length).toBe(3);
    actionableOutcomes.forEach((pair, index) => {
      const request = generatorCalls[index];
      expect(request).toBeDefined();
      expect(request?.analysisRecord).toEqual(pair.analysisRecord);
      expect(request?.tenantProfile.profileVersion).toBe(
        pair.analysisRecord.versionBundle.tenantProfileVersion,
      );
      expect(pair.suggestedChangeActionResult?.actions.length).toBe(1);
      expect(pair.suggestedChangeActionResult?.actions[0]?.actionId).toBe(
        'action.notify-owner-001',
      );
    });
  });
});

describe('runImpactAnalysisMatrix — deterministic final and classifier bounds', () => {
  it('calls the classifier zero times when every pair is DETERMINISTIC_FINAL', async () => {
    // A throwing classifier must survive an all-final matrix untouched.
    // FINAL-CHANGE-A pairs with teams-enabled BASE-TENANT reach the
    // classification path, so it is excluded here: the remaining five
    // pairs are all DETERMINISTIC_FINAL.
    const { result, classifierCalls } = await runSmallMatrix({
      changes: [{ fixtureId: 'FINAL-CHANGE-B', event: finalEvent }],
      profiles: [
        { fixtureId: 'TEAMS-OFF-TENANT', profile: teamsOffProfile },
        { fixtureId: 'MISSING-TEAMS-TENANT', profile: missingTeamsProfile },
        {
          fixtureId: 'TEAMS-OFF-TENANT-B',
          profile: TenantProfileSchema.parse({
            ...teamsOffProfile,
            profileVersion: 'profile-teams-off-b',
          }),
        },
      ],
      classifier: throwingClassifier(),
    });

    expect(result.processedCount).toBe(3);
    expect(result.stateCounts.NOT_APPLICABLE).toBe(2);
    expect(result.stateCounts.INSUFFICIENT_CONTEXT).toBe(1);
    expect(classifierCalls.length).toBe(0);
    expect(result.actionCount).toBe(0);
  });

  it('calls the classifier exactly once for each non-final pair only', async () => {
    // Three change events × three profiles: every BASE-TENANT pair (3)
    // plus the FLOOR-CHANGE column (2 more) reach the classifier — 5 in
    // total; the remaining 4 pairs are DETERMINISTIC_FINAL.
    const { result, classifierCalls } = await runSmallMatrix({
      changes: [
        { fixtureId: 'FINAL-CHANGE-A', event: finalEvent },
        { fixtureId: 'FLOOR-CHANGE', event: actionFloorEvent },
      ],
      classifier: informationalClassifier(),
    });

    expect(result.processedCount).toBe(6);
    expect(classifierCalls.length).toBe(4);
    expect(result.stateCounts.ACTION_REQUIRED).toBe(3);
    expect(result.stateCounts.NOT_APPLICABLE).toBe(1);
    expect(result.stateCounts.INSUFFICIENT_CONTEXT).toBe(1);
    expect(result.stateCounts.INFORMATIONAL).toBe(1);
  });
});

describe('runImpactAnalysisMatrix — actionable and non-actionable generator bounds', () => {
  it('calls the generator exactly once per actionable pair', async () => {
    const { generatorCalls } = await runSmallMatrix();
    expect(generatorCalls.length).toBe(3);
  });

  it('calls the generator zero times for every non-actionable pair', async () => {
    const { result, generatorCalls } = await runSmallMatrix({
      changes: [
        { fixtureId: 'INFO-CHANGE', event: classificationEvent },
        { fixtureId: 'FINAL-CHANGE', event: finalEvent },
      ],
    });

    // BASE-TENANT pairs are non-final: both accept the INFORMATIONAL
    // proposal, so two of the six pairs are non-actionable classification
    // outputs; the remaining four are finals (2 NOT_APPLICABLE,
    // 2 INSUFFICIENT_CONTEXT).
    expect(result.stateCounts.INFORMATIONAL).toBe(2);
    expect(result.stateCounts.NOT_APPLICABLE).toBe(2);
    expect(result.stateCounts.INSUFFICIENT_CONTEXT).toBe(2);
    expect(result.stateCounts.ACTION_REQUIRED).toBe(0);
    expect(result.stateCounts.REVIEW_REQUIRED).toBe(0);
    expect(result.actionCount).toBe(0);
    expect(generatorCalls.length).toBe(0);
    expect(
      result.pairs.every(
        (pair) => 'suggestedChangeActionResult' in pair === false,
      ),
    ).toBe(true);
  });

  it('omits action results entirely when no generator is provided', async () => {
    const { result, generatorCalls } = await runSmallMatrix({
      omitGenerator: true,
    });

    expect(result.processedCount).toBe(6);
    expect(result.actionCount).toBe(0);
    expect(generatorCalls.length).toBe(0);
    expect(
      result.pairs.every(
        (pair) => 'suggestedChangeActionResult' in pair === false,
      ),
    ).toBe(true);
    // The three actionable records still exist; only the action results
    // are absent.
    expect(result.pairs.filter((pair) => isActionable(pair)).length).toBe(3);
  });
});

describe('runImpactAnalysisMatrix — fail-closed pair attribution', () => {
  it('attributes a metadata factory throw to its pair identity', async () => {
    await expect(
      runSmallMatrix({
        metadataFactory: (pair) => {
          if (pair.tenantProfileFixtureId === 'TEAMS-OFF-TENANT') {
            throw new Error('metadata source down');
          }
          return metadataFor(pair);
        },
      }),
    ).rejects.toThrow(
      /analysis metadata factory threw for pair \(changeFixtureId: FINAL-CHANGE, tenantProfileFixtureId: TEAMS-OFF-TENANT\)/,
    );
  });

  it('attributes an invalid metadata return to its pair identity', async () => {
    await expect(
      runSmallMatrix({
        metadataFactory: ((pair: ImpactAnalysisMatrixPairIdentity) => {
          if (pair.tenantProfileFixtureId === 'MISSING-TEAMS-TENANT') {
            return { analysisId: '', tenantId: 'tenant-under-test' };
          }
          return metadataFor(pair);
        }) as unknown as ImpactAnalysisMatrixMetadataFactory,
      }),
    ).rejects.toThrow(
      /analysis metadata factory returned invalid metadata for pair \(changeFixtureId: FINAL-CHANGE, tenantProfileFixtureId: MISSING-TEAMS-TENANT\)/,
    );
  });

  it('fails closed on an analysisId collision between two pairs', async () => {
    await expect(
      runSmallMatrix({
        metadataFactory: () => ({
          analysisId: 'analysis.duplicate',
          tenantId: 'tenant-under-test',
          createdAt: CREATED_AT,
        }),
      }),
    ).rejects.toThrow(
      /analysis metadata collision for pair \(changeFixtureId: FINAL-CHANGE, tenantProfileFixtureId: TEAMS-OFF-TENANT\): analysisId "analysis\.duplicate" was already produced for pair \(changeFixtureId: FINAL-CHANGE, tenantProfileFixtureId: BASE-TENANT\)/,
    );
  });

  it('aborts with pair identity when the classifier fails on a non-final pair', async () => {
    await expect(
      runSmallMatrix({ classifier: failingClassifier() }),
    ).rejects.toThrow(
      /impact analysis failed for pair \(changeFixtureId: FINAL-CHANGE, tenantProfileFixtureId: BASE-TENANT\): classification provider unavailable/,
    );
  });

  it('attributes an action generation failure to its pair identity', async () => {
    const generator = generatorFor({ failOnCallNumber: 2 });
    await expect(
      runSmallMatrix({ actionGenerator: generator }),
    ).rejects.toThrow(
      /suggested action generation failed for pair \(changeFixtureId: ACTION-CHANGE, tenantProfileFixtureId: TEAMS-OFF-TENANT\): action generator unavailable/,
    );
    // The first actionable pair was served; the run aborted on the second.
    expect(generator.calls.length).toBe(2);
  });

  it('fails closed on duplicate change fixture IDs with no pair processed', async () => {
    const duplicated = { fixtureId: 'DUP-CHANGE', event: finalEvent };
    const classifier = throwingClassifier();
    await expect(
      runImpactAnalysisMatrix({
        collection: collectionOf(
          [duplicated, duplicated],
          [{ fixtureId: 'BASE-TENANT', profile: baseProfile }],
        ),
        sourceMessageVersion: 'message-v1',
        riskPolicy,
        tenantApplicabilityPolicy: tenantPolicy,
        metadataFactory: metadataFor,
        classifier,
      }),
    ).rejects.toThrow(
      /duplicate change fixture IDs in corpus collection: DUP-CHANGE/,
    );
    expect(classifier.calls.length).toBe(0);
  });

  it('fails closed on duplicate tenant profile fixture IDs with no pair processed', async () => {
    const duplicated = { fixtureId: 'DUP-TENANT', profile: baseProfile };
    const classifier = throwingClassifier();
    await expect(
      runImpactAnalysisMatrix({
        collection: collectionOf(
          [{ fixtureId: 'FINAL-CHANGE', event: finalEvent }],
          [duplicated, duplicated],
        ),
        sourceMessageVersion: 'message-v1',
        riskPolicy,
        tenantApplicabilityPolicy: tenantPolicy,
        metadataFactory: metadataFor,
        classifier,
      }),
    ).rejects.toThrow(
      /duplicate tenant profile fixture IDs in corpus collection: DUP-TENANT/,
    );
    expect(classifier.calls.length).toBe(0);
  });

  it('rejects boundary-invalid inputs before any pair runs', async () => {
    const baseInput = {
      collection: collectionOf(smallChanges, smallProfiles),
      riskPolicy,
      tenantApplicabilityPolicy: tenantPolicy,
      metadataFactory: metadataFor,
      classifier: throwingClassifier(),
    };

    await expect(
      runImpactAnalysisMatrix({
        ...baseInput,
        sourceMessageVersion: '   ',
      }),
    ).rejects.toThrow();

    await expect(
      runImpactAnalysisMatrix({
        ...baseInput,
        sourceMessageVersion: 'message-v1',
        riskPolicy: { ...riskPolicy, policyId: '' },
      }),
    ).rejects.toThrow();
  });

  it('rejects an empty change fixture collection before any pair runs', async () => {
    const validCollection = collectionOf(smallChanges, smallProfiles);
    await expect(
      runImpactAnalysisMatrix({
        collection: {
          ...validCollection,
          changeFixtures: [],
        } as unknown as Parameters<
          typeof runImpactAnalysisMatrix
        >[0]['collection'],
        sourceMessageVersion: 'message-v1',
        riskPolicy,
        tenantApplicabilityPolicy: tenantPolicy,
        metadataFactory: metadataFor,
        classifier: throwingClassifier(),
      }),
    ).rejects.toThrow();
  });
});

describe('runImpactAnalysisMatrix — determinism, purity, JSON safety', () => {
  it('is deterministic across repeated runs with equal inputs', async () => {
    const first = await runSmallMatrix();
    const second = await runSmallMatrix();

    expect(second.result).toEqual(first.result);
  });

  it('never mutates inputs and round-trips through JSON', async () => {
    const eventBefore = clone(finalEvent);
    const profileBefore = clone(baseProfile);
    const policyBefore = clone(riskPolicy);

    const { result } = await runSmallMatrix();

    expect(clone(finalEvent)).toEqual(eventBefore);
    expect(clone(baseProfile)).toEqual(profileBefore);
    expect(clone(riskPolicy)).toEqual(policyBefore);

    const revived: unknown = JSON.parse(JSON.stringify(result));
    expect(revived).toEqual(result);
  });
});

describe('runImpactAnalysisMatrix — representative corpus matrix', () => {
  it('routes the full 500-pair synthetic corpus in fixed order with correct counts', async () => {
    const changeDirectory = resolve(process.cwd(), 'corpus/changes');
    const profileDirectory = resolve(process.cwd(), 'corpus/tenant-profiles');
    const manifestText = readFileSync(
      resolve(process.cwd(), 'corpus/manifest.json'),
      'utf8',
    );

    const changeFixtures = readdirSync(changeDirectory)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => readJson(join(changeDirectory, name)));
    const profileFixtures = readdirSync(profileDirectory)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => readJson(join(profileDirectory, name)));
    const manifest = JSON.parse(manifestText) as {
      goldenCases: { caseId: string; path: string }[];
    };
    const firstGoldenCase = readJson(
      resolve(process.cwd(), 'corpus', manifest.goldenCases[0]!.path),
    );

    const collection = CorpusCollectionSchema.parse({
      manifest: JSON.parse(manifestText),
      changeFixtures,
      tenantProfileFixtures: profileFixtures,
      goldenCases: [firstGoldenCase],
    });

    const generator = generatorFor();
    const result = await runImpactAnalysisMatrix({
      collection,
      sourceMessageVersion: 'message-v1',
      riskPolicy,
      tenantApplicabilityPolicy: tenantPolicy,
      metadataFactory: metadataFor,
      classifier: informationalClassifier(),
      actionGenerator: generator,
    });

    expect(changeFixtures.length).toBe(50);
    expect(profileFixtures.length).toBe(10);
    expect(result.processedCount).toBe(500);
    expect(result.pairs.length).toBe(500);

    const totalStates = Object.values(result.stateCounts).reduce(
      (sum, count) => sum + count,
      0,
    );
    expect(totalStates).toBe(500);
    expect(result.stateCounts.NOT_APPLICABLE).toBeGreaterThan(0);
    expect(result.stateCounts.ACTION_REQUIRED).toBeGreaterThan(0);

    // Fixed change-major order: the first ten pairs share the first change
    // fixture and iterate the profile fixtures in declaration order.
    expect(result.pairs[0]?.changeFixtureId).toBe('SYNTH-MC-001');
    result.pairs.slice(0, 10).forEach((pair, index) => {
      expect(pair.changeFixtureId).toBe('SYNTH-MC-001');
      expect(pair.tenantProfileFixtureId).toBe(
        `SYNTH-TENANT-${String(index + 1).padStart(3, '0')}`,
      );
    });

    // Every pair's final state agrees with the existing decision evaluators:
    // deterministic finals keep their state; classified pairs accept the
    // INFORMATIONAL proposal unless a guardrail floor raises it.
    for (const pair of result.pairs) {
      const changeFixture = collection.changeFixtures.find(
        (candidate) => candidate.fixtureId === pair.changeFixtureId,
      );
      const profileFixture = collection.tenantProfileFixtures.find(
        (candidate) => candidate.fixtureId === pair.tenantProfileFixtureId,
      );
      expect(changeFixture).toBeDefined();
      expect(profileFixture).toBeDefined();
      const decision = createDeterministicImpactDecision(
        evaluateRiskPolicy(riskPolicy, changeFixture!.event),
        evaluateTenantApplicability(
          tenantPolicy,
          changeFixture!.event,
          profileFixture!.profile,
        ),
      );
      if (decision.kind === 'DETERMINISTIC_FINAL') {
        expect(pair.analysisRecord.impactAssessment.state).toBe(decision.state);
      } else if (decision.kind === 'GUARDRAIL_FLOOR') {
        expect(pair.analysisRecord.impactAssessment.state).toBe(
          decision.stateFloor,
        );
      } else {
        expect(pair.analysisRecord.impactAssessment.state).toBe(
          'INFORMATIONAL',
        );
      }
      expect(AnalysisRecordSchema.safeParse(pair.analysisRecord).success).toBe(
        true,
      );
    }

    // Actionable pairs all carry generator results; nothing else does.
    const actionableOutcomes = result.pairs.filter(
      (pair) => pair.suggestedChangeActionResult !== undefined,
    );
    const expectedActionable = result.pairs.filter((pair) =>
      isActionable(pair),
    );
    expect(actionableOutcomes.length).toBe(expectedActionable.length);
    expect(generator.calls.length).toBe(expectedActionable.length);
    let countedActions = 0;
    for (const pair of actionableOutcomes) {
      countedActions += pair.suggestedChangeActionResult?.actions.length ?? 0;
    }
    expect(result.actionCount).toBe(countedActions);

    // Every analysisId is unique across the matrix.
    const analysisIds = new Set(
      result.pairs.map((pair) => pair.analysisRecord.analysisId),
    );
    expect(analysisIds.size).toBe(500);

    // The corpus manifest input was not modified by the run.
    expect(
      readFileSync(resolve(process.cwd(), 'corpus/manifest.json'), 'utf8'),
    ).toBe(manifestText);
  }, 120_000);
});
