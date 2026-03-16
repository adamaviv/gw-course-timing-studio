import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { computeAppVersion } from './scripts/app-version.mjs';

const appVersion = computeAppVersion();

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
});
