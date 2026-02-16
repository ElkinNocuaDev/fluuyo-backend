const express = require('express');
const { z } = require('zod');
const { requireAuth } = require('../../middlewares/auth.middleware');
const { pool } = require('../../db');
const { writeAuditLog } = require('../audit/audit.service');
const { eaToEm, fixedInstallment, totalPayable } = require('../../utils/loan.math');

const router = express.Router();

const applySchema = z.object({
  principal_cop: z.number().int().min(100000).max(1000000),
  term_months: z.number().int().refine(v => v === 2 || v === 3, 'term_months debe ser 2 o 3'),
});

const PRODUCT_EA = 0.22; // 22% EA (MVP). Luego lo sacamos de tabla rate.

router.post('/apply', requireAuth, async (req, res, next) => {
  try {
    const data = applySchema.parse(req.body);

    // 1) Cargar estado del usuario + perfil de crédito
    const u = await pool.query(
      `
      SELECT u.id, u.kyc_status, cp.current_limit_cop, cp.max_limit_cop, cp.risk_tier, cp.is_suspended, cp.suspension_reason
      FROM users u
      JOIN credit_profiles cp ON cp.user_id = u.id
      WHERE u.id = $1 AND u.deleted_at IS NULL
      `,
      [req.user.id]
    );

    const row = u.rows[0];
    if (!row) {
      const e = new Error('Usuario no encontrado.');
      e.status = 404; e.code = 'NOT_FOUND';
      throw e;
    }

    // 2) Reglas de elegibilidad
    if (row.is_suspended) {
      const e = new Error(row.suspension_reason || 'Cuenta suspendida.');
      e.status = 403; e.code = 'SUSPENDED';
      throw e;
    }

    if (row.kyc_status !== 'APPROVED') {
      const e = new Error('KYC no aprobado.');
      e.status = 403; e.code = 'KYC_NOT_APPROVED';
      throw e;
    }

    // Riesgo vs plazo
    if (row.risk_tier === 'MEDIUM' && data.term_months === 3) {
      const e = new Error('Tu perfil solo permite plazo de 2 meses.');
      e.status = 400; e.code = 'TERM_NOT_ALLOWED';
      throw e;
    }
    if (row.risk_tier === 'HIGH') {
      const e = new Error('Tu perfil requiere revisión para solicitar préstamo.');
      e.status = 403; e.code = 'RISK_REVIEW_REQUIRED';
      throw e;
    }

    // Monto vs límite
    const limit = Number(row.current_limit_cop);
    if (data.principal_cop > limit) {
      const e = new Error(`Monto excede tu cupo actual (${limit}).`);
      e.status = 400; e.code = 'LIMIT_EXCEEDED';
      throw e;
    }

    // 3) Regla: 1 préstamo activo por usuario
    const active = await pool.query(
      `
      SELECT id, status
      FROM loans
      WHERE user_id = $1 AND status IN ('PENDING','APPROVED','DISBURSED')
      LIMIT 1
      `,
      [req.user.id]
    );

    if (active.rows[0]) {
      const e = new Error('Ya tienes un préstamo en curso.');
      e.status = 409; e.code = 'ACTIVE_LOAN_EXISTS';
      throw e;
    }

    // 4) Calcular tasa mensual y cuota
    const monthlyRate = eaToEm(PRODUCT_EA);
    const installment = fixedInstallment(data.principal_cop, monthlyRate, data.term_months);
    const total = totalPayable(installment, data.term_months);

    // 5) Crear préstamo + cuotas en transacción
    await pool.query('BEGIN');

    const loanIns = await pool.query(
      `
      INSERT INTO loans (
        user_id, principal_cop, term_months,
        interest_ea_used, monthly_rate_em,
        installment_amount_cop, total_payable_cop,
        status
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING')
      RETURNING *
      `,
      [req.user.id, data.principal_cop, data.term_months, PRODUCT_EA, monthlyRate, installment, total]
    );

    const loan = loanIns.rows[0];

    // Generar cuotas: 1ra cuota = +30 días (MVP simple). Luego afinamos por calendario real.
    const today = new Date();
    for (let k = 1; k <= data.term_months; k++) {
      const due = new Date(today);
      due.setDate(due.getDate() + (30 * k));

      // YYYY-MM-DD
      const dueDate = due.toISOString().slice(0, 10);

      await pool.query(
        `
        INSERT INTO loan_installments (loan_id, installment_number, due_date, amount_due_cop)
        VALUES ($1, $2, $3, $4)
        `,
        [loan.id, k, dueDate, installment]
      );
    }

    await writeAuditLog({
      actorUserId: req.user.id,
      action: 'LOAN_APPLIED',
      entityType: 'loan',
      entityId: loan.id,
      before: null,
      after: {
        principal_cop: loan.principal_cop,
        term_months: loan.term_months,
        interest_ea_used: loan.interest_ea_used,
        installment_amount_cop: loan.installment_amount_cop,
        total_payable_cop: loan.total_payable_cop,
        status: loan.status
      },
      ip: req.ip,
      userAgent: req.headers['user-agent'] || null,
    });

    await pool.query('COMMIT');

    // 6) Respuesta: incluye cuotas
    const installments = await pool.query(
      `
      SELECT id, installment_number, due_date, amount_due_cop, amount_paid_cop, status
      FROM loan_installments
      WHERE loan_id = $1
      ORDER BY installment_number ASC
      `,
      [loan.id]
    );

    res.status(201).json({
      ok: true,
      loan,
      installments: installments.rows
    });
  } catch (err) {
    try { await pool.query('ROLLBACK'); } catch (_) {}
    if (err?.name === 'ZodError') {
      err.status = 400;
      err.code = 'VALIDATION_ERROR';
      err.message = 'Datos inválidos.';
      err.details = err.issues;
      return next(err);
    }
    next(err);
  }
});

