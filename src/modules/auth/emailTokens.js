const crypto = require('crypto');

function generateEmailVerificationToken() {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 1000 * 60 * 30); // 30 min
  return { token, expires };
}

module.exports = { generateEmailVerificationToken };
