import { AgentToRendererMessageSchema } from '@a2ui/web_core/v1_0';
import { catalogId, create, updateComponents, updateData, maxInputFields,
  type FieldValue, type SurfaceAction, type SurfaceMessage, type Widget } from './catalog.js';

export const maxAssistantChars = 128 * 1024;
const maxBlockBytes = 32 * 1024;
const maxMessages = 24;
const maxSurfaces = 4;
const maxDepth = 12;

export type Surface = { message: SurfaceMessage; actions: SurfaceAction[] };
export type Segment = { kind: 'text'; text: string } | { kind: 'surface'; surface: Surface };
type Draft = { components: Map<string, Widget>; data: Map<string, FieldValue> };

function finalize(id: string, draft: Draft): Surface | undefined {
  const seen = new Set<string>();
  const fields = new Map<string, 'string' | 'boolean'>();
  const buttons: Extract<Widget, { component: 'Button' }>[] = [];
  function visit(key: string, depth: number): boolean {
    const widget = draft.components.get(key);
    if (!widget || depth > maxDepth || seen.has(key)) return false;
    seen.add(key);
    switch (widget.component) {
      case 'Column': return widget.children.every((child) => visit(child, depth + 1));
      case 'Button': {
        const child = draft.components.get(widget.child);
        buttons.push(widget);
        return child?.component === 'Text' && Boolean(child.text.trim()) && visit(widget.child, depth + 1);
      }
      case 'TextField':
      case 'CheckBox': {
        const path = widget.value['@path'].slice(1);
        if (fields.has(path)) return false;
        fields.set(path, widget.component === 'TextField' ? 'string' : 'boolean');
        return true;
      }
      default: return true;
    }
  }
  if (!visit('root', 1) || draft.components.size !== seen.size || fields.size > maxInputFields) return;
  if ([...draft.data].some(([key, value]) => fields.get(key) !== typeof value)) return;
  for (const [key, type] of fields) {
    if (!draft.data.has(key)) draft.data.set(key, type === 'string' ? '' : false);
  }
  const actions: SurfaceAction[] = [];
  for (const button of buttons) {
    const { name, context } = button.action.event;
    const bindings = [];
    for (const [key, ref] of Object.entries(context ?? {})) {
      const path = ref['@path'];
      const type = fields.get(path.slice(1));
      if (!type) return;
      bindings.push([key, { path, type }] as const);
    }
    if (bindings.length > maxInputFields) return;
    actions.push({ componentId: button.id, name, fields: Object.fromEntries(bindings) });
  }
  return {
    message: { version: '1.0', createSurface: {
      surfaceId: id, catalogId, components: [...draft.components.values()], dataModel: Object.fromEntries(draft.data),
    } },
    actions,
  };
}

function validateBlock(source: string): Surface[] | undefined {
  if (source.length > maxBlockBytes || new TextEncoder().encode(source).length > maxBlockBytes) return;
  let payload: unknown;
  try { payload = JSON.parse(source); } catch { return; }
  if (!Array.isArray(payload) || payload.length === 0 || payload.length > maxMessages) return;
  const drafts = new Map<string, Draft>();
  for (const raw of payload) {
    // Validate the bounded, strict MVP shape first. The upstream envelope parser then sees only shallow data.
    const creation = create.safeParse(raw);
    const componentUpdate = creation.success ? undefined : updateComponents.safeParse(raw);
    const dataUpdate = creation.success || componentUpdate?.success ? undefined : updateData.safeParse(raw);
    if (!creation.success && !componentUpdate?.success && !dataUpdate?.success) return;
    if (!AgentToRendererMessageSchema.safeParse(raw).success) return;
    if (creation.success) {
      const { surfaceId, components, dataModel } = creation.data.createSurface;
      if (drafts.has(surfaceId) || drafts.size >= maxSurfaces) return;
      const widgets = components ?? [];
      const map = new Map(widgets.map((widget) => [widget.id, widget]));
      if (map.size !== widgets.length) return;
      drafts.set(surfaceId, { components: map, data: new Map(Object.entries(dataModel ?? {})) });
    } else if (componentUpdate?.success) {
      const { surfaceId, components } = componentUpdate.data.updateComponents;
      const draft = drafts.get(surfaceId);
      if (!draft || new Set(components.map(({ id }) => id)).size !== components.length) return;
      for (const widget of components) draft.components.set(widget.id, widget);
      if (draft.components.size > 64) return;
    } else if (dataUpdate?.success) {
      const { surfaceId, path, value } = dataUpdate.data.updateDataModel;
      const draft = drafts.get(surfaceId);
      if (!draft) return;
      draft.data.set(path.slice(1), value);
      if (draft.data.size > maxInputFields) return;
    }
  }
  const surfaces: Surface[] = [];
  for (const [id, draft] of drafts) {
    const surface = finalize(id, draft);
    if (!surface) return;
    surfaces.push(surface);
  }
  return surfaces;
}

/** Parse a complete assistant message. Invalid or unclosed fences remain byte-for-byte text. */
export function parseAssistant(text: string): Segment[] {
  if (text.length > maxAssistantChars) return [{ kind: 'text', text }];
  const result: Segment[] = [];
  const ids = new Set<string>();
  let fence: { token: string; start: number; content: number; a2ui: boolean } | undefined;
  let plainStart = 0;
  for (const line of text.matchAll(/^[ ]{0,3}(\x60{3,}|~{3,})([^\r\n]*)(?:\r?\n|$)/gm)) {
    const [whole, token, rest] = line;
    if (!fence) {
      if (token[0] === '\x60' && rest.includes('\x60')) continue;
      fence = { token, start: line.index, content: line.index + whole.length,
        a2ui: token[0] === '\x60' && rest.trim() === 'a2ui' };
      continue;
    }
    if (token[0] !== fence.token[0] || token.length < fence.token.length || rest.trim()) continue;
    if (fence.a2ui) {
      const surfaces = validateBlock(text.slice(fence.content, line.index));
      if (surfaces && ids.size + surfaces.length <= maxSurfaces &&
          surfaces.every(({ message }) => !ids.has(message.createSurface.surfaceId))) {
        if (plainStart < fence.start) result.push({ kind: 'text', text: text.slice(plainStart, fence.start) });
        for (const surface of surfaces) {
          ids.add(surface.message.createSurface.surfaceId);
          result.push({ kind: 'surface', surface });
        }
        plainStart = line.index + whole.length;
      }
    }
    fence = undefined;
  }
  if (plainStart < text.length || !result.length) result.push({ kind: 'text', text: text.slice(plainStart) });
  return result;
}
