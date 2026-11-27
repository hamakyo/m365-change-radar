import { readFileSync } from 'node:fs';

import { expect, expectTypeOf, it, describe } from 'vitest';

import {
  AIInferenceSchema,
  AnalysisRecordSchema,
  ProvenanceRecordSchema,
  StructuredClassificationAIInferenceSchema,
  StructuredImpactClassificationOutputSchema,
  type AIInference,
  type StructuredClassificationAIInference,
  type StructuredImpactClassificationOutput,
} from '../src/index.js';
import { StructuredImpactClassificationOutputSchema as OutputFromLeafModule } from '../src/domain/structured-classification-output.js';

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

function recordsFrom(analysis: Record<string, unknown>): unknown[] {
  const records = analysis.provenanceRecords;
  if (!Array.isArray(records)) {
    throw new Error('analysis fixture has no provenance records');
  }
  return records;
}

function proposalFor(
  proposedState: StructuredImpactClassificationOutput['proposedState'],
): StructuredImpactClassificationOutput {
  const base = {
    confidence: 0.82,
    reason: 'Notify the Teams owner before the deadline.',
    affectedComponents: ['Microsoft Teams'],
    supportingEvidenceIds: ['source.deadline', 'tenant.services.teams'],
  };
  switch (proposedState) {
    case 'ACTION_REQUIRED':
      return { proposedState: 'ACTION_REQUIRED', ...base };
    case 'REVIEW_REQUIRED':
      return { proposedState: 'REVIEW_REQUIRED', ...base };
    case 'INFORMATIONAL':
      return { proposedState: 'INFORMATIONAL', ...base };
    case 'NOT_APPLICABLE':
      return { proposedState: 'NOT_APPLICABLE', ...base };
    case 'INSUFFICIENT_CONTEXT':
      return {
        proposedState: 'INSUFFICIENT_CONTEXT',
        ...base,
        reason: 'Tenant context is incomplete for a decision.',
        affectedComponents: [],
        missingContext: ['/services/stream', '/capabilities/viva'],
      };
  }
}

function structuredRecordFor(
  output: StructuredImpactClassificationOutput,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: 'ai_inference',
    evidenceId: 'ai.structured-proposal',
    promptVersion: 'prompt-2026-08',
    model: 'gpt-5.6-luna',
    modelVersion: 'gpt-5.6-luna-2026-08-01',
    confidence: output.confidence,
    inference: output.reason,
    dependsOnEvidenceIds: [...output.supportingEvidenceIds],
    classificationOutput: output,
    ...overrides,
  };
}

