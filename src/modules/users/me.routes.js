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


/**
 * GET /me/disbursement-account
 * Devuelve la cuenta bancaria asociada al préstamo activo
 */
router.get('/me/disbursement-account', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;

    // Buscar préstamo activo
    const loanR = await pool.query(
      `
      SELECT id, status
      FROM loans
      WHERE user_id = $1
        AND status IN ('PENDING','APPROVED','DISBURSED')
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [userId]
    );

    const loan = loanR.rows[0];
    if (!loan) {
      return res.json({ ok: true, disbursement_account: null });
    }

    const accR = await pool.query(
      `
      SELECT
        id,
        account_holder_name,
        account_holder_document,
        bank_name,
        account_type,
        account_number,
        is_verified,
        created_at
      FROM loan_disbursement_accounts
      WHERE loan_id = $1
      LIMIT 1
      `,
      [loan.id]
    );

    res.json({
      ok: true,
      disbursement_account: accR.rows[0] || null
    });

  } catch (err) {
    next(err);
  }
});


/**
 * POST /me/disbursement-account
 * Crea o actualiza la cuenta bancaria para el préstamo aprobado
 */
router.post('/me/disbursement-account', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;

    let {
      account_holder_name,
      account_holder_document,
      bank_name,
      account_type,
      account_number
    } = req.body;

    // ==========================
    // Normalización
    // ==========================
    account_holder_name = String(account_holder_name || '').trim().toUpperCase();
    account_holder_document = String(account_holder_document || '').trim();
    bank_name = String(bank_name || '').trim().toUpperCase();
    account_type = String(account_type || '').trim().toUpperCase();
    account_number = String(account_number || '').trim();

    // ==========================
    // Validación básica presencia
    // ==========================
    if (
      !account_holder_name ||
      !account_holder_document ||
      !bank_name ||
      !account_number
    ) {
      const e = new Error('Datos incompletos.');
      e.status = 400;
      throw e;
    }

    // ==========================
    // Validación nombre
    // ==========================
    if (account_holder_name.length < 5) {
      const e = new Error('Nombre del titular inválido.');
      e.status = 400;
      throw e;
    }

    // ==========================
    // Validación documento
    // ==========================
    if (!/^[0-9]{5,15}$/.test(account_holder_document)) {
      const e = new Error('Documento inválido.');
      e.status = 400;
      throw e;
    }

    // ==========================
    // Validación número solo dígitos
    // ==========================
    if (!/^[0-9]+$/.test(account_number)) {
      const e = new Error('El número debe contener solo dígitos.');
      e.status = 400;
      throw e;
    }

    // ==========================
    // Validación según entidad
    // ==========================
    const isWallet =
      bank_name === 'NEQUI' ||
      bank_name === 'DAVIPLATA';

    if (isWallet) {
      // Debe ser celular colombiano 10 dígitos iniciando en 3
      if (!/^[3][0-9]{9}$/.test(account_number)) {
        const e = new Error(
          'Nequi/Daviplata debe ser un celular válido de 10 dígitos que inicie en 3.'
        );
        e.status = 400;
        throw e;
      }

      // Forzamos tipo consistente para billeteras
      account_type = 'WALLET';

    } else {
      // Cuenta bancaria tradicional
      if (!/^[0-9]{6,20}$/.test(account_number)) {
        const e = new Error(
          'La cuenta bancaria debe tener entre 6 y 20 dígitos.'
        );
        e.status = 400;
        throw e;
      }

      if (!account_type) {
        const e = new Error('Tipo de cuenta requerido.');
        e.status = 400;
        throw e;
      }

      if (!['SAVINGS', 'CHECKING'].includes(account_type)) {
        const e = new Error('Tipo de cuenta inválido.');
        e.status = 400;
        throw e;
      }
    }

    // ==========================
    // Debe tener préstamo APPROVED
    // ==========================
    const loanR = await pool.query(
      `
      SELECT id, status
      FROM loans
      WHERE user_id = $1
        AND status = 'APPROVED'
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [userId]
    );

    const loan = loanR.rows[0];

    if (!loan) {
      const e = new Error('No tienes un préstamo aprobado.');
      e.status = 400;
      throw e;
    }

    // ==========================
    // Verificar si ya existe cuenta
    // ==========================
    const existingR = await pool.query(
      `
      SELECT id, is_verified
      FROM loan_disbursement_accounts
      WHERE loan_id = $1
      `,
      [loan.id]
    );

    if (existingR.rowCount > 0) {
      const existing = existingR.rows[0];

      if (existing.is_verified) {
        const e = new Error(
          'La cuenta ya fue verificada y no puede modificarse.'
        );
        e.status = 400;
        throw e;
      }

      // Update si no está verificada
      await pool.query(
        `
        UPDATE loan_disbursement_accounts
        SET
          account_holder_name = $1,
          account_holder_document = $2,
          bank_name = $3,
          account_type = $4,
          account_number = $5,
          updated_at = now()
        WHERE loan_id = $6
        `,
        [
          account_holder_name,
          account_holder_document,
          bank_name,
          account_type,
          account_number,
          loan.id
        ]
      );

    } else {
      // Insert
      await pool.query(
        `
        INSERT INTO loan_disbursement_accounts (
          loan_id,
          user_id,
          account_holder_name,
          account_holder_document,
          bank_name,
          account_type,
          account_number
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        `,
        [
          loan.id,
          userId,
          account_holder_name,
          account_holder_document,
          bank_name,
          account_type,
          account_number
        ]
      );
    }

    res.json({ ok: true });

  } catch (err) {
    next(err);
  }
});




module.exports = router;
