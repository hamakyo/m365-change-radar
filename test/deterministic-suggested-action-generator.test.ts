import { describe, expect, it } from 'vitest';

import {
  SuggestedChangeActionGenerationOutputSchema,
  SuggestedChangeActionResultSchema,
  createSuggestedChangeActionGenerationRequest,
  generateSuggestedChangeActionResult,
} from '../src/index.js';
import { createDeterministicSuggestedActionOutput } from '../src/domain/deterministic-suggested-action-generator.js';
import type {
  SuggestedChangeAction,
  SuggestedChangeActionGenerationRequest,
} from '../src/index.js';

type ActionableState = 'ACTION_REQUIRED' | 'REVIEW_REQUIRED';

const changeEvent = {
  source: 'microsoft-message-center',
  externalId: 'MC123456',
  title: 'Teams meeting policy update',
  body: 'A change to meeting policy defaults is planned.',
  publishedAt: '2026-08-26T09:00:00Z',
  updatedAt: '2026-08-26T10:30:00+00:00',
  products: ['Microsoft Teams'],
  categories: ['collaboration', 'admin-impact'],
  severity: null,
  signals: {
    isMajorChange: false,
    actionRequiredBy: null,
    hasAdminImpact: true,
    isRetirementOrDeprecation: false,
    hasSecurityImpact: false,
    hasPrivacyImpact: false,
    hasComplianceImpact: false,
    tags: [],
  },
  sourceMetadata: {
    messageType: 'serviceAnnouncement',
    tags: ['policy', 'teams'],
  },
} as const;

const tenantProfile = {
  schemaVersion: '1.0',
  profileVersion: 'profile-2026-08-26.1',
  organization: { employees: 120 },
  services: { teams: true, exchange_online: true },
  environment: { windows: true },
  capabilities: { conditional_access: true },
  ownership: {
    exchange_online: 'messaging-team',
    intune: 'endpoint-team',
  },
  changePolicy: { userImpactRequiresCommunication: true },
  maintenance: { allowedDays: ['saturday'], timezone: 'Asia/Tokyo' },
} as const;

const aiVersionBundle = {
  sourceMessageVersion: 'message-v3',
  tenantProfileVersion: 'profile-2026-08-26.1',
  policyVersions: {
    riskPolicyRulesVersion: 'policy-2026-08',
    tenantApplicabilityPolicyRulesVersion: 'tenant-applicability-2026-08',
  },
  ai: {
    used: true,
    promptVersion: 'prompt-2026-08',
    model: 'gpt-5.6-luna',
    modelVersion: 'gpt-5.6-luna-2026-08-01',
  },
};

const noAiVersionBundle = {
  sourceMessageVersion: 'message-v3',
  tenantProfileVersion: 'profile-2026-08-26.1',
  policyVersions: {
    riskPolicyRulesVersion: 'policy-2026-08',
    tenantApplicabilityPolicyRulesVersion: 'tenant-applicability-2026-08',
  },
  ai: { used: false },
};

const eventRef = {
  source: 'microsoft-message-center',
  externalId: 'MC123456',
  sourceMessageVersion: 'message-v3',
};

const aiProvenanceRecords = [
  {
    kind: 'source_fact',
    evidenceId: 'source.deadline',
    source: 'microsoft-message-center',
    externalId: 'MC123456',
    sourceMessageVersion: 'message-v3',
    path: '/actionRequiredByDateTime',
    observation: { presence: 'present', value: '2026-10-01T00:00:00Z' },
  },
  {
    kind: 'tenant_fact',
    evidenceId: 'tenant.services.teams',
    tenantProfileVersion: 'profile-2026-08-26.1',
    path: '/services/teams',
    observation: { presence: 'present', value: true },
  },
  {
    kind: 'deterministic_conclusion',
    evidenceId: 'rule.teams-review',
    policyKind: 'tenant_applicability_policy',
    policyRulesVersion: 'tenant-applicability-2026-08',
    ruleId: 'teams-service-review',
    conclusion: 'Review is required because the tenant uses Teams.',
    dependsOnEvidenceIds: ['source.deadline', 'tenant.services.teams'],
  },
  {
    kind: 'ai_inference',
    evidenceId: 'ai.impact-summary',
    promptVersion: 'prompt-2026-08',
    model: 'gpt-5.6-luna',
    modelVersion: 'gpt-5.6-luna-2026-08-01',
    confidence: 0.82,
    inference: 'Notify the Teams owner and review the policy.',
    dependsOnEvidenceIds: ['rule.teams-review'],
  },
];

