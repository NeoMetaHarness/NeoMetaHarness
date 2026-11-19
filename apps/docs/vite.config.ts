import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('@astryxdesign/core/dist/SideNav/')) return 'astryx-navigation';
          if (id.includes('@astryxdesign/theme-neutral/')) return 'astryx-theme';
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/') || id.includes('node_modules/scheduler/')) return 'react-runtime';
        },
      },
    },
  },
});
