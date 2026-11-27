import { spawn, spawnSync } from 'node:child_process';
import {
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
  RiskPolicySchema,
  TenantApplicabilityPolicySchema,
  createFixedInformationalClassifier,
  createDeterministicSuggestedActionOutput,
  runAnalyzeCommand,
  runImpactAnalysisMatrix,
  type AnalyzeCommandSummary,
  type CorpusCollection,
} from '../src/index.js';
// Child-process integration coverage for the `analyze` command. Three real
// process boundaries are exercised: the direct runner spawned exactly as
// package.json wires it, the real pnpm executable running `--silent analyze`
// through the actual pnpm lifecycle, and the injected-io command against
// fixture corpora. Exit codes, stream contents, byte-stability, and the
// scratch-free compile boundary are verified end to end instead of mocked.

const projectRoot = resolve(process.cwd());
const runnerPath = join(projectRoot, 'scripts', 'run-analyze.mjs');

/** Legacy/every scratch names the runner must never place inside the repo. */
function listRepositoryScratch(): string[] {
  return readdirSync(projectRoot)
    .filter(
      (name) => name.startsWith('.analyze-dist') || name.includes('-dist-'),
    )
    .sort();
}

/**
 * Spawns the actual pnpm executable with `--silent analyze` — the
 * documented byte-stable form — through the genuine pnpm lifecycle, and
 * returns its raw streams. The suite itself always runs under
 * `pnpm test`, so the `pnpm` entry on the inherited PATH is the very
 * executable driving the repository; no synthetic re-execution of the
 * runner is involved.
 */
