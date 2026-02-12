const jwt = require('jsonwebtoken');
const { pool } = require('../db');

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

    const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET);

    if (!payload?.sub) {
      const e = new Error('Token inválido.');
      e.status = 401;
      e.code = 'INVALID_TOKEN';
      return next(e);
    }

    // 🔎 Buscar usuario en PostgreSQL
    const result = await pool.query(
      `
      SELECT id, role, email_verified, status
      FROM users
      WHERE id = $1 AND deleted_at IS NULL
      `,
      [payload.sub]
    );

    const user = result.rows[0];

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

    req.user = {
      id: user.id,
      role: user.role,
      email_verified: user.email_verified,
    };

    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      err.status = 401;
      err.code = 'TOKEN_EXPIRED';
      return next(err);
    }

    if (err.name === 'JsonWebTokenError') {
      err.status = 401;
      err.code = 'INVALID_TOKEN';
      return next(err);
    }

    next(err);
  }
}

module.exports = { requireAuth };
