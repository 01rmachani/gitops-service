const { randomUUID } = require('crypto');

/**
 * Request ID + structured logging middleware.
 *
 * Attaches a unique `req.id` to every request and logs:
 *   → incoming request (method, path, source IP)
 *   ← outgoing response (status, duration ms)
 *
 * All application log helpers (req.log.info / req.log.error / req.log.warn)
 * automatically include the request ID for correlation.
 */
function requestLogger(req, res, next) {
  req.id = req.headers['x-request-id'] || randomUUID();
  res.setHeader('x-request-id', req.id);

  const started = Date.now();

  const base = { reqId: req.id, method: req.method, path: req.path, ip: req.ip };

  console.log(JSON.stringify({ ...base, event: 'request' }));

  res.on('finish', () => {
    const ms = Date.now() - started;
    console.log(JSON.stringify({ ...base, event: 'response', status: res.statusCode, ms }));
  });

  req.log = {
    info:  (msg, extra = {}) => console.log(JSON.stringify({ reqId: req.id, level: 'info',  msg, ...extra })),
    warn:  (msg, extra = {}) => console.warn(JSON.stringify({ reqId: req.id, level: 'warn',  msg, ...extra })),
    error: (msg, extra = {}) => console.error(JSON.stringify({ reqId: req.id, level: 'error', msg, ...extra })),
  };

  next();
}

module.exports = { requestLogger };
