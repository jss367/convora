import react from '@vitejs/plugin-react';
import dotenv from 'dotenv';
import path from 'path';
import { defineConfig } from 'vite';

// Load the root .env into process.env so the dev-server `port` below can read
// PORT. Client-facing config is exposed via import.meta.env instead (see
// envDir): Vite natively injects VITE_-prefixed vars, with no `process` global
// leaking into the browser bundle.
dotenv.config({ path: path.resolve(__dirname, '../.env') });

export default defineConfig({
  plugins: [react()],
  // The root .env lives one level up from this client directory, so point Vite's
  // env loader there to pick up VITE_-prefixed variables.
  envDir: path.resolve(__dirname, '..'),
  root: path.resolve(__dirname, ''),
  build: {
    outDir: path.resolve(__dirname, '../dist'),
    emptyOutDir: true,
  },
  server: {
    port: process.env.PORT || 5173,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  css: {
    postcss: {
      plugins: [
        require('tailwindcss'),
        require('autoprefixer'),
      ],
    },
  },
})
