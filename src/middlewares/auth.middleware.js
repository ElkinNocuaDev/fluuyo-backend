const jwt = require('jsonwebtoken');
const db = require('../db');

async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      const e = new Error('Falta token de autenticación.');
      e.status = 401;
      e.code = 'NO_TOKEN';
      return next(e);
    }

    const token = authHeader.split(' ')[1];

    if (!token) {
      const e = new Error('Token malformado.');
      e.status = 401;
      e.code = 'INVALID_TOKEN';
      return next(e);
    }

    // 🔐 Verificar firma y expiración
    const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET);

    if (!payload?.sub) {
      const e = new Error('Token inválido (sin subject).');
      e.status = 401;
      e.code = 'INVALID_TOKEN';
      return next(e);
    }

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

    if (user.status !== 'ACTIVE') {
      const e = new Error('Usuario inactivo o bloqueado.');
      e.status = 403;
      e.code = 'USER_BLOCKED';
      return next(e);
    }

    // Normalizamos la estructura
    req.user = {
      id: user.id,
      role: user.role,
      email_verified: user.email_verified,
    };

    next();
  } catch (err) {
    // Manejo explícito de JWT
    if (err.name === 'TokenExpiredError') {
      const e = new Error('Token expirado.');
      e.status = 401;
      e.code = 'TOKEN_EXPIRED';
      return next(e);
    }

    if (err.name === 'JsonWebTokenError') {
      const e = new Error('Token inválido.');
      e.status = 401;
      e.code = 'INVALID_TOKEN';
      return next(e);
    }

    next(err); // otros errores reales
  }
}

module.exports = { requireAuth };
