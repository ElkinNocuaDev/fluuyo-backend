const express = require('express');
const path = require('path');
const fs = require('fs');
const { requireAuth } = require('../../middlewares/auth.middleware');
const { requireRole } = require('../../middlewares/role.middleware');

const router = express.Router();

// GET /admin/files?path=uploads/kyc/<userId>/<file>
router.get('/files', requireAuth, requireRole('ADMIN', 'OPERATOR'), (req, res, next) => {
  try {
    const rel = String(req.query.path || '');
    if (!rel.startsWith('uploads/')) {
      const e = new Error('Ruta inválida.');
      e.status = 400;
      e.code = 'VALIDATION_ERROR';
      throw e;
    }

    const abs = path.resolve(process.cwd(), rel);

    // evita path traversal
    const uploadsRoot = path.resolve(process.cwd(), 'uploads');
    if (!abs.startsWith(uploadsRoot)) {
      const e = new Error('Ruta no permitida.');
      e.status = 403;
      e.code = 'FORBIDDEN';
      throw e;
    }

    if (!fs.existsSync(abs)) {
      const e = new Error('Archivo no encontrado.');
      e.status = 404;
      e.code = 'NOT_FOUND';
      throw e;
    }

    res.sendFile(abs);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
