import { z } from 'zod';

import {
  ChangeEventSchema,
  type ChangeEvent,
} from '../../domain/change-event.js';
import { JsonValueSchema, type JsonValue } from '../../domain/json-value.js';
import { mapRoadmapCategories, mapRoadmapProducts } from './product-mapping.js';
import { parseRoadmapRssItems } from './rss-parser.js';
import { extractRoadmapSignals, stripRoadmapHtmlToText } from './signals.js';
import { computeRoadmapSourceMessageVersion } from './source-version.js';

export const MICROSOFT_ROADMAP_SOURCE = 'microsoft-365-roadmap';
export const MICROSOFT_ROADMAP_JSON_API_URL =
  'https://www.microsoft.com/releasecommunications/api/v1/m365';
export const MICROSOFT_ROADMAP_RSS_URL =
  'https://www.microsoft.com/microsoft-365/RoadmapFeatureRSS';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 400;

const TagObjectSchema = z
  .object({
    tagName: z.string(),
  })
  .passthrough();

const TagsContainerSchema = z
  .object({
    products: z.array(TagObjectSchema).optional(),
    cloudInstances: z.array(TagObjectSchema).optional(),
    releasePhase: z.array(TagObjectSchema).optional(),
    platforms: z.array(TagObjectSchema).optional(),
  })
  .passthrough();

export const MicrosoftRoadmapWireItemSchema = z
  .object({
    id: z.union([z.number().int().nonnegative(), z.string().trim().min(1)]),
    title: z.string().trim().min(1),
    description: z.string().nullable().optional(),
    moreInfoLink: z.string().nullable().optional(),
    publicDisclosureAvailabilityDate: z.string().nullable().optional(),
    publicPreviewDate: z.string().nullable().optional(),
    created: z.string().trim().min(1),
    modified: z.string().trim().min(1),
    publicRoadmapStatus: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    locale: z.string().nullable().optional(),
    roadmapLink: z.string().nullable().optional(),
    tags: z.array(TagObjectSchema).optional(),
    tagsContainer: TagsContainerSchema.optional(),
  })
  .passthrough();

export type MicrosoftRoadmapWireItem = z.infer<
  typeof MicrosoftRoadmapWireItemSchema
>;

export type NormalizedRoadmapRecord = {
  readonly changeEvent: ChangeEvent;
  readonly sourceMessageVersion: string;
};

export type MicrosoftRoadmapFeedFormat = 'auto' | 'json' | 'rss';

export type MicrosoftRoadmapFetchOptions = {
  readonly endpoint?: string;
  readonly format?: MicrosoftRoadmapFeedFormat;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly retryDelayMs?: number;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
};

export type MicrosoftRoadmapFetchResult = {
  readonly endpoint: string;
  readonly format: 'json' | 'rss';
  readonly fetchedItemCount: number;
  readonly records: NormalizedRoadmapRecord[];
};

const OFFSETLESS_ISO_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?$/;

/**
 * Normalize Roadmap wire timestamps (`"2026-11-26T00:16:54"`, ISO 8601 with
 * offset, or RFC 2822 `<pubDate>`) into canonical UTC ISO 8601 strings with `Z`.
 */
export function normalizeRoadmapTimestamp(
  rawTimestamp: string,
  fieldName: string,
): string {
  const trimmed = rawTimestamp.trim();
  const candidate = OFFSETLESS_ISO_REGEX.test(trimmed)
    ? `${trimmed}Z`
    : trimmed;
  const parsedMs = Date.parse(candidate);
  if (Number.isNaN(parsedMs)) {
    throw new Error(
      `Invalid Microsoft 365 Roadmap ${fieldName} timestamp: "${rawTimestamp}"`,
    );
  }
  return new Date(parsedMs).toISOString();
}

function nonEmptyOrNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractTagNames(
  entries: ReadonlyArray<{ readonly tagName: string }> | undefined,
): string[] {
  if (entries === undefined) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const trimmed = entry.tagName.trim();
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}

