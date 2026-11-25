import { createRef } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { StreamView, type StreamViewHandle } from '@neometaharness/ui/StreamView';
import { NeoTheme } from '@neometaharness/ui/shell';
import '@neometaharness/ui/styles.css';

const stream = createRef<StreamViewHandle>();
const root = createRoot(document.getElementById('root')!);
flushSync(() => root.render(<NeoTheme mode="light"><StreamView ref={stream} /></NeoTheme>));
Object.assign(window, { stream: stream.current });
