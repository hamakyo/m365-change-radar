import { z } from 'zod';

import {
  AnalysisRecordSchema,
  type AnalysisRecord,
} from './analysis-record.js';
import { ChangeEventSchema, type ChangeEvent } from './change-event.js';
import { TenantProfileSchema, type TenantProfile } from './tenant-profile.js';

const nonEmptyString = z.string().min(1);

function addIssue(
  context: z.RefinementCtx,
  path: PropertyKey[],
  message: string,
): void {
  context.addIssue({ code: 'custom', path, message });
}

/** The analysis states from which generating suggested actions is legitimate.
 * This is the exact boundary enforced by the Phase 1J-1
 * `SuggestedChangeActionResult` gate. */
const actionableStates: readonly string[] = [
  'ACTION_REQUIRED',
  'REVIEW_REQUIRED',
];

type RequestInput = {
  changeEvent: ChangeEvent;
  sourceMessageVersion: string;
  tenantProfile: TenantProfile;
  analysisRecord: AnalysisRecord;
};

/**
 * Cross-record ownership refinements for the action generation request.
 * Checks run against the parsed request only; no raw caller input object is
 * read or written. Identity/version boundary only:
 *
 * - `actionGenerationEligibility`: the bundled analysis's final state must be
 *   ACTION_REQUIRED or REVIEW_REQUIRED; INFORMATIONAL, NOT_APPLICABLE, and
 *   INSUFFICIENT_CONTEXT are rejected as non-actionable inputs (the same
 *   boundary as the Phase 1J-1 result gate);
 * - `actionRequestSourceOwnership`: the request ChangeEvent's `source` and
 *   `externalId` must exactly equal the analysis record's `changeEventRef`,
 *   and the standalone request version must exactly equal both
 *   `changeEventRef.sourceMessageVersion` and
 *   `versionBundle.sourceMessageVersion`;
 * - `actionRequestTenantOwnership`: the request profile's `profileVersion`
 *   must exactly equal `versionBundle.tenantProfileVersion`.
 *
 * The request deliberately does NOT re-resolve fact observation path/value
 * pairs against the ChangeEvent or TenantProfile: that resolution already
 * happened upstream, and the provenance inside the analysis remains the sole
 * owner of those observations. Only identity and version boundaries are
 * enforced here so ownership cannot drift between the bundled analysis and
 * the original source/tenant inputs.
 */
function refineRequest(request: RequestInput, context: z.RefinementCtx): void {
  const { analysisRecord } = request;

  const assessmentState = analysisRecord.impactAssessment.state;
  if (!actionableStates.includes(assessmentState)) {
    addIssue(
      context,
      ['analysisRecord', 'impactAssessment', 'state'],
      `impactAssessment.state must be ACTION_REQUIRED or REVIEW_REQUIRED for suggested action generation: ${assessmentState}`,
    );
  }

  const eventRef = analysisRecord.changeEventRef;

  if (
    request.changeEvent.source !== eventRef.source ||
    request.changeEvent.externalId !== eventRef.externalId
  ) {
    addIssue(
      context,
      ['changeEvent'],
      'changeEvent source/externalId must exactly match analysisRecord.changeEventRef',
    );
  }

  if (request.sourceMessageVersion !== eventRef.sourceMessageVersion) {
    addIssue(
      context,
      ['sourceMessageVersion'],
      'sourceMessageVersion must exactly match analysisRecord.changeEventRef.sourceMessageVersion',
    );
  }

  if (
    request.sourceMessageVersion !==
    analysisRecord.versionBundle.sourceMessageVersion
  ) {
    addIssue(
      context,
      ['sourceMessageVersion'],
      'sourceMessageVersion must exactly match analysisRecord.versionBundle.sourceMessageVersion',
    );
  }

  if (
    request.tenantProfile.profileVersion !==
    analysisRecord.versionBundle.tenantProfileVersion
  ) {
    addIssue(
      context,
      ['tenantProfile', 'profileVersion'],
      'tenantProfile.profileVersion must exactly match analysisRecord.versionBundle.tenantProfileVersion',
    );
  }
}

/**
 * Recursively finds the first own property or array element holding an
 * explicit `undefined` in the given value and returns its dotted/bracketed
 * JSON-style path, or `undefined` when none exists. Traversal mirrors
 * serialization exposure: arrays are walked index-by-index (a sparse hole
 * serializes as `null` instead of vanishing, so only an actual `undefined`
 * element violates), while objects contribute every own property key —
 * string or symbol — via `Reflect.ownKeys`, so enumeration-hidden members an
 * identity-preserving writer could attach are inspected too. Cycles
 * terminate through identity tracking, and an own-property read that
 * unexpectedly throws (an exotic accessor on a hand-built input) is treated
 * as its own violation at that path rather than aborting the walk, keeping
 * acceptance a pure function of inspectable data. Only genuine
 * `value === undefined` is a violation — `null`, `false`, `0`, empty
 * strings, empty arrays, and empty objects are all valid here.
 */
