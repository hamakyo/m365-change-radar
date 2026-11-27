import { z } from 'zod';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);

export const JsonValueSchema = jsonValue;
