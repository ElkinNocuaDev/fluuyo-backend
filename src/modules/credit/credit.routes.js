const express = require('express');
const { requireAuth } = require('../../middlewares/auth.middleware');
const { pool } = require('../../db');

const router = express.Router();

// GET /credit/profile
router.get('/profile', requireAuth, async (req, res, next) => {
  try {
    const profileR = await pool.query(
      `
      SELECT
        cp.user_id,
        cp.current_limit_cop,
        cp.max_limit_cop,
        cp.risk_tier,
        cp.is_suspended,
        cp.suspension_reason,
        cp.score,
        cp.loans_repaid,
        cp.on_time_loans,
        cp.late_loans,
        u.kyc_status
      FROM credit_profiles cp
      JOIN users u ON u.id = cp.user_id
      WHERE cp.user_id = $1
      `,
      [req.user.id]
    );

    const profile = profileR.rows[0];

    if (!profile) {
      const e = new Error('Perfil de crédito no encontrado.');
      e.status = 404;
      e.code = 'NOT_FOUND';
      throw e;
    }

    res.json({
      ok: true,
      credit_profile: {
        ...profile,
        has_history: Number(profile.loans_repaid) > 0
      }
    });
  } catch (err) {
    next(err);
  }
});




router.get('/eligibility', requireAuth, async (req, res, next) => {
  try {
    const r = await pool.query(
      `
      SELECT
        u.kyc_status,
        cp.current_limit_cop,
        cp.max_limit_cop,
        cp.is_suspended,
        cp.suspension_reason
      FROM users u
      JOIN credit_profiles cp ON cp.user_id = u.id
      WHERE u.id = $1 AND u.deleted_at IS NULL
      `,
      [req.user.id]
    );

    const row = r.rows[0];
    if (!row) {
      const e = new Error('Usuario no encontrado.');
      e.status = 404;
      e.code = 'NOT_FOUND';
      throw e;
    }

    const reasons = [];
    if (row.is_suspended) reasons.push(row.suspension_reason || 'Cuenta suspendida');
    if (row.kyc_status !== 'APPROVED') reasons.push('KYC no aprobado');

    // Sprint 4: aquí añadiremos “préstamo activo” cuando exista loans
    const eligible = reasons.length === 0;

    res.json({
      ok: true,
      eligible,
      reasons,
      limits: {
        current_limit_cop: row.current_limit_cop,
        max_limit_cop: row.max_limit_cop
      },
      kyc_status: row.kyc_status
    });
  } catch (err) {
    next(err);
  }
});


module.exports = router;
