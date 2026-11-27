import type { SuggestedChangeActionGenerationOutput } from './suggested-action-generation-output.js';
import {
  SuggestedChangeActionGenerationOutputSchema,
  SuggestedChangeActionGenerationSchema,
} from './suggested-action-generation-output.js';
import {
  SuggestedChangeActionGenerationRequestSchema,
  type SuggestedChangeActionGenerationRequest,
} from './suggested-action-generation-request.js';
import {
  SuggestedChangeActionResultSchema,
  type SuggestedChangeActionResult,
} from './suggested-change-action.js';

/**
 * Injected action-generation boundary. Receives the complete strict action
 * generation request validated by the runner and returns the candidate
 * actions shaped as the existing generation output; the runner never touches
 * any provider, SDK, API, credential, or prompt text.
 */
export type SuggestedChangeActionGenerator = (
  request: SuggestedChangeActionGenerationRequest,
) => Promise<SuggestedChangeActionGenerationOutput>;

/**
 * Orchestrate one validated action-generation request into a validated,
 * human-facing `SuggestedChangeActionResult` using only the existing Phase 1J
 * contracts.
 *
 * The runner first parses the caller's request through the unchanged
 * `SuggestedChangeActionGenerationRequestSchema` into the authoritative
 * request, so a non-actionable analysis, an event/profile version mismatch,
 * a strict extra key, or an explicit `undefined` anywhere in the request is
 * rejected before the generator runs. Because schema parsing shares nested
 * members with the caller's input by reference, the runner additionally
 * re-parses a lossless JSON clone of the authoritative request through the
 * same schema and hands that structurally separate clone to the injected
 * generator exactly once, so any in-place inspection or mutation by the
 * generator cannot reach the authoritative request, the caller's objects, or
 * the returned envelope. The generator's return value is parsed through the
 * unchanged `SuggestedChangeActionGenerationOutputSchema` (rejecting
 * malformed, empty, or duplicate-actionId outputs), the authoritative
 * request and output are joined through the existing
 * `SuggestedChangeActionGenerationSchema` so the envelope ownership
 * refinement re-runs every Phase 1J-1 boundary against the pair (no dangling
 * evidence, deterministic/AI origin rules, combined actionId uniqueness), and
 * finally the same analysis record and action order are re-parsed through
 * the unchanged `SuggestedChangeActionResultSchema` as a self-check of the
 * returned result.
 *
 * The runner is suggestion-only: it never executes an action, creates a
 * ticket, sends a notification, persists anything, or consults a provider.
 * It never mutates any input, never generates an identifier or clock value,
 * and equal inputs with an equal generator result always yield a deep-equal
 * result that round-trips through JSON unchanged.
 */
export async function generateSuggestedChangeActionResult(
  request: SuggestedChangeActionGenerationRequest,
  generator: SuggestedChangeActionGenerator,
): Promise<SuggestedChangeActionResult> {
  // One strict parse of the caller's request before anything else. This
  // value is the authoritative request: the sole request joined with the
  // generator output below and the sole source of the returned result's
  // analysis record. It is never handed to the generator, because schema
  // parsing shares nested members with the caller's input by reference.
  const authoritativeRequest =
    SuggestedChangeActionGenerationRequestSchema.parse(request);

  // Structurally separate clone for the generator: a JSON round-trip (always
  // lossless for accepted requests, whose undefined-free refinement
  // guarantees JSON safety) followed by a full re-parse through the same
  // unchanged schema. Only this clone reaches the generator, so any in-place
  // inspection or mutation by the generator can never reach the
  // authoritative request, the caller's objects, or the returned envelope.
  const generatorRequest = SuggestedChangeActionGenerationRequestSchema.parse(
    JSON.parse(JSON.stringify(authoritativeRequest)) as unknown,
  );

  // Exactly one generator call, receiving the runner-owned clone.
  const rawOutput = await generator(generatorRequest);

  // The untrusted generator return value must be a complete existing
  // generation output before any ownership work happens.
  const parsedOutput =
    SuggestedChangeActionGenerationOutputSchema.parse(rawOutput);

  // Join the authoritative request with the parsed output through the
  // existing envelope schema: its ownership refinement re-parses the pair
  // through the unchanged result contract, so dangling evidence, origin
  // violations, duplicate action IDs, and non-actionable states cannot cross.
  const generation = SuggestedChangeActionGenerationSchema.parse({
    request: authoritativeRequest,
    output: parsedOutput,
  });

  // Self-verify the returned shape with the existing result schema over the
  // same analysis record and actions the envelope just accepted, preserving
  // the output's action order exactly.
  return SuggestedChangeActionResultSchema.parse({
    analysisRecord: generation.request.analysisRecord,
    actions: generation.output.actions,
  });
}
