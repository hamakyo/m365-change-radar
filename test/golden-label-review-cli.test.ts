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

import { Writable } from 'node:stream';

import { afterAll, describe, expect, it } from 'vitest';

import {
  renderGoldenLabelReviewMarkdown,
  type CorpusCollection,
} from '../src/index.js';
import { CorpusCollectionSchema } from '../src/corpus/golden-corpus.js';
import { runGoldenLabelReviewProcess } from '../scripts/run-golden-label-review.mjs';

// Child-process integration coverage for the `corpus:review` command. Two
// real process boundaries are exercised: the direct runner spawned exactly
// as package.json wires it, and the real pnpm executable running
// `--silent corpus:review` through the actual pnpm lifecycle, so exit
// codes, stream contents, and byte-stability are verified end to end
// instead of mocked. Compile-failure paths are exercised through the small
// injected seam exported by the wrapper (an injectable compiler
// entrypoint whose production default is the repository-local tsc); no CLI
// option, flag, or environment variable is involved.

const projectRoot = resolve(process.cwd());
const runnerPath = join(projectRoot, 'scripts', 'run-golden-label-review.mjs');
const HEADER_LINE =
  '| caseId | changeFixtureId | change title | tenantProfileFixtureId | tenant profileVersion | expected state | expected reason | minimumRiskFloor | highImpact | importance | missingContext | coverageTags | evaluationTags |';

/** Legacy/every scratch names the runner must never place inside the repo. */
function listRepositoryScratch(): string[] {
  return readdirSync(projectRoot)
    .filter(
      (name) => name.startsWith('.corpus-dist') || name.includes('-dist-'),
    )
    .sort();
}

function runReviewCli(cwd: string = projectRoot): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd,
    encoding: 'utf8',
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Spawns the actual pnpm executable with `--silent corpus:review` — the
 * documented byte-stable form — through the genuine pnpm lifecycle, and
 * returns its raw streams. The suite itself always runs under
 * `pnpm test`, so the `pnpm` entry on the inherited PATH is the very
 * executable driving the repository; no synthetic re-execution of the
 * runner is involved.
 */
