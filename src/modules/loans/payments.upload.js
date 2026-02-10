const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const baseDir = path.resolve(process.cwd(), 'uploads', 'payments');
if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const loanDir = path.join(baseDir, req.params.id); // /loans/:id/payments
    if (!fs.existsSync(loanDir)) fs.mkdirSync(loanDir, { recursive: true });
    cb(null, loanDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const safeExt = ['.jpg', '.jpeg', '.png', '.pdf'].includes(ext) ? ext : '';
    cb(null, crypto.randomUUID() + safeExt);
  },
});

function fileFilter(req, file, cb) {
  const okTypes = ['image/jpeg', 'image/png', 'application/pdf'];
  if (!okTypes.includes(file.mimetype)) {
    return cb(new Error('Tipo de archivo no permitido. Use JPG/PNG/PDF.'));
  }
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
});

module.exports = { upload };