describe('Structured classification AI provenance contract', () => {
  it('keeps accepting the existing generic AI inference record shape', () => {
    const withAI = asRecord(readFixture('analysis-record-ai.json'));
    const aiRecord = asRecord(recordsFrom(withAI)[3]);
    if (aiRecord.kind !== 'ai_inference') {
      throw new Error('fixture record is not an ai_inference');
    }

    expect('classificationOutput' in aiRecord).toBe(false);
    expect(AIInferenceSchema.parse(aiRecord)).toEqual(aiRecord);
    expect(ProvenanceRecordSchema.parse(aiRecord)).toEqual(aiRecord);
    expect(
      StructuredClassificationAIInferenceSchema.safeParse(aiRecord).success,
    ).toBe(false);

    const parsed = AIInferenceSchema.parse(aiRecord);
    expect(parsed.classificationOutput).toBeUndefined();
    expect(AIInferenceSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(
      parsed,
    );
  });

  it('accepts all five proposedState variants and preserves their exact values', () => {
    const states = [
      'ACTION_REQUIRED',
      'REVIEW_REQUIRED',
      'INFORMATIONAL',
      'NOT_APPLICABLE',
      'INSUFFICIENT_CONTEXT',
    ] as const;

    states.forEach((state) => {
      const output = proposalFor(state);
      const record = structuredRecordFor(output);

      expect(
        StructuredClassificationAIInferenceSchema.safeParse(record).success,
      ).toBe(true);
      expect(ProvenanceRecordSchema.safeParse(record).success).toBe(true);
      expect(AIInferenceSchema.safeParse(record).success).toBe(true);

      const parsed = StructuredClassificationAIInferenceSchema.parse(record);
      expect(parsed.classificationOutput).toEqual(output);
    });

    const insufficient = StructuredClassificationAIInferenceSchema.parse(
      structuredRecordFor(proposalFor('INSUFFICIENT_CONTEXT')),
    );
    const output = insufficient.classificationOutput;
    if (output.proposedState !== 'INSUFFICIENT_CONTEXT') {
      throw new Error('expected the INSUFFICIENT_CONTEXT variant');
    }
    expect(output.missingContext).toEqual([
      '/services/stream',
      '/capabilities/viva',
    ]);
  });

  it('round-trips classificationOutput losslessly through JSON for every variant', () => {
    const states = [
      'ACTION_REQUIRED',
      'REVIEW_REQUIRED',
      'INFORMATIONAL',
      'NOT_APPLICABLE',
      'INSUFFICIENT_CONTEXT',
    ] as const;

    states.forEach((state) => {
      const output = proposalFor(state);
      const record = structuredRecordFor(output);

      const serialized = JSON.stringify(record);
      const revived = JSON.parse(serialized) as unknown;
      const reparsed = StructuredClassificationAIInferenceSchema.parse(revived);

      // Deterministic serialization: formatting the parsed record again
      // produces byte-identical JSON, proving no value was normalized away.
      expect(JSON.stringify(reparsed)).toBe(serialized);
      expect(reparsed.classificationOutput).toEqual(output);
    });
  });

  it('rejects a structured record without complete classificationOutput', () => {
    const output = proposalFor('REVIEW_REQUIRED');

    expect(
      StructuredClassificationAIInferenceSchema.safeParse({
        ...structuredRecordFor(output),
        classificationOutput: undefined,
      }).success,
    ).toBe(false);

    // The field is entirely absent from the record object.
    const withoutOutput: Record<string, unknown> = structuredRecordFor(output);
    delete withoutOutput.classificationOutput;
    expect(
      StructuredClassificationAIInferenceSchema.safeParse(withoutOutput)
        .success,
    ).toBe(false);

    expect(
      StructuredClassificationAIInferenceSchema.safeParse({
        ...structuredRecordFor(proposalFor('INSUFFICIENT_CONTEXT')),
        classificationOutput: {
          proposedState: 'INSUFFICIENT_CONTEXT',
          confidence: 0.82,
          reason: 'Tenant context is incomplete for a decision.',
          affectedComponents: [],
          supportingEvidenceIds: ['source.deadline', 'tenant.services.teams'],
        },
      }).success,
    ).toBe(false);

    expect(
      StructuredClassificationAIInferenceSchema.safeParse(
        structuredRecordFor(output, {
          classificationOutput: {
            proposedState: 'MAYBE_LATER',
            confidence: 0.82,
            reason: 'Not a real state.',
            affectedComponents: [],
            supportingEvidenceIds: ['source.deadline', 'tenant.services.teams'],
          },
        }),
      ).success,
    ).toBe(false);
  });

  it('rejects unknown extra fields on the record and inside classificationOutput', () => {
    const output = proposalFor('REVIEW_REQUIRED');

    expect(
      AIInferenceSchema.safeParse(
        structuredRecordFor(output, { unsupportedField: true }),
      ).success,
    ).toBe(false);
    expect(
      AIInferenceSchema.safeParse(
        structuredRecordFor(output, {
          classificationOutput: { ...output, extraKey: 1 },
        }),
      ).success,
    ).toBe(false);
    expect(
      AIInferenceSchema.safeParse(
        structuredRecordFor(output, { unsupportedField: true }),
      ).success,
    ).toBe(false);
  });

  it('requires the record to own confidence, reason, and ordered dependencies', () => {
    const output = proposalFor('ACTION_REQUIRED');

    expect(
      StructuredClassificationAIInferenceSchema.safeParse(
        structuredRecordFor(output, { confidence: 0.42 }),
      ).success,
    ).toBe(false);
    expect(
      StructuredClassificationAIInferenceSchema.safeParse(
        structuredRecordFor(output, { inference: 'A different reason.' }),
      ).success,
    ).toBe(false);

    // Missing: the record lists fewer dependencies than the output owns.
    expect(
      StructuredClassificationAIInferenceSchema.safeParse(
        structuredRecordFor(output, {
          dependsOnEvidenceIds: ['source.deadline'],
        }),
      ).success,
    ).toBe(false);

    // Surplus: the record claims an unrelated additional dependency.
    expect(
      StructuredClassificationAIInferenceSchema.safeParse(
        structuredRecordFor(output, {
          dependsOnEvidenceIds: [
            'source.deadline',
            'tenant.services.teams',
            'rule.teams-review',
          ],
        }),
      ).success,
    ).toBe(false);

    // Reversed order is rejected even though the ID sets agree.
    expect(
      StructuredClassificationAIInferenceSchema.safeParse(
        structuredRecordFor(output, {
          dependsOnEvidenceIds: ['tenant.services.teams', 'source.deadline'],
        }),
      ).success,
    ).toBe(false);

    // Duplicated entries never satisfy the ownership constraint.
    expect(
      StructuredClassificationAIInferenceSchema.safeParse(
        structuredRecordFor(output, {
          dependsOnEvidenceIds: ['source.deadline', 'source.deadline'],
        }),
      ).success,
    ).toBe(false);

    // Same length but a different value is rejected.
    expect(
      StructuredClassificationAIInferenceSchema.safeParse(
        structuredRecordFor(output, {
          dependsOnEvidenceIds: ['source.deadline', 'rule.other-rule'],
        }),
      ).success,
    ).toBe(false);
  });

  it('rejects -0 confidence on the structured provenance record', () => {
    // The shared output schema rejects negative zero in every variant, so
    // the embedded classificationOutput can never carry it either.
    const negativeZero = {
      ...proposalFor('ACTION_REQUIRED'),
      confidence: -0,
    };
    expect(
      StructuredImpactClassificationOutputSchema.safeParse(negativeZero)
        .success,
    ).toBe(false);
    expect(
      StructuredClassificationAIInferenceSchema.safeParse(
        structuredRecordFor(negativeZero),
      ).success,
    ).toBe(false);
    expect(
      AIInferenceSchema.safeParse(structuredRecordFor(negativeZero)).success,
    ).toBe(false);
    expect(
      ProvenanceRecordSchema.safeParse(structuredRecordFor(negativeZero))
        .success,
    ).toBe(false);

    // Positive zero is accepted on the same path, owned by both the record
    // and its embedded output.
    const positiveZero = {
      ...proposalFor('ACTION_REQUIRED'),
      confidence: 0,
    };
    const parsed = StructuredClassificationAIInferenceSchema.parse(
      structuredRecordFor(positiveZero),
    );
    expect(Object.is(parsed.confidence, 0)).toBe(true);
    expect(Object.is(parsed.classificationOutput.confidence, 0)).toBe(true);
  });

  it('validates a structured proposal inside an AI-enabled analysis record', () => {
    const fixture = asRecord(readFixture('analysis-record-ai.json'));
    const records = recordsFrom(fixture);
    const aiRecord = asRecord(records[3]);
    if (aiRecord.kind !== 'ai_inference') {
      throw new Error('fixture AI record is missing');
    }

    const output = proposalFor('REVIEW_REQUIRED');
    const structured = structuredRecordFor(output, {
      evidenceId: aiRecord.evidenceId,
      promptVersion: aiRecord.promptVersion,
      model: aiRecord.model,
      modelVersion: aiRecord.modelVersion,
    });
    const analysis = {
      ...fixture,
      provenanceRecords: records.map((record, index) =>
        index === 3 ? structured : record,
      ),
    };

    const parsed = AnalysisRecordSchema.parse(analysis);
    const parsedStructured = parsed.provenanceRecords[3];
    if (
      parsedStructured === undefined ||
      parsedStructured.kind !== 'ai_inference' ||
      parsedStructured.classificationOutput === undefined
    ) {
      throw new Error('structured classificationOutput was lost');
    }
    expect(parsedStructured.classificationOutput).toEqual(output);
    expect(parsed.versionBundle.ai.used).toBe(true);

    // Execution identity still binds to the bundle.
    (
      [
        ['promptVersion', 'prompt-other-version'],
        ['model', 'other-model'],
        ['modelVersion', 'other-model-version'],
      ] as const
    ).forEach(([field, value]) => {
      expect(
        AnalysisRecordSchema.safeParse({
          ...analysis,
          provenanceRecords: records.map((record, index) =>
            index === 3
              ? {
                  ...structured,
                  [field]: value,
                }
              : record,
          ),
        }).success,
      ).toBe(false);
    });

    // The structured proposal is also valid as the analysis's evidence.
    const parsedAgain = AnalysisRecordSchema.parse(analysis);
    expect(parsedAgain.impactAssessment.state).toBe('REVIEW_REQUIRED');
    if (parsedAgain.impactAssessment.state !== 'REVIEW_REQUIRED') {
      throw new Error('assessment state changed');
    }
    expect(parsedAgain.impactAssessment.evidence).toContain(
      'ai.impact-summary',
    );
  });

  it('round-trips the whole structured analysis record deterministically', () => {
    const fixture = asRecord(readFixture('analysis-record-ai.json'));
    const records = recordsFrom(fixture);
    const aiRecord = asRecord(records[3]);

    const structured = structuredRecordFor(proposalFor('REVIEW_REQUIRED'), {
      evidenceId: aiRecord.evidenceId,
      promptVersion: aiRecord.promptVersion,
      model: aiRecord.model,
      modelVersion: aiRecord.modelVersion,
    });
    const analysis = {
      ...fixture,
      provenanceRecords: records.map((record, index) =>
        index === 3 ? structured : record,
      ),
    };

    const parsed = AnalysisRecordSchema.parse(analysis);
    expect(
      AnalysisRecordSchema.parse(JSON.parse(JSON.stringify(parsed))),
    ).toEqual(parsed);
  });

  it('rejects dangling dependencies introduced consistently on both sides', () => {
    const fixture = asRecord(readFixture('analysis-record-ai.json'));
    const records = recordsFrom(fixture);
    const aiRecord = asRecord(records[3]);

    // Ownership is deliberately satisfied, so the failure comes from the
    // envelope's dependency-closure check alone.
    const dangling = {
      ...structuredRecordFor(proposalFor('REVIEW_REQUIRED'), {
        evidenceId: aiRecord.evidenceId,
        promptVersion: aiRecord.promptVersion,
        model: aiRecord.model,
        modelVersion: aiRecord.modelVersion,
      }),
      dependsOnEvidenceIds: ['ghost.dependency'],
      classificationOutput: {
        ...proposalFor('REVIEW_REQUIRED'),
        supportingEvidenceIds: ['ghost.dependency'],
      },
    };

    expect(
      StructuredClassificationAIInferenceSchema.safeParse(dangling).success,
    ).toBe(true);
    expect(
      AnalysisRecordSchema.safeParse({
        ...fixture,
        provenanceRecords: records.map((record, index) =>
          index === 3 ? dangling : record,
        ),
      }).success,
    ).toBe(false);
  });

  it('rejects AI provenance when the version bundle says AI was not used', () => {
    const noAI = asRecord(readFixture('analysis-record-no-ai.json'));
    const structured = structuredRecordFor(proposalFor('INFORMATIONAL'));

    expect(
      AnalysisRecordSchema.safeParse({
        ...noAI,
        provenanceRecords: [...recordsFrom(noAI), structured],
      }).success,
    ).toBe(false);
  });

  it('keeps the structured output schema identical across every export path', () => {
    expect(StructuredImpactClassificationOutputSchema).toBe(
      OutputFromLeafModule,
    );
  });

  it('keeps the structured type classificationOutput-required at the type level', () => {
    // The required field must come from the schema's own Zod object, so the
    // inferred type carries a non-optional `classificationOutput`.
    expectTypeOf<
      StructuredClassificationAIInference['classificationOutput']
    >().toEqualTypeOf<StructuredImpactClassificationOutput>();

    expectTypeOf<StructuredClassificationAIInference>().toExtend<{
      classificationOutput: StructuredImpactClassificationOutput;
    }>();
    expectTypeOf<StructuredClassificationAIInference>().toExtend<AIInference>();

    // A generic AI inference is never assignable to the classification-
    // specific required-output shape: `classificationOutput` may be absent
    // (or explicitly undefined) there.
    expectTypeOf<
      AIInference extends {
        classificationOutput: StructuredImpactClassificationOutput;
      }
        ? true
        : false
    >().toEqualTypeOf<false>();

    const generic: AIInference = AIInferenceSchema.parse({
      kind: 'ai_inference',
      evidenceId: 'ai.type-level-generic',
      promptVersion: 'prompt-2026-08',
      model: 'gpt-5.6-luna',
      modelVersion: 'gpt-5.6-luna-2026-08-01',
      confidence: 0.82,
      inference: 'Generic inference without an output.',
      dependsOnEvidenceIds: ['source.deadline'],
    });
    expect(generic.classificationOutput).toBeUndefined();

    // Compile-time guarantee: stripping the optional member still leaves a
    // record that fails to satisfy the required-output contract.
    expectTypeOf<
      Omit<
        AIInference,
        'classificationOutput'
      > extends StructuredClassificationAIInference
        ? true
        : false
    >().toEqualTypeOf<false>();

    // Runtime correspondence of the same boundary: a record without the
    // field satisfies only the generic schema.
    const baseRecord = structuredRecordFor(proposalFor('REVIEW_REQUIRED'));
    delete baseRecord.classificationOutput;
    expect(AIInferenceSchema.safeParse(baseRecord).success).toBe(true);
    expect(
      StructuredClassificationAIInferenceSchema.safeParse(baseRecord).success,
    ).toBe(false);
  });
});
