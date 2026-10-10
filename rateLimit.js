// middleware/rateLimit.js
// Minimal in-memory rate limiter (per IP, fixed window). Good enough for a
// single Render instance; if you ever run several instances, swap for a
// shared store (e.g. Redis) or the express-rate-limit package.

function rateLimit({ windowMs, max, message }) {
  const hits = new Map(); // ip -> { count, resetAt }

  // Periodically drop expired entries so the map can't grow forever
  setInterval(() => {
    const now = Date.now();
    for (const [ip, h] of hits) if (h.resetAt <= now) hits.delete(ip);
  }, windowMs).unref();

  return (req, res, next) => {
    const now = Date.now();
    let h = hits.get(req.ip);
    if (!h || h.resetAt <= now) { h = { count: 0, resetAt: now + windowMs }; hits.set(req.ip, h); }
    h.count++;
    if (h.count > max) {
      res.set('Retry-After', String(Math.ceil((h.resetAt - now) / 1000)));
      return res.status(429).json({ error: message || 'Too many requests, please try again later.' });
    }
    next();
  };
}

module.exports = rateLimit;
