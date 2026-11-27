import type {
  ChangeSignalTag,
  ChangeSignals,
} from '../../domain/change-event.js';

const NAMED_HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  nbsp: ' ',
};

/**
 * Decode common named and numeric HTML entities without external DOM libraries.
 */
export function decodeHtmlEntities(input: string): string {
  return input.replace(
    /&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z0-9]+));/g,
    (fullMatch, decDigits?: string, hexDigits?: string, named?: string) => {
      if (decDigits !== undefined) {
        const codePoint = Number.parseInt(decDigits, 10);
        if (
          Number.isInteger(codePoint) &&
          codePoint > 0 &&
          codePoint <= 0x10ffff
        ) {
          return String.fromCodePoint(codePoint);
        }
        return fullMatch;
      }
      if (hexDigits !== undefined) {
        const codePoint = Number.parseInt(hexDigits, 16);
        if (
          Number.isInteger(codePoint) &&
          codePoint > 0 &&
          codePoint <= 0x10ffff
        ) {
          return String.fromCodePoint(codePoint);
        }
        return fullMatch;
      }
      if (named !== undefined) {
        const replacement = NAMED_HTML_ENTITIES[named.toLowerCase()];
        if (replacement !== undefined) return replacement;
      }
      return fullMatch;
    },
  );
}

/**
 * Convert HTML fragments carried in Microsoft 365 Roadmap `description` fields
 * into clean, normalized plain text suitable for `ChangeEvent.body` and
 * Markdown rendering.
 */
export function stripRoadmapHtmlToText(html: string): string {
  const withLineBreaks = html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/p\s*>/gi, '\n\n')
    .replace(/<\s*li\b[^>]*>/gi, '\n- ')
    .replace(/<\s*\/li\s*>/gi, '')
    .replace(/<[^>]+>/g, ' ');

  const decoded = decodeHtmlEntities(withLineBreaks);
  return decoded
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export type RoadmapSignalExtractionInput = {
  readonly title: string;
  readonly body: string;
  readonly rawProducts: readonly string[];
  readonly rawTags: readonly string[];
};

const ADMIN_PORTAL_PRODUCTS = new Set([
  'Microsoft 365 admin center',
  'Microsoft 365 Admin Center',
  'Microsoft Intune',
  'Microsoft Entra',
  'Microsoft Entra ID',
  'Microsoft Power Platform governance and administration',
]);

const SECURITY_DEDICATED_PRODUCTS = new Set([
  'Microsoft Defender for Office 365',
  'Microsoft 365 Defender',
  'Microsoft Defender',
  'Microsoft Defender for Endpoint',
]);

const RETIREMENT_PATTERN =
  /\b(?:retire|retired|retiring|retirement|end of support|end-of-support)\b/i;
const DEPRECATION_PATTERN =
  /\b(?:deprecate|deprecated|deprecating|deprecation)\b/i;
const MAJOR_CHANGE_PATTERN =
  /\b(?:major change|breaking change|mandatory migration|default behavior change|enabled by default for all tenants)\b/i;
const NEGATED_ADMIN_ACTION_PATTERN =
  /\bno\s+(?:admin|administrator)\s+action\s+(?:is\s+)?required\b/gi;
const ADMIN_IMPACT_PATTERN =
  /\b(?:admin center|admins?\s+(?:can|will|must|should|need)|administrators?\s+(?:can|will|must|should|need)|(?:configured|managed|enabled|controlled)\s+by\s+(?:admins?|administrators?)|group policy|relaunch notification policy|organization-wide|tenant-wide|powershell|conditional access)\b/i;
const SECURITY_CONTROL_PATTERN =
  /\b(?:conditional access|multi-factor authentication|mfa|phishing|anti-malware|quarantine|threat explorer|advanced hunting|zero trust|authentication policy|encryption key|security posture)\b/i;
const COMPLIANCE_CONTROL_PATTERN =
  /\b(?:ediscovery|data loss prevention|\bdlp\b|retention policy|retention labels?|sensitivity labels?|communication compliance|insider risk|audit logs?|regulatory compliance|information protection)\b/i;
const PRIVACY_CONTROL_PATTERN =
  /\b(?:personal data|\bgdpr\b|data privacy|user privacy|privacy controls?|privacy policy)\b/i;

const CANONICAL_TAG_ORDER: readonly ChangeSignalTag[] = [
  'admin-impact',
  'retirement',
  'deprecation',
  'security',
  'privacy',
  'compliance',
];

/**
 * Extract conservative deterministic `ChangeSignals` from a public Microsoft 365
 * Roadmap item after inspecting its title, cleaned plain-text body, product
 * tags, and raw tags.
 *
 * Confirmed absences are emitted explicitly (`false`, `null`, `[]`) because
 * every field of the Roadmap item has been inspected. `actionRequiredBy` is
 * always `null` for public Roadmap items because the feed exposes only release
 * month strings (`publicDisclosureAvailabilityDate`) rather than concrete ISO
 * administrator deadlines.
 */
export function extractRoadmapSignals(
  input: RoadmapSignalExtractionInput,
): ChangeSignals {
  const combinedText = `${input.title}\n${input.body}`;
  const textWithoutNegatedAdmin = combinedText.replace(
    NEGATED_ADMIN_ACTION_PATTERN,
    ' ',
  );
  const lowerTags = new Set(
    input.rawTags.map((tag) => tag.trim().toLowerCase()),
  );

  const hasRetirement =
    RETIREMENT_PATTERN.test(combinedText) || lowerTags.has('retirement');
  const hasDeprecation =
    DEPRECATION_PATTERN.test(combinedText) || lowerTags.has('deprecation');
  const isRetirementOrDeprecation = hasRetirement || hasDeprecation;

  const isMajorChange =
    MAJOR_CHANGE_PATTERN.test(combinedText) || lowerTags.has('major change');

  const hasAdminImpact =
    input.rawProducts.some((product) =>
      ADMIN_PORTAL_PRODUCTS.has(product.trim()),
    ) ||
    ADMIN_IMPACT_PATTERN.test(textWithoutNegatedAdmin) ||
    lowerTags.has('admin impact');

  const hasSecurityImpact =
    input.rawProducts.some((product) =>
      SECURITY_DEDICATED_PRODUCTS.has(product.trim()),
    ) ||
    SECURITY_CONTROL_PATTERN.test(combinedText) ||
    lowerTags.has('security');

  const hasComplianceImpact =
    COMPLIANCE_CONTROL_PATTERN.test(combinedText) ||
    lowerTags.has('compliance');

  const hasPrivacyImpact =
    PRIVACY_CONTROL_PATTERN.test(combinedText) || lowerTags.has('privacy');

  const matchedTags = new Set<ChangeSignalTag>();
  if (hasAdminImpact) matchedTags.add('admin-impact');
  if (hasRetirement) matchedTags.add('retirement');
  if (hasDeprecation) matchedTags.add('deprecation');
  if (hasSecurityImpact) matchedTags.add('security');
  if (hasPrivacyImpact) matchedTags.add('privacy');
  if (hasComplianceImpact) matchedTags.add('compliance');

  const tags = CANONICAL_TAG_ORDER.filter((tag) => matchedTags.has(tag));

  return {
    isMajorChange,
    actionRequiredBy: null,
    hasAdminImpact,
    isRetirementOrDeprecation,
    hasSecurityImpact,
    hasPrivacyImpact,
    hasComplianceImpact,
    tags,
  };
}
