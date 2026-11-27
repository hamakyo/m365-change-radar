import { z } from 'zod';

/**
 * Evidence IDs are shared by every provenance record kind and by the
 * structured classification output, so they live in a leaf module with no
 * domain imports. Both provenance and the classification output schema
 * import from here, keeping the dependency graph acyclic.
 */
export const EvidenceIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export type EvidenceId = z.infer<typeof EvidenceIdSchema>;
