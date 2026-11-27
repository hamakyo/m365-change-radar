import {
  SuggestedChangeActionGenerationOutputSchema,
  type SuggestedChangeActionGenerationOutput,
} from './suggested-action-generation-output.js';
import {
  SuggestedChangeActionGenerationRequestSchema,
  type SuggestedChangeActionGenerationRequest,
} from './suggested-action-generation-request.js';
import type {
  SuggestedChangeAction,
  SuggestedChangeActionKind,
} from './suggested-change-action.js';

/** Ordinal suffixes for the stable `action.<slug>-<ordinal>` ID scheme. */
const actionIdOrdinals = ['001', '002', '003', '004', '005'] as const;

/**
 * Fixed action-kind order for the `ACTION_REQUIRED` final state
 * (`deterministic action template` ordering rule). Generated action
 * sequences follow this order for the state and never repeat a kind.
 */
const actionRequiredKindOrder: readonly SuggestedChangeActionKind[] = [
  'INVESTIGATE',
  'PLAN',
  'IMPLEMENT',
  'COMMUNICATE',
  'VALIDATE',
];

/**
 * Fixed action-kind order for the `REVIEW_REQUIRED` final state. Review
 * work starts by understanding the change, communicates the review need,
 * and closes by validating the outcome, so the kind sequence stays narrower
 * than the actionable one.
 */
const reviewRequiredKindOrder: readonly SuggestedChangeActionKind[] = [
  'INVESTIGATE',
  'COMMUNICATE',
  'VALIDATE',
];

const kindOrderByState: Record<
  'ACTION_REQUIRED' | 'REVIEW_REQUIRED',
  readonly SuggestedChangeActionKind[]
> = {
  ACTION_REQUIRED: actionRequiredKindOrder,
  REVIEW_REQUIRED: reviewRequiredKindOrder,
};

/** Per-kind fixed template text for each final state. */
type TemplateSpec = {
  title: string;
  description: string;
};

type ActionableState = 'ACTION_REQUIRED' | 'REVIEW_REQUIRED';

const actionRequiredSpecs: Record<SuggestedChangeActionKind, TemplateSpec> = {
  INVESTIGATE: {
    title: 'Investigate {components}',
    description:
      'Confirm how {components} reaches this tenant and which configuration areas are affected, using the recorded analysis evidence before planning any work.',
  },
  PLAN: {
    title: 'Plan the tenant response for {components}',
    description:
      'Draft a tenant-specific response plan for {components}, including any known deadline recorded in the change signals, and align it with the accountable owners.',
  },
  IMPLEMENT: {
    title: 'Implement the configuration changes for {components}',
    description:
      "Apply the configuration changes {components} requires under this tenant's change policy once the plan is approved.",
  },
  COMMUNICATE: {
    title: 'Communicate {components} to stakeholders',
    description:
      'Notify the affected stakeholders about {components} and coordinate with the accountable service owners before any tenant-wide communication.',
  },
  VALIDATE: {
    title: 'Validate the tenant after the {components} change',
    description:
      'Verify that the tenant configuration behaves as expected after the {components} change and record the outcome against the recorded policy conclusions.',
  },
};

/**
 * Per-state template specs. The REVIEW_REQUIRED map is deliberately partial:
 * only the three kinds of the review order exist, so a kind outside the
 * state's fixed order has no template and can never be emitted.
 */
const reviewRequiredSpecs: Partial<
  Record<SuggestedChangeActionKind, TemplateSpec>
> = {
  INVESTIGATE: {
    title: 'Investigate {components} before the review',
    description:
      'Confirm how {components} reaches this tenant and collect the context the recorded policy conclusions already establish, before the review starts.',
  },
  COMMUNICATE: {
    title: 'Communicate the {components} review outcome',
    description:
      'Share the {components} review need and its outcome with the accountable service owners so the tenant decision is recorded.',
  },
  VALIDATE: {
    title: 'Validate the tenant during the {components} review',
    description:
      'Verify that the tenant configuration behaves as expected during the {components} review and record the outcome against the recorded policy conclusions.',
  },
};

