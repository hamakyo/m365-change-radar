import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ChangeEventSchema } from '../src/domain/change-event.js';
import { createDeterministicImpactDecision } from '../src/domain/deterministic-impact-decision-evaluator.js';
import { createStructuredImpactClassificationRequest } from '../src/domain/structured-impact-classification-request-builder.js';
import { evaluateRiskPolicy } from '../src/domain/risk-policy-evaluator.js';
import { RiskPolicySchema } from '../src/domain/risk-policy.js';
import { TenantApplicabilityPolicySchema } from '../src/domain/tenant-applicability.js';
import { evaluateTenantApplicability } from '../src/domain/tenant-applicability-evaluator.js';
import { TenantProfileSchema } from '../src/domain/tenant-profile.js';
import { runOpenAIProviderValidationCommand } from '../src/corpus/openai-provider-validation.js';
import {
  OPENAI_RESPONSES_MODEL_VERSION,
  createOpenAIResponsesClassifier,
} from '../src/providers/openai-responses-classifier.js';

const projectRoot = process.cwd();

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function classifierRequest() {
  const event = ChangeEventSchema.parse(
    (
      readJson(join(projectRoot, 'corpus/changes/synth-mc-008.json')) as {
        event: unknown;
      }
    ).event,
  );
  const profile = TenantProfileSchema.parse(
    (
      readJson(
        join(projectRoot, 'corpus/tenant-profiles/synth-tenant-001.json'),
      ) as { profile: unknown }
    ).profile,
  );
  const riskPolicy = RiskPolicySchema.parse(
    readJson(join(projectRoot, 'test/fixtures/risk-policy.json')),
  );
  const tenantPolicy = TenantApplicabilityPolicySchema.parse(
    readJson(
      join(projectRoot, 'test/fixtures/tenant-applicability-policy.json'),
    ),
  );
  const decision = createDeterministicImpactDecision(
    evaluateRiskPolicy(riskPolicy, event),
    evaluateTenantApplicability(tenantPolicy, event, profile),
  );
  if (decision.kind === 'DETERMINISTIC_FINAL') {
    throw new Error('test fixture unexpectedly produced DETERMINISTIC_FINAL');
  }
  return createStructuredImpactClassificationRequest(
    event,
    'openai-provider-test-1',
    profile,
    decision,
  );
}

