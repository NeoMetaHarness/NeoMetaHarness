import type { PropsWithChildren } from 'react';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';

export { AppShell } from '@astryxdesign/core/AppShell';
export { SideNav, SideNavItem, SideNavSection } from '@astryxdesign/core/SideNav';

export function NeoTheme({ children }: PropsWithChildren) {
  return <Theme theme={neutralTheme}>{children}</Theme>;
}
