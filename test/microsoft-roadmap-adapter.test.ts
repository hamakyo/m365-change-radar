import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ChangeEventSchema,
  MICROSOFT_ROADMAP_JSON_API_URL,
  MICROSOFT_ROADMAP_SOURCE,
  assertUndefinedFree,
  deduplicateRoadmapRecords,
  fetchMicrosoftRoadmapFeed,
  normalizeMicrosoftRoadmapItem,
  parseMicrosoftRoadmapFeed,
  parseMicrosoftRoadmapJsonPayload,
  parseMicrosoftRoadmapRssXml,
} from '../src/index.js';

const projectRoot = resolve(process.cwd());
const snapshotJsonText = readFileSync(
  join(projectRoot, 'test', 'fixtures', 'microsoft-roadmap-snapshot.json'),
  'utf8',
);
const snapshotRssText = readFileSync(
  join(projectRoot, 'test', 'fixtures', 'microsoft-roadmap-rss.xml'),
  'utf8',
);

describe('MicrosoftRoadmapAdapter normalization and schema invariants', () => {
  it('normalizes every fixture JSON item into a schema-valid, undefined-free ChangeEvent', () => {
    const records = parseMicrosoftRoadmapJsonPayload(snapshotJsonText);
    expect(records).toHaveLength(11);

    for (const record of records) {
      expect(record.changeEvent.source).toBe(MICROSOFT_ROADMAP_SOURCE);
      expect(record.sourceMessageVersion).toMatch(
        /^roadmap-v1:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z:[0-9a-f]{16}$/,
      );
      assertUndefinedFree(record);
      const roundTripped = JSON.parse(JSON.stringify(record)) as unknown;
      expect(roundTripped).toEqual(record);
      expect(ChangeEventSchema.parse(record.changeEvent)).toEqual(
        record.changeEvent,
      );
    }
  });

  it('accepts OData { value: [...] } JSON envelopes identically to top-level arrays', () => {
    const rawArray = JSON.parse(snapshotJsonText) as unknown[];
    const fromArray = parseMicrosoftRoadmapJsonPayload(rawArray);
    const fromOData = parseMicrosoftRoadmapJsonPayload({
      '@odata.context':
        'https://www.microsoft.com/releasecommunications/api/v1/$metadata',
      value: rawArray,
    });
    expect(fromOData).toEqual(fromArray);
  });

  it('preserves unmapped product tags verbatim in products and sourceMetadata.unmappedProducts', () => {
    const records = parseMicrosoftRoadmapJsonPayload(snapshotJsonText);
    const workIq = records.find(
      (record) => record.changeEvent.externalId === '570869',
    );
    expect(workIq).toBeDefined();
    expect(workIq?.changeEvent.products).toEqual(['Work IQ']);
    const meta = workIq?.changeEvent.sourceMetadata as Record<string, unknown>;
    expect(meta.rawProducts).toEqual(['Work IQ']);
    expect(meta.unmappedProducts).toEqual(['Work IQ']);
    expect(meta.sovereignCloudOnly).toBe(false);
  });

  it('normalizes sovereign-cloud-only (GCC/GCC High/DoD/China) vs dual Worldwide+GCC vs empty cloudInstances accurately', () => {
    const records = parseMicrosoftRoadmapJsonPayload(snapshotJsonText);
    const byId = new Map(
      records.map((record) => [
        record.changeEvent.externalId,
        record.changeEvent,
      ]),
    );

    // GCC / GCC High / DoD only -> sovereign cloud product selectors + sovereign-cloud-only category
    const govPurview = byId.get('529852');
    expect(govPurview?.products).toEqual([
      'Microsoft Cloud GCC',
      'Microsoft Cloud GCC High',
      'Microsoft Cloud DoD',
    ]);
    expect(govPurview?.categories).toContain('sovereign-cloud-only');
    expect(govPurview?.signals?.hasComplianceImpact).toBe(true);
    const govMeta = govPurview?.sourceMetadata as Record<string, unknown>;
    expect(govMeta.sovereignCloudOnly).toBe(true);
    expect(govMeta.normalizedWorkloads).toEqual(['Microsoft Purview']);

    // Dual Worldwide + GCC -> normal workload products (NOT sovereign-cloud-only)
    const dualTeams = byId.get('580451');
    expect(dualTeams?.products).toEqual(['Microsoft Teams']);
    expect(dualTeams?.categories).not.toContain('sovereign-cloud-only');
    const dualMeta = dualTeams?.sourceMetadata as Record<string, unknown>;
    expect(dualMeta.sovereignCloudOnly).toBe(false);

    // China (21Vianet) only -> Microsoft Cloud China (21Vianet)
    const chinaOnly = normalizeMicrosoftRoadmapItem({
      id: 910001,
      title: 'Microsoft Teams: Meeting recording storage in China cloud',
      description: '<p>Available for China cloud tenants.</p>',
      created: '2026-11-20T00:00:00',
      modified: '2026-11-25T00:00:00',
      status: 'In development',
      tagsContainer: {
        products: [{ tagName: 'Microsoft Teams' }],
        cloudInstances: [{ tagName: 'China (21Vianet)' }],
      },
    });
    expect(chinaOnly.changeEvent.products).toEqual([
      'Microsoft Cloud China (21Vianet)',
    ]);

    // Empty/missing cloudInstances -> conservative normal workload evaluation
    const emptyClouds = normalizeMicrosoftRoadmapItem({
      id: 910002,
      title: 'Microsoft Purview: Sensitivity label policy update',
      description: '<p>Admins can configure sensitivity label policies.</p>',
      created: '2026-11-20T00:00:00',
      modified: '2026-11-25T00:00:00',
      status: 'In development',
      tagsContainer: {
        products: [{ tagName: 'Microsoft Purview' }],
        cloudInstances: [],
      },
    });
    expect(emptyClouds.changeEvent.products).toEqual(['Microsoft Purview']);
    expect(
      (emptyClouds.changeEvent.sourceMetadata as Record<string, unknown>)
        .sovereignCloudOnly,
    ).toBe(false);
  });

  it('extracts conservative deterministic signals and guards against negated admin phrases', () => {
    const records = parseMicrosoftRoadmapJsonPayload(snapshotJsonText);
    const byId = new Map(
      records.map((record) => [
        record.changeEvent.externalId,
        record.changeEvent,
      ]),
    );

    const defender = byId.get('184915');
    expect(defender?.severity).toBeNull();
    expect(defender?.signals).toEqual({
      isMajorChange: false,
      actionRequiredBy: null,
      hasAdminImpact: true,
      isRetirementOrDeprecation: false,
      hasSecurityImpact: true,
      hasPrivacyImpact: false,
      hasComplianceImpact: false,
      tags: ['admin-impact', 'security'],
    });

    const purviewLabel = byId.get('581739');
    expect(purviewLabel?.signals?.hasComplianceImpact).toBe(true);
    expect(purviewLabel?.signals?.hasAdminImpact).toBe(true);
    expect(purviewLabel?.signals?.tags).toEqual(['admin-impact', 'compliance']);

    const ewsDeprecate = byId.get('573701');
    expect(ewsDeprecate?.signals?.isRetirementOrDeprecation).toBe(true);
    expect(ewsDeprecate?.signals?.tags).toContain('deprecation');

    const teamsPages = byId.get('580886');
    expect(teamsPages?.signals?.hasAdminImpact).toBe(false);
    expect(teamsPages?.signals?.tags).toEqual([]);
  });

  it('produces distinct immutable sourceMessageVersion values on any upstream field or cloudInstance change', () => {
    const rawItems = JSON.parse(snapshotJsonText) as Array<
      Record<string, unknown>
    >;
    const baseRaw = rawItems[0];
    if (baseRaw === undefined) {
      throw new Error('Expected at least one fixture item');
    }

    const base = normalizeMicrosoftRoadmapItem(baseRaw);
    const repeat = normalizeMicrosoftRoadmapItem({ ...baseRaw });
    expect(repeat.sourceMessageVersion).toBe(base.sourceMessageVersion);

    const modifiedTimestamp = normalizeMicrosoftRoadmapItem({
      ...baseRaw,
      modified: '2026-11-26T05:00:00',
    });
    expect(modifiedTimestamp.sourceMessageVersion).not.toBe(
      base.sourceMessageVersion,
    );

    const modifiedCloudScope = normalizeMicrosoftRoadmapItem({
      ...baseRaw,
      tagsContainer: {
        products: [{ tagName: 'Microsoft Defender for Office 365' }],
        cloudInstances: [{ tagName: 'GCC' }],
      },
    });
    expect(modifiedCloudScope.sourceMessageVersion).not.toBe(
      base.sourceMessageVersion,
    );
  });

  it('parses RSS 2.0 XML items cleanly and auto-detects JSON vs RSS formats', () => {
    const rssRecords = parseMicrosoftRoadmapRssXml(snapshotRssText);
    expect(rssRecords).toHaveLength(2);
    expect(parseMicrosoftRoadmapFeed(snapshotRssText, 'auto')).toEqual(
      rssRecords,
    );
    expect(parseMicrosoftRoadmapFeed(snapshotJsonText, 'auto')).toHaveLength(
      11,
    );

    const teamsRss = rssRecords.find(
      (record) => record.changeEvent.externalId === '580451',
    );
    expect(teamsRss?.changeEvent.products).toEqual(['Microsoft Teams']);
    expect(teamsRss?.changeEvent.signals?.hasAdminImpact).toBe(true);
    const meta = teamsRss?.changeEvent.sourceMetadata as Record<
      string,
      unknown
    >;
    expect(meta.publicDisclosureAvailabilityDate).toBe('January CY2027');
    expect(meta.status).toBe('In development');
    expect(teamsRss?.changeEvent.body).not.toContain('<p>');
    expect(teamsRss?.changeEvent.body).not.toContain('GA date:');
  });

  it('deduplicates records by externalId keeping the latest updatedAt', () => {
    const rawItems = JSON.parse(snapshotJsonText) as Array<
      Record<string, unknown>
    >;
    const first = rawItems[0];
    if (first === undefined) throw new Error('Missing fixture');
    const older = normalizeMicrosoftRoadmapItem({
      ...first,
      modified: '2026-11-01T00:00:00',
    });
    const newer = normalizeMicrosoftRoadmapItem({
      ...first,
      modified: '2026-11-26T00:00:00',
    });
    const deduped = deduplicateRoadmapRecords([older, newer]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.sourceMessageVersion).toBe(newer.sourceMessageVersion);
  });
});

