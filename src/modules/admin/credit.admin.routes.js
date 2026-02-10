const express = require('express');
const { requireAuth } = require('../../middlewares/auth.middleware');
const { requireRole } = require('../../middlewares/role.middleware');
const { pool } = require('../../db');
const { writeAuditLog } = require('../audit/audit.service');

const router = express.Router();

/**
 * =========================================================
 * GET /admin/credit/profiles
 * LISTADO de perfiles de crédito (ADMIN / OPERATOR)
 * =========================================================
 */
router.get(
  '/credit/profiles',
  requireAuth,
  requireRole('ADMIN', 'OPERATOR'),
  async (req, res, next) => {
    try {
      const r = await pool.query(
        `
        SELECT
          cp.user_id,
          u.email,
          u.kyc_status,
          cp.score,
          cp.risk_tier,
          cp.current_limit_cop,
          cp.max_limit_cop,
          cp.is_suspended,
          cp.updated_at
        FROM credit_profiles cp
        JOIN users u ON u.id = cp.user_id
        ORDER BY cp.updated_at DESC
        `
      );

      res.json({
        ok: true,
        profiles: r.rows
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * =========================================================
 * GET /admin/credit/profiles/:userId
 * DETALLE de un perfil de crédito
 * =========================================================
 */
router.get(
  '/credit/profiles/:userId',
  requireAuth,
  requireRole('ADMIN', 'OPERATOR'),
  async (req, res, next) => {
    try {
      const { userId } = req.params;

      const r = await pool.query(
        `
        SELECT cp.*, u.email, u.kyc_status
        FROM credit_profiles cp
        JOIN users u ON u.id = cp.user_id
        WHERE cp.user_id = $1
        `,
        [userId]
      );

      res.json({
        ok: true,
        profile: r.rows[0] || null
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * =========================================================
 * PATCH /admin/credit/profiles/:userId
 * ACTUALIZAR perfil de crédito
 * =========================================================
 */
router.patch(
  '/credit/profiles/:userId',
  requireAuth,
  requireRole('ADMIN'),
  async (req, res, next) => {
    try {
      const { userId } = req.params;
      const {
        current_limit_cop,
        max_limit_cop,
        risk_tier,
        is_suspended,
        suspension_reason
      } = req.body;

      const beforeR = await pool.query(
        `SELECT * FROM credit_profiles WHERE user_id = $1`,
        [userId]
      );

      const before = beforeR.rows[0];
      if (!before) {
        const e = new Error('Perfil de crédito no encontrado.');
        e.status = 404;
        e.code = 'NOT_FOUND';
        throw e;
      }

      const updated = await pool.query(
        `
        UPDATE credit_profiles
        SET
          current_limit_cop = COALESCE($1, current_limit_cop),
          max_limit_cop     = COALESCE($2, max_limit_cop),
          risk_tier         = COALESCE($3, risk_tier),
          is_suspended      = COALESCE($4, is_suspended),
          suspension_reason = CASE
            WHEN $4 = true THEN COALESCE($5, suspension_reason)
            ELSE NULL
          END,
          updated_at = NOW()
        WHERE user_id = $6
        RETURNING *
        `,
        [
          current_limit_cop ?? null,
          max_limit_cop ?? null,
          risk_tier ?? null,
          typeof is_suspended === 'boolean' ? is_suspended : null,
          suspension_reason ?? null,
          userId
        ]
      );

      await writeAuditLog({
        actorUserId: req.user.id,
        action: 'CREDIT_PROFILE_UPDATED',
        entityType: 'credit_profile',
        entityId: userId,
        before,
        after: updated.rows[0],
        ip: req.ip,
        userAgent: req.headers['user-agent'] || null
      });

      res.json({ ok: true, profile: updated.rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

// GET /admin/credits/:userId/loans
router.get(
  '/credits/:userId/loans',
  requireAuth,
  requireRole('ADMIN', 'OPERATOR'),
  async (req, res, next) => {
    try {
      const { userId } = req.params;

      // Validar perfil de crédito
      const profileR = await pool.query(
        `SELECT user_id FROM credit_profiles WHERE user_id = $1`,
        [userId]
      );

      if (!profileR.rows.length) {
        const e = new Error('Perfil de crédito no encontrado.');
        e.status = 404;
        e.code = 'NOT_FOUND';
        throw e;
      }

      // Préstamos + total pagado
      const loansR = await pool.query(
        `
        SELECT
          l.id,
          l.principal_cop        AS amount_cop,
          l.installment_amount_cop,
          l.total_payable_cop,
          l.term_months,
          l.status,
          l.created_at,
          COALESCE(SUM(lp.amount_cop), 0) AS total_paid_cop
        FROM loans l
        LEFT JOIN loan_payments lp
          ON lp.loan_id = l.id
        WHERE l.user_id = $1
        GROUP BY l.id
        ORDER BY l.created_at DESC
        `,
        [userId]
      );

      res.json({
        ok: true,
        loans: loansR.rows
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * =========================================================
 * POST /admin/credits/:userId/suspend
 * SUSPENDER perfil de crédito + usuario
 * =========================================================
 */
router.post(
  '/credits/:userId/suspend',
  requireAuth,
  requireRole('ADMIN'),
  async (req, res, next) => {
    const client = await pool.connect();

    try {
      const { userId } = req.params;
      const { reason } = req.body;

      await client.query('BEGIN');

      // 1️⃣ Validar usuario
      const userR = await client.query(
        `
        SELECT id, status
        FROM users
        WHERE id = $1 AND deleted_at IS NULL
        `,
        [userId]
      );

      if (!userR.rows.length) {
        const e = new Error('Usuario no encontrado.');
        e.status = 404;
        throw e;
      }

      // 2️⃣ Validar perfil de crédito
      const profileR = await client.query(
        `
        SELECT *
        FROM credit_profiles
        WHERE user_id = $1
        `,
        [userId]
      );

      if (!profileR.rows.length) {
        const e = new Error('Perfil de crédito no encontrado.');
        e.status = 404;
        throw e;
      }

      const beforeProfile = profileR.rows[0];

      // 3️⃣ Suspender usuario (operativo)
      await client.query(
        `
        UPDATE users
        SET
          status = 'SUSPENDED',
          updated_at = NOW()
        WHERE id = $1
        `,
        [userId]
      );

      // 4️⃣ Suspender perfil de crédito (financiero)
      const updatedProfileR = await client.query(
        `
        UPDATE credit_profiles
        SET
          is_suspended = true,
          suspension_reason = $1,
          updated_at = NOW()
        WHERE user_id = $2
        RETURNING *
        `,
        [reason || 'Suspensión administrativa', userId]
      );

      // 5️⃣ Auditoría
      await writeAuditLog({
        actorUserId: req.user.id,
        action: 'CREDIT_PROFILE_SUSPENDED',
        entityType: 'credit_profile',
        entityId: userId,
        before: beforeProfile,
        after: updatedProfileR.rows[0],
        ip: req.ip,
        userAgent: req.headers['user-agent'] || null
      });

      await client.query('COMMIT');

      res.json({
        ok: true,
        message: 'Usuario y perfil de crédito suspendidos correctamente'
      });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  }
);



module.exports = router;
