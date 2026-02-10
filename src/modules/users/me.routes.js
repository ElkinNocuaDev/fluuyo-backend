const express = require('express');
const { requireAuth } = require('../../middlewares/auth.middleware');
const { pool } = require('../../db');

const router = express.Router();

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `
      SELECT id, email, phone, first_name, last_name, role, status, kyc_status, created_at, updated_at
      FROM users
      WHERE id = $1 AND deleted_at IS NULL
      `,
      [req.user.id]
    );

    const user = result.rows[0];
    if (!user) {
      const e = new Error('Usuario no encontrado.');
      e.status = 404;
      e.code = 'NOT_FOUND';
      throw e;
    }

    res.json({ ok: true, user });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /me/credit-profile
 * Devuelve el perfil crediticio del usuario autenticado
 */
router.get('/me/credit-profile', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;

    const r = await pool.query(
      `
      SELECT
        user_id,
        current_limit_cop,
        max_limit_cop,
        score,
        on_time_loans,
        late_loans,
        loans_repaid,
        last_repaid_at,
        created_at,
        updated_at
      FROM credit_profiles
      WHERE user_id = $1::uuid
      `,
      [userId]
    );

    // MVP recomendado: crear automáticamente si no existe
    if (r.rowCount === 0) {
      const upsert = await pool.query(
        `
        INSERT INTO credit_profiles (
          user_id,
          current_limit_cop,
          max_limit_cop
        )
        VALUES ($1::uuid, 100000, 1000000)
        ON CONFLICT (user_id) DO UPDATE
        SET user_id = EXCLUDED.user_id
        RETURNING
          user_id,
          current_limit_cop,
          max_limit_cop,
          score,
          on_time_loans,
          late_loans,
          loans_repaid,
          last_repaid_at,
          created_at,
          updated_at
        `,
        [userId]
      );
  
      return res.json({
        ok: true,
        credit_profile: upsert.rows[0],
        created: true
      });
    }

    res.json({ ok: true, credit_profile: r.rows[0] });
  } catch (err) {
    next(err);
  }
});


module.exports = router;