const noAiProvenanceRecords = [
  {
    kind: 'source_fact',
    evidenceId: 'source.products',
    source: 'microsoft-message-center',
    externalId: 'MC123456',
    sourceMessageVersion: 'message-v3',
    path: '/products/0',
    observation: { presence: 'present', value: 'Microsoft Teams' },
  },
  {
    kind: 'tenant_fact',
    evidenceId: 'tenant.services.teams',
    tenantProfileVersion: 'profile-2026-08-26.1',
    path: '/services/teams',
    observation: { presence: 'present', value: true },
  },
  {
    kind: 'deterministic_conclusion',
    evidenceId: 'rule.teams-action',
    policyKind: 'tenant_applicability_policy',
    policyRulesVersion: 'tenant-applicability-2026-08',
    ruleId: 'teams-service-action',
    conclusion: 'Action is required because the tenant uses Teams.',
    dependsOnEvidenceIds: ['source.products', 'tenant.services.teams'],
  },
];

/** A fresh AI-enabled analysis record in the requested actionable state;
 * the assessment evidence deliberately includes the AI inference ID so the
 * evidence-filtering behavior is observable. */
function aiAnalysis(state: ActionableState): Record<string, unknown> {
  return {
    analysisId: `analysis-${state.toLowerCase()}`,
    tenantId: 'tenant-demo',
    createdAt: '2026-08-26T12:00:00Z',
    changeEventRef: eventRef,
    versionBundle: aiVersionBundle,
    impactAssessment: {
      state,
      reason: `Reason for ${state}.`,
      evidence: ['rule.teams-review', 'ai.impact-summary'],
    },
    provenanceRecords: aiProvenanceRecords,
  };
}

