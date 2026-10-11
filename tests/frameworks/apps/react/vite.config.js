import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  base: '/react/',
  logLevel: 'warn',
  resolve: { alias: { vue: 'vue' } },
  build: { rollupOptions: { input: { index: resolve(__dirname, 'index.html'), hash: resolve(__dirname, 'hash.html') } } },
});