function findExplicitUndefinedProperty(root: unknown): string | undefined {
  const visited = new Set<object>();

  function visit(value: unknown, path: string): string | undefined {
    if (value === undefined) {
      return path.length > 0 ? path : '<root>';
    }
    if (typeof value !== 'object' || value === null) {
      return undefined;
    }
    const container = value as Record<string | symbol, unknown>;
    if (visited.has(container)) {
      return undefined;
    }
    visited.add(container);
    const isArray = Array.isArray(container);
    for (const key of Reflect.ownKeys(container)) {
      const label =
        typeof key === 'symbol'
          ? `Symbol(${key.description ?? ''})`
          : String(key);
      const childPath = isArray
        ? `${path}[${label}]`
        : `${path.length > 0 ? `${path}.` : ''}${label}`;
      let child: unknown;
      try {
        child = container[key];
      } catch {
        return childPath;
      }
      const violation = visit(child, childPath);
      if (violation !== undefined) {
        return violation;
      }
    }
    return undefined;
  }

  return visit(root, '');
}

/**
 * Whole-request refusal of explicit `undefined` own properties and array
 * elements (`actionRequestUndefinedFree`). Member schemas preserve the exact
 * presence semantics of their inputs — a Zod object key assigned
 * `undefined` survives parsing as a present-but-`undefined` own property —
 * so an inner value such as `changeEvent.signals.isMajorChange: undefined`
 * or an optional tenant-profile member passed as `undefined` would otherwise
 * be accepted verbatim and then silently disappear through
 * `JSON.stringify`, violating this phase's JSON-safe promise. Because the
 * parsed members retain that presence, one recursive inspection of the fully
 * parsed request closes the gap everywhere at once: any depth of nested
 * optional member carrying `undefined` is reported with a dotted/bracketed
 * path to the offender, and the request is rejected. Falsy-but-defined
 * values (`null`, `false`, `0`, empty strings/arrays/objects) stay valid
 * wherever the member schemas allow them.
 */
function refineRequestIsUndefinedFree(
  request: RequestInput,
  context: z.RefinementCtx,
): void {
  const offenderPath = findExplicitUndefinedProperty(request);
  if (offenderPath !== undefined) {
    addIssue(
      context,
      [],
      `explicit undefined is not allowed anywhere in the request (found at: ${offenderPath})`,
    );
  }
}

/**
 * Strict JSON-safe request bundling one final actionable `AnalysisRecord`
 * with the complete `ChangeEvent`, its `sourceMessageVersion`, and the
 * `TenantProfile` it was evaluated against, ready to hand to a tenant-
 * specific action generator. Every member keeps its full existing validation
 * chain because each is declared with its unchanged schema:
 *
 * - `changeEvent`: the unchanged `ChangeEventSchema`;
 * - `sourceMessageVersion`: a non-empty string;
 * - `tenantProfile`: the unchanged `TenantProfileSchema`;
 * - `analysisRecord`: the unchanged `AnalysisRecordSchema`, so version-bundle
 *   agreement, dependency closure, evidence integrity, and the prohibition
 *   of AI inference records without an AI-enabled bundle keep being enforced
 *   by the existing schema chain. Because of that inherited validation, the
 *   source facts inside the analysis stay bound to one event ref/version and
 *   tenant facts to one profile version, and the policy/AI versions together
 *   with the dependency closure remain intact without any additional
 *   re-resolution here.
 *
 * On top of the inherited chains, the fully parsed request is recursively
 * inspected so an own property or array element holding an explicit
 * `undefined` — at any depth, including nested optional members like
 * `changeEvent.signals.isMajorChange` or an optional tenant-profile field —
 * is rejected with an explicit path (`actionRequestUndefinedFree`). Accepted
 * requests therefore round-trip through JSON without losing or inventing any
 * field.
 */
export const SuggestedChangeActionGenerationRequestSchema = z
  .object({
    changeEvent: ChangeEventSchema,
    sourceMessageVersion: nonEmptyString,
    tenantProfile: TenantProfileSchema,
    analysisRecord: AnalysisRecordSchema,
  })
  .strict()
  .superRefine(refineRequest)
  .superRefine(refineRequestIsUndefinedFree);

export type SuggestedChangeActionGenerationRequest = z.infer<
  typeof SuggestedChangeActionGenerationRequestSchema
>;

/**
 * Pure deterministic builder for tenant-specific action generation requests.
 * All four inputs are first parsed with their existing schemas — rejecting
 * strict extras, missing fields, and own-property explicit undefined at
 * every layer — then cross-checked by the request refinements above and
 * self-verified with a final parse through
 * `SuggestedChangeActionGenerationRequestSchema`. No clock, UUID, or provider
 * call is involved, no input object is mutated, identical inputs always
 * produce deep-equal requests, and accepted outputs round-trip through JSON.
 */
export function createSuggestedChangeActionGenerationRequest(
  changeEvent: ChangeEvent,
  sourceMessageVersion: string,
  tenantProfile: TenantProfile,
  analysisRecord: AnalysisRecord,
): SuggestedChangeActionGenerationRequest {
  const parsedChangeEvent = ChangeEventSchema.parse(changeEvent);
  const parsedSourceMessageVersion = nonEmptyString.parse(sourceMessageVersion);
  const parsedTenantProfile = TenantProfileSchema.parse(tenantProfile);
  const parsedAnalysisRecord = AnalysisRecordSchema.parse(analysisRecord);

  return SuggestedChangeActionGenerationRequestSchema.parse({
    changeEvent: parsedChangeEvent,
    sourceMessageVersion: parsedSourceMessageVersion,
    tenantProfile: parsedTenantProfile,
    analysisRecord: parsedAnalysisRecord,
  });
}