function successfulResponse(
  request: ReturnType<typeof classifierRequest>,
  overrides: Record<string, unknown> = {},
): Response {
  const component =
    request.changeEvent.products[0] ?? request.changeEvent.categories[0];
  return new Response(
    JSON.stringify({
      id: 'resp_test',
      status: 'completed',
      model: OPENAI_RESPONSES_MODEL_VERSION,
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({
                proposedState: 'INFORMATIONAL',
                confidence: 0.8,
                reason:
                  'The supplied title and body describe an informational change.',
                affectedComponents: component === undefined ? [] : [component],
                supportingEvidenceIds: [
                  'source.event.title',
                  'source.event.body',
                ],
                missingContext: null,
                ...overrides,
              }),
            },
          ],
        },
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        input_tokens_details: { cached_tokens: 10 },
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('OpenAI Responses classifier', () => {
  it('uses strict structured output, returns the existing inference contract, and records usage', async () => {
    const request = classifierRequest();
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        model: OPENAI_RESPONSES_MODEL_VERSION,
        store: false,
        reasoning: { effort: 'low' },
      });
      expect(body.text).toMatchObject({
        format: {
          type: 'json_schema',
          strict: true,
          schema: {
            properties: {
              supportingEvidenceIds: {
                items: {
                  enum: request.evidenceRecords.map(
                    (record) => record.evidenceId,
                  ),
                },
              },
            },
          },
        },
      });
      return successfulResponse(request);
    });
    const times = [100, 145];
    const classifier = createOpenAIResponsesClassifier({
      apiKey: 'test-key-never-logged',
      fetch: fetchMock,
      now: () => times.shift() ?? 145,
    });

    const result = await classifier(request);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.classificationOutput.proposedState).toBe('INFORMATIONAL');
    expect(result.modelVersion).toBe(OPENAI_RESPONSES_MODEL_VERSION);
    expect(result.dependsOnEvidenceIds).toEqual([
      'source.event.title',
      'source.event.body',
    ]);
    expect(classifier.getObservations()).toEqual([
      {
        responseId: 'resp_test',
        modelVersion: OPENAI_RESPONSES_MODEL_VERSION,
        latencyMs: 45,
        inputTokens: 100,
        cachedInputTokens: 10,
        outputTokens: 20,
        totalTokens: 120,
      },
    ]);
  });

  it('rejects dangling evidence IDs and unsupported affected components', async () => {
    const request = classifierRequest();
    const dangling = createOpenAIResponsesClassifier({
      apiKey: 'test-key-never-logged',
      fetch: async () =>
        successfulResponse(request, {
          supportingEvidenceIds: ['source.event.not-present'],
        }),
    });
    await expect(dangling(request)).rejects.toThrow(/does not exist/);

    const unsupportedComponent = createOpenAIResponsesClassifier({
      apiKey: 'test-key-never-logged',
      fetch: async () =>
        successfulResponse(request, {
          affectedComponents: ['invented-component'],
        }),
    });
    await expect(unsupportedComponent(request)).rejects.toThrow(
      /unsupported affected component/,
    );
  });

  it('rejects provider failures without exposing the credential', async () => {
    const request = classifierRequest();
    const secret = 'test-key-must-stay-secret';
    const classifier = createOpenAIResponsesClassifier({
      apiKey: secret,
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    let message = '';
    try {
      await classifier(request);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('status 429');
    expect(message).not.toContain(secret);
    expect(classifier.getObservations()).toEqual([]);
  });
});

describe('OpenAI provider validation command', () => {
  it('runs all 65 golden cases in manifest order and keeps unsupported claims for manual review', async () => {
    const manifest = readJson(join(projectRoot, 'corpus/manifest.json')) as {
      goldenCases: Array<{ caseId: string }>;
    };
    const manifestCaseIds = manifest.goldenCases.map((entry) => entry.caseId);
    let requestCount = 0;
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      requestCount += 1;
      const requestBody = JSON.parse(String(init?.body)) as { input: string };
      const request = JSON.parse(requestBody.input) as ReturnType<
        typeof classifierRequest
      >;
      return successfulResponse(request);
    });
    let currentTime = 0;
    const result = await runOpenAIProviderValidationCommand({
      apiKey: 'test-key-never-logged',
      resolveProjectRoot: () => projectRoot,
      fetch: fetchMock,
      now: () => {
        currentTime += 10;
        return currentTime;
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout) as {
      selectedCaseIds: string[];
      caseCount: number;
      providerCallCount: number;
      deterministicFinalCount: number;
      stateMetrics: { exactMatchCount: number; totalCases: number };
      usage: { inputTokens: number; outputTokens: number };
      estimatedCostUsd: number;
      unsupportedClaimRate: { status: string };
      automaticEvidenceChecks: { status: string };
      cases: Array<{ caseId: string; providerCalled: boolean }>;
    };
    expect(report.caseCount).toBe(65);
    expect(report.selectedCaseIds).toEqual(manifestCaseIds);
    expect(report.cases.map((entry) => entry.caseId)).toEqual(manifestCaseIds);
    expect(report.providerCallCount).toBe(requestCount);
    expect(report.providerCallCount).toBe(54);
    expect(report.deterministicFinalCount).toBe(11);
    expect(report.providerCallCount + report.deterministicFinalCount).toBe(65);
    expect(report.deterministicFinalCount).toBe(
      report.cases.filter((entry) => !entry.providerCalled).length,
    );
    expect(report.stateMetrics).toMatchObject({ totalCases: 65 });
    expect(report.usage.inputTokens).toBe(100 * requestCount);
    expect(report.usage.outputTokens).toBe(20 * requestCount);
    expect(report.estimatedCostUsd).toBeGreaterThan(0);
    expect(report.automaticEvidenceChecks.status).toBe('PASS');
    expect(report.unsupportedClaimRate.status).toBe('MANUAL_REVIEW_REQUIRED');
  });

  it('fails with empty stdout when no API key is supplied', async () => {
    const result = await runOpenAIProviderValidationCommand({
      apiKey: undefined,
      resolveProjectRoot: () => projectRoot,
    });
    expect(result).toMatchObject({ exitCode: 1, stdout: '' });
    expect(result.stderr).toContain('OpenAI provider validation failed');
  });

  it('identifies the failing golden case without exposing the credential', async () => {
    const secret = 'test-key-must-stay-secret';
    const result = await runOpenAIProviderValidationCommand({
      apiKey: secret,
      resolveProjectRoot: () => projectRoot,
      fetch: async () => new Response('{}', { status: 503 }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('SYNTH-CASE-001');
    expect(result.stderr).not.toContain(secret);
  });
});
