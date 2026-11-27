import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';

import { z } from 'zod';

import {
  MICROSOFT_ROADMAP_JSON_API_URL,
  fetchMicrosoftRoadmapFeed,
  parseMicrosoftRoadmapFeed,
  type NormalizedRoadmapRecord,
} from '../adapters/microsoft-roadmap/index.js';
import type { StructuredImpactClassifier } from '../domain/impact-analysis-runner.js';
import { RiskPolicySchema, type RiskPolicy } from '../domain/risk-policy.js';
import {
  TenantApplicabilityPolicySchema,
  type TenantApplicabilityPolicy,
} from '../domain/tenant-applicability.js';
import { TenantProfileSchema } from '../domain/tenant-profile.js';
import {
  runDigestPipeline,
  type DigestBundle,
  type PersonaProfileInput,
} from './digest-bundle.js';
import { renderDigestMarkdownJa } from './render-digest-markdown-ja.js';
import { renderZennArticleMarkdownJa } from './render-zenn-article-ja.js';

export type DigestCommandResult = {
  readonly exitCode: 0 | 1;
  readonly stdout: string;
  readonly stderr: string;
};

export type DigestCommandIo = {
  readonly resolveProjectRoot: () => string;
  readonly now: () => string;
  readonly fetch?: typeof fetch;
  readonly classifier?: StructuredImpactClassifier;
};

const DEFAULT_IO: DigestCommandIo = {
  resolveProjectRoot: () => process.cwd(),
  now: () => new Date().toISOString(),
};

const DEFAULT_DAYS = 7;
const DEFAULT_LIMIT = 50;
const DEFAULT_PROFILES_ARG = 'profiles';
const DEFAULT_OUT_DIR_ARG = 'artifacts/digest';

export type ParsedDigestCliArgs =
  | { readonly kind: 'help' }
  | {
      readonly kind: 'run';
      readonly mode: 'live' | 'input';
      readonly inputPath?: string;
      readonly feedUrl?: string;
      readonly days: number;
      readonly limit: number;
      readonly profilesArg: string;
      readonly outDirArg: string;
      readonly now?: string;
    };

const DIGEST_USAGE = `Usage: pnpm digest (--live | --input <snapshot.json|rss.xml>) [options]

Options:
  --live                      Fetch unauthenticated Microsoft 365 Roadmap public feed
  --input <path>              Load local Roadmap JSON snapshot or RSS 2.0 XML file
  --feed-url <url>            Override live Roadmap endpoint URL
  --days <n>                  Rolling lookback window in days (default: 7)
  --limit <n>                 Maximum changes to analyze (default: 50)
  --profiles <dir|paths>      Profile directory or comma-separated JSON paths (default: profiles)
  --out-dir <dir>             Output directory for digest-bundle.json, digest-ja.md & zenn-article-ja.md (default: artifacts/digest)
  --now <iso-timestamp>       Explicit offset-aware ISO 8601 reference timestamp
  --help, -h                  Show this usage message
`;

function parsePositiveIntFlag(flag: string, raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${flag} must be a positive integer; received "${raw}"`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer; received "${raw}"`);
  }
  return parsed;
}

