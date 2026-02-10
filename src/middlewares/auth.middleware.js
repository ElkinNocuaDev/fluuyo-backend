const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;

  if (!token) {
    const e = new Error('Falta token de autenticación.');
    e.status = 401;
    e.code = 'NO_TOKEN';
    return next(e);
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET);

    if (!payload.email_verified) {
      const e = new Error('Correo no verificado.');
      e.status = 403;
      e.code = 'EMAIL_NOT_VERIFIED';
      return next(e);
    }

    req.user = {
      id: payload.sub,
      role: payload.role,
      email_verified: payload.email_verified,
    };

    next();
  } catch {
    const e = new Error('Token inválido o expirado.');
    e.status = 401;
    e.code = 'INVALID_TOKEN';
    next(e);
  }
}

module.exports = { requireAuth };
