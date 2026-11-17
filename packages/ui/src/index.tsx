import type { PropsWithChildren } from 'react';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';

export { AppShell } from '@astryxdesign/core/AppShell';
export { SideNav, SideNavHeading, SideNavItem, SideNavSection } from '@astryxdesign/core/SideNav';
export { Markdown } from '@astryxdesign/core/Markdown';
export { Switch } from '@astryxdesign/core/Switch';
export { Button } from '@astryxdesign/core/Button';
export { StreamView, type StreamViewHandle } from './StreamView';

export function NeoTheme({ children }: PropsWithChildren) {
  return <Theme theme={neutralTheme}>{children}</Theme>;
}
