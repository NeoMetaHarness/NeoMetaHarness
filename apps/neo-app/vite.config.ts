import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        experimentalMinChunkSize: 40000,
        onlyExplicitManualChunks: true,
        manualChunks(id, { getModuleInfo }) {
          const isStartup = (moduleId: string, seen = new Set<string>()): boolean => {
            if (seen.has(moduleId)) return false;
            seen.add(moduleId);
            const info = getModuleInfo(moduleId);
            return !!info && (info.isEntry || info.importers.some(importer => isStartup(importer, seen)));
          };
          // Preserve the startup graph while sharing compression across lazy Astryx modules.
          if (id.includes('node_modules/@astryxdesign/') && !isStartup(id)) return 'astryx-lazy';
          if (id.includes('@astryxdesign/core/dist/SideNav/')) return 'astryx-navigation';
          if (id.includes('@astryxdesign/theme-neutral/')) return 'astryx-theme';
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/') || id.includes('node_modules/scheduler/')) return 'react-runtime';
        },
      },
    },
  },
});