/** A fresh no-AI analysis record in the requested actionable state. */
function noAiAnalysis(state: ActionableState): Record<string, unknown> {
  return {
    analysisId: `analysis-noai-${state.toLowerCase()}`,
    tenantId: 'tenant-demo',
    createdAt: '2026-08-26T12:05:00Z',
    changeEventRef: eventRef,
    versionBundle: noAiVersionBundle,
    impactAssessment: {
      state,
      reason: `Reason for ${state}.`,
      evidence: ['rule.teams-action'],
    },
    provenanceRecords: noAiProvenanceRecords,
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The output's first action, typed as the deterministic variant. */
function firstAction(
  output: ReturnType<typeof createDeterministicSuggestedActionOutput>,
): Extract<SuggestedChangeAction, { origin: 'deterministic' }> {
  const first = output.actions[0];
  if (first === undefined || first.origin !== 'deterministic') {
    throw new Error('expected at least one deterministic action');
  }
  return first;
}

function buildRequest(
  analysisRecord: Record<string, unknown>,
  eventOverride: Record<string, unknown> = {},
): SuggestedChangeActionGenerationRequest {
  const event = clone(changeEvent) as Record<string, unknown>;
  const signals = {
    ...(event.signals as Record<string, unknown>),
    ...(eventOverride.signals as Record<string, unknown> | undefined),
  };
  const mergedEvent = { ...event, ...eventOverride, signals };
  if (mergedEvent.signals.actionRequiredBy === null) {
    delete mergedEvent.signals.actionRequiredBy;
  }
  return createSuggestedChangeActionGenerationRequest(
    mergedEvent as never,
    'message-v3',
    clone(tenantProfile) as never,
    clone(analysisRecord) as never,
  );
}

describe('createDeterministicSuggestedActionOutput — actionable states', () => {
  it('emits the five ACTION_REQUIRED kinds in the fixed order with stable IDs', () => {
    const output = createDeterministicSuggestedActionOutput(
      buildRequest(aiAnalysis('ACTION_REQUIRED')),
    );

    expect(output.actions.map((action) => action.kind)).toEqual([
      'INVESTIGATE',
      'PLAN',
      'IMPLEMENT',
      'COMMUNICATE',
      'VALIDATE',
    ]);
    expect(output.actions.map((action) => action.actionId)).toEqual([
      'action.investigate-001',
      'action.plan-002',
      'action.implement-003',
      'action.communicate-004',
      'action.validate-005',
    ]);
  });

  it('emits the three REVIEW_REQUIRED kinds in the fixed order with stable IDs', () => {
    const output = createDeterministicSuggestedActionOutput(
      buildRequest(aiAnalysis('REVIEW_REQUIRED')),
    );

    expect(output.actions.map((action) => action.kind)).toEqual([
      'INVESTIGATE',
      'COMMUNICATE',
      'VALIDATE',
    ]);
    expect(output.actions.map((action) => action.actionId)).toEqual([
      'action.investigate-001',
      'action.communicate-002',
      'action.validate-003',
    ]);
  });

  it('rejects a non-actionable analysis even though the request schema also gates it', () => {
    const analysis = aiAnalysis('REVIEW_REQUIRED') as Record<string, unknown>;
    analysis.impactAssessment = {
      state: 'INFORMATIONAL',
      reason: 'Informational only.',
      evidence: ['rule.teams-review'],
    };
    expect(() =>
      createDeterministicSuggestedActionOutput(buildRequest(analysis) as never),
    ).toThrow(/must be ACTION_REQUIRED or REVIEW_REQUIRED/);
  });
});

describe('createDeterministicSuggestedActionOutput — deterministic origin and evidence', () => {
  it('returns deterministic-origin actions without any confidence key', () => {
    const output = createDeterministicSuggestedActionOutput(
      buildRequest(aiAnalysis('ACTION_REQUIRED')),
    );

    output.actions.forEach((action) => {
      expect(action.origin).toBe('deterministic');
      expect(Object.hasOwn(action, 'confidence')).toBe(false);
    });
    expect(
      SuggestedChangeActionGenerationOutputSchema.safeParse(output).success,
    ).toBe(true);
  });

  it('filters AI inference evidence out of the support lists on an AI-enabled analysis', () => {
    const output = createDeterministicSuggestedActionOutput(
      buildRequest(aiAnalysis('ACTION_REQUIRED')),
    );

    // Assessment evidence order first (AI id dropped), then remaining
    // provenance order, de-duplicated: rule, source, tenant fact.
    output.actions.forEach((action) => {
      expect(action.supportingEvidenceIds).not.toContain('ai.impact-summary');
      expect(
        action.supportingEvidenceIds.every((id) =>
          [
            'rule.teams-review',
            'source.deadline',
            'tenant.services.teams',
          ].includes(id),
        ),
      ).toBe(true);
    });
    expect(firstAction(output).supportingEvidenceIds).toEqual([
      'rule.teams-review',
      'source.deadline',
      'tenant.services.teams',
    ]);
    expect(
      firstAction(output).supportingEvidenceIds.length,
    ).toBeLessThanOrEqual(3);
  });

  it('builds evidence-anchored actions from a no-AI analysis', () => {
    const output = createDeterministicSuggestedActionOutput(
      buildRequest(noAiAnalysis('ACTION_REQUIRED')),
    );

    output.actions.forEach((action) => {
      expect(action.supportingEvidenceIds).toEqual(
        expect.arrayContaining(['rule.teams-action']),
      );
      expect(action.supportingEvidenceIds.length).toBeGreaterThanOrEqual(1);
    });
    expect(firstAction(output).supportingEvidenceIds).toEqual([
      'rule.teams-action',
      'source.products',
      'tenant.services.teams',
    ]);
  });
});

describe('createDeterministicSuggestedActionOutput — ownership-aware fields', () => {
  it('fills ownerKey from the tenant ownership map and leaves dueAt absent without a deadline', () => {
    const output = createDeterministicSuggestedActionOutput(
      buildRequest(aiAnalysis('REVIEW_REQUIRED')),
    );

    output.actions.forEach((action) => {
      expect(action.origin === 'deterministic' && action.ownerKey).toBe(
        'exchange_online:messaging-team',
      );
      expect(Object.hasOwn(action, 'dueAt')).toBe(false);
    });
  });

  it('carries the change event deadline as dueAt only when the signals record it', () => {
    const output = createDeterministicSuggestedActionOutput(
      buildRequest(aiAnalysis('ACTION_REQUIRED'), {
        signals: { actionRequiredBy: '2026-10-01T09:30:00+09:00' },
      }),
    );

    output.actions.forEach((action) => {
      expect(action.origin === 'deterministic' && action.dueAt).toBe(
        '2026-10-01T09:30:00+09:00',
      );
    });
  });
});

describe('createDeterministicSuggestedActionOutput — component-aware text', () => {
  it('splices the event products into every title and description in event order', () => {
    const output = createDeterministicSuggestedActionOutput(
      buildRequest(aiAnalysis('ACTION_REQUIRED'), {
        products: ['Microsoft Teams', 'Microsoft 365 Copilot'],
      }),
    );

    output.actions.forEach((action) => {
      expect(action.title).toContain(
        '"Microsoft Teams, Microsoft 365 Copilot"',
      );
      expect(action.description).toContain(
        '"Microsoft Teams, Microsoft 365 Copilot"',
      );
    });
  });

  it('falls back to categories when the event records no products', () => {
    const output = createDeterministicSuggestedActionOutput(
      buildRequest(aiAnalysis('REVIEW_REQUIRED'), {
        products: [],
      }),
    );

    output.actions.forEach((action) => {
      expect(action.title).toContain('"collaboration, admin-impact"');
    });
  });

  it('uses a neutral phrase when neither products nor categories exist', () => {
    const output = createDeterministicSuggestedActionOutput(
      buildRequest(aiAnalysis('REVIEW_REQUIRED'), {
        products: [],
        categories: [],
      }),
    );

    output.actions.forEach((action) => {
      expect(action.title).toContain('"the affected Microsoft 365 services"');
    });
  });
});

describe('createDeterministicSuggestedActionOutput — fail-closed support', () => {
  it('fails closed only when zero non-AI provenance entries qualify', () => {
    // A single AI record whose dependencies are also AI records: the
    // qualifying non-AI support set is empty, so no suggestion can be
    // anchored and the generator must throw.
    const analysis = {
      analysisId: 'analysis-zero-support',
      tenantId: 'tenant-demo',
      createdAt: '2026-08-26T12:00:00Z',
      changeEventRef: eventRef,
      versionBundle: aiVersionBundle,
      impactAssessment: {
        state: 'ACTION_REQUIRED',
        reason: 'Reason for ACTION_REQUIRED.',
        evidence: ['ai.impact-summary'],
      },
      provenanceRecords: [
        {
          kind: 'ai_inference',
          evidenceId: 'ai.impact-summary',
          promptVersion: 'prompt-2026-08',
          model: 'gpt-5.6-luna',
          modelVersion: 'gpt-5.6-luna-2026-08-01',
          confidence: 0.82,
          inference: 'Zero-support inference.',
          dependsOnEvidenceIds: ['ai.impact-summary'],
        },
      ],
    };

    expect(() =>
      createDeterministicSuggestedActionOutput(buildRequest(analysis)),
    ).toThrow(/non-AI provenance/);
  });

  it('generates the full action sequence from a single qualifying evidence entry', () => {
    // One non-AI source fact is enough: every per-kind minimum was removed,
    // so a valid actionable analysis must not be rejected.
    const analysis = {
      analysisId: 'analysis-single-support',
      tenantId: 'tenant-demo',
      createdAt: '2026-08-26T12:00:00Z',
      changeEventRef: eventRef,
      versionBundle: aiVersionBundle,
      impactAssessment: {
        state: 'ACTION_REQUIRED',
        reason: 'Reason for ACTION_REQUIRED.',
        evidence: ['ai.impact-summary'],
      },
      provenanceRecords: [
        {
          kind: 'source_fact',
          evidenceId: 'source.deadline',
          source: 'microsoft-message-center',
          externalId: 'MC123456',
          sourceMessageVersion: 'message-v3',
          path: '/actionRequiredByDateTime',
          observation: { presence: 'present', value: '2026-10-01T00:00:00Z' },
        },
        {
          kind: 'ai_inference',
          evidenceId: 'ai.impact-summary',
          promptVersion: 'prompt-2026-08',
          model: 'gpt-5.6-luna',
          modelVersion: 'gpt-5.6-luna-2026-08-01',
          confidence: 0.82,
          inference: 'Single-support inference.',
          dependsOnEvidenceIds: ['source.deadline'],
        },
      ],
    };

    const output = createDeterministicSuggestedActionOutput(
      buildRequest(analysis),
    );
    expect(output.actions.map((action) => action.kind)).toEqual([
      'INVESTIGATE',
      'PLAN',
      'IMPLEMENT',
      'COMMUNICATE',
      'VALIDATE',
    ]);
    output.actions.forEach((action) => {
      expect(action.supportingEvidenceIds).toEqual(['source.deadline']);
    });
  });

  it('shares the full ordered non-AI support list with every action', () => {
    const output = createDeterministicSuggestedActionOutput(
      buildRequest(aiAnalysis('ACTION_REQUIRED')),
    );
    output.actions.forEach((action) => {
      expect(action.supportingEvidenceIds).toEqual([
        'rule.teams-review',
        'source.deadline',
        'tenant.services.teams',
      ]);
    });
  });
});

describe('createDeterministicSuggestedActionOutput — generation envelope ownership', () => {
  it('flows through the existing generation envelope into a validated result', async () => {
    const request = buildRequest(aiAnalysis('REVIEW_REQUIRED'));
    const output = createDeterministicSuggestedActionOutput(request);
    const result = await generateSuggestedChangeActionResult(
      request,
      async (received) => createDeterministicSuggestedActionOutput(received),
    );

    expect(SuggestedChangeActionResultSchema.safeParse(result).success).toBe(
      true,
    );
    expect(result.actions).toEqual(output.actions);
    expect(result.analysisRecord).toEqual(request.analysisRecord);
    result.actions.forEach((action) => {
      expect(action.supportingEvidenceIds).not.toContain('ai.impact-summary');
    });
  });

  it('keeps the envelope boundary: a tampered generator citing AI evidence is rejected', async () => {
    const request = buildRequest(aiAnalysis('REVIEW_REQUIRED'));
    await expect(
      generateSuggestedChangeActionResult(request, async () => {
        const output = createDeterministicSuggestedActionOutput(request);
        const first = firstAction(output);
        return {
          actions: [
            {
              ...first,
              supportingEvidenceIds: ['ai.impact-summary'],
            },
            ...output.actions.slice(1),
          ],
        };
      }),
    ).rejects.toThrow(/must not reference AI inference evidence/);
  });
});

describe('createDeterministicSuggestedActionOutput — determinism and purity', () => {
  it('is deterministic across repeated runs for the same request', () => {
    const request = buildRequest(aiAnalysis('ACTION_REQUIRED'));
    const first = createDeterministicSuggestedActionOutput(request);
    const second = createDeterministicSuggestedActionOutput(
      buildRequest(aiAnalysis('ACTION_REQUIRED')),
    );

    expect(second).toEqual(first);
  });

  it('never mutates the input request', () => {
    const request = buildRequest(aiAnalysis('ACTION_REQUIRED'));
    const before = clone(request);
    createDeterministicSuggestedActionOutput(request);
    expect(clone(request)).toEqual(before);
  });

  it('round-trips the accepted output through JSON losslessly', () => {
    const output = createDeterministicSuggestedActionOutput(
      buildRequest(noAiAnalysis('REVIEW_REQUIRED')),
    );
    const revived = SuggestedChangeActionGenerationOutputSchema.parse(
      JSON.parse(JSON.stringify(output)) as unknown,
    );
    expect(revived).toEqual(output);
  });
});
