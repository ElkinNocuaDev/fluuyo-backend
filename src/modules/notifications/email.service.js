const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendVerificationEmail({ to, token }) {
  const verifyUrl = `${process.env.FRONTEND_URL}/verify-email?token=${token}`;
  const fromEmail = process.env.EMAIL_FROM || "Fluyoo <no-reply@fluuyo.com>";

  console.log("🔹 Enviando correo de verificación");
  console.log("To:", to);
  console.log("From:", fromEmail);
  console.log("Verify URL:", verifyUrl);

  try {
    const result = await resend.emails.send({
      from: fromEmail,
      to,
      subject: "Verifica tu correo – Fluyoo",
      html: `
        <p>Hola,</p>
        <p>Gracias por registrarte en <strong>Fluyoo</strong>.</p>
        <p>Para activar tu cuenta, verifica tu correo:</p>
        <p><a href="${verifyUrl}" target="_blank">Verificar correo</a></p>
        <p>Este enlace expira en 30 minutos.</p>
      `,
    });

    console.log("✅ Correo enviado, respuesta de Resend:", result);
    return result;
  } catch (err) {
    console.error("❌ Error enviando correo:", err);
    throw new Error("No se pudo enviar el correo de verificación. " + err.message);
  }
}

module.exports = { sendVerificationEmail };