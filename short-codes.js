const crypto = require('crypto');

const SHORT_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const SHORT_CODE_LENGTH = 6;
const CUSTOM_SHORT_CODE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/;

function generateShortCode() {
  let code = '';
  const bytes = crypto.randomBytes(SHORT_CODE_LENGTH);
  for (const byte of bytes) {
    code += SHORT_CODE_ALPHABET[byte % SHORT_CODE_ALPHABET.length];
  }
  return code;
}

function normalizeCustomShortCode(value) {
  const trimmed = String(value || '').trim().toLowerCase();
  if (!trimmed) return null;

  const withoutOrigin = trimmed.replace(/^https?:\/\/[^/]+\/?/i, '');
  const withoutPrefix = withoutOrigin.replace(/^s\//i, '');
  return withoutPrefix.replace(/^\/+|\/+$/g, '');
}

function isValidCustomShortCode(value) {
  return CUSTOM_SHORT_CODE_PATTERN.test(value);
}

function createShortCodes({ pool, verifyAdmin }) {
  async function generateDiscussionShortCode(topic, token, requestedCode) {
    const discussionId = await verifyAdmin(topic, token);
    if (!discussionId) {
      return { success: false, error: 'not_authorized' };
    }

    const customCode = normalizeCustomShortCode(requestedCode);
    if (requestedCode !== undefined && !customCode) {
      return { success: false, error: 'invalid' };
    }
    if (customCode && !isValidCustomShortCode(customCode)) {
      return { success: false, error: 'invalid' };
    }

    const client = await pool.connect();
    try {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await client.query('BEGIN');
        try {
          const existing = await client.query(
            'SELECT slug, short_code FROM discussions WHERE id = $1 FOR UPDATE',
            [discussionId]
          );

          if (existing.rows.length === 0) {
            await client.query('ROLLBACK');
            return { success: false, error: 'not_found' };
          }

          const row = existing.rows[0];
          if (!customCode && row.short_code) {
            await client.query('COMMIT');
            return { success: true, slug: row.slug, shortCode: row.short_code };
          }

          const shortCode = customCode || generateShortCode();
          const updated = await client.query(
            `UPDATE discussions
                SET short_code = $1
              WHERE id = $2
              RETURNING slug, short_code`,
            [shortCode, discussionId]
          );
          await client.query('COMMIT');
          return { success: true, slug: updated.rows[0].slug, shortCode: updated.rows[0].short_code };
        } catch (e) {
          await client.query('ROLLBACK');
          if (customCode && e.code === '23505') {
            return { success: false, error: 'taken' };
          }
          if (e.code === '23505') {
            continue;
          }
          throw e;
        }
      }
    } finally {
      client.release();
    }

    throw new Error(`Could not generate a unique short code for discussion ${discussionId}`);
  }

  return { generateDiscussionShortCode };
}

module.exports = { createShortCodes };
