const express = require('express');
const { requireAuth } = require('../../middlewares/auth.middleware');
const { requireRole } = require('../../middlewares/role.middleware');
const { pool } = require('../../db');

const router = express.Router();

// router.get('/users', requireAuth, requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
//   try {
//     const { q = '', kyc_status, status, page = '1', limit = '20' } = req.query;
// 
//     const p = Math.max(parseInt(page, 10) || 1, 1);
//     const l = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
//     const offset = (p - 1) * l;
// 
//     const filters = [];
//     const values = [];
//     let idx = 1;
// 
//     if (q) {
//       filters.push(`(email ILIKE $${idx} OR phone ILIKE $${idx})`);
//       values.push(`%${q}%`);
//       idx++;
//     }
//     if (kyc_status) {
//       filters.push(`kyc_status = $${idx}`);
//       values.push(kyc_status);
//       idx++;
//     }
//     if (status) {
//       filters.push(`status = $${idx}`);
//       values.push(status);
//       idx++;
//     }
// 
//     filters.push(`deleted_at IS NULL`);
// 
//     const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
// 
//     const rows = await pool.query(
//       `
//       SELECT id, email, phone, role, status, kyc_status, created_at, updated_at
//       FROM users
//       ${where}
//       ORDER BY created_at DESC
//       LIMIT ${l} OFFSET ${offset}
//       `,
//       values
//     );
// 
//     res.json({ ok: true, page: p, limit: l, users: rows.rows });
//   } catch (err) {
//     next(err);
//   }
// });

router.get('/users', requireAuth, requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const { q = '', kyc_status, status, page = '1', limit = '20' } = req.query;

    const p = Math.max(parseInt(page, 10) || 1, 1);
    const l = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const offset = (p - 1) * l;

    const filters = [];
    const values = [];
    let idx = 1;

    if (q) {
      filters.push(`(email ILIKE $${idx} OR phone ILIKE $${idx})`);
      values.push(`%${q}%`);
      idx++;
    }
    if (kyc_status) {
      filters.push(`kyc_status = $${idx}`);
      values.push(kyc_status);
      idx++;
    }
    if (status) {
      filters.push(`status = $${idx}`);
      values.push(status);
      idx++;
    }

    filters.push(`deleted_at IS NULL`);

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    // 🔹 TOTAL (para paginación)
    const countR = await pool.query(
      `
      SELECT COUNT(*)::int AS total
      FROM users
      ${where}
      `,
      values
    );

    // 🔹 DATA
    const rows = await pool.query(
      `
      SELECT id, first_name, last_name, email, phone, role, status, kyc_status, created_at, updated_at
      FROM users
      ${where}
      ORDER BY created_at DESC
      LIMIT ${l} OFFSET ${offset}
      `,
      values
    );

    res.json({
      ok: true,
      page: p,
      limit: l,
      total: countR.rows[0].total,
      users: rows.rows
    });
  } catch (err) {
    next(err);
  }
});

router.get(
  '/stats',
  requireAuth,
  requireRole('ADMIN', 'OPERATOR'),
  async (req, res, next) => {
    try {
      const [usersR, creditProfilesR, pendingLoansR] = await Promise.all([
        pool.query(`
          SELECT COUNT(*)::int AS count
          FROM users
          WHERE deleted_at IS NULL
        `),

        pool.query(`
          SELECT COUNT(*)::int AS count
          FROM credit_profiles
        `),

        pool.query(`
          SELECT COUNT(*)::int AS count
          FROM loans
          WHERE status = 'PENDING'
        `)
      ]);

      res.json({
        ok: true,
        stats: {
          users: usersR.rows[0].count,
          credits: creditProfilesR.rows[0].count,
          pendingLoans: pendingLoansR.rows[0].count
        }
      });
    } catch (err) {
      next(err);
    }
  }
);


router.get(
  '/users/:id',
  requireAuth,
  requireRole('ADMIN', 'OPERATOR'),
  async (req, res, next) => {
    try {
      const { id } = req.params;

      const userR = await pool.query(
        `
        SELECT
          id,
          email,
          phone,
          first_name,
          last_name,
          role,
          status,
          kyc_status,
          created_at,
          updated_at
        FROM users
        WHERE id = $1 AND deleted_at IS NULL
        `,
        [id]
      );

      if (userR.rowCount === 0) {
        return res.status(404).json({ ok: false, message: 'Usuario no encontrado' });
      }

      res.json({ ok: true, user: userR.rows[0] });
    } catch (err) {
      next(err);
    }
  }
);


router.get(
  '/users/:id/loans',
  requireAuth,
  requireRole('ADMIN', 'OPERATOR'),
  async (req, res, next) => {
    try {
      const { id } = req.params;

      const loansR = await pool.query(
        `
        SELECT
          id,
          principal_cop,
          installment_amount_cop,
          total_payable_cop,
          term_months,
          status,
          created_at
        FROM loans
        WHERE user_id = $1
        ORDER BY created_at DESC
        `,
        [id]
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



module.exports = router;
