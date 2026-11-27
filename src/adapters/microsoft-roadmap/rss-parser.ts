import {
  MICROSOFT_ROADMAP_RELEASE_PHASE_CATEGORY_MAP,
  MICROSOFT_ROADMAP_STATUS_CATEGORY_MAP,
} from './product-mapping.js';
import { decodeHtmlEntities } from './signals.js';

const KNOWN_CLOUD_INSTANCES = new Set([
  'Worldwide (Standard Multi-Tenant)',
  'GCC',
  'GCC High',
  'DoD',
  'China (21Vianet)',
  'Microsoft Cloud operated by 21Vianet',
  'Microsoft Cloud for China',
  '21Vianet',
]);

const KNOWN_PLATFORMS = new Set([
  'Web',
  'Desktop',
  'Mac',
  'Android',
  'iOS',
  'Teams and Surface Devices',
  'Mobile',
  'Developer',
  'Linux',
]);

export type ParsedRssRoadmapWireItem = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly moreInfoLink: string | null;
  readonly publicDisclosureAvailabilityDate: string | null;
  readonly publicPreviewDate: string | null;
  readonly created: string;
  readonly modified: string;
  readonly status: string | null;
  readonly roadmapLink: string | null;
  readonly tags: ReadonlyArray<{ readonly tagName: string }>;
  readonly tagsContainer: {
    readonly products: ReadonlyArray<{ readonly tagName: string }>;
    readonly cloudInstances: ReadonlyArray<{ readonly tagName: string }>;
    readonly releasePhase: ReadonlyArray<{ readonly tagName: string }>;
    readonly platforms: ReadonlyArray<{ readonly tagName: string }>;
  };
};

function unwrapXmlText(raw: string): string {
  const trimmed = raw.trim();
  const cdataMatch = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(trimmed);
  if (cdataMatch?.[1] !== undefined) {
    return cdataMatch[1].trim();
  }
  return decodeHtmlEntities(trimmed);
}

function extractFirstTag(itemXml: string, tagName: string): string | null {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(
    `<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`,
    'i',
  );
  const match = regex.exec(itemXml);
  if (match?.[1] === undefined) return null;
  return unwrapXmlText(match[1]);
}

function extractAllTags(itemXml: string, tagName: string): string[] {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(
    `<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`,
    'gi',
  );
  const results: string[] = [];
  let match = regex.exec(itemXml);
  while (match !== null) {
    if (match[1] !== undefined) {
      const value = unwrapXmlText(match[1]);
      if (value.length > 0) {
        results.push(value);
      }
    }
    match = regex.exec(itemXml);
  }
  return results;
}

function extractAvailabilitySuffixes(descriptionHtml: string): {
  readonly cleanedDescriptionHtml: string;
  readonly gaDate: string | null;
  readonly previewDate: string | null;
} {
  let cleaned = descriptionHtml;
  let gaDate: string | null = null;
  let previewDate: string | null = null;

  const previewMatch =
    /(?:\s*<br\s*\/?>\s*)?Preview date:\s*([^<\r\n]+)\s*$/i.exec(cleaned);
  if (previewMatch?.[1] !== undefined) {
    previewDate = previewMatch[1].trim() || null;
    cleaned = cleaned.slice(0, previewMatch.index);
  }

  const gaMatch = /(?:\s*<br\s*\/?>\s*)?GA date:\s*([^<\r\n]+)\s*$/i.exec(
    cleaned,
  );
  if (gaMatch?.[1] !== undefined) {
    gaDate = gaMatch[1].trim() || null;
    cleaned = cleaned.slice(0, gaMatch.index);
  }

  return {
    cleanedDescriptionHtml: cleaned.trim(),
    gaDate,
    previewDate,
  };
}

/**
 * Parse a Microsoft 365 Roadmap RSS 2.0 XML document (`RoadmapFeatureRSS`)
 * into structured wire items compatible with `normalizeMicrosoftRoadmapItem`.
 */
export function parseRoadmapRssItems(
  xmlText: string,
): ParsedRssRoadmapWireItem[] {
  const trimmed = xmlText.trim();
  if (!trimmed.includes('<rss') && !trimmed.includes('<channel>')) {
    throw new Error(
      'Invalid Microsoft 365 Roadmap RSS XML: missing <rss> or <channel> root element.',
    );
  }

  const itemRegex = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
  const items: ParsedRssRoadmapWireItem[] = [];
  let match = itemRegex.exec(trimmed);
  let index = 0;

  while (match !== null) {
    const itemXml = match[1] ?? '';
    const guid = extractFirstTag(itemXml, 'guid');
    const link = extractFirstTag(itemXml, 'link');
    const title = extractFirstTag(itemXml, 'title');
    const rawDescription = extractFirstTag(itemXml, 'description') ?? '';
    const pubDate = extractFirstTag(itemXml, 'pubDate');
    const updated =
      extractFirstTag(itemXml, 'a10:updated') ??
      extractFirstTag(itemXml, 'updated') ??
      pubDate;

    const idFromLink =
      link !== null ? (/[?&]id=(\d+)/i.exec(link)?.[1] ?? null) : null;
    const id = guid ?? idFromLink;
    if (id === null || id.length === 0) {
      throw new Error(
        `Invalid Microsoft 365 Roadmap RSS <item> at index ${index}: missing <guid> or roadmap ID.`,
      );
    }
    if (title === null || title.length === 0) {
      throw new Error(
        `Invalid Microsoft 365 Roadmap RSS <item> (${id}): missing <title>.`,
      );
    }
    if (pubDate === null || updated === null) {
      throw new Error(
        `Invalid Microsoft 365 Roadmap RSS <item> (${id}): missing <pubDate> or <a10:updated>.`,
      );
    }

    const categories = extractAllTags(itemXml, 'category');
    let status: string | null = null;
    const products: Array<{ readonly tagName: string }> = [];
    const cloudInstances: Array<{ readonly tagName: string }> = [];
    const releasePhase: Array<{ readonly tagName: string }> = [];
    const platforms: Array<{ readonly tagName: string }> = [];

    for (const category of categories) {
      if (
        status === null &&
        MICROSOFT_ROADMAP_STATUS_CATEGORY_MAP[category] !== undefined
      ) {
        status = category;
      } else if (
        MICROSOFT_ROADMAP_RELEASE_PHASE_CATEGORY_MAP[category] !== undefined
      ) {
        releasePhase.push({ tagName: category });
      } else if (KNOWN_CLOUD_INSTANCES.has(category)) {
        cloudInstances.push({ tagName: category });
      } else if (KNOWN_PLATFORMS.has(category)) {
        platforms.push({ tagName: category });
      } else {
        products.push({ tagName: category });
      }
    }

    const { cleanedDescriptionHtml, gaDate, previewDate } =
      extractAvailabilitySuffixes(rawDescription);

    items.push({
      id,
      title,
      description: cleanedDescriptionHtml,
      moreInfoLink: null,
      publicDisclosureAvailabilityDate: gaDate,
      publicPreviewDate: previewDate,
      created: pubDate,
      modified: updated,
      status,
      roadmapLink: link,
      tags: categories.map((tagName) => ({ tagName })),
      tagsContainer: {
        products,
        cloudInstances,
        releasePhase,
        platforms,
      },
    });

    index += 1;
    match = itemRegex.exec(trimmed);
  }

  return items;
}