export function parseDigestCliArgs(
  argv: readonly string[],
): ParsedDigestCliArgs {
  let live = false;
  let inputPath: string | undefined;
  let feedUrl: string | undefined;
  let days = DEFAULT_DAYS;
  let limit = DEFAULT_LIMIT;
  let profilesArg = DEFAULT_PROFILES_ARG;
  let outDirArg = DEFAULT_OUT_DIR_ARG;
  let now: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined || arg === '--') continue;

    if (arg === '--help' || arg === '-h') {
      return { kind: 'help' };
    }
    if (arg === '--live') {
      live = true;
      continue;
    }

    const nextValue = (): string => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        throw new Error(`Missing value for option ${arg}`);
      }
      i += 1;
      return next;
    };

    if (arg === '--input') {
      inputPath = nextValue();
    } else if (arg === '--feed-url') {
      feedUrl = z.url().parse(nextValue());
    } else if (arg === '--days') {
      days = parsePositiveIntFlag('--days', nextValue());
    } else if (arg === '--limit') {
      limit = parsePositiveIntFlag('--limit', nextValue());
    } else if (arg === '--profiles') {
      profilesArg = nextValue();
    } else if (arg === '--out-dir') {
      outDirArg = nextValue();
    } else if (arg === '--now') {
      const candidate = nextValue();
      z.iso.datetime({ offset: true }).parse(candidate);
      now = candidate;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (live && inputPath !== undefined) {
    throw new Error('Specify either --live or --input <path>, not both.');
  }
  if (!live && inputPath === undefined) {
    throw new Error(
      'Missing feed source: specify either --live or --input <snapshot.json|rss.xml>.',
    );
  }

  return {
    kind: 'run',
    mode: live ? 'live' : 'input',
    ...(inputPath !== undefined ? { inputPath } : {}),
    ...(feedUrl !== undefined ? { feedUrl } : {}),
    days,
    limit,
    profilesArg,
    outDirArg,
    ...(now !== undefined ? { now } : {}),
  };
}

function loadPersonaProfiles(
  projectRoot: string,
  profilesArg: string,
): PersonaProfileInput[] {
  const parts = profilesArg
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length === 0) {
    throw new Error('No tenant profile paths provided to --profiles.');
  }

  const filePaths: string[] = [];
  for (const part of parts) {
    const resolved = resolve(projectRoot, part);
    const stat = statSync(resolved);
    if (stat.isDirectory()) {
      const jsonFiles = readdirSync(resolved)
        .filter((file) => file.endsWith('.json'))
        .sort()
        .map((file) => join(resolved, file));
      filePaths.push(...jsonFiles);
    } else {
      filePaths.push(resolved);
    }
  }

  if (filePaths.length === 0) {
    throw new Error(`No .json tenant profile files found in "${profilesArg}".`);
  }

  return filePaths.map((filePath) => {
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    const profile = TenantProfileSchema.parse(raw);
    const personaId = basename(filePath, extname(filePath));
    return { personaId, profile };
  });
}

function loadPolicies(projectRoot: string): {
  readonly riskPolicy: RiskPolicy;
  readonly tenantApplicabilityPolicy: TenantApplicabilityPolicy;
} {
  const riskPath = join(projectRoot, 'policies', 'risk-policy.json');
  const tenantPath = join(
    projectRoot,
    'policies',
    'tenant-applicability-policy.json',
  );
  const riskPolicy = RiskPolicySchema.parse(
    JSON.parse(readFileSync(riskPath, 'utf8')) as unknown,
  );
  const tenantApplicabilityPolicy = TenantApplicabilityPolicySchema.parse(
    JSON.parse(readFileSync(tenantPath, 'utf8')) as unknown,
  );
  return { riskPolicy, tenantApplicabilityPolicy };
}

function deriveDeterministicSnapshotNow(
  records: readonly NormalizedRoadmapRecord[],
): string {
  if (records.length === 0) {
    return '1970-01-01T00:00:00.000Z';
  }
  let maxMs = -Infinity;
  for (const record of records) {
    const ms = Date.parse(record.changeEvent.updatedAt);
    if (ms > maxMs) maxMs = ms;
  }
  return new Date(maxMs).toISOString();
}

function describeError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
        return `${path}: ${issue.message}`;
      })
      .join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Execute the `pnpm digest` command with injected I/O seams so tests can run
 * deterministically without touching live networks or repository files.
 */
