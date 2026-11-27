import {
  CorpusCollectionSchema,
  type CorpusCollection,
  type ChangeFixture,
  type GoldenCase,
  type TenantProfileFixture,
} from './golden-corpus.js';
import { validateCorpusCollection } from './validator.js';

const HEADER_COLUMNS = [
  'caseId',
  'changeFixtureId',
  'change title',
  'tenantProfileFixtureId',
  'tenant profileVersion',
  'expected state',
  'expected reason',
  'minimumRiskFloor',
  'highImpact',
  'importance',
  'missingContext',
  'coverageTags',
  'evaluationTags',
] as const;

/**
 * Escape one Markdown table cell: backslashes first (so the pipe escape is
 * not itself escaped), then pipes, then normalize CR/LF line breaks to plain
 * spaces so exactly one physical row per golden case is preserved.
 */
function escapeCell(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replaceAll('\r\n', ' ')
    .replaceAll('\n', ' ')
    .replaceAll('\r', ' ');
}

/** Join an array cell keeping the existing element order, separated by `<br>`. */
function listCell(values: readonly string[]): string {
  return values.map(escapeCell).join('<br>');
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function minimumRiskFloorCell(goldenCase: GoldenCase): string {
  if ('minimumRiskFloor' in goldenCase.expected) {
    return escapeCell(goldenCase.expected.minimumRiskFloor ?? '');
  }
  return '';
}

function missingContextCell(goldenCase: GoldenCase): string {
  if ('missingContext' in goldenCase.expected) {
    return listCell(goldenCase.expected.missingContext);
  }
  return '';
}

function buildRow(
  goldenCase: GoldenCase,
  changeFixture: ChangeFixture,
  profileFixture: TenantProfileFixture,
): string[] {
  return [
    escapeCell(goldenCase.caseId),
    escapeCell(goldenCase.changeFixtureId),
    escapeCell(changeFixture.event.title),
    escapeCell(goldenCase.tenantProfileFixtureId),
    escapeCell(profileFixture.profile.profileVersion),
    escapeCell(goldenCase.expected.state),
    escapeCell(goldenCase.expected.reason),
    minimumRiskFloorCell(goldenCase),
    goldenCase.highImpact ? 'true' : 'false',
    escapeCell(goldenCase.importance),
    missingContextCell(goldenCase),
    listCell(goldenCase.coverageTags),
    listCell(goldenCase.evaluationTags),
  ];
}

function renderTable(rows: readonly (readonly string[])[]): string {
  const lines: string[] = [];
  lines.push(`| ${HEADER_COLUMNS.join(' | ')} |`);
  lines.push(`| ${HEADER_COLUMNS.map(() => '---').join(' | ')} |`);
  for (const row of rows) {
    lines.push(`| ${row.join(' | ')} |`);
  }
  return lines.join('\n');
}

/**
 * Render a read-only expert review document from a fully validated corpus
 * collection.
 *
 * The input is re-parsed against `CorpusCollectionSchema` and additionally
 * checked with `validateCorpusCollection`, so schema violations, duplicate
 * IDs, and missing or unknown fixture references are rejected with a thrown
 * error instead of a misleading Markdown document. The collection and every
 * fixture inside it are never mutated; nothing is written to disk. The output
 * depends only on set content — array ordering of changes, profiles, or cases
 * never affects the bytes — and always ends with a trailing newline.
 *
 * The document contains a fixed title, a corpusId/corpusVersion overview, and
 * one sorted table row per golden case. It deliberately excludes timestamps,
 * environment paths, observed states, engine metrics, and model outputs:
 * this document reviews hand-authored labels, it does not record runs.
 */
export function renderGoldenLabelReviewMarkdown(
  corpusCollectionInput: CorpusCollection,
): string {
  const collection = CorpusCollectionSchema.parse(corpusCollectionInput);

  const validation = validateCorpusCollection(collection);
  if (!validation.valid) {
    throw new Error(
      `corpus collection failed validation: ${validation.errors.join('; ')}`,
    );
  }

  const changeById = new Map<string, ChangeFixture>();
  for (const fixture of collection.changeFixtures) {
    changeById.set(fixture.fixtureId, fixture);
  }
  const profileById = new Map<string, TenantProfileFixture>();
  for (const fixture of collection.tenantProfileFixtures) {
    profileById.set(fixture.fixtureId, fixture);
  }

  const rows = [...collection.goldenCases]
    .sort((a, b) => compareStrings(a.caseId, b.caseId))
    .map((goldenCase) => {
      // validateCorpusCollection has verified both references exist.
      const changeFixture = changeById.get(goldenCase.changeFixtureId);
      const profileFixture = profileById.get(goldenCase.tenantProfileFixtureId);
      if (changeFixture === undefined || profileFixture === undefined) {
        throw new Error(
          `golden case ${goldenCase.caseId} references an unknown fixture after validation`,
        );
      }
      return buildRow(goldenCase, changeFixture, profileFixture);
    });

  const header = [
    '# Golden label review',
    '',
    `- corpusId: ${escapeCell(collection.manifest.corpusId)}`,
    `- corpusVersion: ${escapeCell(collection.manifest.corpusVersion)}`,
    `- goldenCases: ${rows.length}`,
    '',
    'Read-only expert review sheet rendered from the synthetic golden',
    'corpus. Expected states and reasons are hand-authored labels, not',
    'engine observations.',
  ].join('\n');

  return `${header}\n${renderTable(rows)}\n`;
}