function runPnpmSilentAnalyze(): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync('pnpm', ['--silent', 'analyze'], {
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

/**
 * Build a command-level failure corpus: one change fixture fails the
 * existing `ChangeEventSchema`, so the analyze command's corpus parse
 * rejects the whole collection before any matrix work runs.
 */
function corpusWithInvalidChange(corpus: CorpusCollection): {
  manifest: unknown;
  changeFixtures: unknown[];
  tenantProfileFixtures: unknown[];
  goldenCases: unknown[];
} {
  const first = corpus.changeFixtures[0];
  if (first === undefined) {
    throw new Error('tracked corpus has no change fixtures');
  }
  const rest = corpus.changeFixtures.slice(1);
  const brokenFirst = {
    ...first,
    fixtureId: `${first.fixtureId}-BROKEN`,
    event: { ...first.event, title: 42 },
  };
  return {
    manifest: {
      ...corpus.manifest,
      changeFixtures: [
        {
          fixtureId: `${first.fixtureId}-BROKEN`,
          path: 'changes/synth-mc-001.json',
        },
        ...corpus.manifest.changeFixtures.slice(1),
      ],
    },
    changeFixtures: [brokenFirst, ...rest],
    tenantProfileFixtures: corpus.tenantProfileFixtures,
    goldenCases: corpus.goldenCases,
  };
}

describe('analyze command (injected io, command module)', () => {
  it('processes all 500 tracked pairs, reports every state key, and counts actions', async () => {
    const result = await runAnalyzeCommand({
      resolveProjectRoot: () => projectRoot,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const summary = JSON.parse(result.stdout) as AnalyzeCommandSummary;
    expect(summary.corpusId).toBe('m365-change-radar-phase-1b-dataset');
    expect(summary.corpusVersion).toBe('1.1.0');
    expect(summary.processedCount).toBe(500);
    expect(Object.keys(summary.stateCounts).sort()).toEqual([
      'ACTION_REQUIRED',
      'INFORMATIONAL',
      'INSUFFICIENT_CONTEXT',
      'NOT_APPLICABLE',
      'REVIEW_REQUIRED',
    ]);
    expect(Object.values(summary.stateCounts).reduce((a, b) => a + b, 0)).toBe(
      500,
    );
    expect(summary.actionCount).toBeGreaterThan(0);
  });

  it('is byte-deterministic: fixed key order, single trailing newline, no intermediate output', async () => {
    const first = await runAnalyzeCommand({
      resolveProjectRoot: () => projectRoot,
    });
    const second = await runAnalyzeCommand({
      resolveProjectRoot: () => projectRoot,
    });
    expect(first).toEqual(second);
    expect(first.stdout.endsWith('\n')).toBe(true);
    expect(first.stdout.endsWith('\n\n')).toBe(false);
    const lines = first.stdout.split('\n');
    expect(lines).toHaveLength(2);
    const summaryLine = lines[0];
    if (summaryLine === undefined) {
      throw new Error('summary line missing');
    }
    expect(lines.at(-1)).toBe('');
    expect(JSON.parse(summaryLine)).toBeDefined();
  }, 20_000);

  it('never invokes the golden corpus oracle and only uses the fixed classifier identity', async () => {
    const result = await runAnalyzeCommand({
      resolveProjectRoot: () => projectRoot,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.includes('golden-label-oracle')).toBe(false);
  });

  it('fails closed on an invalid corpus with empty stdout and non-empty stderr', async () => {
    const corpus = loadTrackedCorpus();
    const invalidInput = corpusWithInvalidChange(corpus);
    const invalidFirstChange = invalidInput['changeFixtures'][0];
    if (!(
      typeof invalidFirstChange === 'object' && invalidFirstChange !== null
    )) {
      throw new Error('invalid corpus lost its first change fixture');
    }
    const tempRoot = mkdtempSync(join(tmpdir(), 'analyze-cli-invalid-'));
    try {
      const corpusRoot = join(tempRoot, 'corpus');
      mkdirSync(join(corpusRoot, 'changes'), { recursive: true });
      writeFileSync(
        join(corpusRoot, 'manifest.json'),
        JSON.stringify(invalidInput['manifest']),
      );
      writeFileSync(
        join(corpusRoot, 'changes', 'synth-mc-001.json'),
        JSON.stringify(invalidFirstChange),
      );
      const result = await runAnalyzeCommand({
        resolveProjectRoot: () => tempRoot,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr.length).toBeGreaterThan(0);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('fails closed on a missing corpus with empty stdout and non-empty stderr', async () => {
    const result = await runAnalyzeCommand({
      resolveProjectRoot: () => join(tmpdir(), 'analyze-cli-missing-root'),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});

describe('analyze CLI (child process integration)', () => {
  it('matches the injected-io command bytes through the real pnpm --silent analyze lifecycle', async () => {
    const commandResult = await runAnalyzeCommand({
      resolveProjectRoot: () => projectRoot,
    });
    const child = runPnpmSilentAnalyze();
    expect(child.status).toBe(0);
    expect(child.stderr).toBe('');
    expect(child.stdout).toBe(commandResult.stdout);
    expect(child.stdout.endsWith('\n')).toBe(true);
    const summary = JSON.parse(child.stdout) as AnalyzeCommandSummary;
    expect(summary.processedCount).toBe(500);
    expect(summary.actionCount).toBeGreaterThan(0);
  }, 20_000);

  it('leaves no scratch directory inside the repository during a full run', async () => {
    const { status, observedScratch } = await watchRepositoryDuringRun();
    expect(status).toBe(0);
    expect(observedScratch).toEqual([]);
    expect(listRepositoryScratch()).toEqual([]);
  }, 20_000);
});

/** Existing evaluation policy fixtures, parsed only as untrusted JSON here. */
const riskPolicyFixture: unknown = JSON.parse(
  readFileSync(
    join(projectRoot, 'test', 'fixtures', 'risk-policy.json'),
    'utf8',
  ),
);
const tenantPolicyFixture: unknown = JSON.parse(
  readFileSync(
    join(projectRoot, 'test', 'fixtures', 'tenant-applicability-policy.json'),
    'utf8',
  ),
);

describe('analyze matrix (golden-oracle isolation)', () => {
  it('produces the same summary without golden cases loaded through the pure matrix core', async () => {
    const corpus = loadTrackedCorpus();
    // The pure matrix core consumes the collection as-is; golden cases are
    // not part of its input. Loading them (as the command does) and then
    // verifying the oracle's synthetic identity never appears anywhere in
    // the matrix results pins the oracle isolation: the command's
    // classifier is the fixed INFORMATIONAL one, never the oracle.
    const result = await runImpactAnalysisMatrix({
      collection: corpus,
      sourceMessageVersion: 'analyze-cli-1',
      riskPolicy: RiskPolicySchema.parse(riskPolicyFixture),
      tenantApplicabilityPolicy:
        TenantApplicabilityPolicySchema.parse(tenantPolicyFixture),
      metadataFactory: (pair) => ({
        analysisId: `analysis.${pair.changeFixtureId}.${pair.tenantProfileFixtureId}`,
        tenantId: pair.tenantProfileFixtureId,
        createdAt: '1970-01-01T00:00:00.000Z',
      }),
      classifier: createFixedInformationalClassifier(),
      actionGenerator: async (request) =>
        createDeterministicSuggestedActionOutput(request),
    });
    expect(result.processedCount).toBe(500);
    expect(Object.keys(result.stateCounts).sort()).toEqual([
      'ACTION_REQUIRED',
      'INFORMATIONAL',
      'INSUFFICIENT_CONTEXT',
      'NOT_APPLICABLE',
      'REVIEW_REQUIRED',
    ]);
    expect(result.actionCount).toBeGreaterThan(0);
  });
});
