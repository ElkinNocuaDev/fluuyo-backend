const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const { pool } = require('../../db');
const { writeAuditLog } = require('../audit/audit.service');

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  phone: z.string().min(7).max(20).optional(),
  first_name: z.string().min(1).max(80).optional(),
  last_name: z.string().min(1).max(80).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m' }
  );
}

async function register(req, res, next) {
  try {
    const data = registerSchema.parse(req.body);

    const saltRounds = Number(process.env.BCRYPT_SALT_ROUNDS || 12);
    const passwordHash = await bcrypt.hash(data.password, saltRounds);

    // ✅ AQUÍ va esto
    const { token: emailToken, expires } = generateEmailVerificationToken();

    const result = await pool.query(
      `
      INSERT INTO users (
        email,
        phone,
        password_hash,
        first_name,
        last_name,
        email_verified,
        email_verification_token,
        email_verification_expires,
        status
      )
      VALUES ($1, $2, $3, $4, $5, false, $6, $7, 'PENDING')
      RETURNING id, email, phone, role, status, kyc_status, created_at
      `,
      [
        data.email,
        data.phone || null,
        passwordHash,
        data.first_name || null,
        data.last_name || null,
        emailToken,
        expires,
      ]
    );

    const user = result.rows[0];

    // 2) Crear perfil de crédito
    await pool.query(
      `
      INSERT INTO credit_profiles (user_id)
      VALUES ($1)
      ON CONFLICT (user_id) DO NOTHING
      `,
      [user.id]
    );

    await writeAuditLog({
      actorUserId: user.id,
      action: 'AUTH_REGISTER',
      entityType: 'user',
      entityId: user.id,
      before: null,
      after: { id: user.id, email: user.email, role: user.role },
      ip: req.ip,
      userAgent: req.headers['user-agent'] || null,
    });

    // (opcional pero recomendado)
    // await sendVerificationEmail({ to: user.email, token: emailToken });

    const token = signAccessToken(user);

    res.status(201).json({ ok: true, token, user });
  } catch (err) {
    if (err?.code === '23505') {
      err.status = 409;
      err.code = 'DUPLICATE';
      err.message = 'Email o teléfono ya está registrado.';
      return next(err);
    }
    if (err?.name === 'ZodError') {
      err.status = 400;
      err.code = 'VALIDATION_ERROR';
      err.message = 'Datos inválidos.';
      err.details = err.issues;
      return next(err);
    }
    next(err);
  }
}

async function login(req, res, next) {
  try {
    const data = loginSchema.parse(req.body);

    const result = await pool.query(
      `
      SELECT id, email, password_hash, role, status, kyc_status
      FROM users
      WHERE email = $1 AND deleted_at IS NULL
      `,
      [data.email]
    );

    const user = result.rows[0];
    if (!user) {
      const e = new Error('Credenciales inválidas.');
      e.status = 401;
      e.code = 'INVALID_CREDENTIALS';
      throw e;
    }

    if (user.status !== 'ACTIVE') {
      const e = new Error('Usuario bloqueado o inactivo.');
      e.status = 403;
      e.code = 'USER_BLOCKED';
      throw e;
    }

    const ok = await bcrypt.compare(data.password, user.password_hash);
    if (!ok) {
      const e = new Error('Credenciales inválidas.');
      e.status = 401;
      e.code = 'INVALID_CREDENTIALS';
      throw e;
    }

    await pool.query(`UPDATE users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1`, [user.id]);

    await writeAuditLog({
      actorUserId: user.id,
      action: 'AUTH_LOGIN',
      entityType: 'user',
      entityId: user.id,
      before: null,
      after: { id: user.id, email: user.email },
      ip: req.ip,
      userAgent: req.headers['user-agent'] || null,
    });

    const token = signAccessToken(user);

    res.json({
      ok: true,
      token,
      user: { id: user.id, email: user.email, role: user.role, status: user.status, kyc_status: user.kyc_status },
    });
  } catch (err) {
    if (err?.name === 'ZodError') {
      err.status = 400;
      err.code = 'VALIDATION_ERROR';
      err.message = 'Datos inválidos.';
      err.details = err.issues;
      return next(err);
    }
    next(err);
  }
}

async function verifyEmail(req, res, next) {
  try {
    const { token } = req.body;

    if (!token) {
      const e = new Error('Token requerido');
      e.status = 400;
      throw e;
    }

    const result = await pool.query(
      `
      UPDATE users
      SET email_verified = true,
          email_verification_token = NULL,
          email_verification_expires = NULL,
          status = 'ACTIVE',
          updated_at = NOW()
      WHERE email_verification_token = $1
        AND email_verification_expires > NOW()
      RETURNING id, email
      `,
      [token]
    );

    if (result.rowCount === 0) {
      const e = new Error('Token inválido o expirado');
      e.status = 400;
      e.code = 'INVALID_TOKEN';
      throw e;
    }

    await writeAuditLog({
      actorUserId: result.rows[0].id,
      action: 'EMAIL_VERIFIED',
      entityType: 'user',
      entityId: result.rows[0].id,
      before: null,
      after: { email_verified: true },
      ip: req.ip,
      userAgent: req.headers['user-agent'] || null,
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { register, login, verifyEmail };
