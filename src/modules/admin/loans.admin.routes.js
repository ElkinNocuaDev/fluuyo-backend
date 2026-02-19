const express = require('express');
const { requireAuth } = require('../../middlewares/auth.middleware');
const { requireRole } = require('../../middlewares/role.middleware');
const { pool } = require('../../db');
const { writeAuditLog } = require('../audit/audit.service');

const router = express.Router();

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

const tierDown = (current) => {
  if (current >= 1000000) return 500000;
  if (current >= 500000) return 200000;
  if (current >= 200000) return 100000;
  return 100000;
};

// PATCH /admin/loans/:id/approve
router.patch('/loans/:id/approve', requireAuth, requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const { id } = req.params;

    const beforeR = await pool.query(`SELECT * FROM loans WHERE id = $1`, [id]);
    const before = beforeR.rows[0];
    if (!before) {
      const e = new Error('Préstamo no encontrado.');
      e.status = 404; e.code = 'NOT_FOUND';
      throw e;
    }

    if (before.status !== 'PENDING') {
      const e = new Error('Solo se puede aprobar un préstamo en estado PENDING.');
      e.status = 409; e.code = 'INVALID_STATE';
      throw e;
    }

    const updatedR = await pool.query(
      `
      UPDATE loans
      SET status = 'APPROVED',
          approved_by = $1,
          approved_at = NOW(),
          updated_at = NOW()
      WHERE id = $2
      RETURNING *
      `,
      [req.user.id, id]
    );

    const updated = updatedR.rows[0];

    await writeAuditLog({
      actorUserId: req.user.id,
      action: 'LOAN_APPROVED',
      entityType: 'loan',
      entityId: id,
      before,
      after: { status: updated.status, approved_by: updated.approved_by, approved_at: updated.approved_at },
      ip: req.ip,
      userAgent: req.headers['user-agent'] || null,
    });

    res.json({ ok: true, loan: updated });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/loans/:id/disburse
router.patch(
  '/loans/:id/disburse',
  requireAuth,
  requireRole('ADMIN'),
  async (req, res, next) => {
    const { id } = req.params;

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // 1️⃣ Lock del préstamo
      const loanR = await client.query(
        `
        SELECT 
          id,
          status,
          disbursed_at,
          principal_cop,
          term_months,
          installment_amount_cop
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

      // 2️⃣ Validar estado correcto
      if (loan.status !== 'APPROVED') {
        const e = new Error(
          'Solo se puede desembolsar un préstamo en estado APPROVED.'
        );
        e.status = 409;
        e.code = 'INVALID_LOAN_STATUS';
        throw e;
      }

      if (loan.disbursed_at) {
        const e = new Error('El préstamo ya fue desembolsado.');
        e.status = 409;
        e.code = 'ALREADY_DISBURSED';
        throw e;
      }

      // 3️⃣ Lock cuenta bancaria verificada
      const accR = await client.query(
        `
        SELECT id
        FROM loan_disbursement_accounts
        WHERE loan_id = $1
          AND is_verified = TRUE
        FOR UPDATE
        `,
        [id]
      );

      if (accR.rowCount === 0) {
        const e = new Error(
          'No existe cuenta bancaria verificada para este préstamo.'
        );
        e.status = 409;
        e.code = 'NO_VERIFIED_DISBURSEMENT_ACCOUNT';
        throw e;
      }

      // 4️⃣ Evitar doble generación de cuotas
      const existingInstallments = await client.query(
        `
        SELECT 1
        FROM loan_installments
        WHERE loan_id = $1
        LIMIT 1
        `,
        [id]
      );

      if (existingInstallments.rowCount > 0) {
        const e = new Error(
          'El cronograma ya existe para este préstamo.'
        );
        e.status = 409;
        e.code = 'INSTALLMENTS_ALREADY_EXIST';
        throw e;
      }

      // 5️⃣ Actualizar préstamo
      await client.query(
        `
        UPDATE loans
        SET
          status = 'DISBURSED',
          disbursed_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
        `,
        [id]
      );

      const disbursementDate = new Date();

      // 6️⃣ Generar cuotas
      for (let i = 1; i <= loan.term_months; i++) {
        const dueDate = new Date(disbursementDate);
        dueDate.setMonth(dueDate.getMonth() + i);

        await client.query(
          `
          INSERT INTO loan_installments (
            loan_id,
            installment_number,
            amount_due_cop,
            amount_paid_cop,
            due_date,
            status,
            created_at,
            updated_at
          )
          VALUES (
            $1,
            $2,
            $3,
            0,
            $4,
            'PENDING',
            NOW(),
            NOW()
          )
          `,
          [
            loan.id,
            i,
            loan.installment_amount_cop,
            dueDate
          ]
        );
      }

      // 7️⃣ Registrar transacción contable (tabla correcta)
      await client.query(
        `
        INSERT INTO transactions (
          loan_id,
          type,
          amount_cop,
          reference,
          proof_url,
          created_by,
          created_at
        )
        VALUES (
          $1,
          'DISBURSEMENT',
          $2,
          $3,
          NULL,
          $4,
          NOW()
        )
        `,
        [
          loan.id,
          loan.principal_cop,
          `DISB-${loan.id}`,
          req.user.id
        ]
      );

      await client.query('COMMIT');

      res.json({
        ok: true,
        loan_id: loan.id,
        status: 'DISBURSED'
      });

    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  }
);


router.get('/loan-payments', requireAuth, requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const { status = 'SUBMITTED', page = '1', limit = '20' } = req.query;
    const p = Math.max(parseInt(page, 10) || 1, 1);
    const l = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const offset = (p - 1) * l;

    const limitValue = l;

    const r = await pool.query(
      `
      SELECT lp.id, lp.loan_id, lp.installment_id, lp.amount_cop, lp.proof_url, lp.status, lp.created_at,
             u.email
      FROM loan_payments lp
      JOIN loans lo ON lo.id = lp.loan_id
      JOIN users u ON u.id = lo.user_id
      WHERE lp.status = $1
      ORDER BY lp.created_at DESC
      LIMIT ${l} OFFSET ${offset}
      `,
      [status]
    );

    res.json({ ok: true, page: p, limit: l, payments: r.rows });
  } catch (err) {
    next(err);
  }
});

router.patch('/loan-payments/:id/review', requireAuth, requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, rejection_reason } = req.body;

    const allowed = new Set(['APPROVED', 'REJECTED']);
    if (!allowed.has(status)) {
      const e = new Error('status inválido.');
      e.status = 400; e.code = 'VALIDATION_ERROR';
      throw e;
    }
    if (status === 'REJECTED' && (!rejection_reason || String(rejection_reason).trim().length < 3)) {
      const e = new Error('rejection_reason es requerido al rechazar.');
      e.status = 400; e.code = 'VALIDATION_ERROR';
      throw e;
    }

    await pool.query('BEGIN');

    const payR = await pool.query(
      `SELECT * FROM loan_payments WHERE id = $1 FOR UPDATE`,
      [id]
    );
    const payment = payR.rows[0];
    if (!payment) {
      const e = new Error('Pago no encontrado.');
      e.status = 404; e.code = 'NOT_FOUND';
      throw e;
    }
    if (payment.status !== 'SUBMITTED') {
      const e = new Error('Solo se pueden revisar pagos en estado SUBMITTED.');
      e.status = 409; e.code = 'INVALID_STATE';
      throw e;
    }

    // Actualizar estado del payment
    // const updPay = await pool.query(
    //   `
    //   UPDATE loan_payments
    //   SET status = $1,
    //       reviewed_by = $2,
    //       reviewed_at = NOW(),
    //       rejection_reason = $3
    //   WHERE id = $4
    //   RETURNING *
    //   `,
    //   [status, req.user.id, status === 'REJECTED' ? rejection_reason : null, id]
    // );

    // const updPay = await pool.query(
    //   `
    //   UPDATE loan_payments
    //   SET status = $1,
    //       reviewed_by = $2,
    //       reviewed_at = NOW(),
    //       rejection_reason = $3
    //   WHERE id = $4
    //     AND status = 'SUBMITTED'
    //   RETURNING *
    //   `,
    //   [status, req.user.id, status === 'REJECTED' ? rejection_reason : null, id]
    // );
    
    const updPay = await pool.query(
      `
      UPDATE loan_payments
      SET status = $1,
          reviewed_by = $2,
          reviewed_at = NOW(),
          rejection_reason = $3
      WHERE id = $4
        AND status = 'SUBMITTED'
      RETURNING *
      `,
      [status, req.user.id, status === 'REJECTED' ? rejection_reason : null, id]
    );

    if (updPay.rowCount === 0) {
      const e = new Error('El pago ya fue revisado o no está en estado SUBMITTED.');
      e.status = 409;
      e.code = 'INVALID_STATE';
      throw e;
    }

    const paymentAfter = updPay.rows[0];

    // Si rechazado, no aplica a cuotas
    if (paymentAfter.status === 'REJECTED') {
      await writeAuditLog({
        actorUserId: req.user.id,
        action: 'PAYMENT_REJECTED',
        entityType: 'loan_payment',
        entityId: id,
        before: payment,
        after: updPay.rows[0],
        ip: req.ip,
        userAgent: req.headers['user-agent'] || null,
      });

      await pool.query('COMMIT');
      return res.json({ ok: true, payment: updPay.rows[0] });
    }

    // APPROVED: aplicar pago
    const loanId = paymentAfter.loan_id;

    // Crear transacción ledger (usar paymentAfter)
    await pool.query(
      `
      INSERT INTO transactions (loan_id, type, amount_cop, proof_url, created_by)
      VALUES ($1, 'PAYMENT', $2, $3, $4)
      `,
      [loanId, paymentAfter.amount_cop, paymentAfter.proof_url, req.user.id]
    );

    // Aplicación a cuotas:
    let remaining = Number(paymentAfter.amount_cop);

    const getInstallments = async () => {
      return pool.query(
        `
        SELECT id, amount_due_cop, amount_paid_cop, status
        FROM loan_installments
        WHERE loan_id = $1::uuid
        ORDER BY installment_number ASC
        FOR UPDATE
        `,
        [loanId]
      );
    };


    const instR = await getInstallments();
    const installments = instR.rows;

    const applyTo = (inst) => {
      const due = Number(inst.amount_due_cop);
      const paid = Number(inst.amount_paid_cop);
      const pending = Math.max(due - paid, 0);

      const toPay = Math.min(pending, remaining);
      const newPaid = paid + toPay;
      remaining -= toPay;

      const newStatus = (newPaid >= due) ? 'PAID' : 'PENDING';
      return { toPay, newPaid, newStatus };
    };

    // const targetOrder = payment.installment_id
    //   ? installments.filter(i => i.id === payment.installment_id).concat(installments.filter(i => i.id !== payment.installment_id))
    //   : installments;

    const targetOrder = paymentAfter.installment_id
    ? installments.filter(i => i.id === paymentAfter.installment_id).concat(installments.filter(i => i.id !== paymentAfter.installment_id))
    : installments;

    for (const inst of targetOrder) {
      if (remaining <= 0) break;
      if (inst.status === 'PAID') continue;

      const { toPay, newPaid, newStatus } = applyTo(inst);
      if (toPay <= 0) continue;

      // await pool.query(
      //   `
      //   UPDATE loan_installments
      //   SET amount_paid_cop = $1::numeric,
      //       status = $2::installment_status,
      //       paid_at = CASE WHEN $2::installment_status = 'PAID' THEN NOW() ELSE paid_at END,
      //       updated_at = NOW()
      //   WHERE id = $3::uuid
      //   `,
      //   [newPaid, newStatus, inst.id]
      // );

      // const updInstR = await pool.query(
      //   `
      //   UPDATE loan_installments
      //   SET amount_paid_cop = $1::numeric,
      //       status = $2::installment_status,
      //       paid_at = CASE
      //         WHEN $2::installment_status = 'PAID' THEN NOW()
      //         ELSE paid_at
      //       END,
      //       days_late = CASE
      //         WHEN $2::installment_status = 'PAID' THEN
      //           GREATEST(
      //             0,
      //             FLOOR(EXTRACT(EPOCH FROM (NOW() - due_date)) / 86400)::int
      //           )
      //         ELSE days_late
      //       END,
      //       updated_at = NOW()
      //   WHERE id = $3::uuid
      //   `,
      //   [newPaid, newStatus, inst.id]
      // );

      // const instUpdated = updInstR.rows[0];

      const updInstR = await pool.query(
      `
      UPDATE loan_installments
      SET amount_paid_cop = $1::numeric,
          status = $2::installment_status,
          paid_at = CASE
            WHEN $2::installment_status = 'PAID' THEN NOW()
            ELSE paid_at
          END,
          days_late = CASE
            WHEN $2::installment_status = 'PAID' THEN
              GREATEST(0, (CURRENT_DATE - due_date::date))
            ELSE days_late
          END,
          updated_at = NOW()
      WHERE id = $3::uuid
      RETURNING id, installment_number, due_date, paid_at, status, days_late
      `,
      [newPaid, newStatus, inst.id]
    );

    if (updInstR.rowCount === 0) {
      const e = new Error('No se pudo actualizar la cuota.');
      e.status = 500;
      e.code = 'INSTALLMENT_UPDATE_FAILED';
      throw e;
    }

    const instUpdated = updInstR.rows[0];


    // Si la cuota quedó pagada con mora, actualiza métricas del perfil
    // if (instUpdated && instUpdated.status === 'PAID' && Number(instUpdated.days_late) > 0) {
    //   await pool.query(
    //     `
    //     UPDATE credit_profiles
    //     SET late_payments = late_payments + 1,
    //         days_past_due_total = days_past_due_total + $2::int,
    //         updated_at = NOW()
    //     WHERE user_id = (
    //       SELECT user_id FROM loans WHERE id = $1::uuid
    //     )
    //     `,
    //     [loanId, Number(instUpdated.days_late)]
    //   );
    // }

    }

    // Si quedó sobrante, lo dejamos como "crédito" para próxima cuota (MVP: no guardamos crédito extra; lo puedes convertir en adjustment)
    // Para MVP: si remaining > 0, lo aplicamos igual pero como paid extra en última cuota (no recomendado),
    // o lo dejamos registrado en transactions como pago, y en operaciones se ajusta manual.
    // Aquí lo más seguro: si remaining > 0 => error y rollback (evita inconsistencias).
    if (remaining > 0.009) {
      const e = new Error('El pago excede el saldo pendiente del préstamo.');
      e.status = 400; e.code = 'OVERPAYMENT';
      throw e;
    }

    // Verificar si todas las cuotas están PAID → cerrar préstamo
    const check = await pool.query(
      `
      SELECT COUNT(*)::int AS total,
             SUM(CASE WHEN status = 'PAID' THEN 1 ELSE 0 END)::int AS paid
      FROM loan_installments
      WHERE loan_id = $1::uuid
      `,
      [loanId]
    );
    

    if (check.rows[0].total > 0 && check.rows[0].paid === check.rows[0].total) {
    // 1) Cerrar el préstamo (idempotente: solo si aún no está cerrado)
    const closedR = await pool.query(
      `
      UPDATE loans
      SET status = 'CLOSED',
          closed_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
        AND status <> 'CLOSED'
      RETURNING id, user_id, term_months
      `,
      [loanId]
    );

    // Si no retornó fila, ya estaba CLOSED (evita doble conteo)
    if (closedR.rowCount === 0) {
      // No hacemos nada más para evitar duplicar métricas
    } else {
      const { user_id, term_months } = closedR.rows[0];

      // 2) Calcular mora total del préstamo desde cuotas (ya con days_late)
      const lateAggR = await pool.query(
        `
        SELECT
          COALESCE(SUM(COALESCE(days_late, 0)), 0)::int AS total_days_late,
          COALESCE(SUM(CASE WHEN COALESCE(days_late, 0) > 0 THEN 1 ELSE 0 END), 0)::int AS late_installments
        FROM loan_installments
        WHERE loan_id = $1::uuid
        `,
        [loanId]
      );

    const totalDaysLate = Number(lateAggR.rows[0].total_days_late || 0);
    const lateInstallments = Number(lateAggR.rows[0].late_installments || 0);
    const isOnTimeLoan = lateInstallments === 0;

    // 3) Bloquear y leer credit_profile
    const cpR = await pool.query(
      `
      SELECT
        current_limit_cop,
        max_limit_cop,
        loans_repaid,
        on_time_loans,
        late_loans,
        score
      FROM credit_profiles
      WHERE user_id = $1
      FOR UPDATE
      `,
      [user_id]
    );

    const cp = cpR.rows[0];

    if (cp) {
      const current = Number(cp.current_limit_cop);
      const max = Number(cp.max_limit_cop);
      const repaid = Number(cp.loans_repaid || 0);
      // const onTimeLoans = Number(cp.on_time_loans || 0);
      // const lateLoans = Number(cp.late_loans || 0);
      const prevScore = Number(cp.score ?? 50);

      // 4) Score MVP (simple y explicable)
      // Base: score actual
      // +10 si préstamo puntual
      // -15 si tuvo mora (cualquier cuota)
      // Penalización extra si totalDaysLate es alta (opcional)
      let newScore = prevScore + (isOnTimeLoan ? 10 : -15);

      if (!isOnTimeLoan) {
        if (totalDaysLate > 15) newScore -= 10; // mora alta
        if (totalDaysLate > 30) newScore -= 10; // mora extrema
      }

      newScore = clamp(newScore, 20, 100);

      // 5) Regla de cupo por tiers + score + historial
      // - Puntual: puede subir
      // - Con mora: no sube; si mora alta (>15) baja 1 tier
      let newLimit = current;

      if (isOnTimeLoan) {
        // escalera base
        if (current <= 100000) newLimit = 200000;
        else if (current <= 200000 && (repaid + 1) >= 2) newLimit = 500000;
        else if (current <= 500000 && newScore >= 85 && (repaid + 1) >= 4) newLimit = 1000000;

        // Puedes endurecer: si newScore < 40, no sube
        if (newScore < 40) newLimit = current;
      } else {
        // si mora alta, baja tier
        if (totalDaysLate > 15) {
          newLimit = tierDown(current);
        }
      }

      if (newLimit > max) newLimit = max;

      // 6) Actualizar credit_profile (contadores por préstamo, no por cuota)
      await pool.query(
        `
        UPDATE credit_profiles
        SET loans_repaid = loans_repaid + 1,
            on_time_loans = on_time_loans + $2::int,
            late_loans = late_loans + $3::int,
            score = $4::int,
            current_limit_cop = $5::numeric,
            last_repaid_at = NOW(),
            updated_at = NOW()
        WHERE user_id = $1
        `,
        [
          user_id,
          isOnTimeLoan ? 1 : 0,
          isOnTimeLoan ? 0 : 1,
          newScore,
          newLimit
        ]
      );
    }
  }
    }

    await writeAuditLog({
      actorUserId: req.user.id,
      action: 'PAYMENT_APPROVED',
      entityType: 'loan_payment',
      entityId: id,
      before: payment,
      after: updPay.rows[0],
      ip: req.ip,
      userAgent: req.headers['user-agent'] || null,
    });

    await pool.query('COMMIT');

    res.json({ ok: true, payment: updPay.rows[0] });
  } catch (err) {
    try { await pool.query('ROLLBACK'); } catch (_) {}
    next(err);
  }
});

// GET /admin/loans?status=&page=&limit=
router.get(
  '/loans',
  requireAuth,
  requireRole('ADMIN', 'OPERATOR'),
  async (req, res, next) => {
    try {
      const { status, page = '1', limit = '20' } = req.query;

      const p = Math.max(parseInt(page, 10) || 1, 1);
      const l = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
      const offset = (p - 1) * l;

      const params = [];
      let where = '';

      if (status) {
        params.push(status);
        where = `WHERE l.status = $1`;
      }

      // COUNT
      const countR = await pool.query(
        `
        SELECT COUNT(*)::int AS total
        FROM loans l
        ${where}
        `,
        params
      );

      // Agregamos limit y offset como parámetros
      params.push(l);
      params.push(offset);

      const rowsR = await pool.query(
        `
        SELECT
          l.id,
          l.user_id,
          u.email,
          l.principal_cop,
          l.status,
          l.created_at,
          l.updated_at
        FROM loans l
        JOIN users u ON u.id = l.user_id
        ${where}
        ORDER BY l.created_at DESC
        LIMIT $${params.length - 1}
        OFFSET $${params.length}
        `,
        params
      );

      res.json({
        ok: true,
        page: p,
        limit: l,
        total: countR.rows[0].total,
        loans: rowsR.rows
      });
    } catch (err) {
      next(err);
    }
  }
);



// GET /admin/loans/:id
router.get(
  '/loans/:id',
  requireAuth,
  requireRole('ADMIN', 'OPERATOR'),
  async (req, res, next) => {
    try {
      const { id } = req.params;

      // 1️⃣ Préstamo + usuario
      const loanR = await pool.query(
        `
        SELECT
          l.*,
          u.email,
          u.kyc_status
        FROM loans l
        JOIN users u ON u.id = l.user_id
        WHERE l.id = $1
        `,
        [id]
      );

      const loan = loanR.rows[0];
      if (!loan) {
        const e = new Error('Préstamo no encontrado.');
        e.status = 404;
        e.code = 'NOT_FOUND';
        throw e;
      }

      // 2️⃣ Cuenta bancaria de desembolso
      const accountR = await pool.query(
        `
        SELECT
          id,
          account_holder_name,
          account_holder_document,
          bank_name,
          account_type,
          account_number,
          is_verified,
          created_at,
          updated_at
        FROM loan_disbursement_accounts
        WHERE loan_id = $1
        `,
        [id]
      );

      const disbursementAccount = accountR.rows[0] || null;

      // 3️⃣ Cuotas (compatible + estado derivable correcto)
      const installmentsR = await pool.query(
        `
        SELECT
          li.id,
          li.amount_due_cop AS amount_cop,
          li.amount_paid_cop,
          li.due_date,
      
          -- Estado contable real
          li.status AS base_status,
      
          -- Último estado de pago asociado a esta cuota
          (
            SELECT lp.status
            FROM loan_payments lp
            WHERE lp.installment_id = li.id
            ORDER BY lp.created_at DESC
            LIMIT 1
          ) AS latest_payment_status,
      
          -- 🔒 Mantener compatibilidad con producción
          CASE
            WHEN (
              SELECT lp.status
              FROM loan_payments lp
              WHERE lp.installment_id = li.id
              ORDER BY lp.created_at DESC
              LIMIT 1
            ) = 'SUBMITTED'
            THEN 'UNDER_REVIEW'
            ELSE li.status
          END AS status,
      
          li.paid_at,
          li.days_late
      
        FROM loan_installments li
        WHERE li.loan_id = $1
        ORDER BY li.installment_number ASC
        `,
        [id]
      );


      // 4️⃣ Pagos
      const paymentsR = await pool.query(
        `
        SELECT
          lp.id,
          lp.amount_cop,
          lp.status,
          lp.proof_url,
          lp.created_at,
          lp.reviewed_at
        FROM loan_payments lp
        WHERE lp.loan_id = $1
        ORDER BY lp.created_at DESC
        `,
        [id]
      );

      res.json({
        ok: true,
        loan,
        disbursement_account: disbursementAccount,
        installments: installmentsR.rows,
        payments: paymentsR.rows
      });

    } catch (err) {
      next(err);
    }
  }
);



// GET /admin/loans/:id/payments
router.get(
  '/loans/:id/payments',
  requireAuth,
  requireRole('ADMIN', 'OPERATOR'),
  async (req, res, next) => {
    try {
      const { id } = req.params;

      const r = await pool.query(
        `
        SELECT
          lp.id,
          lp.amount_cop,
          lp.status,
          lp.proof_url,
          lp.created_at,
          lp.reviewed_at
        FROM loan_payments lp
        WHERE lp.loan_id = $1
        ORDER BY lp.created_at DESC
        `,
        [id]
      );

      res.json({
        ok: true,
        payments: r.rows
      });
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  '/loans/:id/verify-disbursement-account',
  requireAuth,
  requireRole('ADMIN'),
  async (req, res, next) => {
    const { id } = req.params;

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // 1️⃣ Validar préstamo
      const loanR = await client.query(
        `
        SELECT id, status, disbursed_at
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

      if (loan.status !== 'APPROVED') {
        const e = new Error(
          'Solo se puede verificar cuenta cuando el préstamo está APPROVED.'
        );
        e.status = 409;
        e.code = 'INVALID_LOAN_STATUS';
        throw e;
      }

      if (loan.disbursed_at) {
        const e = new Error(
          'No se puede verificar cuenta después del desembolso.'
        );
        e.status = 409;
        throw e;
      }

      // 2️⃣ Verificar que exista cuenta
      const accR = await client.query(
        `
        SELECT id, is_verified
        FROM loan_disbursement_accounts
        WHERE loan_id = $1
        FOR UPDATE
        `,
        [id]
      );

      if (accR.rowCount === 0) {
        const e = new Error(
          'No existe cuenta bancaria registrada para este préstamo.'
        );
        e.status = 409;
        e.code = 'NO_DISBURSEMENT_ACCOUNT';
        throw e;
      }

      const account = accR.rows[0];

      // 3️⃣ Si ya está verificada → idempotente
      if (account.is_verified) {
        await client.query('COMMIT');
        return res.json({
          ok: true,
          already_verified: true
        });
      }

      // 4️⃣ Marcar como verificada
      await client.query(
        `
        UPDATE loan_disbursement_accounts
        SET is_verified = TRUE,
            updated_at = NOW()
        WHERE loan_id = $1
        `,
        [id]
      );

      await client.query('COMMIT');

      res.json({
        ok: true,
        verified: true
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
