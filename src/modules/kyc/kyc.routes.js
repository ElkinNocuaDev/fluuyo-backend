const express = require('express');
const path = require('path');
const { requireAuth } = require('../../middlewares/auth.middleware');
const { upload } = require('./kyc.upload');
const { pool } = require('../../db');
const { writeAuditLog } = require('../audit/audit.service');
const fs = require("fs");

const router = express.Router();

const ALLOWED = new Set(['ID_FRONT', 'ID_BACK', 'SELFIE', 'PROOF_ADDRESS']);

// 🇨🇴 Requeridos para KYC en tu MVP
const REQUIRED = ['ID_FRONT', 'ID_BACK', 'SELFIE', 'PROOF_ADDRESS'];

function buildProgress(docs = []) {
  // docs = rows de kyc_documents
  const uploadedTypes = new Set(
    docs
      .filter((d) => String(d.status || '').toUpperCase() === 'UPLOADED')
      .map((d) => d.document_type)
  );

  const missing = REQUIRED.filter((t) => !uploadedTypes.has(t));
  const complete = missing.length === 0;

  return {
    required: REQUIRED,
    uploaded: Array.from(uploadedTypes),
    missing,
    complete,
    progress: {
      uploaded: REQUIRED.length - missing.length,
      total: REQUIRED.length,
      pct: Math.round(((REQUIRED.length - missing.length) / REQUIRED.length) * 100),
    },
  };
}

/**
 * POST /kyc/documents
 * form-data:
 * - document_type: ID_FRONT | ID_BACK | SELFIE | PROOF_ADDRESS
 * - file: (jpg/png/pdf)
 */
router.post('/documents', requireAuth, upload.single('file'), async (req, res, next) => {
  try {
    const { document_type } = req.body;

    if (!ALLOWED.has(document_type)) {
      const e = new Error('document_type inválido.');
      e.status = 400;
      e.code = 'VALIDATION_ERROR';
      throw e;
    }

    if (!req.file) {
      const e = new Error('Archivo requerido.');
      e.status = 400;
      e.code = 'VALIDATION_ERROR';
      throw e;
    }

    // Ruta interna (no pública)
    const fileUrl = `uploads/kyc/${req.user.id}/${req.file.filename}`;

    // Upsert por UNIQUE (user_id, document_type)
    const result = await pool.query(
      `
      INSERT INTO kyc_documents (user_id, document_type, file_url, status)
      VALUES ($1, $2, $3, 'UPLOADED')
      ON CONFLICT (user_id, document_type)
      DO UPDATE SET
        file_url = EXCLUDED.file_url,
        status = 'UPLOADED',
        reviewed_by = NULL,
        reviewed_at = NULL,
        rejection_reason = NULL,
        updated_at = NOW()
      RETURNING id, user_id, document_type, file_url, status, created_at, updated_at
      `,
      [req.user.id, document_type, fileUrl]
    );

    const doc = result.rows[0];

    // Cargar docs actuales para calcular progreso y decidir SUBMITTED
    const docsR = await pool.query(
      `
      SELECT id, document_type, status, reviewed_at, rejection_reason, created_at, updated_at
      FROM kyc_documents
      WHERE user_id = $1
      ORDER BY created_at DESC
      `,
      [req.user.id]
    );

    const progress = buildProgress(docsR.rows);
    const shouldSubmit = progress.complete;

    // SUBMITTED solo cuando están todos los requeridos
    await pool.query(
      `
      UPDATE users
      SET kyc_status = CASE
        WHEN $2::boolean = true AND kyc_status IN ('PENDING','REJECTED','EXPIRED') THEN 'SUBMITTED'
        WHEN $2::boolean = false AND kyc_status IN ('REJECTED','EXPIRED') THEN 'PENDING'
        ELSE kyc_status
      END,
      updated_at = NOW()
      WHERE id = $1
      `,
      [req.user.id, shouldSubmit]
    );

    await writeAuditLog({
      actorUserId: req.user.id,
      action: 'KYC_DOCUMENT_UPLOADED',
      entityType: 'kyc_document',
      entityId: doc.id,
      before: null,
      after: { document_type: doc.document_type, file_url: doc.file_url, status: doc.status },
      ip: req.ip,
      userAgent: req.headers['user-agent'] || null,
    });

    return res.status(201).json({
      ok: true,
      document: doc,
      kyc: {
        submitted: shouldSubmit,
        ...progress,
      },
    });
  } catch (err) {
    // Multer size limit
    if (err?.code === 'LIMIT_FILE_SIZE') {
      err.status = 413;
      err.code = 'FILE_TOO_LARGE';
      err.message = 'Archivo demasiado grande (máx. 5MB).';
      return next(err);
    }

    // fileFilter errors (mimetype)
    if (typeof err?.message === 'string' && err.message.toLowerCase().includes('tipo de archivo no permitido')) {
      err.status = 400;
      err.code = 'INVALID_FILE_TYPE';
      return next(err);
    }

    next(err);
  }
});

/**
 * GET /kyc/documents
 * Devuelve docs + progreso + missing
 */
