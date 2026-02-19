const { API_KEY } = process.env;

/**
 * x-api-key authentication middleware.
 * Rejects requests missing or with wrong key with 401.
 */
function auth(req, res, next) {
  if (!API_KEY) {
    console.warn('[auth] API_KEY not configured — all requests rejected');
    return res.status(500).json({ error: 'Server misconfigured: API_KEY not set' });
  }
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

module.exports = { auth };
