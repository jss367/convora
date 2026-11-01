const { defineConfig, devices } = require('@playwright/test');
const { assertSafeTestDatabase } = require('./scripts/test-database');

const databaseUrl = process.env.DATABASE_URL || 'postgresql://convora:convora@127.0.0.1:54330/convora_test';
assertSafeTestDatabase(databaseUrl);
const baseURL = 'http://127.0.0.1:4173';

module.exports = defineConfig({
  testDir: './tests/browser',
  outputDir: './.context/browser-results',
  workers: 1,
  forbidOnly: !!process.env.CI,
  use: { baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'NODE_ENV=production npm run build && node server.js',
    url: `${baseURL}/api/discussions`,
    reuseExistingServer: false,
    env: {
      NODE_ENV: 'test', PORT: '4173', DATABASE_URL: databaseUrl, CLIENT_URL: baseURL,
      // Isolate the test build from local split-origin settings in .env.
      VITE_SOCKET_URL: baseURL, REACT_APP_SOCKET_URL: baseURL,
    },
  },
});
