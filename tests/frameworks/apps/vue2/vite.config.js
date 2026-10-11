import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  base: '/vue2/',
  logLevel: 'warn',
  resolve: { alias: { vue: 'vue/dist/vue.esm.js' } },
  build: { rollupOptions: { input: { index: resolve(__dirname, 'index.html'), hash: resolve(__dirname, 'hash.html') } } },
});