function runPnpmSilentReview(): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync('pnpm', ['--silent', 'corpus:review'], {
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
 * and exit. With the pre-fix runner this catches the transient
 * `.corpus-dist-*` compile directory inside the repository; with the fixed
 * runner the list stays empty for the whole process lifetime.
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

function loadSeedCorpus(): CorpusCollection {
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

describe('golden label review CLI (child process integration)', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'golden-label-review-cli-test-'));

  afterAll(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  /** Mirrors the repository default corpus under a temporary project root. */
  function stageCorpusCopy(): void {
    mkdirSync(join(tempRoot, 'corpus'), { recursive: true });
    cpSync(join(projectRoot, 'corpus'), join(tempRoot, 'corpus'), {
      recursive: true,
    });
  }

  /** Stream collectors standing in for the real stdout/stderr. */
  function collectStreams(): {
    chunks: { stdout: string[]; stderr: string[] };
    streams: { stdout: Writable; stderr: Writable };
    text: () => { stdout: string; stderr: string };
  } {
    const chunks = { stdout: [''] as string[], stderr: [''] as string[] };
    const makeCollector = (slot: string[]): Writable =>
      new Writable({
        write(chunk, _encoding, callback) {
          slot.push(String(chunk));
          callback();
        },
      });
    return {
      chunks,
      streams: {
        stdout: makeCollector(chunks.stdout),
        stderr: makeCollector(chunks.stderr),
      },
      text: () => ({
        stdout: chunks.stdout.join(''),
        stderr: chunks.stderr.join(''),
      }),
    };
  }

  it('keeps the corpus:review script name and wiring from package.json', () => {
    const pkg = JSON.parse(
      readFileSync(join(projectRoot, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.['corpus:review']).toBe(
      'node scripts/run-golden-label-review.mjs',
    );
  });

  it('spawns the actual pnpm executable with --silent corpus:review: exit 0, empty stderr, byte-identical stdout, single trailing newline, 65 rows', () => {
    const pnpm = runPnpmSilentReview();
    const expected = renderGoldenLabelReviewMarkdown(loadSeedCorpus());

    // The real pnpm lifecycle completed without reporting anything.
    expect(pnpm.status).toBe(0);
    expect(pnpm.stderr).toBe('');

    // Byte-exact renderer parity through the real pnpm --silent path.
    expect(pnpm.stdout).toBe(expected);

    // Exactly one trailing newline comes from the renderer.
    expect(pnpm.stdout.endsWith('\n')).toBe(true);
    expect(pnpm.stdout.endsWith('\n\n')).toBe(false);

    const dataRows = pnpm.stdout
      .split('\n')
      .filter(
        (line) =>
          line.startsWith('| ') &&
          line !== HEADER_LINE &&
          !line.startsWith('| ---'),
      );
    expect(dataRows).toHaveLength(65);

    // pnpm's own lifecycle banner is absent from the silent form: the
    // output starts with the document title, not with pnpm chatter.
    expect(pnpm.stdout.startsWith('# Golden label review')).toBe(true);
  });

  it('exits 0 with byte-identical renderer markdown and empty stderr', () => {
    const result = runReviewCli();

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    // Exact renderer parity: stdout must be the renderer's returned string
    // verbatim for the repository default corpus.
    expect(result.stdout).toBe(
      renderGoldenLabelReviewMarkdown(loadSeedCorpus()),
    );
    // Trailing newline comes from the renderer and is preserved exactly.
    expect(result.stdout.endsWith('\n')).toBe(true);
    expect(result.stdout.endsWith('\n\n')).toBe(false);

    const dataRows = result.stdout
      .split('\n')
      .filter(
        (line) =>
          line.startsWith('| ') &&
          line !== HEADER_LINE &&
          !line.startsWith('| ---'),
      );
    expect(dataRows).toHaveLength(65);
    expect(result.stdout).toContain(
      'corpusId: m365-change-radar-phase-1b-dataset',
    );
  });

  it('keeps the project root free of compile scratch directories during and after a successful run', async () => {
    const { status, observedScratch } = await watchRepositoryDuringRun();

    expect(status).toBe(0);
    // Nothing resembling a compile output directory ever appeared inside the
    // repository: the runner builds its temporary compile directory below
    // the OS temp dir instead.
    expect(observedScratch).toEqual([]);
    expect(listRepositoryScratch()).toEqual([]);
  });

  it('is deterministic across repeated runs of the tracked corpus', () => {
    const first = runReviewCli();
    const second = runReviewCli();

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(second.stdout).toBe(first.stdout);
  }, 15_000);

  it('fails with non-zero exit, no stdout, and clear stderr when the corpus cannot be loaded', () => {
    stageCorpusCopy();
    const manifest = JSON.parse(
      readFileSync(join(projectRoot, 'corpus', 'manifest.json'), 'utf8'),
    ) as {
      changeFixtures: Array<{ fixtureId: string; path: string }>;
    };
    const victim = manifest.changeFixtures[0]!;
    writeFileSync(join(tempRoot, 'corpus', victim.path), '{ not json');

    const result = runReviewCli(tempRoot);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Unable to load corpus files');
    expect(result.stderr).toContain(victim.path);
  });

  it('fails with non-zero exit, no stdout, and clear stderr when label validation rejects a duplicated golden case', () => {
    stageCorpusCopy();
    const manifest = JSON.parse(
      readFileSync(join(projectRoot, 'corpus', 'manifest.json'), 'utf8'),
    ) as {
      goldenCases: Array<{ caseId: string; path: string }>;
    };
    const originalCase = manifest.goldenCases[0]!;
    const duplicateRaw = JSON.parse(
      readFileSync(join(projectRoot, 'corpus', originalCase.path), 'utf8'),
    ) as { caseId: string };
    const duplicatePath = 'cases/synth-case-cli-duplicate.json';
    writeFileSync(
      join(tempRoot, 'corpus', duplicatePath),
      JSON.stringify(duplicateRaw),
    );
    manifest.goldenCases.push({
      caseId: duplicateRaw.caseId,
      path: duplicatePath,
    });
    writeFileSync(
      join(tempRoot, 'corpus', 'manifest.json'),
      JSON.stringify(manifest),
    );

    const result = runReviewCli(tempRoot);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/duplicate ID/);
  });

  describe('compile failure (injected compiler-entrypoint seam)', () => {
    /**
     * Writes a stub `tsc` entrypoint that misbehaves like a failing
     * compiler. It receives the same argv contract as the real tsc
     * (`--project <file> --outDir <dir>`), scribbles on BOTH child streams,
     * and exits with a distinctive non-zero code.
     */
    function writeStubCompiler(exitCode: number): string {
      const stubBinDir = join(tempRoot, `stub-tsc-${exitCode}`);
      mkdirSync(stubBinDir, { recursive: true });
      const stubPath = join(stubBinDir, 'tsc.js');
      writeFileSync(
        stubPath,
        [
          '// Stub compiler for wrapper seam tests.',
          'const [, , projectFlag, projectValue, outDirFlag] = process.argv;',
          `if (projectFlag !== '--project' || outDirFlag !== '--outDir') {`,
          "  process.stderr.write('stub compiler: unexpected argv\\n');",
          '  process.exit(97);',
          '}',
          "// Prove the wrapper never lets compiler chatter reach the CLI's stdout.",
          'process.stdout.write(`stub-stdout-noise for ${projectValue}\\n`);',
          'process.stderr.write(`stub compile diagnostics for ${projectValue}\\n`);',
          `process.exit(${exitCode});`,
          '',
        ].join('\n'),
      );
      return stubPath;
    }

    it('propagates the compiler exit code, forwards diagnostics to stderr, and keeps CLI stdout empty', async () => {
      const stubCompiler = writeStubCompiler(2);
      const collector = collectStreams();

      const exitCode = await runGoldenLabelReviewProcess({
        projectRoot,
        compilerEntrypoint: stubCompiler,
        stdout: collector.streams.stdout,
        stderr: collector.streams.stderr,
      });

      const { stdout, stderr } = collector.text();
      expect(exitCode).toBe(2);
      expect(stdout).toBe('');
      // The wrapper surfaces WHY compilation failed and the compiler's own
      // diagnostics land on stderr.
      expect(stderr).toContain('stub compile diagnostics');
      expect(stderr.toLowerCase()).toMatch(/compil(e|ation)/);

      // Failure path is still scratch-free inside the repository.
      expect(listRepositoryScratch()).toEqual([]);
    });

    it('reports spawn-level compiler errors clearly on stderr with non-zero exit and empty stdout', async () => {
      const collector = collectStreams();

      const exitCode = await runGoldenLabelReviewProcess({
        projectRoot,
        compilerEntrypoint: join(tempRoot, 'does-not-exist', 'missing-tsc.js'),
        stdout: collector.streams.stdout,
        stderr: collector.streams.stderr,
      });

      const { stdout, stderr } = collector.text();
      expect(exitCode).not.toBe(0);
      expect(stdout).toBe('');
      expect(stderr).toContain('Unable to compile golden label review CLI');
      expect(listRepositoryScratch()).toEqual([]);
    });

    it('still returns a zero exit and pure stdout once the injected compiler succeeds again', async () => {
      // Positive control over the seam itself: the production compiler
      // entrypoint fed through the same call shape yields the documented
      // success contract.
      const realCompiler = join(
        projectRoot,
        'node_modules',
        'typescript',
        'bin',
        'tsc',
      );
      const collector = collectStreams();

      const exitCode = await runGoldenLabelReviewProcess({
        projectRoot,
        compilerEntrypoint: realCompiler,
        stdout: collector.streams.stdout,
        stderr: collector.streams.stderr,
      });

      const { stdout, stderr } = collector.text();
      expect(exitCode).toBe(0);
      expect(stderr).toBe('');
      expect(stdout).toBe(renderGoldenLabelReviewMarkdown(loadSeedCorpus()));
      expect(listRepositoryScratch()).toEqual([]);
    });
  });

  it('never writes into the corpus or the repository while running', () => {
    const snapshotBefore = loadSeedCorpus();
    const result = runReviewCli();

    expect(result.status).toBe(0);
    expect(JSON.stringify(loadSeedCorpus())).toBe(
      JSON.stringify(snapshotBefore),
    );
    // And stdout stays byte-identical with the untouched-corpus rendering.
    expect(result.stdout).toBe(renderGoldenLabelReviewMarkdown(snapshotBefore));
  });
});
