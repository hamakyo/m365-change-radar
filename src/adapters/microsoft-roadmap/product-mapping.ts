/**
 * Canonical product, cloud-instance, and category normalization tables for the
 * public Microsoft 365 Roadmap feed (`https://www.microsoft.com/releasecommunications/api/v1/m365`
 * and `https://www.microsoft.com/microsoft-365/RoadmapFeatureRSS`).
 *
 * Mapped product and sovereign-cloud labels align 1-to-1 with
 * `policies/tenant-applicability-policy.json` exact-match `products` selectors.
 *
 * Cloud-instance normalization rules:
 * - When `cloudInstances` is empty (unspecified) OR includes
 *   `"Worldwide (Standard Multi-Tenant)"` (including dual `Worldwide + GCC`
 *   rollouts), `ChangeEvent.products` carries the normalized workload labels so
 *   standard service applicability runs unchanged (`Unknown != Not Applicable`).
 * - When `cloudInstances` is non-empty and omits
 *   `"Worldwide (Standard Multi-Tenant)"` (for example, `["GCC", "GCC High", "DoD"]`
 *   or `["China (21Vianet)"]`), `ChangeEvent.products` carries the normalized
 *   sovereign-cloud partition selectors (`"Microsoft Cloud GCC"`, etc.) so a
 *   commercial `Worldwide` tenant (`environment.cloud_gcc = false`, ...) resolves
 *   deterministically to `NOT_APPLICABLE`, while a profile omitting those keys
 *   resolves to `INSUFFICIENT_CONTEXT`.
 */
export const MICROSOFT_ROADMAP_WORLDWIDE_CLOUD_INSTANCE =
  'Worldwide (Standard Multi-Tenant)';

export const MICROSOFT_ROADMAP_SOVEREIGN_CLOUD_PRODUCT_MAP: Readonly<
  Record<string, string>
> = {
  GCC: 'Microsoft Cloud GCC',
  'GCC High': 'Microsoft Cloud GCC High',
  DoD: 'Microsoft Cloud DoD',
  'China (21Vianet)': 'Microsoft Cloud China (21Vianet)',
  'Microsoft Cloud operated by 21Vianet': 'Microsoft Cloud China (21Vianet)',
  'Microsoft Cloud for China': 'Microsoft Cloud China (21Vianet)',
  '21Vianet': 'Microsoft Cloud China (21Vianet)',
};

