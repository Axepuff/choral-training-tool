import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.CHORAL_BUILD_BASE ?? './',
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: process.env.CHORAL_API_PROXY ?? 'http://127.0.0.1:8080', changeOrigin: false },
    },
  },
});
