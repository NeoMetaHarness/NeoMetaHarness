import { Catalog } from '@a2ui/web_core';
import { z } from 'zod';

export const catalogId = 'neometaharness:chat:v1';
export const maxInputLength = 1024;
export const maxInputFields = 16;
const reserved = new Set(['__proto__', 'prototype', 'constructor']);
const identifier = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/).refine((value) => !reserved.has(value));
const path = z.string().regex(/^\/[a-zA-Z][a-zA-Z0-9_-]{0,63}$/).refine((value) => !reserved.has(value.slice(1)));
const reference = z.object({ '@path': path }).strict();
const fieldValue = z.union([z.string().max(maxInputLength), z.boolean()]);
const values = z.record(identifier, fieldValue);
const text = z.string().max(4096);
const label = z.string().trim().min(1).max(160);
const actionContext = z.record(identifier, reference);

const schemas = {
  Text: z.object({ text }).strict(),
  Heading: z.object({ text: label }).strict(),
  Column: z.object({ children: z.array(identifier).min(1).max(24) }).strict(),
  Button: z.object({
    child: identifier,
    action: z.object({
      event: z.object({ name: identifier, context: actionContext.optional() }).strict(),
    }).strict(),
  }).strict(),
  CheckBox: z.object({ label, value: reference }).strict(),
  TextField: z.object({ label, value: reference }).strict(),
};

export const neoCatalog = new Catalog(catalogId, '1.0',
  Object.entries(schemas).map(([name, schema]) => ({ name, schema })), []);

const components = z.discriminatedUnion('component', [
  schemas.Text.extend({ id: identifier, component: z.literal('Text') }),
  schemas.Heading.extend({ id: identifier, component: z.literal('Heading') }),
  schemas.Column.extend({ id: identifier, component: z.literal('Column') }),
  schemas.Button.extend({ id: identifier, component: z.literal('Button') }),
  schemas.CheckBox.extend({ id: identifier, component: z.literal('CheckBox') }),
  schemas.TextField.extend({ id: identifier, component: z.literal('TextField') }),
]);
const entries = z.array(components).min(1).max(64);
const version = z.literal('1.0');
export const create = z.object({ version, createSurface: z.object({
  surfaceId: identifier, catalogId: z.literal(catalogId), components: entries.optional(), dataModel: values.optional(),
}).strict() }).strict();
export const updateComponents = z.object({ version, updateComponents: z.object({
  surfaceId: identifier, components: entries,
}).strict() }).strict();
export const updateData = z.object({ version, updateDataModel: z.object({
  surfaceId: identifier, path, value: fieldValue,
}).strict() }).strict();

export type Widget = z.infer<typeof components>;
export type FieldValue = z.infer<typeof fieldValue>;
export type SurfaceMessage = z.infer<typeof create>;
export type ActionField = { path: string; type: 'string' | 'boolean' };
export type SurfaceAction = { componentId: string; name: string; fields: Record<string, ActionField> };