/**
 * Verify recursively that no own property or array element holds `undefined`,
 * guaranteeing lossless JSON serialization across the engine boundary.
 */
export function assertUndefinedFree(value: unknown, path = '<root>'): void {
  if (value === undefined) {
    throw new Error(`Unexpected undefined value at ${path}`);
  }
  if (value === null || typeof value !== 'object') {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((element, index) => {
      assertUndefinedFree(element, `${path}[${index}]`);
    });
    return;
  }
  for (const key of Object.keys(value)) {
    const record = value as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      assertUndefinedFree(record[key], `${path}.${key}`);
    }
  }
}

/**
 * Normalize one raw Microsoft 365 Roadmap wire item into a source-neutral
 * `ChangeEvent` plus its immutable `sourceMessageVersion`.
 */
export function normalizeMicrosoftRoadmapItem(
  rawItem: unknown,
): NormalizedRoadmapRecord {
  const parsed = MicrosoftRoadmapWireItemSchema.parse(rawItem);
  const externalId = String(parsed.id).trim();
  const title = parsed.title.trim();
  const rawDescription = parsed.description ?? '';
  const body = stripRoadmapHtmlToText(rawDescription);

  const publishedAt = normalizeRoadmapTimestamp(parsed.created, 'created');
  const rawUpdatedAt = normalizeRoadmapTimestamp(parsed.modified, 'modified');
  const updatedAt =
    Date.parse(rawUpdatedAt) < Date.parse(publishedAt)
      ? publishedAt
      : rawUpdatedAt;

  const rawProducts = extractTagNames(parsed.tagsContainer?.products);
  const cloudInstances = extractTagNames(parsed.tagsContainer?.cloudInstances);
  const releasePhases = extractTagNames(parsed.tagsContainer?.releasePhase);
  const platforms = extractTagNames(parsed.tagsContainer?.platforms);
  const rawTags = extractTagNames(parsed.tags);

  const status = nonEmptyOrNull(parsed.status);
  const publicRoadmapStatus = nonEmptyOrNull(parsed.publicRoadmapStatus);
  const publicDisclosureAvailabilityDate = nonEmptyOrNull(
    parsed.publicDisclosureAvailabilityDate,
  );
  const publicPreviewDate = nonEmptyOrNull(parsed.publicPreviewDate);
  const moreInfoLink = nonEmptyOrNull(parsed.moreInfoLink);
  const roadmapUrl =
    nonEmptyOrNull(parsed.roadmapLink) ??
    `https://www.microsoft.com/microsoft-365/roadmap?id=${encodeURIComponent(externalId)}`;

  const signals = extractRoadmapSignals({
    title,
    body,
    rawProducts,
    rawTags,
  });

  const {
    products,
    normalizedWorkloads,
    unmappedProducts,
    sovereignCloudOnly,
  } = mapRoadmapProducts(rawProducts, cloudInstances);
  const { categories, unmappedCategories } = mapRoadmapCategories({
    status,
    releasePhases,
    signalTags: signals.tags ?? [],
    sovereignCloudOnly,
  });

  const sourceMetadataCandidate: JsonValue = JsonValueSchema.parse({
    roadmapId: externalId,
    roadmapUrl,
    status,
    publicRoadmapStatus,
    publicDisclosureAvailabilityDate,
    publicPreviewDate,
    moreInfoLink,
    cloudInstances,
    sovereignCloudOnly,
    releasePhases,
    platforms,
    rawProducts,
    normalizedWorkloads,
    unmappedProducts,
    unmappedCategories,
    rawTags,
  });

  const changeEventCandidate: ChangeEvent = {
    source: MICROSOFT_ROADMAP_SOURCE,
    externalId,
    title,
    body,
    publishedAt,
    updatedAt,
    products,
    categories,
    severity: null,
    signals,
    sourceMetadata: sourceMetadataCandidate,
  };

  assertUndefinedFree(changeEventCandidate);
  const changeEvent = ChangeEventSchema.parse(changeEventCandidate);

  const sourceMessageVersion = computeRoadmapSourceMessageVersion({
    source: changeEvent.source,
    externalId: changeEvent.externalId,
    publishedAt: changeEvent.publishedAt,
    updatedAt: changeEvent.updatedAt,
    title: changeEvent.title,
    body: changeEvent.body,
    status,
    publicDisclosureAvailabilityDate,
    publicPreviewDate,
    moreInfoLink,
    cloudInstances,
    products: changeEvent.products,
    categories: changeEvent.categories,
  });

  return {
    changeEvent,
    sourceMessageVersion,
  };
}

