import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CorpusCollectionSchema,
  NOT_MEASURED,
  PHASE1_EXPECTED_GOLDEN_CASE_COUNT,
  PHASE1_EXPECTED_PAIR_COUNT,
  PHASE1_REQUIRED_HIGH_IMPACT_FALSE_NEGATIVES,
  PHASE1_REQUIRED_INSUFFICIENT_CONTEXT_ACCURACY,
  PHASE1_REQUIRED_RECALL,
  buildBlockers,
  buildDecision,
  buildMeasuredGateConditions,
  runPhase1ExitGateReportCommand,
  type CorpusCollection,
  type GoldenImpactStateEvaluationResult,
  type MeasuredGateConditions,
  type Phase1ExitGateBlocker,
  type Phase1ExitGateReport,
  type Phase1UnmeasuredMetrics,
} from '../src/index.js';
// Child-process integration coverage for the `phase1:report` command. Three
// real process boundaries are exercised: the injected-io command module, the
// direct runner spawned exactly as package.json wires it, and the real pnpm
// executable running `pnpm --silent phase1:report` through the actual pnpm
// lifecycle. Exit codes, stream contents, byte-stability, the fixed key
// order, the exact measured metric values, the measured gate conditions, and
// the exact blocker order are verified against the tracked corpus instead of
// mocked. The pure decision seam (buildMeasuredGateConditions /
// buildBlockers / buildDecision) is additionally exercised with tampered
// metrics to prove that a measured mandatory-condition failure blocks
// `PROCEED` even when nothing is unmeasured.

const projectRoot = resolve(process.cwd());
const runnerPath = join(
  projectRoot,
  'scripts',
  'run-phase1-exit-gate-report.mjs',
);

const EXPECTED_TOP_LEVEL_KEYS = [
  'corpus',
  'goldenCaseCount',
  'analyzeSummary',
  'measuredMetrics',
  'measuredGateConditions',
  'unmeasuredMetrics',
  'decision',
  'blockers',
] as const;

const EXPECTED_CORPUS_KEYS = ['corpusId', 'corpusVersion'] as const;

const EXPECTED_SUMMARY_KEYS = [
  'corpusId',
  'corpusVersion',
  'processedCount',
  'stateCounts',
  'actionCount',
] as const;

const EXPECTED_UNMEASURED_KEYS = [
  'modelCost',
  'providerLatency',
  'unsupportedClaimRate',
] as const;

const EXPECTED_MEASURED_GATE_CONDITION_KEYS = [
  'highImpactFalseNegatives',
  'recall',
  'insufficientContextAccuracy',
] as const;

/** Fixed lossless reasons behind every unmeasured blocker (same as source). */
const UNMEASURED_REASONS = {
  modelCost:
    'no provider cost instrumentation exists in the provider-free Phase 1 path',
  providerLatency:
    'no provider latency instrumentation exists in the provider-free Phase 1 path',
  unsupportedClaimRate:
    'no provider output exists in the provider-free Phase 1 path to audit for unsupported claims',
} as const;

/** The fixed unmeasured metrics block the provider-free path always emits. */
function trackedUnmeasuredMetrics(): Phase1UnmeasuredMetrics {
  return {
    modelCost: {
      status: NOT_MEASURED,
      reason: UNMEASURED_REASONS.modelCost,
    },
    providerLatency: {
      status: NOT_MEASURED,
      reason: UNMEASURED_REASONS.providerLatency,
    },
    unsupportedClaimRate: {
      status: NOT_MEASURED,
      reason: UNMEASURED_REASONS.unsupportedClaimRate,
    },
  };
}