const specsByState: Record<
  ActionableState,
  Partial<Record<SuggestedChangeActionKind, TemplateSpec>>
> = {
  ACTION_REQUIRED: actionRequiredSpecs,
  REVIEW_REQUIRED: reviewRequiredSpecs,
};

/**
 * Deterministic, source-data-derived component phrase for titles and
 * descriptions: the change event's `products` in event order, falling back
 * to `categories` in event order, then to a neutral phrase when the event
 * records neither. Both members are plain string arrays, so event order is
 * already a deterministic order.
 */
function componentPhrase(
  request: SuggestedChangeActionGenerationRequest,
): string {
  const products = request.changeEvent.products;
  if (products.length > 0) {
    return products.join(', ');
  }
  const categories = request.changeEvent.categories;
  if (categories.length > 0) {
    return categories.join(', ');
  }
  return 'the affected Microsoft 365 services';
}

/**
 * Append the component phrase to a template sentence in a fixed way: the
 * phrase is always wrapped in double quotes and spliced into the first
 * `{components}` placeholder of the template, so the wording stays stable
 * regardless of the component names themselves.
 */
function withComponents(template: string, components: string): string {
  return template.replace('{components}', `"${components}"`);
}

/**
 * Tenant-ownership-aware owner key: when the profile declares an ownership
 * map, the lexicographically first service with a non-empty owner value is
 * used as the fixed deterministic owner for every action. An absent or
 * ownerless map means the field stays absent (unknown is expressed by field
 * absence only, never a null or empty-string placeholder).
 */
function ownerKeyFor(
  request: SuggestedChangeActionGenerationRequest,
): string | undefined {
  const ownership = request.tenantProfile.ownership;
  const sortedKeys = Object.keys(ownership).sort();
  for (const key of sortedKeys) {
    const owner = ownership[key];
    if (typeof owner === 'string' && owner.length > 0) {
      return `${key}:${owner}`;
    }
  }
  return undefined;
}

/**
 * Deadline-aware dueAt: the change event's `actionRequiredBy` signal is the
 * only deadline a deterministic suggestion may carry, because it is source
 * data already recorded in the request. Absence keeps the field absent.
 */
function dueAtFor(
  request: SuggestedChangeActionGenerationRequest,
): string | undefined {
  const actionRequiredBy = request.changeEvent.signals?.actionRequiredBy;
  return actionRequiredBy ?? undefined;
}

/**
 * Build the fixed non-AI support list for one final state: the analysis's
 * final-assessment evidence in assessment order, filtered to records that
 * exist in the analysis and are not `ai_inference`, then every remaining
 * non-AI provenance record in provenance order. De-duplicated by first
 * occurrence. The list may be empty; the caller fails closed when it is.
 */
function nonAiSupportIds(
  request: SuggestedChangeActionGenerationRequest,
): string[] {
  const byId = new Map(
    request.analysisRecord.provenanceRecords.map((record) => [
      record.evidenceId,
      record,
    ]),
  );

  const ordered: string[] = [];
  const seen = new Set<string>();
  const push = (id: string): void => {
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  };

  const assessment = request.analysisRecord.impactAssessment;
  if (assessment.state !== 'INSUFFICIENT_CONTEXT') {
    assessment.evidence.forEach((id) => {
      const record = byId.get(id);
      if (record !== undefined && record.kind !== 'ai_inference') {
        push(id);
      }
    });
  }

  request.analysisRecord.provenanceRecords.forEach((record) => {
    if (record.kind !== 'ai_inference') {
      push(record.evidenceId);
    }
  });

  return ordered;
}

