import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import {
  CorpusCollectionSchema,
  CorpusManifestSchema,
  type CorpusCollection,
} from './golden-corpus.js';
import { renderGoldenLabelReviewMarkdown } from './golden-label-review.js';

/**
 * Result of the golden label review command. On success `stdout` is exactly
 * the renderer's returned Markdown (including its single trailing newline);
 * on failure `stdout` is always empty, so partial output is never emitted.
 */
export type GoldenLabelReviewCommandResult = {
  exitCode: 0 | 1;
  stdout: string;
  stderr: string;
};

/**
 * Seam that keeps the command free of direct `process` access so tests can
 * inject fixture corpora without adding options or flags to the command.
 */
export type GoldenLabelReviewCommandIo = {
  /** Returns the repository root that contains the `corpus/` directory. */
  resolveProjectRoot(): string;
};

const DEFAULT_IO: GoldenLabelReviewCommandIo = {
  resolveProjectRoot: () => process.cwd(),
};

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
    return `${path}: ${issue.message}`;
  });
}

function fail(messages: readonly string[]): GoldenLabelReviewCommandResult {
  return { exitCode: 1, stdout: '', stderr: `${messages.join('\n')}\n` };
}

function readAll(
  corpusRoot: string,
  entries: readonly { path: string }[],
  kind: string,
): unknown[] {
  return entries.map((entry) => {
    try {
      return readJson(join(corpusRoot, entry.path));
    } catch (error) {
      throw new Error(
        `Unable to read ${kind} ${entry.path}: ${describeError(error)}`,
        { cause: error },
      );
    }
  });
}

/**
 * Load the repository default corpus and render the expert golden label
 * review document with the existing pure renderer.
 *
 * This is the entire golden-label-review CLI logic; the actual process
 * boundary (stdout/stderr/exit code) lives in a thin wrapper script. Every
 * environment touch goes through `io`, so callers can point the loader at a
 * different repository root without touching global state. Loading reads
 * `corpus/manifest.json` plus every referenced fixture, re-parses the
 * assembled collection against `CorpusCollectionSchema`, and hands it to
 * `renderGoldenLabelReviewMarkdown`, which additionally enforces reference
 * integrity via `validateCorpusCollection`. Load, validation, and render
 * failures each return a distinct multi-line stderr message with a non-zero
 * exit code and empty stdout; nothing is ever written to disk and no fixture
 * or label is mutated. On success the renderer's string is returned
 * verbatim, so repeated runs over the same tracked corpus are byte-identical.
 */
export function runGoldenLabelReviewCommand(
  io: GoldenLabelReviewCommandIo = DEFAULT_IO,
): GoldenLabelReviewCommandResult {
  const corpusRoot = join(io.resolveProjectRoot(), 'corpus');
  const manifestPath = join(corpusRoot, 'manifest.json');

  let manifestValue: unknown;
  try {
    manifestValue = readJson(manifestPath);
  } catch (error) {
    return fail([
      `Unable to read corpus manifest ${manifestPath}: ${describeError(error)}`,
    ]);
  }

  const manifestResult = CorpusManifestSchema.safeParse(manifestValue);
  if (!manifestResult.success) {
    return fail([
      'Corpus manifest is invalid:',
      ...formatZodIssues(manifestResult.error),
    ]);
  }

  let collectionInput: {
    manifest: typeof manifestResult.data;
    changeFixtures: unknown[];
    tenantProfileFixtures: unknown[];
    goldenCases: unknown[];
  };
  try {
    collectionInput = {
      manifest: manifestResult.data,
      changeFixtures: readAll(
        corpusRoot,
        manifestResult.data.changeFixtures,
        'change fixture',
      ),
      tenantProfileFixtures: readAll(
        corpusRoot,
        manifestResult.data.tenantProfileFixtures,
        'tenant profile fixture',
      ),
      goldenCases: readAll(
        corpusRoot,
        manifestResult.data.goldenCases,
        'golden case',
      ),
    };
  } catch (error) {
    return fail([`Unable to load corpus files: ${describeError(error)}`]);
  }

  let collection: CorpusCollection;
  try {
    collection = CorpusCollectionSchema.parse(collectionInput);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return fail([
        'Corpus collection failed schema validation:',
        ...formatZodIssues(error),
      ]);
    }
    return fail([
      `Corpus collection failed schema validation: ${describeError(error)}`,
    ]);
  }

  let markdown: string;
  try {
    markdown = renderGoldenLabelReviewMarkdown(collection);
  } catch (error) {
    return fail([
      `Golden label review rendering failed: ${describeError(error)}`,
    ]);
  }

  return { exitCode: 0, stdout: markdown, stderr: '' };
}
