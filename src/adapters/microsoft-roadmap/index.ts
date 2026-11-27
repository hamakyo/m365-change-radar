export {
  MICROSOFT_ROADMAP_JSON_API_URL,
  MICROSOFT_ROADMAP_RSS_URL,
  MICROSOFT_ROADMAP_SOURCE,
  MicrosoftRoadmapWireItemSchema,
  assertUndefinedFree,
  deduplicateRoadmapRecords,
  fetchMicrosoftRoadmapFeed,
  normalizeMicrosoftRoadmapItem,
  normalizeRoadmapTimestamp,
  parseMicrosoftRoadmapFeed,
  parseMicrosoftRoadmapJsonPayload,
  parseMicrosoftRoadmapRssXml,
  type MicrosoftRoadmapFeedFormat,
  type MicrosoftRoadmapFetchOptions,
  type MicrosoftRoadmapFetchResult,
  type MicrosoftRoadmapWireItem,
  type NormalizedRoadmapRecord,
} from './adapter.js';
export {
  MICROSOFT_ROADMAP_PRODUCT_MAP,
  MICROSOFT_ROADMAP_RELEASE_PHASE_CATEGORY_MAP,
  MICROSOFT_ROADMAP_SOVEREIGN_CLOUD_PRODUCT_MAP,
  MICROSOFT_ROADMAP_STATUS_CATEGORY_MAP,
  MICROSOFT_ROADMAP_WORLDWIDE_CLOUD_INSTANCE,
  isSovereignCloudOnlyInstances,
  mapRoadmapCategories,
  mapRoadmapProducts,
  type MappedRoadmapCategories,
  type MappedRoadmapProducts,
} from './product-mapping.js';
export {
  parseRoadmapRssItems,
  type ParsedRssRoadmapWireItem,
} from './rss-parser.js';
export {
  decodeHtmlEntities,
  extractRoadmapSignals,
  stripRoadmapHtmlToText,
  type RoadmapSignalExtractionInput,
} from './signals.js';
export {
  computeRoadmapSourceMessageVersion,
  type RoadmapSourceVersionCanonicalInput,
} from './source-version.js';
