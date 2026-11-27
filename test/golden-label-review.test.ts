import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CorpusCollectionSchema,
  renderGoldenLabelReviewMarkdown,
  type CorpusCollection,
} from '../src/index.js';

function loadSeedCorpus(): CorpusCollection {
  const corpusRoot = resolve(process.cwd(), 'corpus');
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

const HEADER_LINE =
  '| caseId | changeFixtureId | change title | tenantProfileFixtureId | tenant profileVersion | expected state | expected reason | minimumRiskFloor | highImpact | importance | missingContext | coverageTags | evaluationTags |';

describe('golden label review renderer', () => {
  it('renders 65 sorted rows for the real corpus with a fixed structure', () => {
    const collection = loadSeedCorpus();
    const markdown = renderGoldenLabelReviewMarkdown(collection);

    expect(markdown.startsWith('# Golden label review\n')).toBe(true);
    expect(markdown).toContain('corpusId: m365-change-radar-phase-1b-dataset');
    expect(markdown).toContain('- corpusVersion:');
    expect(markdown).toContain(HEADER_LINE);

    const dataRows = markdown
      .split('\n')
      .filter(
        (line) =>
          line.startsWith('| ') &&
          line !== HEADER_LINE &&
          !line.startsWith('| ---'),
      );
    expect(dataRows).toHaveLength(65);

    // Rows are sorted by caseId ascending.
    const caseIds = dataRows.map((line) => {
      const firstCell = line.split(' | ')[0];
      if (firstCell === undefined) throw new Error('empty table row');
      return firstCell.slice(2);
    });
    const sorted = [...caseIds].sort();
    expect(caseIds).toEqual(sorted);
    // Exactly one row per case; no duplicates.
    expect(new Set(caseIds).size).toBe(65);
  });

  it('resolves known fixture values into the expected row cells', () => {
    const collection = loadSeedCorpus();
    const markdown = renderGoldenLabelReviewMarkdown(collection);

    const firstCase = collection.goldenCases.find(
      (goldenCase) => goldenCase.caseId === 'SYNTH-CASE-001',
    );
    expect(firstCase).toBeDefined();
    if (!firstCase) throw new Error('unreachable');

    const row = markdown
      .split('\n')
      .find((line) => line.startsWith(`| SYNTH-CASE-001 |`));
    expect(row).toBeDefined();
    if (!row) throw new Error('unreachable');

    const changeTitle = collection.changeFixtures.find(
      (fixture) => fixture.fixtureId === firstCase!.changeFixtureId,
    )!.event.title;
    const profileVersion = collection.tenantProfileFixtures.find(
      (fixture) => fixture.fixtureId === firstCase!.tenantProfileFixtureId,
    )!.profile.profileVersion;

    expect(row).toContain(`| ${firstCase!.changeFixtureId} |`);
    expect(row).toContain(`| ${changeTitle.replaceAll('|', '\\|')} |`);
    expect(row).toContain(`| ${profileVersion} |`);
    expect(row).toContain(`| ${firstCase!.expected.state} |`);
    expect(row).toContain(`| ${firstCase!.expected.reason} |`);
    expect(row.endsWith(`| ${firstCase!.evaluationTags.join('<br>')} |`)).toBe(
      true,
    );
    // minimumRiskFloor is declared on SYNTH-CASE-001.
    if ('minimumRiskFloor' in firstCase!.expected) {
      expect(row).toContain(`| ${firstCase!.expected.minimumRiskFloor} |`);
    }
  });

  it('is byte-identical when every input array order is reversed', () => {
    const collection = loadSeedCorpus();
    const forward = renderGoldenLabelReviewMarkdown(collection);
    const reversed = renderGoldenLabelReviewMarkdown({
      ...collection,
      changeFixtures: [...collection.changeFixtures].reverse(),
      tenantProfileFixtures: [...collection.tenantProfileFixtures].reverse(),
      goldenCases: [...collection.goldenCases].reverse(),
      manifest: {
        ...collection.manifest,
        changeFixtures: [...collection.manifest.changeFixtures].reverse(),
        tenantProfileFixtures: [
          ...collection.manifest.tenantProfileFixtures,
        ].reverse(),
        goldenCases: [...collection.manifest.goldenCases].reverse(),
      },
    });

    expect(reversed).toBe(forward);
  });

  it('escapes pipes and backslashes and normalizes line breaks inside cells', () => {
    const collection = loadSeedCorpus();
    // Pick a change fixture referenced by exactly one golden case so the row
    // count assertion below is unambiguous.
    const referenceCounts = new Map<string, number>();
    for (const goldenCase of collection.goldenCases) {
      referenceCounts.set(
        goldenCase.changeFixtureId,
        (referenceCounts.get(goldenCase.changeFixtureId) ?? 0) + 1,
      );
    }
    const uniqueFixtureId = [...referenceCounts.entries()].find(
      ([, count]) => count === 1,
    )![0];
    const target = collection.changeFixtures.find(
      (fixture) => fixture.fixtureId === uniqueFixtureId,
    )!;
    const tampered = {
      ...collection,
      changeFixtures: collection.changeFixtures.map((fixture) =>
        fixture.fixtureId === target.fixtureId
          ? {
              ...fixture,
              event: {
                ...fixture.event,
                title:
                  'Pipes | and \\ backslashes |break tables| with\nline breaks\r\ntoo',
              },
            }
          : fixture,
      ),
    } as CorpusCollection;

    const markdown = renderGoldenLabelReviewMarkdown(tampered);

    expect(markdown).toContain(
      'Pipes \\| and \\\\ backslashes \\|break tables\\| with line breaks too',
    );
    // One physical table row still contains the whole cell (the review
    // overview does not repeat the title).
    const rowsWithContent = markdown
      .split('\n')
      .filter((line) => line.startsWith('| ') && line.includes('Pipes'));
    expect(rowsWithContent).toHaveLength(1);

    // Raw input fixtures are untouched.
    const original = CorpusCollectionSchema.parse(
      collection,
    ).changeFixtures.find((fixture) => fixture.fixtureId === target.fixtureId)!;
    expect(original.event.title).not.toContain('\\|');
  });

  it('keeps array order inside list cells without reordering or sorting tags', () => {
    const collection = loadSeedCorpus();
    const target = collection.goldenCases[0]!;
    const evaluationTagsInOrder = target.evaluationTags;
    const markdown = renderGoldenLabelReviewMarkdown(collection);
    const row = markdown
      .split('\n')
      .find((line) => line.startsWith(`| ${target.caseId} |`));
    expect(row).toBeDefined();
    expect(row!.endsWith(`| ${evaluationTagsInOrder.join('<br>')} |`)).toBe(
      true,
    );
  });

  it('renders empty minimumRiskFloor/missingContext cells where absent', () => {
    const collection = loadSeedCorpus();
    const informationalCase = collection.goldenCases.find(
      (goldenCase) => goldenCase.expected.state === 'INFORMATIONAL',
    );
    expect(informationalCase).toBeDefined();

    const row = renderGoldenLabelReviewMarkdown(collection)
      .split('\n')
      .find((line) => line.startsWith(`| ${informationalCase!.caseId} |`));
    expect(row).toBeDefined();
    if (!row) throw new Error('unreachable');
    const cells = row.split('|');
    // minimumRiskFloor cell and missingContext cell are both empty strings.
    // Cell layout: ['', caseId, ..., reason, minimumRiskFloor, highImpact,
    // importance, missingContext, coverageTags, evaluationTags, ''].
    const minFloorCell = cells[8]!;
    const missingContextCell = cells[11]!;
    expect(minFloorCell.trim()).toBe('');
    expect(missingContextCell.trim()).toBe('');
  });

  it('does not mutate its inputs', () => {
    const collection = loadSeedCorpus();
    const snapshot = JSON.stringify(collection);
    const frozen = Object.freeze({ ...collection });

    renderGoldenLabelReviewMarkdown(frozen);

    expect(JSON.stringify(collection)).toBe(snapshot);
  });

  it('always ends with exactly one trailing newline', () => {
    const markdown = renderGoldenLabelReviewMarkdown(loadSeedCorpus());
    expect(markdown.endsWith('\n')).toBe(true);
    expect(markdown.endsWith('\n\n')).toBe(false);
  });

  it('rejects duplicate golden case IDs instead of rendering', () => {
    const collection = loadSeedCorpus();
    const duplicatedFirst = collection.goldenCases[0]!;
    const broken = {
      ...collection,
      goldenCases: [duplicatedFirst, ...collection.goldenCases],
    } as unknown as CorpusCollection;

    expect(() => renderGoldenLabelReviewMarkdown(broken)).toThrowError(
      /duplicate/,
    );
  });

  it('rejects a golden case referencing an unknown tenant profile fixture', () => {
    const collection = loadSeedCorpus();
    const firstCase = collection.goldenCases[0]!;
    const broken = {
      ...collection,
      goldenCases: collection.goldenCases.map((goldenCase) =>
        goldenCase.caseId === firstCase.caseId
          ? {
              ...goldenCase,
              tenantProfileFixtureId: 'SYNTH-TENANT-DOES-NOT-EXIST',
            }
          : goldenCase,
      ),
    } as unknown as CorpusCollection;

    expect(() => renderGoldenLabelReviewMarkdown(broken)).toThrowError(
      /failed validation/,
    );
  });

  it('rejects schema extras inside a fixture via the runtime parse', () => {
    const collection = loadSeedCorpus();
    const firstChange = collection.changeFixtures[0]!;
    const broken = {
      ...collection,
      changeFixtures: [
        { ...firstChange, extraField: true },
        ...collection.changeFixtures.slice(1),
      ],
    };

    expect(() =>
      renderGoldenLabelReviewMarkdown(broken as unknown as CorpusCollection),
    ).toThrowError(/extraField/);
  });
});