const { upload } = require('./payments.upload');

const paymentSchema = z.object({
  amount_cop: z.coerce.number().positive(),
  installment_id: z.string().uuid().optional(),
});

router.post('/:id/payments', requireAuth, upload.single('file'), async (req, res, next) => {
  try {
    const { id: loanId } = req.params;
    const data = paymentSchema.parse(req.body);

    if (!req.file) {
      const e = new Error('Archivo requerido.');
      e.status = 400; e.code = 'VALIDATION_ERROR';
      throw e;
    }

    // Validar que el préstamo sea del usuario y esté desembolsado
    const loanR = await pool.query(
      `SELECT id, user_id, status FROM loans WHERE id = $1`,
      [loanId]
    );
    const loan = loanR.rows[0];
    if (!loan) {
      const e = new Error('Préstamo no encontrado.');
      e.status = 404; e.code = 'NOT_FOUND';
      throw e;
    }
    if (loan.user_id !== req.user.id) {
      const e = new Error('No autorizado.');
      e.status = 403; e.code = 'FORBIDDEN';
      throw e;
    }
    if (loan.status !== 'DISBURSED') {
      const e = new Error('Solo puedes registrar pagos cuando el préstamo esté desembolsado.');
      e.status = 409; e.code = 'INVALID_STATE';
      throw e;
    }

    const proofUrl = `/uploads/payments/${loanId}/${req.file.filename}`;

    // Si envía installment_id, validarlo que pertenezca al loan
    let installmentId = data.installment_id || null;
    if (installmentId) {
      const instR = await pool.query(
        `SELECT id FROM loan_installments WHERE id = $1 AND loan_id = $2`,
        [installmentId, loanId]
      );
      if (!instR.rows[0]) {
        const e = new Error('installment_id inválido para este préstamo.');
        e.status = 400; e.code = 'VALIDATION_ERROR';
        throw e;
      }
    }

    const ins = await pool.query(
      `
      INSERT INTO loan_payments (loan_id, installment_id, amount_cop, proof_url, status, created_by)
      VALUES ($1, $2, $3, $4, 'SUBMITTED', $5)
      RETURNING *
      `,
      [loanId, installmentId, data.amount_cop, proofUrl, req.user.id]
    );

    await writeAuditLog({
      actorUserId: req.user.id,
      action: 'PAYMENT_SUBMITTED',
      entityType: 'loan_payment',
      entityId: ins.rows[0].id,
      before: null,
      after: { loan_id: loanId, amount_cop: data.amount_cop, status: 'SUBMITTED' },
      ip: req.ip,
      userAgent: req.headers['user-agent'] || null,
    });

    res.status(201).json({ ok: true, payment: ins.rows[0] });
  } catch (err) {
    if (err?.name === 'ZodError') {
      err.status = 400; err.code = 'VALIDATION_ERROR'; err.message = 'Datos inválidos.'; err.details = err.issues;
      return next(err);
    }
    next(err);
  }
});

