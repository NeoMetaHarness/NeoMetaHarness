import { MessageProcessor } from '@a2ui/web_core';
import { neoCatalog, type SurfaceMessage } from './catalog.js';

export function openSurface(message: SurfaceMessage) {
  const processor = new MessageProcessor([neoCatalog]);
  try {
    processor.processMessages(message);
    const surface = processor.model.getSurface(message.createSurface.surfaceId);
    if (!surface?.componentsModel.get('root')) throw new Error('A2UI root is missing');
    return { surface, dispose: () => processor.dispose() };
  } catch (error) {
    processor.dispose();
    throw error;
  }
}
