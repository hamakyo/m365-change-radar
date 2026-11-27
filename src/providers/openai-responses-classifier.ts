import { z } from 'zod';

import type { StructuredImpactClassifier } from '../domain/impact-analysis-runner.js';
import {
  StructuredClassificationAIInferenceSchema,
  type StructuredClassificationAIInference,
} from '../domain/provenance.js';
import {
  StructuredImpactClassificationOutputSchema,
  StructuredImpactClassificationRequestSchema,
  StructuredImpactClassificationSchema,
  type StructuredImpactClassificationOutput,
  type StructuredImpactClassificationRequest,
} from '../domain/structured-impact-classification.js';

export const OPENAI_RESPONSES_MODEL = 'gpt-5.4-mini';
export const OPENAI_RESPONSES_MODEL_VERSION = 'gpt-5.4-mini-2026-03-17';
export const OPENAI_RESPONSES_PROMPT_VERSION =
  'm365-change-radar-impact-classifier-v3';

const OPENAI_RESPONSES_ENDPOINT = 'https://api.openai.com/v1/responses';
const DEFAULT_TIMEOUT_MS = 60_000;

const wireOutputSchema = z
  .object({
    proposedState: z.enum([
      'ACTION_REQUIRED',
      'REVIEW_REQUIRED',
      'INFORMATIONAL',
      'NOT_APPLICABLE',
      'INSUFFICIENT_CONTEXT',
    ]),
    confidence: z.number().finite().min(0).max(1),
    reason: z.string().min(1),
    affectedComponents: z.array(z.string().min(1)),
    supportingEvidenceIds: z.array(z.string().min(1)).min(1),
    missingContext: z.array(z.string().min(1)).min(1).nullable(),
  })
  .strict();

