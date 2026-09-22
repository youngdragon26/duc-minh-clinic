let transporter;

function getTransporter() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  if (!transporter) {
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transporter;
}

const PURPOSE_LABELS = { register: 'đăng ký tài khoản', login: 'đăng nhập' };

// Gửi mã OTP qua email. Giống cách GEMINI_API_KEY không bắt buộc để chạy server:
// chưa cấu hình SMTP_* thì in mã ra console server thay vì gửi thật, để vẫn chạy
// thử/chấm điểm được mà không cần có sẵn tài khoản email SMTP.
async function sendOtpEmail(toEmail, code, purpose) {
  const label = PURPOSE_LABELS[purpose] || purpose;
  const transport = getTransporter();
  if (!transport) {
    console.log(`[OTP] (SMTP chưa cấu hình, xem .env.example) Mã xác thực ${label} gửi tới ${toEmail}: ${code} — hết hạn sau 5 phút.`);
    return;
  }
  await transport.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: toEmail,
    subject: `Mã xác thực ${label} — Phòng khám Đa khoa Đức Minh`,
    text: [
      `Mã xác thực của bạn là: ${code}`,
      'Mã có hiệu lực trong 5 phút.',
      'Vui lòng không chia sẻ mã này cho bất kỳ ai, kể cả người tự xưng là nhân viên phòng khám.',
    ].join('\n'),
  });
}

module.exports = { sendOtpEmail };
