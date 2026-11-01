const crypto = require('node:crypto');
const { test: base, expect } = require('@playwright/test');
const { Pool } = require('pg');
const { assertSafeTestDatabase } = require('../../scripts/test-database');

const test = base.extend({
  rooms: async ({ request }, use) => {
    const connectionString = process.env.DATABASE_URL || 'postgresql://convora:convora@127.0.0.1:54330/convora_test';
    assertSafeTestDatabase(connectionString);
    const pool = new Pool({ connectionString });
    const ids = [];
    try {
      await use({
        pool,
        async create(title, type = 'Open Ended') {
          const response = await request.post('/api/discussions', { data: { topic: `${title} ${crypto.randomUUID()}` } });
          expect(response.ok()).toBeTruthy();
          const room = await response.json();
          ids.push(room.id);
          await pool.query('INSERT INTO questions (discussion_id, text, type) VALUES ($1, $2, $3)', [room.id, `${title} question`, type]);
          return room;
        },
        async trackSlug(slug) {
          const result = await pool.query('SELECT id FROM discussions WHERE slug = $1', [slug]);
          expect(result.rows).toHaveLength(1);
          ids.push(result.rows[0].id);
          return result.rows[0].id;
        },
      });
    } finally {
      try {
        await pool.query('DELETE FROM votes WHERE question_id IN (SELECT id FROM questions WHERE discussion_id = ANY($1::int[]))', [ids]);
        await pool.query('DELETE FROM questions WHERE discussion_id = ANY($1::int[])', [ids]);
        await pool.query('DELETE FROM discussions WHERE id = ANY($1::int[])', [ids]);
      } finally {
        await pool.end();
      }
    }
  },
});

module.exports = { test, expect };
