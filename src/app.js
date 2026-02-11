require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');

const authRoutes = require('./modules/auth/auth.routes');
const meRoutes = require('./modules/users/me.routes');
const adminRoutes = require('./modules/admin/admin.routes');
const kycRoutes = require('./modules/kyc/kyc.routes');
const kycAdminRoutes = require('./modules/admin/kyc.admin.routes');
const filesAdminRoutes = require('./modules/admin/files.admin.routes');
const creditRoutes = require('./modules/credit/credit.routes');
const creditAdminRoutes = require('./modules/admin/credit.admin.routes');
const loansRoutes = require('./modules/loans/loans.routes');
const loansAdminRoutes = require('./modules/admin/loans.admin.routes');



const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/auth', authRoutes);
app.use('/', meRoutes);
app.use('/admin', adminRoutes);
app.use('/kyc', kycRoutes);
app.use('/admin', kycAdminRoutes);
app.use('/admin', filesAdminRoutes);
app.use('/credit', creditRoutes);
app.use('/admin', creditAdminRoutes);
app.use('/loans', loansRoutes);
app.use('/admin', loansAdminRoutes);
app.use('/uploads', express.static('uploads'));

app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || 500;
  res.status(status).json({
    ok: false,
    error: {
      code: err.code || 'INTERNAL_ERROR',
      message: err.message || 'Unexpected error',
      details: err.details || null,
    },
  });
});

module.exports = app;
