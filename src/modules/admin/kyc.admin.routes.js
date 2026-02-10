const express = require('express');
const { requireAuth } = require('../../middlewares/auth.middleware');
const { requireRole } = require('../../middlewares/role.middleware');
const { pool } = require('../../db');
const { writeAuditLog } = require('../audit/audit.service');

const path = require("path");
const fs = require("fs");

const router = express.Router();

/**
 * GET /admin/kyc/documents?status=&user_id=&page=&limit=
 */
router.get('/kyc/documents', requireAuth, requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const { status, user_id, page = '1', limit = '20' } = req.query;
    const p = Math.max(parseInt(page, 10) || 1, 1);
    const l = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const offset = (p - 1) * l;

    const filters = [];
    const values = [];
    let idx = 1;

    if (status) {
      filters.push(`d.status = $${idx++}`);
      values.push(status);
    }
    if (user_id) {
      filters.push(`d.user_id = $${idx++}`);
      values.push(user_id);
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const q = await pool.query(
      `
      SELECT d.id, d.user_id, u.email, d.document_type, d.status, d.reviewed_at, d.rejection_reason, d.created_at, d.file_url
      FROM kyc_documents d
      JOIN users u ON u.id = d.user_id
      ${where}
      ORDER BY d.created_at DESC
      LIMIT ${l} OFFSET ${offset}
      `,
      values
    );

    res.json({ ok: true, page: p, limit: l, documents: q.rows });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /admin/kyc/documents/:id/review
 * body: { status: 'APPROVED'|'REJECTED'|'IN_REVIEW', rejection_reason? }
 */
router.patch('/kyc/documents/:id/review', requireAuth, requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, rejection_reason } = req.body;

    const allowed = new Set(['IN_REVIEW', 'APPROVED', 'REJECTED']);
    if (!allowed.has(status)) {
      const e = new Error('status inválido.');
      e.status = 400;
      e.code = 'VALIDATION_ERROR';
      throw e;
    }
    if (status === 'REJECTED' && (!rejection_reason || String(rejection_reason).trim().length < 3)) {
      const e = new Error('rejection_reason es requerido al rechazar.');
      e.status = 400;
      e.code = 'VALIDATION_ERROR';
      throw e;
    }

    // Before snapshot
    const beforeR = await pool.query(
      `SELECT id, user_id, document_type, status, file_url FROM kyc_documents WHERE id = $1`,
      [id]
    );
    const before = beforeR.rows[0];
    if (!before) {
      const e = new Error('Documento no encontrado.');
      e.status = 404;
      e.code = 'NOT_FOUND';
      throw e;
    }

    const updated = await pool.query(
      `
      UPDATE kyc_documents
      SET status = $1,
          reviewed_by = $2,
          reviewed_at = NOW(),
          rejection_reason = $3,
          updated_at = NOW()
      WHERE id = $4
      RETURNING id, user_id, document_type, status, reviewed_at, rejection_reason
      `,
      [status, req.user.id, status === 'REJECTED' ? rejection_reason : null, id]
    );

    // Regla Start Waves (MVP): ID_FRONT + SELFIE obligatorios
    const reqTypes = ['ID_FRONT', 'SELFIE'];
    const userId = before.user_id;
    
    const stats = await pool.query(
      `
      SELECT document_type, status
      FROM kyc_documents
      WHERE user_id = $1
      `,
      [userId]
    );
    
    const docs = stats.rows;
    
    let newKycStatus = 'SUBMITTED';
    
    // Si hay algún REJECTED, el usuario queda REJECTED
    if (docs.some(d => d.status === 'REJECTED')) {
      newKycStatus = 'REJECTED';
    } else {
      // Verifica que los obligatorios existan y estén APPROVED
      const byType = new Map(docs.map(d => [d.document_type, d.status]));
      const okRequired = reqTypes.every(t => byType.get(t) === 'APPROVED');
    
      newKycStatus = okRequired ? 'APPROVED' : 'SUBMITTED';
    }
    
    await pool.query(
      `UPDATE users SET kyc_status = $1, updated_at = NOW() WHERE id = $2`,
      [newKycStatus, userId]
    );

    await writeAuditLog({
      actorUserId: req.user.id,
      action: 'KYC_DOCUMENT_REVIEWED',
      entityType: 'kyc_document',
      entityId: id,
      before,
      after: updated.rows[0],
      ip: req.ip,
      userAgent: req.headers['user-agent'] || null,
    });

    res.json({ ok: true, document: updated.rows[0], user_kyc_status: newKycStatus });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /admin/kyc/users
 * Listado de usuarios con estado KYC
 */
router.get('/kyc/users', requireAuth, requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const q = await pool.query(`
      SELECT
        u.id,
        u.email,
        u.first_name,
        u.last_name,
        u.kyc_status,
        u.updated_at
      FROM users u
      WHERE u.deleted_at IS NULL
      ORDER BY u.updated_at DESC
    `);

    const users = q.rows.map(u => ({
      id: u.id,
      email: u.email,
      name: `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim(),
      kyc_status: u.kyc_status,
      updated_at: u.updated_at
    }));

    res.json({ ok: true, users });
  } catch (err) {
    next(err);
  }
});


/**
 * GET /admin/kyc/users/:userId
 * Documentos KYC de un usuario
 */
router.get('/kyc/users/:userId', requireAuth, requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const { userId } = req.params;

    const userR = await pool.query(`
      SELECT
        id,
        email,
        first_name,
        last_name,
        kyc_status
      FROM users
      WHERE id = $1 AND deleted_at IS NULL
    `, [userId]);

    const user = userR.rows[0];
    if (!user) {
      const e = new Error('Usuario no encontrado.');
      e.status = 404;
      throw e;
    }

    const docsR = await pool.query(`
      SELECT
        id,
        document_type,
        status,
        file_url,
        reviewed_at,
        rejection_reason,
        created_at
      FROM kyc_documents
      WHERE user_id = $1
      ORDER BY created_at DESC
    `, [userId]);

    res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        name: `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim(),
        kyc_status: user.kyc_status
      },
      documents: docsR.rows
    });
  } catch (err) {
    next(err);
  }
});


/**
 * GET /admin/kyc/documents/:id/view
 * Ver archivo KYC (ADMIN / OPERATOR)
 */
router.get(
  "/kyc/documents/:id/view",
  requireAuth,
  requireRole("ADMIN", "OPERATOR"),
  async (req, res, next) => {
    try {
      const { id } = req.params;

      const r = await pool.query(
        `
        SELECT id, document_type, file_url
        FROM kyc_documents
        WHERE id = $1
        `,
        [id]
      );

      const doc = r.rows[0];
      if (!doc) {
        const e = new Error("Documento no encontrado.");
        e.status = 404;
        throw e;
      }

      const abs = path.resolve(process.cwd(), doc.file_url);
      if (!fs.existsSync(abs)) {
        const e = new Error("Archivo no encontrado en disco.");
        e.status = 404;
        throw e;
      }

      const ext = path.extname(abs);
      const filename = `${doc.document_type}${ext}`;

      // INLINE = ver en navegador
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${filename}"`
      );

      return res.sendFile(abs);
    } catch (err) {
      next(err);
    }
  }
);


module.exports = router;
