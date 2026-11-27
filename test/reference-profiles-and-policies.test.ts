import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MICROSOFT_ROADMAP_PRODUCT_MAP,
  MICROSOFT_ROADMAP_SOVEREIGN_CLOUD_PRODUCT_MAP,
  RiskPolicySchema,
  TenantApplicabilityPolicySchema,
  TenantProfileSchema,
  assertUndefinedFree,
  createImpactAnalysisRecord,
  createRoadmapRuleClassifier,
  evaluateTenantApplicability,
  isConfirmedSovereignCloudNonApplicable,
  normalizeMicrosoftRoadmapItem,
  resolveEffectiveRiskPolicyForCloudPartition,
} from '../src/index.js';

const projectRoot = resolve(process.cwd());
const profilesDir = join(projectRoot, 'profiles');
const policiesDir = join(projectRoot, 'policies');

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
}

describe('reference Japanese IT persona profiles and production policies', () => {
  it('validates all reference profiles in profiles/ against TenantProfileSchema with explicit Worldwide cloud flags', () => {
    const files = readdirSync(profilesDir)
      .filter((name) => name.endsWith('.json'))
      .sort();

    expect(files).toEqual([
      'jp-enterprise-hybrid-e3.json',
      'jp-small-teams-exo.json',
      'jp-smb-m365-bp-intune.json',
    ]);

    for (const file of files) {
      const raw = readJson(join(profilesDir, file));
      const parsed = TenantProfileSchema.parse(raw);
      assertUndefinedFree(parsed);
      expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
      expect(parsed.maintenance.timezone).toBe('Asia/Tokyo');
      expect(parsed.environment.cloud_worldwide_multi_tenant).toBe(true);
      expect(parsed.environment.cloud_gcc).toBe(false);
      expect(parsed.environment.cloud_gcc_high).toBe(false);
      expect(parsed.environment.cloud_dod).toBe(false);
      expect(parsed.environment.cloud_china_21vianet).toBe(false);
    }
  });

  it('covers every normalized value in MICROSOFT_ROADMAP_PRODUCT_MAP and SOVEREIGN_CLOUD_PRODUCT_MAP with enabled rules', () => {
    const riskPolicy = RiskPolicySchema.parse(
      readJson(join(policiesDir, 'risk-policy.json')),
    );
    expect(riskPolicy.rules.some((rule) => rule.enabled)).toBe(true);

    const tenantPolicy = TenantApplicabilityPolicySchema.parse(
      readJson(join(policiesDir, 'tenant-applicability-policy.json')),
    );

    const configuredProducts = new Set<string>();
    for (const rule of tenantPolicy.rules) {
      if (rule.enabled && rule.selector.field === 'products') {
        for (const value of rule.selector.values) {
          configuredProducts.add(value);
        }
      }
    }

    for (const normalizedProduct of new Set([
      ...Object.values(MICROSOFT_ROADMAP_PRODUCT_MAP),
      ...Object.values(MICROSOFT_ROADMAP_SOVEREIGN_CLOUD_PRODUCT_MAP),
    ])) {
      expect(configuredProducts.has(normalizedProduct)).toBe(true);
    }
  });

  it('resolves GCC/GCC High/DoD-only compliance and security items to DETERMINISTIC_FINAL NOT_APPLICABLE (ai.used=false) on Worldwide personas while preserving dual Worldwide+GCC and empty cloudInstances', async () => {
    const riskPolicy = RiskPolicySchema.parse(
      readJson(join(policiesDir, 'risk-policy.json')),
    );
    const tenantPolicy = TenantApplicabilityPolicySchema.parse(
      readJson(join(policiesDir, 'tenant-applicability-policy.json')),
    );
    const enterprise = TenantProfileSchema.parse(
      readJson(join(profilesDir, 'jp-enterprise-hybrid-e3.json')),
    );
    const small = TenantProfileSchema.parse(
      readJson(join(profilesDir, 'jp-small-teams-exo.json')),
    );
    const classifier = createRoadmapRuleClassifier();

    // 1. GCC / GCC High / DoD only with compliance + security signals -> NOT_APPLICABLE, ai.used = false
    const govOnlySecurityCompliance = normalizeMicrosoftRoadmapItem({
      id: 529852,
      title:
        'Microsoft Purview: Communication Compliance and Conditional Access alert improvements for US Gov',
      description:
        '<p>Admins can configure sensitivity label and Conditional Access alert policies in GCC, GCC High, and DoD.</p>',
      created: '2026-11-20T00:00:00',
      modified: '2026-11-26T00:00:00',
      status: 'In development',
      tagsContainer: {
        products: [{ tagName: 'Microsoft Purview' }],
        cloudInstances: [
          { tagName: 'GCC' },
          { tagName: 'GCC High' },
          { tagName: 'DoD' },
        ],
      },
    });
    expect(
      govOnlySecurityCompliance.changeEvent.signals?.hasSecurityImpact,
    ).toBe(true);
    expect(
      govOnlySecurityCompliance.changeEvent.signals?.hasComplianceImpact,
    ).toBe(true);

    for (const [personaId, profile] of [
      ['jp-enterprise-hybrid-e3', enterprise],
      ['jp-small-teams-exo', small],
    ] as const) {
      const applicability = evaluateTenantApplicability(
        tenantPolicy,
        govOnlySecurityCompliance.changeEvent,
        profile,
      );
      expect(applicability.status).toBe('NOT_APPLICABLE');
      expect(isConfirmedSovereignCloudNonApplicable(applicability)).toBe(true);

      const effectiveRiskPolicy = resolveEffectiveRiskPolicyForCloudPartition(
        riskPolicy,
        applicability,
      );
      const record = await createImpactAnalysisRecord(
        govOnlySecurityCompliance.changeEvent,
        govOnlySecurityCompliance.sourceMessageVersion,
        profile,
        effectiveRiskPolicy,
        tenantPolicy,
        {
          analysisId: `test.gov.${personaId}`,
          tenantId: personaId,
          createdAt: '2026-11-27T00:00:00.000Z',
        },
        classifier,
      );
      expect(record.impactAssessment.state).toBe('NOT_APPLICABLE');
      expect(record.versionBundle.ai).toEqual({ used: false });
    }

    // 2. Dual Worldwide + GCC -> evaluated normally (REVIEW_REQUIRED for Viva-enabled Enterprise, NOT_APPLICABLE for Viva-disabled Small)
    const dualViva = normalizeMicrosoftRoadmapItem({
      id: 578862,
      title: 'Microsoft Viva: Access Management for Copilot Analytics',
      description:
        '<p>Admins can manage access to Viva Insights in the admin center.</p>',
      created: '2026-11-20T00:00:00',
      modified: '2026-11-26T00:00:00',
      status: 'In development',
      tagsContainer: {
        products: [{ tagName: 'Microsoft Viva' }],
        cloudInstances: [
          { tagName: 'Worldwide (Standard Multi-Tenant)' },
          { tagName: 'GCC' },
        ],
      },
    });
    const entDualApp = evaluateTenantApplicability(
      tenantPolicy,
      dualViva.changeEvent,
      enterprise,
    );
    expect(entDualApp.status).toBe('APPLICABLE');
    expect(isConfirmedSovereignCloudNonApplicable(entDualApp)).toBe(false);

    const smallDualApp = evaluateTenantApplicability(
      tenantPolicy,
      dualViva.changeEvent,
      small,
    );
    expect(smallDualApp.status).toBe('NOT_APPLICABLE');
    // Service-level NOT_APPLICABLE (services.viva = false), NOT sovereign-cloud partition!
    expect(isConfirmedSovereignCloudNonApplicable(smallDualApp)).toBe(false);

    // 3. Profile omitting cloud_gcc on a GCC-only calm item -> INSUFFICIENT_CONTEXT (Unknown != Not Applicable)
    const unknownCloudProfile = TenantProfileSchema.parse({
      ...small,
      environment: {
        windows: true,
        macos: true,
      },
    });
    const calmGovItem = normalizeMicrosoftRoadmapItem({
      id: 495465,
      title: 'Microsoft Places: Microsoft Places Support to GCC cloud',
      description: '<p>General feature availability in GCC.</p>',
      created: '2026-11-20T00:00:00',
      modified: '2026-11-26T00:00:00',
      status: 'In development',
      tagsContainer: {
        products: [{ tagName: 'Microsoft 365 app' }],
        cloudInstances: [{ tagName: 'GCC' }],
      },
    });
    const unknownCloudApp = evaluateTenantApplicability(
      tenantPolicy,
      calmGovItem.changeEvent,
      unknownCloudProfile,
    );
    expect(unknownCloudApp.status).toBe('INSUFFICIENT_CONTEXT');
    expect(isConfirmedSovereignCloudNonApplicable(unknownCloudApp)).toBe(false);
  });
});
