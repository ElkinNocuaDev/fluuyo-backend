const express = require('express');
const { register, login, verifyEmail, resendVerification } = require('./auth.controller');

const router = express.Router();

router.post('/register', register);
router.post('/login', login);
router.post('/verify-email', verifyEmail);
router.post('/resend-verification', resendVerification);


module.exports = router;