/**
 * Deduplicate normalized records by `externalId`, retaining the newest
 * `updatedAt` (and breaking ties by deterministic `sourceMessageVersion`),
 * sorted by `updatedAt` descending then `externalId` ascending.
 */
export function deduplicateRoadmapRecords(
  records: readonly NormalizedRoadmapRecord[],
): NormalizedRoadmapRecord[] {
  const byId = new Map<string, NormalizedRoadmapRecord>();
  for (const record of records) {
    const existing = byId.get(record.changeEvent.externalId);
    if (existing === undefined) {
      byId.set(record.changeEvent.externalId, record);
      continue;
    }
    const existingMs = Date.parse(existing.changeEvent.updatedAt);
    const candidateMs = Date.parse(record.changeEvent.updatedAt);
    if (
      candidateMs > existingMs ||
      (candidateMs === existingMs &&
        record.sourceMessageVersion > existing.sourceMessageVersion)
    ) {
      byId.set(record.changeEvent.externalId, record);
    }
  }

  return [...byId.values()].sort((a, b) => {
    const diff =
      Date.parse(b.changeEvent.updatedAt) - Date.parse(a.changeEvent.updatedAt);
    if (diff !== 0) return diff;
    return a.changeEvent.externalId.localeCompare(b.changeEvent.externalId);
  });
}

const ODataEnvelopeSchema = z
  .object({
    value: z.array(z.unknown()),
  })
  .passthrough();

/**
 * Parse and normalize a Microsoft 365 Roadmap JSON API payload (either a raw
 * JSON string or an already-parsed JavaScript value).
 */
