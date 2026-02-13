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
      <body style="margin:0;padding:0;background-color:#0f172a;font-family:Arial,Helvetica,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
          <tr>
            <td align="center" style="padding:40px 20px;">

              <table width="100%" max-width="600" cellpadding="0" cellspacing="0" role="presentation"
                     style="max-width:600px;background:#111827;border-radius:12px;padding:40px 30px;">

                <!-- Logo -->
                <tr>
                  <td align="center">
                    <img src="https://app.fluuyo.com/logo-fluuyo-email.png"
                         alt="Fluyoo"
                         width="150"
                         style="display:block;margin-bottom:30px;" />
                  </td>
                </tr>

                <!-- Title -->
                <tr>
                  <td align="center" style="color:#ffffff;font-size:22px;font-weight:bold;padding-bottom:15px;">
                    Verifica tu correo
                  </td>
                </tr>

                <!-- Message -->
                <tr>
                  <td align="center" style="color:#cbd5e1;font-size:15px;line-height:1.6;padding-bottom:30px;">
                    Gracias por registrarte en <strong style="color:#ffffff;">Fluyoo</strong>.<br/>
                    Para activar tu cuenta y comenzar a solicitar microcréditos,<br/>
                    confirma tu correo electrónico.
                  </td>
                </tr>

                <!-- Button -->
                <tr>
                  <td align="center" style="padding-bottom:30px;">
                    <a href="${verifyUrl}"
                       style="background:#3b82f6;
                              color:#ffffff;
                              text-decoration:none;
                              padding:14px 28px;
                              border-radius:8px;
                              font-weight:bold;
                              display:inline-block;">
                      Verificar correo
                    </a>
                  </td>
                </tr>

                <!-- Expiration -->
                <tr>
                  <td align="center" style="color:#94a3b8;font-size:13px;">
                    Este enlace expira en 30 minutos.
                  </td>
                </tr>

              </table>

              <!-- Footer -->
              <table width="600" cellpadding="0" cellspacing="0" role="presentation"
                     style="max-width:600px;margin-top:20px;">
                <tr>
                  <td align="center" style="color:#64748b;font-size:12px;padding:10px;">
                    © ${new Date().getFullYear()} Fluyoo. Todos los derechos reservados.
                  </td>
                </tr>
              </table>

            </td>
          </tr>
        </table>
      </body>
      `,
    });


    console.log("✅ Correo enviado, respuesta de Resend:", result);
    return result;
  } catch (err) {
    console.error("❌ Error enviando correo:", err);
    throw new Error("No se pudo enviar el correo de verificación. " + err.message);
  }
}

async function sendResetPasswordEmail({ to, token }) {
  const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;
  const fromEmail = process.env.EMAIL_FROM || "Fluyoo <no-reply@fluuyo.com>";

  try {
    const result = await resend.emails.send({
      from: fromEmail,
      to,
      subject: "Restablece tu contraseña – Fluyoo",
      html: `
      <body style="margin:0;padding:0;background-color:#0f172a;font-family:Arial,Helvetica,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
          <tr>
            <td align="center" style="padding:40px 20px;">

              <table width="100%" max-width="600" cellpadding="0" cellspacing="0" role="presentation"
                     style="max-width:600px;background:#111827;border-radius:12px;padding:40px 30px;">

                <!-- Logo -->
                <tr>
                  <td align="center">
                    <img src="https://app.fluuyo.com/logo-fluuyo-email.png"
                         alt="Fluyoo"
                         width="150"
                         style="display:block;margin-bottom:30px;" />
                  </td>
                </tr>

                <!-- Title -->
                <tr>
                  <td align="center" style="color:#ffffff;font-size:22px;font-weight:bold;padding-bottom:15px;">
                    Restablece tu contraseña
                  </td>
                </tr>

                <!-- Message -->
                <tr>
                  <td align="center" style="color:#cbd5e1;font-size:15px;line-height:1.6;padding-bottom:30px;">
                    Recibimos una solicitud para cambiar la contraseña de tu cuenta en
                    <strong style="color:#ffffff;">Fluyoo</strong>.<br/>
                    Si fuiste tú, haz clic en el botón para continuar.
                  </td>
                </tr>

                <!-- Button -->
                <tr>
                  <td align="center" style="padding-bottom:30px;">
                    <a href="${resetUrl}"
                       style="background:#3b82f6;
                              color:#ffffff;
                              text-decoration:none;
                              padding:14px 28px;
                              border-radius:8px;
                              font-weight:bold;
                              display:inline-block;">
                      Restablecer contraseña
                    </a>
                  </td>
                </tr>

                <!-- Expiration -->
                <tr>
                  <td align="center" style="color:#94a3b8;font-size:13px;">
                    Este enlace expira en 30 minutos.
                  </td>
                </tr>

                <!-- Security Note -->
                <tr>
                  <td align="center" style="color:#64748b;font-size:12px;padding-top:20px;line-height:1.5;">
                    Si no solicitaste este cambio, puedes ignorar este correo.
                    Tu contraseña actual seguirá siendo válida.
                  </td>
                </tr>

              </table>

              <!-- Footer -->
              <table width="600" cellpadding="0" cellspacing="0" role="presentation"
                     style="max-width:600px;margin-top:20px;">
                <tr>
                  <td align="center" style="color:#64748b;font-size:12px;padding:10px;">
                    © ${new Date().getFullYear()} Fluyoo. Todos los derechos reservados.
                  </td>
                </tr>
              </table>

            </td>
          </tr>
        </table>
      </body>
      `,
    });

    return result;
  } catch (err) {
    console.error("❌ Error enviando correo reset:", err);
    throw new Error("No se pudo enviar el correo de recuperación. " + err.message);
  }
}

module.exports = { sendVerificationEmail, sendResetPasswordEmail };