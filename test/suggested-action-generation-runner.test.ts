import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  SuggestedChangeActionResultSchema,
  createSuggestedChangeActionGenerationRequest,
  generateSuggestedChangeActionResult,
  type SuggestedChangeActionGenerationOutput,
  type SuggestedChangeActionGenerationRequest,
  type SuggestedChangeActionGenerator,
} from '../src/index.js';

function readFixture(name: string): unknown {
  const url = new URL(`./fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('fixture value is not an object');
  }
  return value as Record<string, unknown>;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The tenant-profile fixture carries `profileVersion` "2026-08-26.1" while
 * the AI analysis fixture was evaluated against "profile-2026-08-26.1", so
 * ownership-consistent request inputs need this single-field retarget. */
function consistentProfile(): Record<string, unknown> {
  const profile = asRecord(readFixture('tenant-profile.json'));
  profile.profileVersion = 'profile-2026-08-26.1';
  return profile;
}

const changeEvent = asRecord(readFixture('change-event.json'));
const aiAnalysisInput = asRecord(readFixture('analysis-record-ai.json'));

function buildRequest(): SuggestedChangeActionGenerationRequest {
  return createSuggestedChangeActionGenerationRequest(
    changeEvent as never,
    'message-v3',
    consistentProfile() as never,
    aiAnalysisInput as never,
  );
}

/** Swaps the AI fixture's assessment to a non-actionable state while keeping
 * its provenance-backed evidence list intact. The runner must reject such a
 * request before the generator is ever consulted. */
function withAssessmentState(
  state: 'INFORMATIONAL' | 'NOT_APPLICABLE' | 'INSUFFICIENT_CONTEXT',
): Record<string, unknown> {
  const record = asRecord(clone(aiAnalysisInput));
  if (state === 'INSUFFICIENT_CONTEXT') {
    record.impactAssessment = {
      state,
      reason: 'The tenant profile lacks the required paths.',
      missingContext: ['/services/stream'],
    };
  } else {
    record.impactAssessment = {
      state,
      reason: `Reason for ${state}.`,
      evidence: ['rule.teams-review'],
    };
  }
  return record;
}

function rawRequest(
  analysisRecord: unknown,
  eventOverride: unknown = changeEvent,
): Record<string, unknown> {
  return {
    changeEvent: eventOverride,
    sourceMessageVersion: 'message-v3',
    tenantProfile: consistentProfile(),
    analysisRecord,
  };
}

/** Shared deterministic action retargeted at the AI fixture's provenance. */
const deterministicAction = {
  origin: 'deterministic',
  actionId: 'action.notify-owner-001',
  kind: 'COMMUNICATE',
  title: 'Notify service owners of the upcoming deadline',
  description:
    'Send the deadline notice derived from the policy conclusion to every listed owner.',
  ownerKey: 'teams-service-owners',
  dueAt: '2026-10-01T00:00:00+09:00',
  supportingEvidenceIds: ['rule.teams-review', 'source.deadline'],
} as const;

/** Shared AI-origin action citing the AI fixture's inference evidence. */
const aiAction = {
  origin: 'ai_inference',
  actionId: 'action.draft-plan-001',
  kind: 'PLAN',
  title: 'Draft a rollout plan for the affected service',
  description:
    'Use the AI impact summary to draft tenant-specific rollout steps for review.',
  confidence: 0.82,
  supportingEvidenceIds: ['rule.teams-review', 'ai.impact-summary'],
} as const;

type GeneratorOptions = {
  mutateReceived?: (received: SuggestedChangeActionGenerationRequest) => void;
  rawReturn?: unknown;
};

/** Counting stub generator: records every received request, optionally
 * mutates it in place and/or returns a raw override instead of valid
 * actions. */
function generatorFor(
  actions: readonly unknown[] = [],
  options: GeneratorOptions = {},
): SuggestedChangeActionGenerator & {
  calls: SuggestedChangeActionGenerationRequest[];
} {
  const calls: SuggestedChangeActionGenerationRequest[] = [];
  const generator = (async (
    received: SuggestedChangeActionGenerationRequest,
  ) => {
    calls.push(received);
    options.mutateReceived?.(received);
    if (options.rawReturn !== undefined) {
      return options.rawReturn as SuggestedChangeActionGenerationOutput;
    }
    return {
      actions: clone(actions),
    } as SuggestedChangeActionGenerationOutput;
  }) as SuggestedChangeActionGenerator & {
    calls: SuggestedChangeActionGenerationRequest[];
  };
  generator.calls = calls;
  return generator;
}

describe('generateSuggestedChangeActionResult — accepted generation', () => {
  it('returns a validated result joining the request analysis with the generator actions', async () => {
    const request = buildRequest();
    const actions = [deterministicAction, aiAction];
    const generator = generatorFor(actions);
    const result = await generateSuggestedChangeActionResult(
      request,
      generator,
    );

    expect(generator.calls.length).toBe(1);
    expect(SuggestedChangeActionResultSchema.safeParse(result).success).toBe(
      true,
    );
    expect(result.actions).toEqual([...actions]);
    expect(result.analysisRecord).toEqual(request.analysisRecord);
  });

  it('hands the generator a deep-equal copy of the parsed request exactly once', async () => {
    const request = buildRequest();
    let receivedSnapshot: unknown;
    const generator = generatorFor([aiAction], {
      mutateReceived: (received) => {
        receivedSnapshot = clone(received);
      },
    });
    await generateSuggestedChangeActionResult(request, generator);

    expect(generator.calls.length).toBe(1);
    expect(receivedSnapshot).toEqual(clone(request));
  });

  it('isolates the authoritative request from in-place generator mutations', async () => {
    const request = buildRequest();
    const requestBefore = clone(request);
    let receivedSnapshot: unknown;
    const generator = generatorFor([aiAction], {
      mutateReceived: (received) => {
        receivedSnapshot = clone(received);
        (received.analysisRecord.provenanceRecords as unknown[]).push({
          evidenceId: 'generator.planted',
        });
        received.sourceMessageVersion = 'message-v999';
        received.changeEvent.externalId = 'MC999999';
      },
    });
    const result = await generateSuggestedChangeActionResult(
      request,
      generator,
    );

    // The generator saw a deep-equal copy, trashed it, and none of that
    // reached the authoritative analysis, the caller's request, or the
    // returned result.
    expect(receivedSnapshot).toEqual(requestBefore);
    expect(result.analysisRecord).toEqual(requestBefore.analysisRecord);
    expect(
      result.analysisRecord.provenanceRecords.some(
        (record) => record.evidenceId === 'generator.planted',
      ),
    ).toBe(false);
    expect(result.actions).toEqual([aiAction]);
    expect(clone(request)).toEqual(requestBefore);
    expect(SuggestedChangeActionResultSchema.safeParse(result).success).toBe(
      true,
    );
  });

  it('preserves the generator action order exactly in the returned result', async () => {
    const request = buildRequest();
    const orderedActions = [
      { ...aiAction, actionId: 'action.a-first' },
      { ...deterministicAction, actionId: 'action.b-second' },
      { ...aiAction, actionId: 'action.c-third', confidence: 0.5 },
    ];
    const result = await generateSuggestedChangeActionResult(
      request,
      generatorFor(orderedActions),
    );

    expect(result.actions.map((action) => action.actionId)).toEqual([
      'action.a-first',
      'action.b-second',
      'action.c-third',
    ]);
  });
});

describe('generateSuggestedChangeActionResult — request gates', () => {
  it.each(['INFORMATIONAL', 'NOT_APPLICABLE', 'INSUFFICIENT_CONTEXT'] as const)(
    'rejects a %s analysis before calling the generator',
    async (state) => {
      const generator = generatorFor([aiAction]);
      await expect(
        generateSuggestedChangeActionResult(
          rawRequest(
            withAssessmentState(state),
          ) as unknown as SuggestedChangeActionGenerationRequest,
          generator,
        ),
      ).rejects.toThrow(/must be ACTION_REQUIRED or REVIEW_REQUIRED/);
      expect(generator.calls.length).toBe(0);
    },
  );

  it('rejects a version-mismatched request before calling the generator', async () => {
    const request = buildRequest();
    const generator = generatorFor([aiAction]);
    await expect(
      generateSuggestedChangeActionResult(
        {
          ...request,
          sourceMessageVersion: 'message-v999',
        } as unknown as SuggestedChangeActionGenerationRequest,
        generator,
      ),
    ).rejects.toThrow(/sourceMessageVersion must exactly match/);
    expect(generator.calls.length).toBe(0);
  });

  it('rejects an explicit undefined anywhere in the request before calling the generator', async () => {
    const generator = generatorFor([aiAction]);
    await expect(
      generateSuggestedChangeActionResult(
        rawRequest(aiAnalysisInput, {
          ...changeEvent,
          signals: {
            ...(changeEvent.signals as Record<string, unknown>),
            isMajorChange: undefined,
          },
        }) as unknown as SuggestedChangeActionGenerationRequest,
        generator,
      ),
    ).rejects.toThrow(/explicit undefined is not allowed anywhere/);
    expect(generator.calls.length).toBe(0);
  });

  it('rejects strict extras on the request before calling the generator', async () => {
    const request = buildRequest();
    const generator = generatorFor([aiAction]);
    await expect(
      generateSuggestedChangeActionResult(
        {
          ...request,
          extraKey: true,
        } as unknown as SuggestedChangeActionGenerationRequest,
        generator,
      ),
    ).rejects.toThrow();
    expect(generator.calls.length).toBe(0);
  });
});

describe('generateSuggestedChangeActionResult — generator output gates', () => {
  it('rejects an empty action collection from the generator', async () => {
    const request = buildRequest();
    const generator = generatorFor([], {
      rawReturn: { actions: [] },
    });
    await expect(
      generateSuggestedChangeActionResult(request, generator),
    ).rejects.toThrow();
    expect(generator.calls.length).toBe(1);
  });

  it('rejects duplicate actionIds across the generator output', async () => {
    const request = buildRequest();
    const generator = generatorFor([deterministicAction, deterministicAction]);
    await expect(
      generateSuggestedChangeActionResult(request, generator),
    ).rejects.toThrow(/duplicate actionId across the generation output/);
    expect(generator.calls.length).toBe(1);
  });

  it('rejects a malformed action shape from the generator', async () => {
    const request = buildRequest();
    const generator = generatorFor([
      { ...deterministicAction, confidence: 0.5 },
    ]);
    await expect(
      generateSuggestedChangeActionResult(request, generator),
    ).rejects.toThrow();
    expect(generator.calls.length).toBe(1);
  });

  it('rejects strict extras on the generator output object', async () => {
    const request = buildRequest();
    const generator = generatorFor([aiAction], {
      rawReturn: { actions: [clone([aiAction])[0]], note: 'extra' },
    });
    await expect(
      generateSuggestedChangeActionResult(request, generator),
    ).rejects.toThrow();
    expect(generator.calls.length).toBe(1);
  });

  it('rejects a generator return that is not a valid output object', async () => {
    const request = buildRequest();
    const generator = generatorFor([aiAction], { rawReturn: null });
    await expect(
      generateSuggestedChangeActionResult(request, generator),
    ).rejects.toThrow();
    expect(generator.calls.length).toBe(1);
  });

  it('propagates a generator rejection without producing a result', async () => {
    const request = buildRequest();
    const generator: SuggestedChangeActionGenerator = async () => {
      throw new Error('generator unavailable');
    };
    await expect(
      generateSuggestedChangeActionResult(request, generator),
    ).rejects.toThrow('generator unavailable');
  });
});

describe('generateSuggestedChangeActionResult — envelope ownership inheritance', () => {
  it('rejects dangling supportingEvidenceIds relative to the request analysis', async () => {
    const request = buildRequest();
    const generator = generatorFor([
      { ...deterministicAction, supportingEvidenceIds: ['ghost.evidence'] },
    ]);
    await expect(
      generateSuggestedChangeActionResult(request, generator),
    ).rejects.toThrow(/does not exist in this analysis/);
    expect(generator.calls.length).toBe(1);
  });

  it('rejects deterministic actions citing AI inference evidence', async () => {
    const request = buildRequest();
    const generator = generatorFor([
      {
        ...deterministicAction,
        supportingEvidenceIds: ['ai.impact-summary'],
      },
    ]);
    await expect(
      generateSuggestedChangeActionResult(request, generator),
    ).rejects.toThrow(/must not reference AI inference evidence/);
    expect(generator.calls.length).toBe(1);
  });

  it('rejects AI-origin actions without any AI inference reference', async () => {
    const request = buildRequest();
    const generator = generatorFor([
      { ...aiAction, supportingEvidenceIds: ['source.deadline'] },
    ]);
    await expect(
      generateSuggestedChangeActionResult(request, generator),
    ).rejects.toThrow(/AI inference reference/);
    expect(generator.calls.length).toBe(1);
  });
});

describe('generateSuggestedChangeActionResult — determinism and purity', () => {
  it('is deterministic across repeated runs and round-trips through JSON', async () => {
    const request = buildRequest();
    const actions = [deterministicAction, aiAction];
    const first = await generateSuggestedChangeActionResult(
      request,
      generatorFor(actions),
    );
    const second = await generateSuggestedChangeActionResult(
      request,
      generatorFor(actions),
    );

    expect(second).toEqual(first);
    const revived = SuggestedChangeActionResultSchema.parse(
      JSON.parse(JSON.stringify(first)),
    );
    expect(revived).toEqual(first);
  });
});
