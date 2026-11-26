const crypto = require('node:crypto');
const { logError } = require('./logging');
const { OAuth2Client } = require('google-auth-library');

function registerModeratorAccounts(app, pool, {
  clientId = process.env.GOOGLE_CLIENT_ID,
  google = new OAuth2Client(),
  secure = process.env.NODE_ENV === 'production',
} = {}) {
  const cookieName = secure ? '__Host-convora_session' : 'convora_session';
  const cookieOptions = { httpOnly: true, sameSite: 'lax', secure, path: '/' };
  const digest = token => crypto.createHash('sha256').update(token).digest('hex');

  function sessionDigest(req) {
    const cookie = (req.get('Cookie') || '').split(';').map(value => value.trim())
      .find(value => value.startsWith(cookieName + '='));
    const value = cookie?.slice(cookieName.length + 1);
    return value && /^[a-f0-9]{64}$/.test(value) ? digest(value) : null;
  }

  async function account(req, db = pool) {
    const key = sessionDigest(req);
    if (!clientId || !key) return null;
    const { rows } = await db.query(
      'SELECT google_sub, email FROM moderator_sessions WHERE digest = $1 AND expires_at > now()', [key]);
    return rows[0] || null;
  }

  app.use('/api/account', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // A same-origin fetch can set this custom header. Reject cross-origin
    // callers even when another origin is allowed by the general API CORS policy.
    const origin = req.get('Origin');
    if (req.get('X-Convora-Account') !== '1' || req.get('Sec-Fetch-Site') === 'cross-site'
        || (origin && origin !== (secure ? 'https://' : req.protocol + '://') + req.get('Host'))) {
      return res.sendStatus(403);
    }
    next();
  });

  app.get('/api/account', async (req, res) => {
    const current = await account(req);
    res.json({ clientId: clientId || null, signedIn: !!current, email: current?.email || null });
  });

  app.post('/api/account/login', async (req, res) => {
    if (!clientId) return res.sendStatus(404);
    if (typeof req.body?.credential !== 'string') return res.sendStatus(400);
    let identity;
    try {
      const ticket = await google.verifyIdToken({ idToken: req.body.credential, audience: clientId });
      identity = ticket.getPayload();
    } catch {
      return res.status(401).json({ error: 'Google sign-in could not be verified.' });
    }
    if (!identity?.sub) return res.sendStatus(401);
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query('DELETE FROM moderator_sessions WHERE expires_at <= now() OR digest = $1', [sessionDigest(req)]);
    await pool.query(`INSERT INTO moderator_sessions (digest, google_sub, email, expires_at)
      VALUES ($1, $2, $3, now() + interval '30 days')`, [digest(token), identity.sub, identity.email || null]);
    res.cookie(cookieName, token, { ...cookieOptions, maxAge: 30 * 86400000 }).sendStatus(204);
  });

  app.post('/api/account/logout', async (req, res) => {
    await pool.query('DELETE FROM moderator_sessions WHERE digest = $1', [sessionDigest(req)]);
    res.clearCookie(cookieName, cookieOptions).sendStatus(204);
  });

  app.use('/api/account', async (req, res, next) => {
    const current = await account(req);
    if (!current) return res.sendStatus(401);
    req.googleSubject = current.google_sub;
    next();
  });

  app.get('/api/account/discussions', async (req, res) => {
    const { rows } = await pool.query(
      'SELECT slug, topic, created_at FROM discussions WHERE creator_google_sub = $1 ORDER BY created_at DESC, id DESC',
      [req.googleSubject]);
    res.json(rows);
  });

  app.post('/api/account/link', async (req, res) => {
    const entries = req.body?.discussions;
    if (!Array.isArray(entries) || entries.length > 100 ||
        !entries.every(d => typeof d?.slug === 'string' && typeof d.token === 'string' && d.token)) {
      return res.sendStatus(400);
    }
    const result = await pool.query(`UPDATE discussions d SET creator_google_sub = $1
      FROM jsonb_to_recordset($2::jsonb) AS proof(slug text, token text)
      WHERE (d.slug = proof.slug OR d.topic = proof.slug) AND d.admin_token = proof.token AND d.creator_google_sub IS NULL`,
    [req.googleSubject, JSON.stringify(entries)]);
    res.json({ linked: result.rowCount });
  });

  app.get('/api/account/access/:slug', async (req, res) => {
    const { rows } = await pool.query(
      'SELECT admin_token FROM discussions WHERE slug = $1 AND creator_google_sub = $2',
      [req.params.slug, req.googleSubject]);
    res.json({ token: rows[0]?.admin_token || null });
  });

  app.use('/api/account', (error, req, res, next) => {
    if (res.headersSent) return next(error);
    logError('Moderator account request failed', error);
    res.sendStatus(500);
  });

  return account;
}

module.exports = { registerModeratorAccounts };
