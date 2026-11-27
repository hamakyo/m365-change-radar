import { z } from 'zod';

const nonEmptyString = z.string().min(1);
const flagKey = z.string().min(1);

const ContextFlagsSchema = z.record(flagKey, z.boolean());
const OwnershipSchema = z.record(nonEmptyString, nonEmptyString);

const OrganizationSchema = z
  .object({
    employees: z.number().int().nonnegative().optional(),
  })
  .strict();

const MaintenanceDaySchema = z.enum([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
]);

const MaintenanceSchema = z
  .object({
    allowedDays: z.array(MaintenanceDaySchema).optional(),
    timezone: nonEmptyString.optional(),
  })
  .strict();

export const TenantProfileSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+(?:\.\d+)*$/),
    profileVersion: nonEmptyString,
    organization: OrganizationSchema,
    services: ContextFlagsSchema,
    environment: ContextFlagsSchema,
    capabilities: ContextFlagsSchema,
    ownership: OwnershipSchema,
    changePolicy: ContextFlagsSchema,
    maintenance: MaintenanceSchema,
  })
  .strict();

export type TenantProfile = z.infer<typeof TenantProfileSchema>;
