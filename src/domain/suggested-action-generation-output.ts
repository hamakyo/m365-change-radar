import { z } from 'zod';

import {
  SuggestedChangeActionSchema,
  SuggestedChangeActionResultSchema,
} from './suggested-change-action.js';
import {
  SuggestedChangeActionGenerationRequestSchema,
  type SuggestedChangeActionGenerationRequest,
} from './suggested-action-generation-request.js';

/**
 * Strict JSON-safe output of an action generator: an ordered collection of
 * one or more suggested, never-executed `SuggestedChangeAction` values.
 * Each action keeps its full existing validation chain because the array is
 * declared with the unchanged `SuggestedChangeActionSchema` — origin
 * discrimination, confidence boundaries, assignment-field absence rules,
 * and unique supporting-evidence IDs are all inherited, not re-implemented.
 * Array order is preserved exactly as given: members parse in position
 * order and nothing reorders them.
 */
export const SuggestedChangeActionGenerationOutputSchema = z
  .object({
    actions: z.array(SuggestedChangeActionSchema).min(1),
  })
  .strict()
  .superRefine((output, context) => {
    const seenActionIds = new Set<string>();
    output.actions.forEach((action, index) => {
      if (seenActionIds.has(action.actionId)) {
        context.addIssue({
          code: 'custom',
          path: ['actions', index, 'actionId'],
          message: `duplicate actionId across the generation output: ${action.actionId}`,
        });
      }
      seenActionIds.add(action.actionId);
    });
  });

export type SuggestedChangeActionGenerationOutput = z.infer<
  typeof SuggestedChangeActionGenerationOutputSchema
>;

type GenerationInput = {
  request: SuggestedChangeActionGenerationRequest;
  output: SuggestedChangeActionGenerationOutput;
};

/**
 * Cross-field ownership refinement for the generation envelope
 * (`actionGenerationOutputOwnership`). Checks run against the fully parsed
 * envelope only; no raw caller input object is read or written.
 *
 * It rebuilds the exact `{ analysisRecord: request.analysisRecord, actions:
 * output.actions }` pair and hands that pair to the unchanged
 * `SuggestedChangeActionResultSchema`, so every Phase 1J-1 boundary is
 * inherited from that single contract instead of being re-implemented here:
 *
 * - the assessment state must be ACTION_REQUIRED or REVIEW_REQUIRED
 *   (`actionGenerationEligibility`, re-checked on the request's analysis);
 * - every `supportingEvidenceIds` entry exists in the request analysis's
 *   provenance (no dangling evidence);
 * - deterministic actions cite no `ai_inference` record and every
 *   AI-origin action cites at least one (deterministic/AI origin rules);
 * - every `actionId` is unique across the combined result (which subsumes
 *   output-wide uniqueness and re-checks it inside the full pair);
 * - the unchanged `AnalysisRecordSchema` chain (versions, dependency
 *   closure, evidence integrity) is re-parsed on the request's analysis.
 *
 * Failure issues are re-anchored under the member that owns the offending
 * data — result paths starting with `analysisRecord` are reported under
 * `request`, and result paths starting with `actions` are reported under
 * `output` — while keeping the rest of the result contract's path and the
 * exact issue message, so callers get recognizable diagnostics whether they
 * validate a result or a generation envelope.
 */
function refineActionGenerationOutputOwnership(
  generation: GenerationInput,
  context: z.RefinementCtx,
): void {
  const ownershipResult = SuggestedChangeActionResultSchema.safeParse({
    analysisRecord: generation.request.analysisRecord,
    actions: generation.output.actions,
  });
  if (ownershipResult.success) {
    return;
  }
  for (const issue of ownershipResult.error.issues) {
    const ownerKey = issue.path[0] === 'analysisRecord' ? 'request' : 'output';
    context.addIssue({
      code: 'custom',
      path: [ownerKey, ...issue.path],
      message: issue.message,
    });
  }
}

/**
 * Strict JSON-safe pairing of one validated
 * `SuggestedChangeActionGenerationRequest` with the
 * `SuggestedChangeActionGenerationOutput` produced for it. Both members are
 * declared with their unchanged schemas, so the request keeps its full
 * identity/version ownership chain (event ref, source message version,
 * tenant profile version, eligibility gate, and the request-wide
 * undefined-free inspection) and the output keeps its per-action chain plus
 * output-wide unique action IDs; neither side loses any field.
 *
 * On top of the member chains, `actionGenerationOutputOwnership` re-parses
 * the request's analysis together with the output's actions through the
 * unchanged Phase 1J-1 `SuggestedChangeActionResultSchema`, inheriting the
 * actionable-state gate, evidence-existence rule, deterministic/AI origin
 * rules, and combined actionId uniqueness from that single contract.
 *
 * Accepted envelopes are JSON-safe: both members round-trip losslessly, so
 * `JSON.stringify`/`JSON.parse` of an accepted envelope re-parses to
 * deep-equal data (the Phase 1J-1 confidence boundary already rejects the
 * `-0` values that serialization would silently flip to `0`).
 */
export const SuggestedChangeActionGenerationSchema = z
  .object({
    request: SuggestedChangeActionGenerationRequestSchema,
    output: SuggestedChangeActionGenerationOutputSchema,
  })
  .strict()
  .superRefine(refineActionGenerationOutputOwnership);

export type SuggestedChangeActionGeneration = z.infer<
  typeof SuggestedChangeActionGenerationSchema
>;