const responseUsageSchema = z
  .object({
    input_tokens: z.number().int().min(0),
    output_tokens: z.number().int().min(0),
    total_tokens: z.number().int().min(0),
    input_tokens_details: z
      .object({
        cached_tokens: z.number().int().min(0).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const responseEnvelopeSchema = z
  .object({
    id: z.string().min(1),
    status: z.string().min(1),
    model: z.string().min(1),
    output: z.array(z.unknown()),
    usage: responseUsageSchema.nullable(),
  })
  .passthrough();

const outputTextSchema = z
  .object({
    type: z.literal('output_text'),
    text: z.string().min(1),
  })
  .passthrough();

const refusalSchema = z
  .object({
    type: z.literal('refusal'),
    refusal: z.string().min(1),
  })
  .passthrough();

const messageSchema = z
  .object({
    type: z.literal('message'),
    content: z.array(z.unknown()),
  })
  .passthrough();

export type OpenAIProviderValidationObservation = {
  readonly responseId: string;
  readonly modelVersion: string;
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
};

export type OpenAIResponsesClassifier = StructuredImpactClassifier & {
  getObservations(): readonly OpenAIProviderValidationObservation[];
};

export type OpenAIResponsesClassifierOptions = {
  readonly apiKey: string;
  readonly modelVersion?: string;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
};

const structuredOutputJsonSchema = {
  type: 'object',
  properties: {
    proposedState: {
      type: 'string',
      enum: [
        'ACTION_REQUIRED',
        'REVIEW_REQUIRED',
        'INFORMATIONAL',
        'NOT_APPLICABLE',
        'INSUFFICIENT_CONTEXT',
      ],
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reason: { type: 'string', minLength: 1 },
    affectedComponents: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
    },
    supportingEvidenceIds: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      minItems: 1,
    },
    missingContext: {
      anyOf: [
        {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          minItems: 1,
        },
        { type: 'null' },
      ],
    },
  },
  required: [
    'proposedState',
    'confidence',
    'reason',
    'affectedComponents',
    'supportingEvidenceIds',
    'missingContext',
  ],
  additionalProperties: false,
} as const;

function createStructuredOutputJsonSchema(
  request: StructuredImpactClassificationRequest,
) {
  return {
    ...structuredOutputJsonSchema,
    properties: {
      ...structuredOutputJsonSchema.properties,
      supportingEvidenceIds: {
        ...structuredOutputJsonSchema.properties.supportingEvidenceIds,
        items: {
          type: 'string',
          enum: request.evidenceRecords.map((record) => record.evidenceId),
        },
      },
    },
  } as const;
}

const CLASSIFIER_INSTRUCTIONS = `You classify one Microsoft 365 change for one tenant.
Use only facts and deterministic conclusions in the supplied request. Never invent a Microsoft statement or tenant configuration.
Return the raw proposed state before deterministic guardrail floors are applied.
You are creating that raw proposal now. The absence of an earlier classifier proposal is never missing tenant context.
Ignore stateFloor when choosing proposedState; the existing deterministic merge applies it after your response.
supportingEvidenceIds must copy only evidenceId property values from request.evidenceRecords. Never use a fact path, field name, service name, or condition path in place of an evidenceId.
affectedComponents must contain only exact strings present in changeEvent.products or changeEvent.categories.
Use INSUFFICIENT_CONTEXT only when a missing fact prevents classification. Then missingContext must list the missing paths. For every other state missingContext must be null.
Keep reason concise and explicitly grounded in the selected evidence.`;

function extractOutputText(output: readonly unknown[]): string {
  for (const item of output) {
    const message = messageSchema.safeParse(item);
    if (!message.success) continue;
    for (const content of message.data.content) {
      const refusal = refusalSchema.safeParse(content);
      if (refusal.success) {
        throw new Error(`OpenAI Responses classifier refused the request`);
      }
      const outputText = outputTextSchema.safeParse(content);
      if (outputText.success) return outputText.data.text;
    }
  }
  throw new Error('OpenAI Responses classifier returned no output text');
}

function toDomainOutput(
  request: StructuredImpactClassificationRequest,
  value: unknown,
): StructuredImpactClassificationOutput {
  const wire = wireOutputSchema.parse(value);
  const allowedComponents = new Set([
    ...request.changeEvent.products,
    ...request.changeEvent.categories,
  ]);
  for (const component of wire.affectedComponents) {
    if (!allowedComponents.has(component)) {
      throw new Error(
        `OpenAI Responses classifier returned an unsupported affected component: ${component}`,
      );
    }
  }

  const output =
    wire.proposedState === 'INSUFFICIENT_CONTEXT'
      ? {
          proposedState: wire.proposedState,
          confidence: wire.confidence,
          reason: wire.reason,
          affectedComponents: wire.affectedComponents,
          supportingEvidenceIds: wire.supportingEvidenceIds,
          missingContext:
            wire.missingContext ??
            (() => {
              throw new Error(
                'OpenAI Responses classifier omitted missingContext for INSUFFICIENT_CONTEXT',
              );
            })(),
        }
      : {
          proposedState: wire.proposedState,
          confidence: wire.confidence,
          reason: wire.reason,
          affectedComponents: wire.affectedComponents,
          supportingEvidenceIds: wire.supportingEvidenceIds,
          ...(() => {
            if (wire.missingContext !== null) {
              throw new Error(
                'OpenAI Responses classifier returned missingContext for a non-INSUFFICIENT_CONTEXT state',
              );
            }
            return {};
          })(),
        };

  const parsedOutput = StructuredImpactClassificationOutputSchema.parse(output);
  StructuredImpactClassificationSchema.parse({ request, output: parsedOutput });
  return parsedOutput;
}

function safeProviderError(status: number): Error {
  return new Error(`OpenAI Responses API request failed with status ${status}`);
}

export function createOpenAIResponsesClassifier(
  options: OpenAIResponsesClassifierOptions,
): OpenAIResponsesClassifier {
  const apiKey = z.string().min(1).parse(options.apiKey);
  const modelVersion = z
    .string()
    .min(1)
    .parse(options.modelVersion ?? OPENAI_RESPONSES_MODEL_VERSION);
  const endpoint = z.url().parse(options.endpoint ?? OPENAI_RESPONSES_ENDPOINT);
  const timeoutMs = z
    .number()
    .int()
    .positive()
    .parse(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => performance.now());
  const observations: OpenAIProviderValidationObservation[] = [];

  const classifier = (async (requestInput) => {
    const request =
      StructuredImpactClassificationRequestSchema.parse(requestInput);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = now();
    let response: Response;
    let responseText: string;
    try {
      response = await fetchImplementation(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: modelVersion,
          store: false,
          reasoning: { effort: 'low' },
          instructions: CLASSIFIER_INSTRUCTIONS,
          input: JSON.stringify(request),
          text: {
            format: {
              type: 'json_schema',
              name: 'm365_change_impact_classification',
              strict: true,
              schema: createStructuredOutputJsonSchema(request),
            },
          },
        }),
        signal: controller.signal,
      });
      responseText = await response.text();
    } finally {
      clearTimeout(timeout);
    }
    const latencyMs = Math.max(0, now() - startedAt);
    if (!response.ok) throw safeProviderError(response.status);

    let responseValue: unknown;
    try {
      responseValue = JSON.parse(responseText) as unknown;
    } catch (error) {
      throw new Error('OpenAI Responses API returned invalid JSON', {
        cause: error,
      });
    }

    const envelope = responseEnvelopeSchema.parse(responseValue);
    if (envelope.status !== 'completed') {
      throw new Error(
        `OpenAI Responses classifier returned non-completed status: ${envelope.status}`,
      );
    }
    if (envelope.usage === null) {
      throw new Error('OpenAI Responses classifier returned no usage record');
    }

    const outputText = extractOutputText(envelope.output);
    let outputValue: unknown;
    try {
      outputValue = JSON.parse(outputText) as unknown;
    } catch (error) {
      throw new Error('OpenAI Responses classifier returned invalid JSON', {
        cause: error,
      });
    }
    const output = toDomainOutput(request, outputValue);
    const inference: StructuredClassificationAIInference = {
      kind: 'ai_inference',
      evidenceId: 'ai.openai-responses.classification',
      promptVersion: OPENAI_RESPONSES_PROMPT_VERSION,
      model: OPENAI_RESPONSES_MODEL,
      modelVersion: envelope.model,
      confidence: output.confidence,
      inference: output.reason,
      dependsOnEvidenceIds: [...output.supportingEvidenceIds],
      classificationOutput: output,
    };

    observations.push({
      responseId: envelope.id,
      modelVersion: envelope.model,
      latencyMs: Number(latencyMs.toFixed(3)),
      inputTokens: envelope.usage.input_tokens,
      cachedInputTokens:
        envelope.usage.input_tokens_details?.cached_tokens ?? 0,
      outputTokens: envelope.usage.output_tokens,
      totalTokens: envelope.usage.total_tokens,
    });
    return StructuredClassificationAIInferenceSchema.parse(inference);
  }) as OpenAIResponsesClassifier;

  classifier.getObservations = () =>
    observations.map((observation) => ({ ...observation }));
  return classifier;
}
