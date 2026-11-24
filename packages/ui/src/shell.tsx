import type { PropsWithChildren } from 'react';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';

export { AppShell } from '@astryxdesign/core/AppShell';
export { SideNav, SideNavHeading, SideNavItem, SideNavSection } from '@astryxdesign/core/SideNav';

export function NeoTheme({ children, mode }: PropsWithChildren<{ mode?: 'light' | 'dark' }>) {
  return <Theme theme={neutralTheme} mode={mode}>{children}</Theme>;
}
