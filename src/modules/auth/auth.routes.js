const express = require('express');
const { 
    register, 
    login, 
    verifyEmail, 
    resendVerification, 
    forgotPassword, 
    resetPassword 
} = require('./auth.controller');

const router = express.Router();

router.post('/register', register);
router.post('/login', login);
router.post('/verify-email', verifyEmail);
router.post('/resend-verification', resendVerification);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);

module.exports = router;
