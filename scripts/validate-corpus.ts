import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { z } from 'zod';

import {
  CorpusManifestSchema,
  RiskPolicySchema,
  TenantApplicabilityPolicySchema,
  TenantProfileSchema,
  validateCorpusCollection,
} from '../src/index.js';

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function formatSchemaIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
    return `${path}: ${issue.message}`;
  });
}

function main(): void {
  const corpusRoot = resolve(process.cwd(), 'corpus');
  const manifestPath = join(corpusRoot, 'manifest.json');
  let manifestValue: unknown;

  try {
    manifestValue = readJson(manifestPath);
  } catch (error) {
    console.error(
      `Unable to read corpus manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
    return;
  }

  const manifestResult = CorpusManifestSchema.safeParse(manifestValue);
  if (!manifestResult.success) {
    console.error('Corpus manifest is invalid:');
    formatSchemaIssues(manifestResult.error).forEach((issue) =>
      console.error(`- ${issue}`),
    );
    process.exitCode = 1;
    return;
  }

  const manifest = manifestResult.data;
  try {
    const collection = {
      manifest,
      changeFixtures: manifest.changeFixtures.map((entry) =>
        readJson(resolveCorpusPath(corpusRoot, entry.path)),
      ),
      tenantProfileFixtures: manifest.tenantProfileFixtures.map((entry) =>
        readJson(resolveCorpusPath(corpusRoot, entry.path)),
      ),
      goldenCases: manifest.goldenCases.map((entry) =>
        readJson(resolveCorpusPath(corpusRoot, entry.path)),
      ),
    };
    const result = validateCorpusCollection(collection);

    if (!result.valid) {
      console.error('Corpus validation failed:');
      result.errors.forEach((issue) => console.error(`- ${issue}`));
      process.exitCode = 1;
      return;
    }

    const summary = result.summary;
    if (summary === undefined) {
      console.error('Corpus validation produced no summary.');
      process.exitCode = 1;
      return;
    }
    console.log(
      `Corpus valid: ${summary.changeFixtureCount} change fixtures, ${summary.tenantProfileFixtureCount} tenant profiles, ${summary.goldenCaseCount} golden cases`,
    );
    console.log(`High-impact cases: ${summary.highImpactCaseCount}`);
    console.log(
      `States: ${Object.entries(summary.stateCounts)
        .map(([state, count]) => `${state}=${count}`)
        .join(', ')}`,
    );
    console.log(`Case coverage tags: ${summary.coverageTags.length}`);
    validateReferenceProfilesAndPolicies(process.cwd());
  } catch (error) {
    console.error(
      `Unable to load corpus files: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

function validateReferenceProfilesAndPolicies(projectRoot: string): void {
  const profilesDir = resolve(projectRoot, 'profiles');
  const profileFiles = readdirSync(profilesDir)
    .filter((name) => name.endsWith('.json'))
    .sort();
  if (profileFiles.length === 0) {
    throw new Error(`No reference tenant profiles found in ${profilesDir}`);
  }
  for (const fileName of profileFiles) {
    const profilePath = join(profilesDir, fileName);
    TenantProfileSchema.parse(readJson(profilePath));
  }

  const policiesDir = resolve(projectRoot, 'policies');
  RiskPolicySchema.parse(readJson(join(policiesDir, 'risk-policy.json')));
  TenantApplicabilityPolicySchema.parse(
    readJson(join(policiesDir, 'tenant-applicability-policy.json')),
  );

  console.log(
    `Reference profiles valid: ${profileFiles.length} (${profileFiles.join(', ')})`,
  );
}

function resolveCorpusPath(corpusRoot: string, relativePath: string): string {
  const path = resolve(corpusRoot, relativePath);
  if (isAbsolute(relativePath) || !path.startsWith(`${corpusRoot}/`)) {
    throw new Error(`manifest path escapes corpus root: ${relativePath}`);
  }
  return path;
}

main();