// --- GET /loans/active
router.get('/active', requireAuth, async (req, res, next) => {
  try {
    const loanR = await pool.query(
      `
      SELECT *
      FROM loans
      WHERE user_id = $1
        AND status IN ('PENDING','APPROVED','DISBURSED')
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [req.user.id]
    );

    const loan = loanR.rows[0];

    if (!loan) {
      return res.json({
        ok: true,
        loan: null,
        installments: [],
        disbursement_account: null,
      });
    }

    // Cuotas
    const instR = await pool.query(
      `
      SELECT id, installment_number, due_date, amount_due_cop, amount_paid_cop, status
      FROM loan_installments
      WHERE loan_id = $1
      ORDER BY installment_number ASC
      `,
      [loan.id]
    );

    // Cuenta de desembolso
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

    const disbursementAccount = accR.rows[0] || null;

    res.json({
      ok: true,
      loan,
      installments: instR.rows,
      disbursement_account: disbursementAccount,
    });
  } catch (err) {
    next(err);
  }
});


// --- GET /loans/my?limit=10
router.get('/my', requireAuth, async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 10, 50);

    const r = await pool.query(
      `
      SELECT id, principal_cop, term_months, installment_amount_cop, total_payable_cop,
             status, created_at
      FROM loans
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2
      `,
      [req.user.id, limit]
    );

    res.json({ ok: true, loans: r.rows });
  } catch (err) {
    next(err);
  }
});

// --- GET /loans/:id (solo dueño)
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id: loanId } = req.params;

    const loanR = await pool.query(
      `SELECT * FROM loans WHERE id = $1`,
      [loanId]
    );
    const loan = loanR.rows[0];

    if (!loan) {
      const e = new Error('Préstamo no encontrado.');
      e.status = 404; e.code = 'NOT_FOUND';
      throw e;
    }
    if (loan.user_id !== req.user.id) {
      const e = new Error('No autorizado.');
      e.status = 403; e.code = 'FORBIDDEN';
      throw e;
    }

    const instR = await pool.query(
      `
      SELECT id, installment_number, due_date, amount_due_cop, amount_paid_cop, status
      FROM loan_installments
      WHERE loan_id = $1
      ORDER BY installment_number ASC
      `,
      [loanId]
    );

    res.json({ ok: true, loan, installments: instR.rows });
  } catch (err) {
    next(err);
  }
});


const disbursementSchema = z.object({
  bank_name: z.string().min(2).max(120),
  account_type: z.enum(['SAVINGS', 'CHECKING']),
  account_number: z.string().min(5).max(50),
  account_holder_name: z.string().min(3).max(120),
  account_holder_document: z.string().min(5).max(30),
});

router.post('/:id/disbursement-account', requireAuth, async (req, res, next) => {
  const { id } = req.params;
  const userId = req.user.id;

  const client = await pool.connect();

  try {
    const data = disbursementSchema.parse(req.body);

    await client.query('BEGIN');

    const loanR = await client.query(
      `
      SELECT id, user_id, status, disbursed_at
      FROM loans
      WHERE id = $1
      FOR UPDATE
      `,
      [id]
    );

    if (loanR.rowCount === 0) {
      const e = new Error('Préstamo no encontrado.');
      e.status = 404;
      throw e;
    }

    const loan = loanR.rows[0];

    if (loan.user_id !== userId) {
      const e = new Error('No autorizado.');
      e.status = 403;
      throw e;
    }

    if (loan.status !== 'APPROVED') {
      const e = new Error('Solo permitido cuando el préstamo está APPROVED.');
      e.status = 409;
      e.code = 'INVALID_LOAN_STATUS';
      throw e;
    }

    if (loan.disbursed_at) {
      const e = new Error('No se puede modificar la cuenta después del desembolso.');
      e.status = 409;
      throw e;
    }

    const upsertR = await client.query(
      `
      INSERT INTO loan_disbursement_accounts (
        loan_id,
        user_id,
        bank_name,
        account_type,
        account_number,
        account_holder_name,
        account_holder_document,
        is_verified,
        created_at,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,FALSE,NOW(),NOW())
      ON CONFLICT (loan_id)
      DO UPDATE SET
        bank_name = EXCLUDED.bank_name,
        account_type = EXCLUDED.account_type,
        account_number = EXCLUDED.account_number,
        account_holder_name = EXCLUDED.account_holder_name,
        account_holder_document = EXCLUDED.account_holder_document,
        is_verified = FALSE,
        updated_at = NOW()
      RETURNING *
      `,
      [
        id,
        userId,
        data.bank_name,
        data.account_type,
        data.account_number,
        data.account_holder_name,
        data.account_holder_document
      ]
    );

    await writeAuditLog({
      actorUserId: userId,
      action: 'DISBURSEMENT_ACCOUNT_UPSERTED',
      entityType: 'loan_disbursement_account',
      entityId: upsertR.rows[0].id,
      before: null,
      after: {
        loan_id: id,
        bank_name: data.bank_name,
        account_type: data.account_type
      },
      ip: req.ip,
      userAgent: req.headers['user-agent'] || null,
    });

    await client.query('COMMIT');

    res.json({ ok: true, account: upsertR.rows[0] });

  } catch (err) {
    await client.query('ROLLBACK');
    if (err?.name === 'ZodError') {
      err.status = 400;
      err.code = 'VALIDATION_ERROR';
      err.message = 'Datos inválidos.';
      err.details = err.issues;
    }
    next(err);
  } finally {
    client.release();
  }
});


module.exports = router;
