import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DigestBundleSchema,
  parseDigestCliArgs,
  renderSummaryMarkdownJa,
  runDigestCommand,
  type DigestBundle,
} from '../src/index.js';

const projectRoot = resolve(process.cwd());
const snapshotJsonRel = 'test/fixtures/microsoft-roadmap-snapshot.json';
const snapshotRssRel = 'test/fixtures/microsoft-roadmap-rss.xml';

const EMOJI_PATTERN = /\p{Extended_Pictographic}/u;

function assertMarkdownAntiPatternsClean(markdownBody: string): void {
  const lines = markdownBody.split('\n');
  const headings = lines.filter((line) => /^#{1,6}\s+/.test(line));
  expect(headings.length).toBeGreaterThanOrEqual(5);

  for (const heading of headings) {
    const withoutCode = heading.replace(/`[^`]*`/g, '');
    expect(EMOJI_PATTERN.test(heading)).toBe(false);
    expect(withoutCode.includes('、')).toBe(false);
  }
}

describe('parseDigestCliArgs', () => {
  it('parses valid --input and --live flag combinations and rejects invalid ones', () => {
    expect(parseDigestCliArgs(['--help'])).toEqual({ kind: 'help' });

    const offline = parseDigestCliArgs([
      '--input',
      snapshotJsonRel,
      '--days',
      '14',
      '--limit',
      '25',
      '--profiles',
      'profiles',
      '--out-dir',
      'artifacts/custom',
      '--now',
      '2026-11-26T12:00:00Z',
    ]);
    expect(offline).toEqual({
      kind: 'run',
      mode: 'input',
      inputPath: snapshotJsonRel,
      days: 14,
      limit: 25,
      profilesArg: 'profiles',
      outDirArg: 'artifacts/custom',
      now: '2026-11-26T12:00:00Z',
    });

    expect(() => parseDigestCliArgs([])).toThrow(/Missing feed source/);
    expect(() =>
      parseDigestCliArgs(['--live', '--input', snapshotJsonRel]),
    ).toThrow(/not both/);
    expect(() => parseDigestCliArgs(['--live', '--days', '0'])).toThrow(
      /positive integer/,
    );
  });
});

describe('runDigestCommand offline, mocked live, audit ledger, and summary renderer', () => {
  it('produces all 5 impact states, excludes GCC/DoD-only items, and emits readable digest-ja.md and summary-ja.md byte-deterministically', async () => {
    const outDir1 = mkdtempSync(join(tmpdir(), 'digest-test-1-'));
    const outDir2 = mkdtempSync(join(tmpdir(), 'digest-test-2-'));

    try {
      const res1 = await runDigestCommand(
        ['--input', snapshotJsonRel, '--days', '14', '--out-dir', outDir1],
        {
          resolveProjectRoot: () => projectRoot,
          now: () => '2099-01-01T00:00:00.000Z',
        },
      );
      const res2 = await runDigestCommand(
        ['--input', snapshotJsonRel, '--days', '14', '--out-dir', outDir2],
        {
          resolveProjectRoot: () => projectRoot,
          now: () => '2030-06-01T00:00:00.000Z',
        },
      );

      expect(res1.exitCode).toBe(0);
      expect(res1.stderr).toBe('');
      expect(res2.exitCode).toBe(0);

      const summaryJson1 = JSON.parse(res1.stdout) as Record<string, unknown>;
      expect(summaryJson1.summaryMarkdownPath).toBe(
        join(outDir1, 'summary-ja.md'),
      );
      expect(Object.keys(summaryJson1)).toEqual([
        'generatedAt',
        'mode',
        'fetchedItemCount',
        'selectedItemCount',
        'sovereignCloudExcludedCount',
        'personaCount',
        'pairCount',
        'stateCounts',
        'actionCount',
        'bundlePath',
        'markdownPath',
        'summaryMarkdownPath',
      ]);

      const bundleText1 = readFileSync(
        join(outDir1, 'digest-bundle.json'),
        'utf8',
      );
      const bundleText2 = readFileSync(
        join(outDir2, 'digest-bundle.json'),
        'utf8',
      );
      const mdText1 = readFileSync(join(outDir1, 'digest-ja.md'), 'utf8');
      const mdText2 = readFileSync(join(outDir2, 'digest-ja.md'), 'utf8');
      const summaryText1 = readFileSync(join(outDir1, 'summary-ja.md'), 'utf8');
      const summaryText2 = readFileSync(join(outDir2, 'summary-ja.md'), 'utf8');

      expect(bundleText1).toBe(bundleText2);
      expect(mdText1).toBe(mdText2);
      expect(summaryText1).toBe(summaryText2);

      const bundle: DigestBundle = DigestBundleSchema.parse(
        JSON.parse(bundleText1) as unknown,
      );
      expect(bundle.summary.changeCount).toBe(11);
      expect(bundle.summary.sovereignCloudExcludedCount).toBe(1);
      expect(bundle.summary.personaCount).toBe(3);
      expect(bundle.summary.pairCount).toBe(33);

      const govEntry = bundle.entries.find(
        (entry) => entry.changeEvent.externalId === '529852',
      );
      expect(govEntry).toBeDefined();
      for (const outcome of govEntry?.outcomes ?? []) {
        expect(outcome.analysisRecord.impactAssessment.state).toBe(
          'NOT_APPLICABLE',
        );
        expect(outcome.analysisRecord.versionBundle.ai).toEqual({
          used: false,
        });
      }

      expect(bundle.summary.stateCounts.ACTION_REQUIRED).toBeGreaterThan(0);
      expect(bundle.summary.stateCounts.REVIEW_REQUIRED).toBeGreaterThan(0);
      expect(bundle.summary.stateCounts.INFORMATIONAL).toBeGreaterThan(0);
      expect(bundle.summary.stateCounts.NOT_APPLICABLE).toBeGreaterThan(0);
      expect(bundle.summary.stateCounts.INSUFFICIENT_CONTEXT).toBeGreaterThan(
        0,
      );
      expect(bundle.summary.actionCount).toBeGreaterThan(0);

      // Technical audit ledger checks (concise Japanese summaries, zero raw English DSL dumps)
      assertMarkdownAntiPatternsClean(mdText1);
      expect(EMOJI_PATTERN.test(mdText1)).toBe(false);
      expect(mdText1).toContain('Microsoft 公開ソース事実 (source_fact)');
      expect(mdText1).toContain('ルール `security-impact`');
      expect(mdText1).toContain('ルール `privacy-or-compliance-impact`');
      expect(mdText1).toContain('ルール `retirement-or-deprecation`');
      expect(mdText1).not.toContain('any_of evaluated as MATCH:');
      expect(mdText1).not.toContain('Investigate "');

      // Platform-neutral executive summary checks (standard H1, HTML <details>, zero frontmatter or :::details)
      expect(summaryText1).not.toMatch(/^---\n/);
      expect(summaryText1).not.toContain(':::details');
      expect(summaryText1).toMatch(
        /^# Microsoft 365 週次変更影響サマリー \(\d{4}-\d{2}-\d{2} - \d{4}-\d{2}-\d{2}\)\n\n/,
      );
      expect(summaryText1).toContain(
        '<details>\n<summary>Microsoft 公開ロードマップ原文</summary>\n\n',
      );
      expect(summaryText1).toContain('\n</details>\n');

      assertMarkdownAntiPatternsClean(summaryText1);
      expect(EMOJI_PATTERN.test(summaryText1)).toBe(false);

      const disclaimerMatches =
        summaryText1.match(/Microsoft 公式の手順指示ではありません/g) ?? [];
      expect(disclaimerMatches).toHaveLength(1);
      expect(summaryText1).not.toContain('information-governance-team');
      expect(summaryText1).not.toContain('services.purview_compliance');
      expect(summaryText1).toContain('Microsoft Purview ポータル');
      expect(summaryText1).toContain('Microsoft Teams 管理センター');
      expect(summaryText1).toContain('40名 Teams+EXO最小構成');
      expect(summaryText1).toContain('150名 Business Premium+Intune標準構成');
      expect(summaryText1).toContain('600名 Hybrid E3+Purview/Viva構成');
      expect(summaryText1).toContain('529852');

      // SummaryMarkdownOptions custom row limit
      const cappedSummary = renderSummaryMarkdownJa(bundle, {
        maxInformationalRows: 1,
      });
      expect(cappedSummary).toContain(
        'ほか 2 件の一般機能更新・計画変更も情報共有または対象外として集計済みです。',
      );
    } finally {
      rmSync(outDir1, { recursive: true, force: true });
      rmSync(outDir2, { recursive: true, force: true });
    }
  });

  it('supports RSS XML snapshots via --input <rss.xml> and mocked --live fetch', async () => {
    const outDirRss = mkdtempSync(join(tmpdir(), 'digest-rss-'));
    const outDirLive = mkdtempSync(join(tmpdir(), 'digest-live-'));
    const snapshotJsonText = readFileSync(
      join(projectRoot, snapshotJsonRel),
      'utf8',
    );

    try {
      const rssResult = await runDigestCommand(
        ['--input', snapshotRssRel, '--days', '14', '--out-dir', outDirRss],
        {
          resolveProjectRoot: () => projectRoot,
          now: () => '2026-11-26T00:16:54.000Z',
        },
      );
      expect(rssResult.exitCode).toBe(0);
      const rssBundle = DigestBundleSchema.parse(
        JSON.parse(
          readFileSync(join(outDirRss, 'digest-bundle.json'), 'utf8'),
        ) as unknown,
      );
      expect(rssBundle.summary.changeCount).toBe(2);

      const liveResult = await runDigestCommand(
        [
          '--live',
          '--days',
          '7',
          '--limit',
          '5',
          '--now',
          '2026-11-26T12:00:00Z',
          '--out-dir',
          outDirLive,
        ],
        {
          resolveProjectRoot: () => projectRoot,
          now: () => '2026-11-26T12:00:00.000Z',
          fetch: async () =>
            new Response(snapshotJsonText, {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
        },
      );
      expect(liveResult.exitCode).toBe(0);
      const liveBundle = DigestBundleSchema.parse(
        JSON.parse(
          readFileSync(join(outDirLive, 'digest-bundle.json'), 'utf8'),
        ) as unknown,
      );
      expect(liveBundle.feedSource.mode).toBe('live');
      expect(liveBundle.summary.changeCount).toBeLessThanOrEqual(5);
    } finally {
      rmSync(outDirRss, { recursive: true, force: true });
      rmSync(outDirLive, { recursive: true, force: true });
    }
  });

  it('runs through the real pnpm --silent digest CLI wrapper without leaving repository scratch dirs', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'digest-cli-proc-'));
    try {
      const child = spawnSync(
        'pnpm',
        [
          '--silent',
          'digest',
          '--input',
          snapshotJsonRel,
          '--days',
          '14',
          '--out-dir',
          outDir,
        ],
        {
          cwd: projectRoot,
          encoding: 'utf8',
        },
      );
      expect(child.status).toBe(0);
      expect(child.stderr).toBe('');
      const summary = JSON.parse(child.stdout) as Record<string, unknown>;
      expect(summary.selectedItemCount).toBe(11);
      expect(summary.sovereignCloudExcludedCount).toBe(1);
      expect(summary.personaCount).toBe(3);
      expect(summary.summaryMarkdownPath).toBe(join(outDir, 'summary-ja.md'));

      const scratchDirs = readdirSync(projectRoot).filter((name) =>
        name.includes('-dist-'),
      );
      expect(scratchDirs).toEqual([]);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 20_000);
});