/** Exact measured gate conditions the tracked corpus must produce. */
function expectTrackedMeasuredGateConditions(
  conditions: MeasuredGateConditions,
): void {
  expect(Object.keys(conditions)).toEqual([
    ...EXPECTED_MEASURED_GATE_CONDITION_KEYS,
  ]);
  expect(conditions.highImpactFalseNegatives).toEqual({
    status: 'PASS',
    reason: `observed highImpactFalseNegatives=0, required exactly ${PHASE1_REQUIRED_HIGH_IMPACT_FALSE_NEGATIVES}`,
  });
  expect(conditions.recall).toEqual({
    status: 'PASS',
    reason: `observed recall=1, required exactly ${PHASE1_REQUIRED_RECALL}`,
  });
  expect(conditions.insufficientContextAccuracy).toEqual({
    status: 'PASS',
    reason: `observed insufficientContextAccuracy=1, required exactly ${PHASE1_REQUIRED_INSUFFICIENT_CONTEXT_ACCURACY}`,
  });
}

/** Exact blocker array the tracked corpus must produce, order included. */
function expectTrackedBlockers(
  blockers: readonly Phase1ExitGateBlocker[],
): void {
  const expected: Phase1ExitGateBlocker[] = [
    {
      metric: 'modelCost',
      status: NOT_MEASURED,
      reason: UNMEASURED_REASONS.modelCost,
    },
    {
      metric: 'providerLatency',
      status: NOT_MEASURED,
      reason: UNMEASURED_REASONS.providerLatency,
    },
    {
      metric: 'unsupportedClaimRate',
      status: NOT_MEASURED,
      reason: UNMEASURED_REASONS.unsupportedClaimRate,
    },
  ];
  expect(blockers).toEqual(expected);
}

/** Legacy/every scratch names the runner must never place inside the repo. */
function listRepositoryScratch(): string[] {
  return readdirSync(projectRoot)
    .filter(
      (name) =>
        name.startsWith('.phase1-exit-gate-report-dist') ||
        name.includes('-dist-'),
    )
    .sort();
}

/**
 * Spawns the actual pnpm executable with `pnpm --silent phase1:report` —
 * the documented byte-stable form — through the genuine pnpm lifecycle, and
 * returns its raw streams. The suite itself always runs under `pnpm test`,
 * so the `pnpm` entry on the inherited PATH is the very executable driving
 * the repository; no synthetic re-execution of the runner is involved.
 */