describe('fetchMicrosoftRoadmapFeed HTTP resilience and diagnostics', () => {
  it('retries transient HTTP 503 responses and succeeds without real sleep delay', async () => {
    let attempts = 0;
    const sleepCalls: number[] = [];
    const mockFetch: typeof fetch = async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response('Service Unavailable', { status: 503 });
      }
      return new Response(snapshotJsonText, {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    };

    const result = await fetchMicrosoftRoadmapFeed({
      fetch: mockFetch,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      maxRetries: 2,
      retryDelayMs: 100,
    });

    expect(attempts).toBe(2);
    expect(sleepCalls).toEqual([100]);
    expect(result.endpoint).toBe(MICROSOFT_ROADMAP_JSON_API_URL);
    expect(result.format).toBe('json');
    expect(result.records).toHaveLength(11);
  });

  it('does not retry non-retryable HTTP 404 responses', async () => {
    let attempts = 0;
    const mockFetch: typeof fetch = async () => {
      attempts += 1;
      return new Response('Not Found', { status: 404 });
    };

    await expect(
      fetchMicrosoftRoadmapFeed({
        fetch: mockFetch,
        sleep: async () => {},
        maxRetries: 2,
      }),
    ).rejects.toThrow(/HTTP 404/);
    expect(attempts).toBe(1);
  });

  it('surfaces a clear diagnostic on request timeout (AbortError)', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    const mockFetch: typeof fetch = async () => {
      throw abortError;
    };

    await expect(
      fetchMicrosoftRoadmapFeed({
        fetch: mockFetch,
        sleep: async () => {},
        timeoutMs: 250,
        maxRetries: 1,
      }),
    ).rejects.toThrow(/timed out after 250ms/);
  });
});
