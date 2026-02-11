const jwt = require('jsonwebtoken');
const db = require('../db');

async function requireAuth(req, res, next) {
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

    // 🔎 Buscar usuario real en BD
    const user = await db.user.findUnique({
      where: { id: payload.sub },
    });

    if (!user) {
      const e = new Error('Usuario no encontrado.');
      e.status = 401;
      e.code = 'USER_NOT_FOUND';
      return next(e);
    }

    if (!user.email_verified) {
      const e = new Error('Correo no verificado.');
      e.status = 403;
      e.code = 'EMAIL_NOT_VERIFIED';
      return next(e);
    }

    req.user = {
      id: user.id,
      role: user.role,
      email_verified: user.email_verified,
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