function runPnpmSilentPhase1Report(): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync('pnpm', ['--silent', 'phase1:report'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Collects what a live CLI run writes into the project root between launch
 * and exit. With a scratch-leaking runner this catches the transient
 * compile directory inside the repository; with the tmpdir runner the list
 * stays empty for the whole process lifetime.
 */
async function watchRepositoryDuringRun(): Promise<{
  status: number;
  observedScratch: string[];
}> {
  const child = spawn(process.execPath, [runnerPath], {
    cwd: projectRoot,
    stdio: 'ignore',
  });
  const observedScratch = new Set<string>();
  const sampler = setInterval(() => {
    try {
      for (const name of listRepositoryScratch()) {
        observedScratch.add(name);
      }
    } catch {
      // Snapshot races with the OS listing are irrelevant: any sighting
      // counts, missing a sample does not hide a persistent leak.
    }
  }, 20);
  const status = await new Promise<number>((resolveStatus) => {
    child.on('exit', (code, signal) =>
      resolveStatus(code ?? (signal ? -1 : -1)),
    );
    child.on('error', () => resolveStatus(-1));
  });
  clearInterval(sampler);
  return { status, observedScratch: [...observedScratch].sort() };
}

function loadTrackedCorpus(): CorpusCollection {
  const corpusRoot = join(projectRoot, 'corpus');
  const manifest = JSON.parse(
    readFileSync(join(corpusRoot, 'manifest.json'), 'utf8'),
  ) as Record<string, unknown>;
  const entries = (
    key: 'changeFixtures' | 'tenantProfileFixtures' | 'goldenCases',
  ): Array<{ path: string }> =>
    (manifest[key] as Array<{ path: string }>) ?? [];
  return CorpusCollectionSchema.parse({
    manifest,
    changeFixtures: entries('changeFixtures').map((entry) =>
      JSON.parse(readFileSync(join(corpusRoot, entry.path), 'utf8')),
    ),
    tenantProfileFixtures: entries('tenantProfileFixtures').map((entry) =>
      JSON.parse(readFileSync(join(corpusRoot, entry.path), 'utf8')),
    ),
    goldenCases: entries('goldenCases').map((entry) =>
      JSON.parse(readFileSync(join(corpusRoot, entry.path), 'utf8')),
    ),
  });
}

/** Structural checks on the existing golden evaluation metrics shape. */
function expectValidMeasuredMetrics(
  metrics: GoldenImpactStateEvaluationResult,
): void {
  expect(metrics.totalCases).toBe(PHASE1_EXPECTED_GOLDEN_CASE_COUNT);
  const counts = [
    'exactMatchCount',
    'highImpactCases',
    'highImpactFalseNegatives',
    'expectedPositiveCases',
    'truePositives',
    'falseNegatives',
    'observedPositives',
    'falsePositives',
    'expectedInsufficientContextCases',
    'correctInsufficientContextCount',
  ] as const;
  for (const key of counts) {
    const value = metrics[key];
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
  }
  const rates = [
    'exactMatchAccuracy',
    'highImpactFalseNegativeRate',
    'recall',
    'precision',
    'noiseRate',
    'insufficientContextAccuracy',
  ] as const;
  for (const key of rates) {
    const value = metrics[key];
    if (value !== null) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  }
  expect(metrics.falseNegatives).toBe(
    metrics.expectedPositiveCases - metrics.truePositives,
  );
  expect(metrics.falsePositives).toBe(
    metrics.observedPositives - metrics.truePositives,
  );
}

/**
 * Copy the tracked corpus plus the two evaluation policy fixtures into a
 * fresh temp project root, then hand the caller the copied golden-case file
 * paths so a test can corrupt exactly one of them.
 */
function makeTempProjectRoot(): {
  root: string;
  goldenCasePaths: string[];
} {
  const root = mkdtempSync(join(tmpdir(), 'phase1-exit-gate-report-root-'));
  cpSync(join(projectRoot, 'corpus'), join(root, 'corpus'), {
    recursive: true,
  });
  mkdirSync(join(root, 'test'), { recursive: true });
  cpSync(
    join(projectRoot, 'test', 'fixtures'),
    join(root, 'test', 'fixtures'),
    {
      recursive: true,
    },
  );
  const manifest = JSON.parse(
    readFileSync(join(root, 'corpus', 'manifest.json'), 'utf8'),
  ) as { goldenCases: Array<{ path: string }> };
  return {
    root,
    goldenCasePaths: manifest.goldenCases.map((entry) => entry.path),
  };
}

describe('phase1:report command (injected io, command module)', () => {
  it('joins 500 same-run pairs onto 65 golden cases and emits the fixed report shape', async () => {
    const result = await runPhase1ExitGateReportCommand({
      resolveProjectRoot: () => projectRoot,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');

    const lines = result.stdout.split('\n');
    expect(lines).toHaveLength(2);
    const summaryLine = lines[0];
    if (summaryLine === undefined) {
      throw new Error('report line missing');
    }
    const report = JSON.parse(summaryLine) as Phase1ExitGateReport;

    expect(Object.keys(report)).toEqual([...EXPECTED_TOP_LEVEL_KEYS]);
    expect(Object.keys(report.corpus)).toEqual([...EXPECTED_CORPUS_KEYS]);
    expect(report.corpus.corpusId).toBe('m365-change-radar-phase-1b-dataset');
    expect(report.corpus.corpusVersion).toBe('1.1.0');
    expect(report.goldenCaseCount).toBe(PHASE1_EXPECTED_GOLDEN_CASE_COUNT);

    expect(Object.keys(report.analyzeSummary)).toEqual([
      ...EXPECTED_SUMMARY_KEYS,
    ]);
    expect(report.analyzeSummary.corpusId).toBe(report.corpus.corpusId);
    expect(report.analyzeSummary.corpusVersion).toBe(
      report.corpus.corpusVersion,
    );
    expect(report.analyzeSummary.processedCount).toBe(
      PHASE1_EXPECTED_PAIR_COUNT,
    );
    expect(Object.keys(report.analyzeSummary.stateCounts).sort()).toEqual([
      'ACTION_REQUIRED',
      'INFORMATIONAL',
      'INSUFFICIENT_CONTEXT',
      'NOT_APPLICABLE',
      'REVIEW_REQUIRED',
    ]);
    expect(
      Object.values(report.analyzeSummary.stateCounts).reduce(
        (a, b) => a + b,
        0,
      ),
    ).toBe(PHASE1_EXPECTED_PAIR_COUNT);
    expect(report.analyzeSummary.actionCount).toBeGreaterThan(0);

    expectValidMeasuredMetrics(report.measuredMetrics);

    expect(Object.keys(report.unmeasuredMetrics)).toEqual([
      ...EXPECTED_UNMEASURED_KEYS,
    ]);
    expect(report.unmeasuredMetrics).toEqual(trackedUnmeasuredMetrics());

    expectTrackedMeasuredGateConditions(report.measuredGateConditions);
    expectTrackedBlockers(report.blockers);
    expect(report.decision).toBe('HOLD');
  });

  it('emits the exact tracked measured metric values over the 500-pair / 65-golden-case join', async () => {
    const result = await runPhase1ExitGateReportCommand({
      resolveProjectRoot: () => projectRoot,
    });
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split('\n');
    const summaryLine = lines[0];
    if (summaryLine === undefined) {
      throw new Error('report line missing');
    }
    const report = JSON.parse(summaryLine) as Phase1ExitGateReport;
    const metrics = report.measuredMetrics;
    expect(metrics.totalCases).toBe(65);
    expect(metrics.exactMatchCount).toBe(57);
    expect(metrics.exactMatchAccuracy).toBe(57 / 65);
    expect(metrics.highImpactCases).toBe(28);
    expect(metrics.highImpactFalseNegatives).toBe(0);
    expect(metrics.highImpactFalseNegativeRate).toBe(0);
    expect(metrics.expectedPositiveCases).toBe(39);
    expect(metrics.truePositives).toBe(39);
    expect(metrics.falseNegatives).toBe(0);
    expect(metrics.observedPositives).toBe(39);
    expect(metrics.falsePositives).toBe(0);
    expect(metrics.recall).toBe(1);
    expect(metrics.precision).toBe(1);
    expect(metrics.noiseRate).toBe(0);
    expect(metrics.expectedInsufficientContextCases).toBe(5);
    expect(metrics.correctInsufficientContextCount).toBe(5);
    expect(metrics.insufficientContextAccuracy).toBe(1);
  });

  it('is byte-deterministic: fixed key order, single trailing newline, no intermediate output', async () => {
    const first = await runPhase1ExitGateReportCommand({
      resolveProjectRoot: () => projectRoot,
    });
    const second = await runPhase1ExitGateReportCommand({
      resolveProjectRoot: () => projectRoot,
    });
    expect(first).toEqual(second);
    expect(first.stdout.endsWith('\n')).toBe(true);
    expect(first.stdout.endsWith('\n\n')).toBe(false);
    const lines = first.stdout.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.at(-1)).toBe('');
    expect(JSON.parse(first.stdout)).toBeDefined();
  });

  it('fails closed on an invalid corpus with empty stdout and non-empty stderr', async () => {
    const { root } = makeTempProjectRoot();
    try {
      const corpus = loadTrackedCorpus();
      const first = corpus.changeFixtures[0];
      if (first === undefined) {
        throw new Error('tracked corpus has no change fixtures');
      }
      const brokenFirst = {
        ...first,
        fixtureId: `${first.fixtureId}-BROKEN`,
        event: { ...first.event, title: 42 },
      };
      const manifest = JSON.parse(
        readFileSync(join(root, 'corpus', 'manifest.json'), 'utf8'),
      ) as Record<string, unknown>;
      const changeRefs = manifest['changeFixtures'] as Array<{
        fixtureId: string;
        path: string;
      }>;
      writeFileSync(
        join(root, 'corpus', changeRefs[0]?.path ?? 'changes/none.json'),
        JSON.stringify(brokenFirst),
      );
      const result = await runPhase1ExitGateReportCommand({
        resolveProjectRoot: () => root,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed on a missing corpus with empty stdout and non-empty stderr', async () => {
    const result = await runPhase1ExitGateReportCommand({
      resolveProjectRoot: () =>
        join(tmpdir(), 'phase1-exit-gate-report-missing'),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it('fails closed when a golden case has no matching same-run pair result', async () => {
    const { root, goldenCasePaths } = makeTempProjectRoot();
    try {
      const firstGoldenPath = goldenCasePaths[0];
      if (firstGoldenPath === undefined) {
        throw new Error('tracked corpus has no golden cases');
      }
      const goldenCase = JSON.parse(
        readFileSync(join(root, 'corpus', firstGoldenPath), 'utf8'),
      ) as Record<string, unknown>;
      const orphan = {
        ...goldenCase,
        caseId: 'synth-gc-orphan-join-probe',
        changeFixtureId: 'synth-mc-does-not-exist',
      };
      writeFileSync(
        join(root, 'corpus', firstGoldenPath),
        JSON.stringify(orphan),
      );
      const result = await runPhase1ExitGateReportCommand({
        resolveProjectRoot: () => root,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr.includes('join failed')).toBe(true);
      expect(result.stderr.includes('synth-mc-does-not-exist')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('phase1:report measured gate decision seam (pure functions)', () => {
  it('marks all three tracked conditions PASS when every required value holds', () => {
    const metrics: GoldenImpactStateEvaluationResult = {
      totalCases: 65,
      exactMatchCount: 65,
      exactMatchAccuracy: 1,
      highImpactCases: 28,
      highImpactFalseNegatives: 0,
      highImpactFalseNegativeRate: 0,
      expectedPositiveCases: 39,
      truePositives: 39,
      falseNegatives: 0,
      observedPositives: 39,
      falsePositives: 0,
      recall: 1,
      precision: 1,
      noiseRate: 0,
      expectedInsufficientContextCases: 6,
      correctInsufficientContextCount: 6,
      insufficientContextAccuracy: 1,
    };
    const conditions = buildMeasuredGateConditions(metrics);
    expect(Object.keys(conditions)).toEqual([
      ...EXPECTED_MEASURED_GATE_CONDITION_KEYS,
    ]);
    for (const key of EXPECTED_MEASURED_GATE_CONDITION_KEYS) {
      expect(conditions[key]?.status).toBe('PASS');
      expect(conditions[key]?.reason.length).toBeGreaterThan(0);
    }
  });

  it('fails only the tampered measured condition and keeps the reasons lossless', () => {
    const metrics: GoldenImpactStateEvaluationResult = {
      totalCases: 65,
      exactMatchCount: 56,
      exactMatchAccuracy: 56 / 65,
      highImpactCases: 28,
      highImpactFalseNegatives: 1,
      highImpactFalseNegativeRate: 1 / 28,
      expectedPositiveCases: 39,
      truePositives: 38,
      falseNegatives: 1,
      observedPositives: 39,
      falsePositives: 1,
      recall: 38 / 39,
      precision: 38 / 39,
      noiseRate: 1 / 39,
      expectedInsufficientContextCases: 6,
      correctInsufficientContextCount: 5,
      insufficientContextAccuracy: 5 / 6,
    };
    const conditions = buildMeasuredGateConditions(metrics);
    expect(conditions.highImpactFalseNegatives?.status).toBe('FAIL');
    expect(conditions.recall?.status).toBe('FAIL');
    expect(conditions.insufficientContextAccuracy?.status).toBe('FAIL');
    expect(conditions.highImpactFalseNegatives?.reason).toBe(
      `observed highImpactFalseNegatives=1, required exactly ${PHASE1_REQUIRED_HIGH_IMPACT_FALSE_NEGATIVES}`,
    );
    expect(conditions.recall?.reason).toBe(
      `observed recall=${38 / 39}, required exactly ${PHASE1_REQUIRED_RECALL}`,
    );
    expect(conditions.insufficientContextAccuracy?.reason).toBe(
      `observed insufficientContextAccuracy=${5 / 6}, required exactly ${PHASE1_REQUIRED_INSUFFICIENT_CONTEXT_ACCURACY}`,
    );
  });

  it('orders measured FAIL blockers before unmeasured ones, carrying statuses and reasons', () => {
    const measured: MeasuredGateConditions = {
      highImpactFalseNegatives: {
        status: 'FAIL',
        reason: 'observed highImpactFalseNegatives=2, required exactly 0',
      },
      recall: {
        status: 'PASS',
        reason: 'observed recall=1, required exactly 1',
      },
      insufficientContextAccuracy: {
        status: 'PASS',
        reason: 'observed insufficientContextAccuracy=1, required exactly 1',
      },
    };
    const blockers = buildBlockers(measured, trackedUnmeasuredMetrics());
    expect(blockers).toHaveLength(4);
    expect(blockers.map((blocker) => blocker.metric)).toEqual([
      'highImpactFalseNegatives',
      'modelCost',
      'providerLatency',
      'unsupportedClaimRate',
    ]);
    expect(blockers[0]).toEqual({
      metric: 'highImpactFalseNegatives',
      status: 'FAIL',
      reason: 'observed highImpactFalseNegatives=2, required exactly 0',
    });
    expect(blockers.slice(1)).toEqual([
      {
        metric: 'modelCost',
        status: NOT_MEASURED,
        reason: UNMEASURED_REASONS.modelCost,
      },
      {
        metric: 'providerLatency',
        status: NOT_MEASURED,
        reason: UNMEASURED_REASONS.providerLatency,
      },
      {
        metric: 'unsupportedClaimRate',
        status: NOT_MEASURED,
        reason: UNMEASURED_REASONS.unsupportedClaimRate,
      },
    ]);
  });

  it('never allows PROCEED while a measured mandatory condition fails, even with nothing unmeasured', () => {
    // All conditions PASS, zero unmeasured, zero blockers ⇒ PROCEED.
    const allPass: MeasuredGateConditions = {
      highImpactFalseNegatives: {
        status: 'PASS',
        reason: 'observed highImpactFalseNegatives=0, required exactly 0',
      },
      recall: {
        status: 'PASS',
        reason: 'observed recall=1, required exactly 1',
      },
      insufficientContextAccuracy: {
        status: 'PASS',
        reason: 'observed insufficientContextAccuracy=1, required exactly 1',
      },
    };
    expect(buildDecision(buildBlockers(allPass, {}))).toBe('PROCEED');

    // The tracked reality: all three measured conditions PASS, three
    // unmeasured metrics ⇒ 3 blockers and HOLD (Phase 1L-3 golden
    // alignment resolved the previously failing insufficient-context
    // condition; unmeasured provider metrics still force HOLD).
    const trackedConditions = buildMeasuredGateConditions({
      totalCases: 65,
      exactMatchCount: 57,
      exactMatchAccuracy: 57 / 65,
      highImpactCases: 28,
      highImpactFalseNegatives: 0,
      highImpactFalseNegativeRate: 0,
      expectedPositiveCases: 39,
      truePositives: 39,
      falseNegatives: 0,
      observedPositives: 39,
      falsePositives: 0,
      recall: 1,
      precision: 1,
      noiseRate: 0,
      expectedInsufficientContextCases: 5,
      correctInsufficientContextCount: 5,
      insufficientContextAccuracy: 1,
    });
    const trackedBlockers = buildBlockers(
      trackedConditions,
      trackedUnmeasuredMetrics(),
    );
    expect(trackedBlockers).toHaveLength(3);
    expect(trackedBlockers.map((blocker) => blocker.status)).toEqual([
      NOT_MEASURED,
      NOT_MEASURED,
      NOT_MEASURED,
    ]);
    expect(buildDecision(trackedBlockers)).toBe('HOLD');

    // A measured FAIL with nothing unmeasured still ⇒ HOLD: measured failures
    // can never be waved through just because unmeasured metrics are gone.
    const onlyMeasuredFails: MeasuredGateConditions = {
      highImpactFalseNegatives: allPass.highImpactFalseNegatives,
      recall: allPass.recall,
      insufficientContextAccuracy: {
        status: 'FAIL',
        reason: `observed insufficientContextAccuracy=${5 / 6}, required exactly ${PHASE1_REQUIRED_INSUFFICIENT_CONTEXT_ACCURACY}`,
      },
    };
    const onlyMeasuredBlockers = buildBlockers(onlyMeasuredFails, {});
    expect(onlyMeasuredBlockers).toEqual([
      {
        metric: 'insufficientContextAccuracy',
        status: 'FAIL',
        reason: `observed insufficientContextAccuracy=${5 / 6}, required exactly ${PHASE1_REQUIRED_INSUFFICIENT_CONTEXT_ACCURACY}`,
      },
    ]);
    expect(buildDecision(onlyMeasuredBlockers)).toBe('HOLD');
  });

  it('is deterministic across repeated invocations', () => {
    const metrics: GoldenImpactStateEvaluationResult = {
      totalCases: 65,
      exactMatchCount: 56,
      exactMatchAccuracy: 56 / 65,
      highImpactCases: 28,
      highImpactFalseNegatives: 0,
      highImpactFalseNegativeRate: 0,
      expectedPositiveCases: 39,
      truePositives: 39,
      falseNegatives: 0,
      observedPositives: 0,
      falsePositives: 0,
      recall: 1,
      precision: 1,
      noiseRate: 0,
      expectedInsufficientContextCases: 6,
      correctInsufficientContextCount: 5,
      insufficientContextAccuracy: 5 / 6,
    };
    expect(buildMeasuredGateConditions(metrics)).toEqual(
      buildMeasuredGateConditions(metrics),
    );
  });
});

describe('phase1:report CLI (child process integration)', () => {
  it('matches the injected-io command bytes through the real pnpm --silent phase1:report lifecycle', async () => {
    const commandResult = await runPhase1ExitGateReportCommand({
      resolveProjectRoot: () => projectRoot,
    });
    const child = runPnpmSilentPhase1Report();
    expect(child.status).toBe(0);
    expect(child.stderr).toBe('');
    expect(child.stdout).toBe(commandResult.stdout);
    expect(child.stdout.endsWith('\n')).toBe(true);
    const report = JSON.parse(child.stdout) as Phase1ExitGateReport;
    expect(report.analyzeSummary.processedCount).toBe(
      PHASE1_EXPECTED_PAIR_COUNT,
    );
    expect(report.decision).toBe('HOLD');
  }, 60_000);

  it('leaves no scratch directory inside the repository during a full run', async () => {
    const { status, observedScratch } = await watchRepositoryDuringRun();
    expect(status).toBe(0);
    expect(observedScratch).toEqual([]);
    expect(listRepositoryScratch()).toEqual([]);
  }, 60_000);
});