export function parseMicrosoftRoadmapJsonPayload(
  payload: string | unknown,
): NormalizedRoadmapRecord[] {
  let rawValue: unknown = payload;
  if (typeof payload === 'string') {
    try {
      rawValue = JSON.parse(payload) as unknown;
    } catch (error) {
      throw new Error(
        `Invalid Microsoft 365 Roadmap JSON payload: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  let rawItems: unknown[];
  if (Array.isArray(rawValue)) {
    rawItems = rawValue;
  } else {
    const odata = ODataEnvelopeSchema.safeParse(rawValue);
    if (odata.success) {
      rawItems = odata.data.value;
    } else {
      throw new Error(
        'Invalid Microsoft 365 Roadmap JSON payload: expected an array of roadmap items or an object with a "value" array.',
      );
    }
  }

  return rawItems.map((item, index) => {
    try {
      return normalizeMicrosoftRoadmapItem(item);
    } catch (error) {
      throw new Error(
        `Invalid Microsoft 365 Roadmap item at index ${index}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  });
}

/**
 * Parse and normalize a Microsoft 365 Roadmap RSS 2.0 XML document.
 */
export function parseMicrosoftRoadmapRssXml(
  xmlText: string,
): NormalizedRoadmapRecord[] {
  const wireItems = parseRoadmapRssItems(xmlText);
  return wireItems.map((item, index) => {
    try {
      return normalizeMicrosoftRoadmapItem(item);
    } catch (error) {
      throw new Error(
        `Invalid Microsoft 365 Roadmap RSS item at index ${index}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  });
}

function detectFeedFormat(
  content: string,
  hint: MicrosoftRoadmapFeedFormat,
): 'json' | 'rss' {
  if (hint === 'json' || hint === 'rss') return hint;
  const trimmed = content.trimStart();
  if (trimmed.startsWith('<')) return 'rss';
  return 'json';
}

/**
 * Parse either JSON or RSS XML Roadmap content into normalized records.
 */
export function parseMicrosoftRoadmapFeed(
  content: string,
  format: MicrosoftRoadmapFeedFormat = 'auto',
): NormalizedRoadmapRecord[] {
  const detected = detectFeedFormat(content, format);
  return detected === 'rss'
    ? parseMicrosoftRoadmapRssXml(content)
    : parseMicrosoftRoadmapJsonPayload(content);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch the public, unauthenticated Microsoft 365 Roadmap feed over HTTPS
 * with bounded timeout, transient retry handling, and schema validation.
 */
export async function fetchMicrosoftRoadmapFeed(
  options: MicrosoftRoadmapFetchOptions = {},
): Promise<MicrosoftRoadmapFetchResult> {
  const endpoint = z
    .url()
    .parse(options.endpoint ?? MICROSOFT_ROADMAP_JSON_API_URL);
  const formatHint = options.format ?? 'auto';
  const timeoutMs = z
    .number()
    .int()
    .positive()
    .parse(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxRetries = z
    .number()
    .int()
    .min(0)
    .max(5)
    .parse(options.maxRetries ?? DEFAULT_MAX_RETRIES);
  const retryDelayMs = z
    .number()
    .int()
    .min(0)
    .parse(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const sleepImpl = options.sleep ?? defaultSleep;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (attempt > 0 && retryDelayMs > 0) {
      await sleepImpl(retryDelayMs * 2 ** (attempt - 1));
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: 'GET',
        headers: {
          Accept:
            'application/json, application/rss+xml, application/xml, text/xml;q=0.9',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const statusError = new Error(
          `Microsoft 365 Roadmap request to ${endpoint} failed with HTTP ${response.status}`,
        );
        if (attempt < maxRetries && isRetryableStatus(response.status)) {
          lastError = statusError;
          continue;
        }
        throw statusError;
      }

      const bodyText = await response.text();
      const contentType = response.headers.get('content-type') ?? '';
      const resolvedFormat: 'json' | 'rss' =
        formatHint !== 'auto'
          ? formatHint
          : contentType.includes('xml') || bodyText.trimStart().startsWith('<')
            ? 'rss'
            : 'json';

      const parsedRecords =
        resolvedFormat === 'rss'
          ? parseMicrosoftRoadmapRssXml(bodyText)
          : parseMicrosoftRoadmapJsonPayload(bodyText);

      return {
        endpoint,
        format: resolvedFormat,
        fetchedItemCount: parsedRecords.length,
        records: deduplicateRoadmapRecords(parsedRecords),
      };
    } catch (error) {
      const normalizedError =
        error instanceof Error && error.name === 'AbortError'
          ? new Error(
              `Microsoft 365 Roadmap request to ${endpoint} timed out after ${timeoutMs}ms`,
              { cause: error },
            )
          : error instanceof Error
            ? error
            : new Error(String(error));

      const isNonRetryableValidationOrHttp =
        normalizedError.message.startsWith('Invalid Microsoft 365 Roadmap') ||
        (normalizedError.message.includes('failed with HTTP ') &&
          !/HTTP (?:408|429|5\d\d)\b/.test(normalizedError.message));

      if (attempt < maxRetries && !isNonRetryableValidationOrHttp) {
        lastError = normalizedError;
        continue;
      }
      throw normalizedError;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  throw (
    lastError ??
    new Error(`Microsoft 365 Roadmap request to ${endpoint} failed`)
  );
}
