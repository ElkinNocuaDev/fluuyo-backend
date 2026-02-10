function requireRole(...allowed) {
  return (req, res, next) => {
    if (!req.user?.role || !allowed.includes(req.user.role)) {
      const e = new Error('No autorizado.');
      e.status = 403;
      e.code = 'FORBIDDEN';
      return next(e);
    }
    next();
  };
}

module.exports = { requireRole };
