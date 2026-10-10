// middleware/safe.js
// Express 4 does not catch errors thrown inside async route handlers: a
// rejected promise (bad ID, DB hiccup, ...) becomes an unhandled rejection,
// which on modern Node CRASHES the whole server. safe(router) wraps every
// handler on a router so those errors go to Express's error handler instead.
// No dependency needed.

function safe(router) {
  const wrapLayers = (stack) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const l of layer.route.stack) {
          const fn = l.handle;
          if (fn.length > 3 || fn.__safe) continue; // skip error-handling middleware
          const wrapped = (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
          wrapped.__safe = true;
          l.handle = wrapped;
        }
      }
    }
  };
  wrapLayers(router.stack);
  return router;
}

module.exports = safe;
