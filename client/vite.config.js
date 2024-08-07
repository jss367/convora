import react from '@vitejs/plugin-react';
import dotenv from 'dotenv';
import path from 'path';
import { defineConfig } from 'vite';

// Load environment variables from the root .env file
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Filter out only the variables starting with REACT_APP_
const envWithPrefix = {};
for (const key in process.env) {
  if (key.startsWith('REACT_APP_')) {
    envWithPrefix[`process.env.${key}`] = JSON.stringify(process.env[key]);
  }
}

export default defineConfig({
  plugins: [react()],
  define: envWithPrefix,
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