export async function runDigestCommand(
  argv: readonly string[],
  io: DigestCommandIo = DEFAULT_IO,
): Promise<DigestCommandResult> {
  let parsedArgs: ParsedDigestCliArgs;
  try {
    parsedArgs = parseDigestCliArgs(argv);
  } catch (error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `${describeError(error)}\n\n${DIGEST_USAGE}`,
    };
  }

  if (parsedArgs.kind === 'help') {
    return {
      exitCode: 0,
      stdout: DIGEST_USAGE,
      stderr: '',
    };
  }

  const projectRoot = io.resolveProjectRoot();

  try {
    const { riskPolicy, tenantApplicabilityPolicy } = loadPolicies(projectRoot);
    const personas = loadPersonaProfiles(projectRoot, parsedArgs.profilesArg);

    let records: NormalizedRoadmapRecord[];
    let fetchedItemCount: number;
    let feedLocation: string;

    if (parsedArgs.mode === 'live') {
      const endpoint = parsedArgs.feedUrl ?? MICROSOFT_ROADMAP_JSON_API_URL;
      const fetched = await fetchMicrosoftRoadmapFeed({
        endpoint,
        ...(io.fetch !== undefined ? { fetch: io.fetch } : {}),
      });
      records = fetched.records;
      fetchedItemCount = fetched.fetchedItemCount;
      feedLocation = fetched.endpoint;
    } else {
      const inputPath = parsedArgs.inputPath;
      if (inputPath === undefined) {
        throw new Error('Missing --input path.');
      }
      const resolvedInput = resolve(projectRoot, inputPath);
      const rawContent = readFileSync(resolvedInput, 'utf8');
      const ext = extname(resolvedInput).toLowerCase();
      const formatHint =
        ext === '.xml' || ext === '.rss'
          ? 'rss'
          : ext === '.json'
            ? 'json'
            : 'auto';
      records = parseMicrosoftRoadmapFeed(rawContent, formatHint);
      fetchedItemCount = records.length;
      feedLocation = inputPath;
    }

    const referenceNow =
      parsedArgs.now ??
      (parsedArgs.mode === 'input'
        ? deriveDeterministicSnapshotNow(records)
        : io.now());

    const bundle: DigestBundle = await runDigestPipeline({
      records,
      fetchedItemCount,
      feedMode: parsedArgs.mode,
      feedLocation,
      personas,
      riskPolicy,
      tenantApplicabilityPolicy,
      now: referenceNow,
      days: parsedArgs.days,
      limit: parsedArgs.limit,
      ...(io.classifier !== undefined ? { classifier: io.classifier } : {}),
    });

    const markdownJa = renderDigestMarkdownJa(bundle);
    const zennArticleJa = renderZennArticleMarkdownJa(bundle);
    const outDir = resolve(projectRoot, parsedArgs.outDirArg);
    mkdirSync(outDir, { recursive: true });

    const bundlePath = join(outDir, 'digest-bundle.json');
    const markdownPath = join(outDir, 'digest-ja.md');
    const zennArticlePath = join(outDir, 'zenn-article-ja.md');

    writeFileSync(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
    writeFileSync(markdownPath, markdownJa, 'utf8');
    writeFileSync(zennArticlePath, zennArticleJa, 'utf8');

    const stdoutSummary = JSON.stringify({
      generatedAt: bundle.generatedAt,
      mode: bundle.feedSource.mode,
      fetchedItemCount: bundle.feedSource.fetchedItemCount,
      selectedItemCount: bundle.feedSource.selectedItemCount,
      sovereignCloudExcludedCount: bundle.summary.sovereignCloudExcludedCount,
      personaCount: bundle.summary.personaCount,
      pairCount: bundle.summary.pairCount,
      stateCounts: bundle.summary.stateCounts,
      actionCount: bundle.summary.actionCount,
      bundlePath,
      markdownPath,
      zennArticlePath,
    });

    return {
      exitCode: 0,
      stdout: `${stdoutSummary}\n`,
      stderr: '',
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `Digest command failed: ${describeError(error)}\n`,
    };
  }
}