/**
 * Deterministic-origin, evidence-anchored suggested actions built purely
 * from an already-validated action generation request.
 *
 * `createDeterministicSuggestedActionOutput` is the provider-neutral pure
 * function of the `deterministic action template` rule: its first act is
 * one strict parse of the caller's request through the unchanged
 * `SuggestedChangeActionGenerationRequestSchema`, so the actionable-state
 * gate (ACTION_REQUIRED / REVIEW_REQUIRED) and the identity/version
 * ownership of the event, message version, tenant profile, and bundled
 * analysis are re-enforced by the existing request contract itself — the
 * runtime boundary is reused, not duplicated. Only the parsed request is
 * used afterwards, and every path that rejects or accepts the request keeps
 * the caller's objects untouched.
 *
 * Behavior (all fixed by the request data, never by the environment):
 *
 * - the returned actions are `origin: 'deterministic'` only and carry no
 *   `confidence` key;
 * - the state's fixed kind order runs (ACTION_REQUIRED: INVESTIGATE, PLAN,
 *   IMPLEMENT, COMMUNICATE, VALIDATE; REVIEW_REQUIRED: INVESTIGATE,
 *   COMMUNICATE, VALIDATE), one action per kind, no repeats;
 * - every `supportingEvidenceIds` entry exists in the request analysis and
 *   cites no `ai_inference` record: the support list is the analysis's
 *   final-assessment evidence (assessment order, non-AI only) extended by
 *   the remaining non-AI provenance records (provenance order),
 *   de-duplicated by first occurrence, and shared in full by every action;
 * - the only fail-closed boundary is an empty non-AI support list: a valid
 *   actionable analysis with at least one qualifying non-AI evidence entry
 *   generates the state's full action sequence, while zero entries throw
 *   instead of emitting a speculation or an under-supported suggestion;
 * - `actionId` values are `action.<kind-slug>-<ordinal>` with the position
 *   in the state's kind order as the ordinal, so IDs are stable and
 *   collision-free within and across runs for the same state;
 * - `title` and `description` splice the change event's `products` (in
 *   event order, falling back to `categories`, then to a neutral phrase)
 *   into the per-kind template, so suggestions are component-aware using
 *   only recorded source data;
 * - `ownerKey` is present only when the tenant profile declares an owner,
 *   and `dueAt` only when the change event records `actionRequiredBy`.
 *
 * The input is never mutated, identical requests always yield deep-equal
 * outputs, and accepted outputs round-trip through JSON losslessly.
 */
export function createDeterministicSuggestedActionOutput(
  request: SuggestedChangeActionGenerationRequest,
): SuggestedChangeActionGenerationOutput {
  // One strict parse of the caller's request re-runs the existing runtime
  // boundary: actionable-state eligibility, identity/version ownership, and
  // the request-wide undefined-free inspection all run here, and every
  // value read below comes from this parsed request only.
  const parsedRequest =
    SuggestedChangeActionGenerationRequestSchema.parse(request);

  const state: ActionableState = parsedRequest.analysisRecord.impactAssessment
    .state as ActionableState;

  const ownerKey = ownerKeyFor(parsedRequest);
  const dueAt = dueAtFor(parsedRequest);
  const supportIds = nonAiSupportIds(parsedRequest);
  const components = componentPhrase(parsedRequest);

  if (supportIds.length === 0) {
    throw new Error(
      `no valid deterministic suggestion can be supported by non-AI provenance for state ${state}: 0 qualifying evidence entries available, at least 1 required`,
    );
  }

  const actions: SuggestedChangeAction[] = [];
  const kinds = kindOrderByState[state];
  const specs = specsByState[state];

  kinds.forEach((kind, index) => {
    const spec = specs[kind];
    if (spec === undefined) {
      throw new Error(
        `no deterministic action template exists for state ${state} and kind ${kind}`,
      );
    }

    const slug = kind.toLowerCase();
    actions.push({
      origin: 'deterministic',
      actionId: `action.${slug}-${actionIdOrdinals[index]}`,
      kind,
      title: withComponents(spec.title, components),
      description: withComponents(spec.description, components),
      supportingEvidenceIds: [...supportIds],
      ...(ownerKey !== undefined ? { ownerKey } : {}),
      ...(dueAt !== undefined ? { dueAt } : {}),
    });
  });

  return SuggestedChangeActionGenerationOutputSchema.parse({ actions });
}