export const MICROSOFT_ROADMAP_PRODUCT_MAP: Readonly<Record<string, string>> = {
  // Collaboration & Messaging
  'Microsoft Teams': 'Microsoft Teams',
  Teams: 'Microsoft Teams',
  Exchange: 'Exchange Online',
  'Exchange Online': 'Exchange Online',
  Outlook: 'Outlook',
  SharePoint: 'SharePoint Online',
  'SharePoint Online': 'SharePoint Online',
  OneDrive: 'OneDrive',
  'OneDrive for Business': 'OneDrive',

  // Endpoint, Identity, Security & Compliance
  'Microsoft Intune': 'Microsoft Intune',
  'Microsoft Entra': 'Microsoft Entra ID',
  'Microsoft Entra ID': 'Microsoft Entra ID',
  'Azure Active Directory': 'Microsoft Entra ID',
  'Microsoft Defender for Office 365': 'Microsoft Defender for Office 365',
  'Microsoft 365 Defender': 'Microsoft Defender',
  'Microsoft Defender': 'Microsoft Defender',
  'Microsoft Defender for Endpoint': 'Microsoft Defender',
  'Microsoft Purview': 'Microsoft Purview',
  'Microsoft Information Protection': 'Microsoft Purview',

  // Low-Code, Copilot & Employee Experience
  'Power Apps': 'Microsoft Power Platform',
  'Power Automate': 'Microsoft Power Platform',
  'Power Pages': 'Microsoft Power Platform',
  'Microsoft Dataverse': 'Microsoft Power Platform',
  'Microsoft Power Platform governance and administration':
    'Microsoft Power Platform',
  'Microsoft Copilot Studio': 'Microsoft Power Platform',
  'Microsoft Viva': 'Microsoft Viva',
  'Microsoft Copilot (Microsoft 365)': 'Microsoft 365 Copilot',

  // Microsoft 365 Core Suite, Admin & Desktop Apps
  'Microsoft 365': 'Microsoft 365',
  'Microsoft 365 admin center': 'Microsoft 365',
  'Microsoft 365 Admin Center': 'Microsoft 365',
  Planner: 'Microsoft 365',
  Forms: 'Microsoft 365',
  Whiteboard: 'Microsoft 365',
  'Microsoft To Do': 'Microsoft 365',
  'Microsoft Clipchamp': 'Microsoft 365',
  'Microsoft 365 app': 'Microsoft 365 Apps',
  Word: 'Microsoft 365 Apps',
  Excel: 'Microsoft 365 Apps',
  PowerPoint: 'Microsoft 365 Apps',
  OneNote: 'Microsoft 365 Apps',
  Access: 'Microsoft 365 Apps',
  Visio: 'Microsoft 365 Apps',
  'Microsoft Project': 'Microsoft 365 Apps',

  // Media, Browser & OS
  'Microsoft Stream': 'Microsoft Stream',
  'Microsoft Edge': 'Microsoft Edge',
  Windows: 'Windows',
  'Windows 365': 'Windows 365',

  // Dynamics 365 family (mapped so M365-only tenants with services.dynamics_365=false
  // deterministically resolve non-security ERP items as NOT_APPLICABLE)
  'Dynamics 365 Business Central': 'Dynamics 365',
  'Dynamics 365 Commerce': 'Dynamics 365',
  'Dynamics 365 Contact Center': 'Dynamics 365',
  'Dynamics 365 Customer Insights - Data': 'Dynamics 365',
  'Dynamics 365 Customer Insights - Journeys': 'Dynamics 365',
  'Dynamics 365 Customer Service': 'Dynamics 365',
  'Dynamics 365 Field Service': 'Dynamics 365',
  'Dynamics 365 Finance': 'Dynamics 365',
  'Dynamics 365 Finance and Operations cross-app': 'Dynamics 365',
  'Dynamics 365 Human Resources': 'Dynamics 365',
  'Dynamics 365 Project Operations': 'Dynamics 365',
  'Dynamics 365 Sales': 'Dynamics 365',
  'Dynamics 365 Supply Chain Management': 'Dynamics 365',
  'Dynamics 365 Sustainability': 'Dynamics 365',
};

export const MICROSOFT_ROADMAP_STATUS_CATEGORY_MAP: Readonly<
  Record<string, string>
> = {
  'In development': 'in-development',
  'Rolling out': 'rolling-out',
  Launched: 'launched',
  Cancelled: 'cancelled',
};

export const MICROSOFT_ROADMAP_RELEASE_PHASE_CATEGORY_MAP: Readonly<
  Record<string, string>
> = {
  'General Availability': 'general-availability',
  Preview: 'preview',
  'Targeted Release': 'targeted-release',
  'Targeted Release (Entire Organization)': 'targeted-release',
  'Targeted Release (Select People)': 'targeted-release',
  'Current Channel': 'current-channel',
};

export type MappedRoadmapProducts = {
  readonly products: string[];
  readonly normalizedWorkloads: string[];
  readonly unmappedProducts: string[];
  readonly sovereignCloudOnly: boolean;
};

export type MappedRoadmapCategories = {
  readonly categories: string[];
  readonly unmappedCategories: string[];
};

function pushUnique(target: string[], seen: Set<string>, value: string): void {
  if (!seen.has(value)) {
    seen.add(value);
    target.push(value);
  }
}

/**
 * Determine whether non-empty `cloudInstances` target exclusively non-Worldwide
 * sovereign clouds (`GCC`, `GCC High`, `DoD`, `China (21Vianet)`, etc.).
 * Empty `cloudInstances` returns `false` so unspecified cloud scope is never
 * misclassified as confirmed non-applicability.
 */
export function isSovereignCloudOnlyInstances(
  cloudInstances: readonly string[],
): boolean {
  const nonEmpty = cloudInstances
    .map((instance) => instance.trim())
    .filter((instance) => instance.length > 0);
  if (nonEmpty.length === 0) return false;
  return !nonEmpty.includes(MICROSOFT_ROADMAP_WORLDWIDE_CLOUD_INSTANCE);
}

