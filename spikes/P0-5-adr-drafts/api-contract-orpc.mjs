import { oc, eventIterator } from '@orpc/contract';
import { z } from 'zod';
export const eventSchema = z.object({kind: z.enum(['delta','done']), seq:z.number(), text:z.string()});
export const contract = {subscribe: oc.input(z.object({count:z.number().int().min(1)})).output(eventIterator(eventSchema))};
