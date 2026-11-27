import { createHash } from 'node:crypto';

export type RoadmapSourceVersionCanonicalInput = {
  readonly source: string;
  readonly externalId: string;
  readonly publishedAt: string;
  readonly updatedAt: string;
  readonly title: string;
  readonly body: string;
  readonly status: string | null;
  readonly publicDisclosureAvailabilityDate: string | null;
  readonly publicPreviewDate: string | null;
  readonly moreInfoLink: string | null;
  readonly cloudInstances: readonly string[];
  readonly products: readonly string[];
  readonly categories: readonly string[];
};

/**
 * Derive an immutable, deterministic `sourceMessageVersion` from the canonical
 * normalized content, cloud scope, and timestamps of one Roadmap item. Any
 * upstream edit to timestamps, title, description, rollout status, availability
 * dates, link, cloud instances, or normalized product/category labels produces
 * a distinct version string.
 */
export function computeRoadmapSourceMessageVersion(
  input: RoadmapSourceVersionCanonicalInput,
): string {
  const canonicalPayload = JSON.stringify({
    source: input.source,
    externalId: input.externalId,
    publishedAt: input.publishedAt,
    updatedAt: input.updatedAt,
    title: input.title,
    body: input.body,
    status: input.status,
    publicDisclosureAvailabilityDate: input.publicDisclosureAvailabilityDate,
    publicPreviewDate: input.publicPreviewDate,
    moreInfoLink: input.moreInfoLink,
    cloudInstances: [...input.cloudInstances],
    products: [...input.products],
    categories: [...input.categories],
  });
  const digest = createHash('sha256')
    .update(canonicalPayload, 'utf8')
    .digest('hex')
    .slice(0, 16);
  return `roadmap-v1:${input.updatedAt}:${digest}`;
}
