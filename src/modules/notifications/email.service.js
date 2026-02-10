const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendVerificationEmail({ to, token }) {
  const verifyUrl = `${process.env.FRONTEND_URL}/verify-email?token=${token}`;

  return resend.emails.send({
    from: process.env.EMAIL_FROM || 'Fluyoo <no-reply@fluuyo.com>',
    to,
    subject: 'Verifica tu correo – Fluyoo',
    html: `
      <p>Hola,</p>
      <p>Gracias por registrarte en <strong>Fluyoo</strong>.</p>
      <p>Para activar tu cuenta, verifica tu correo:</p>
      <p>
        <a href="${verifyUrl}" target="_blank">
          Verificar correo
        </a>
      </p>
      <p>Este enlace expira en 30 minutos.</p>
    `,
  });
}

module.exports = { sendVerificationEmail };