/**
 * Normalize raw Roadmap product tag names and cloud instances in
 * first-occurrence order while preserving unmapped labels verbatim so
 * downstream mapping-gap detection (`missingMappings`) remains lossless.
 */
export function mapRoadmapProducts(
  rawProducts: readonly string[],
  cloudInstances: readonly string[] = [],
): MappedRoadmapProducts {
  const normalizedWorkloads: string[] = [];
  const seenWorkloads = new Set<string>();
  const unmappedProducts: string[] = [];
  const seenUnmapped = new Set<string>();

  for (const raw of rawProducts) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    const mapped = MICROSOFT_ROADMAP_PRODUCT_MAP[trimmed];
    if (mapped !== undefined) {
      pushUnique(normalizedWorkloads, seenWorkloads, mapped);
    } else {
      pushUnique(normalizedWorkloads, seenWorkloads, trimmed);
      pushUnique(unmappedProducts, seenUnmapped, trimmed);
    }
  }

  const sovereignCloudOnly = isSovereignCloudOnlyInstances(cloudInstances);
  if (!sovereignCloudOnly) {
    return {
      products: [...normalizedWorkloads],
      normalizedWorkloads,
      unmappedProducts,
      sovereignCloudOnly: false,
    };
  }

  const sovereignProducts: string[] = [];
  const seenSovereign = new Set<string>();
  for (const rawCloud of cloudInstances) {
    const trimmedCloud = rawCloud.trim();
    if (trimmedCloud.length === 0) continue;
    const mappedCloud =
      MICROSOFT_ROADMAP_SOVEREIGN_CLOUD_PRODUCT_MAP[trimmedCloud];
    if (mappedCloud !== undefined) {
      pushUnique(sovereignProducts, seenSovereign, mappedCloud);
    } else {
      const unmappedCloudLabel = `Cloud Instance: ${trimmedCloud}`;
      pushUnique(sovereignProducts, seenSovereign, unmappedCloudLabel);
      pushUnique(unmappedProducts, seenUnmapped, unmappedCloudLabel);
    }
  }

  return {
    products: sovereignProducts,
    normalizedWorkloads,
    unmappedProducts,
    sovereignCloudOnly: true,
  };
}

/**
 * Normalize Roadmap rollout status, release phases, sovereign-cloud scope, and
 * signal tags into deduplicated `ChangeEvent.categories` values.
 */
export function mapRoadmapCategories(input: {
  readonly status?: string | null;
  readonly releasePhases: readonly string[];
  readonly signalTags: readonly string[];
  readonly sovereignCloudOnly?: boolean;
}): MappedRoadmapCategories {
  const categories: string[] = [];
  const seenCategories = new Set<string>();
  const unmappedCategories: string[] = [];
  const seenUnmapped = new Set<string>();

  if (typeof input.status === 'string' && input.status.trim().length > 0) {
    const trimmedStatus = input.status.trim();
    const mappedStatus = MICROSOFT_ROADMAP_STATUS_CATEGORY_MAP[trimmedStatus];
    if (mappedStatus !== undefined) {
      pushUnique(categories, seenCategories, mappedStatus);
    } else {
      pushUnique(unmappedCategories, seenUnmapped, trimmedStatus);
    }
  }

  for (const phase of input.releasePhases) {
    const trimmedPhase = phase.trim();
    if (trimmedPhase.length === 0) continue;
    const mappedPhase =
      MICROSOFT_ROADMAP_RELEASE_PHASE_CATEGORY_MAP[trimmedPhase];
    if (mappedPhase !== undefined) {
      pushUnique(categories, seenCategories, mappedPhase);
    } else {
      pushUnique(unmappedCategories, seenUnmapped, trimmedPhase);
    }
  }

  if (input.sovereignCloudOnly === true) {
    pushUnique(categories, seenCategories, 'sovereign-cloud-only');
  }

  for (const tag of input.signalTags) {
    if (tag.length > 0) {
      pushUnique(categories, seenCategories, tag);
    }
  }

  return { categories, unmappedCategories };
}