router.get('/documents', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `
      SELECT id, document_type, status, reviewed_at, rejection_reason, created_at, updated_at
      FROM kyc_documents
      WHERE user_id = $1
      ORDER BY created_at DESC
      `,
      [req.user.id]
    );

    // También devolvemos el kyc_status actual del usuario
    const u = await pool.query(
      `SELECT kyc_status FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [req.user.id]
    );

    const progress = buildProgress(result.rows);

    res.json({
      ok: true,
      kyc_status: u.rows[0]?.kyc_status || null,
      documents: result.rows,
      ...progress,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /kyc/status
 */
router.get('/status', requireAuth, async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT kyc_status FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [req.user.id]
    );
    res.json({ ok: true, kyc_status: r.rows[0]?.kyc_status || null });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /kyc/documents/:id/download
 * Descarga segura (solo dueño).
 * No expone el directorio uploads como público.
 */
router.get('/documents/:id/download', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const disposition = String(req.query.disposition || "inline").toLowerCase(); // inline | attachment

    const r = await pool.query(
      `
      SELECT id, user_id, document_type, file_url
      FROM kyc_documents
      WHERE id = $1
      `,
      [id]
    );

    const doc = r.rows[0];
    if (!doc) {
      const e = new Error('Documento no encontrado.');
      e.status = 404;
      e.code = 'NOT_FOUND';
      throw e;
    }

    if (doc.user_id !== req.user.id) {
      const e = new Error('No autorizado.');
      e.status = 403;
      e.code = 'FORBIDDEN';
      throw e;
    }

    const abs = path.resolve(process.cwd(), doc.file_url);
    if (!fs.existsSync(abs)) {
      const e = new Error('Archivo no encontrado en disco.');
      e.status = 404;
      e.code = 'FILE_NOT_FOUND';
      throw e;
    }

    const ext = path.extname(abs) || "";
    const filename = `${doc.document_type}${ext}`;

    // Si quieres forzar a ver en navegador: inline
    const disp = disposition === "attachment" ? "attachment" : "inline";
    res.setHeader("Content-Disposition", `${disp}; filename="${filename}"`);

    return res.sendFile(abs);
  } catch (err) {
    next(err);
  }
});


router.delete("/documents/:id", requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    // Documento
    const r = await pool.query(
      `
      SELECT id, user_id, document_type, file_url, status
      FROM kyc_documents
      WHERE id = $1
      `,
      [id]
    );

    const doc = r.rows[0];
    if (!doc) {
      const e = new Error("Documento no encontrado.");
      e.status = 404;
      e.code = "NOT_FOUND";
      throw e;
    }

    if (doc.user_id !== req.user.id) {
      const e = new Error("No autorizado.");
      e.status = 403;
      e.code = "FORBIDDEN";
      throw e;
    }

    // Regla MVP: solo permitir reset si el doc está REJECTED o el user está REJECTED
    const u = await pool.query(
      `SELECT kyc_status FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [req.user.id]
    );

    const userKyc = String(u.rows[0]?.kyc_status || "").toUpperCase();
    const docStatus = String(doc.status || "").toUpperCase();

    if (userKyc !== "REJECTED" && docStatus !== "REJECTED") {
      const e = new Error("Solo puedes eliminar documentos cuando el KYC está rechazado.");
      e.status = 409;
      e.code = "KYC_NOT_REJECTED";
      throw e;
    }

    // Borrar archivo en disco (best-effort)
    const abs = path.resolve(process.cwd(), doc.file_url);
    try {
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    } catch {
      // no bloquear por fallo de fs
    }

    // Borrar row
    await pool.query(`DELETE FROM kyc_documents WHERE id = $1`, [id]);

    // Recalcular progreso y ajustar kyc_status
    const docsR = await pool.query(
      `
      SELECT id, document_type, status, reviewed_at, rejection_reason, created_at, updated_at
      FROM kyc_documents
      WHERE user_id = $1
      ORDER BY created_at DESC
      `,
      [req.user.id]
    );

    const progress = buildProgress(docsR.rows);
    const shouldSubmit = progress.complete;

    await pool.query(
      `
      UPDATE users
      SET kyc_status = CASE
        WHEN $2::boolean = true AND kyc_status IN ('PENDING','REJECTED','EXPIRED') THEN 'SUBMITTED'
        WHEN $2::boolean = false AND kyc_status IN ('REJECTED','EXPIRED','SUBMITTED') THEN 'PENDING'
        ELSE kyc_status
      END,
      updated_at = NOW()
      WHERE id = $1
      `,
      [req.user.id, shouldSubmit]
    );

    await writeAuditLog({
      actorUserId: req.user.id,
      action: "KYC_DOCUMENT_DELETED",
      entityType: "kyc_document",
      entityId: doc.id,
      before: { document_type: doc.document_type, file_url: doc.file_url, status: doc.status },
      after: null,
      ip: req.ip,
      userAgent: req.headers["user-agent"] || null,
    });

    return res.json({
      ok: true,
      deleted: { id: doc.id, document_type: doc.document_type },
      kyc: { submitted: shouldSubmit, ...progress },
    });
  } catch (err) {
    next(err);
  }
});


module.exports = router;
