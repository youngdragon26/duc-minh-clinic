const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { sendOtpEmail } = require('./mailer');

const OTP_TTL_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

class OtpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function generateCode() {
  return String(crypto.randomInt(100000, 1000000)); // luôn đúng 6 chữ số
}

// Tạo (hoặc, nếu vừa gửi gần đây, cập nhật lại) 1 mã OTP cho 1 đích đến + mục
// đích cụ thể, rồi gửi mã qua email. "payload" là dữ liệu cần giữ tạm để hoàn
// tất hành động sau khi xác thực đúng mã (vd thông tin đăng ký chưa lưu CSDL).
// Gộp bước "gửi mới" và "gửi lại" làm một: nếu client gọi lại (resend, hoặc lỡ
// bấm gửi form 2 lần) trong lúc mã cũ vẫn còn hiệu lực, chặn bằng lỗi 429 thay vì
// spam thêm email; nếu mã cũ đã cách >60s thì cập nhật thẳng vào dòng đó (payload
// mới nhất khách vừa nhập) thay vì tạo thêm rác trong bảng.
async function createOtp({ destination, purpose, payload }) {
  const recent = await pool.query(
    `SELECT id, ticket, last_sent_at FROM otp_codes
     WHERE destination = $1 AND purpose = $2 AND consumed_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [destination, purpose]
  );

  if (recent.rows.length && Date.now() - new Date(recent.rows[0].last_sent_at).getTime() < RESEND_COOLDOWN_MS) {
    throw new OtpError(429, 'Mã OTP vừa được gửi, vui lòng kiểm tra email hoặc đợi ít lâu rồi thử lại.');
  }

  const code = generateCode();
  const codeHash = bcrypt.hashSync(code, 10);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  let ticket;
  if (recent.rows.length) {
    ticket = recent.rows[0].ticket;
    await pool.query(
      `UPDATE otp_codes SET code_hash = $1, payload = $2, expires_at = $3, last_sent_at = now(), attempts = 0
       WHERE id = $4`,
      [codeHash, JSON.stringify(payload), expiresAt, recent.rows[0].id]
    );
  } else {
    ticket = crypto.randomBytes(20).toString('hex');
    await pool.query(
      `INSERT INTO otp_codes (ticket, destination, purpose, code_hash, payload, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [ticket, destination, purpose, codeHash, JSON.stringify(payload), expiresAt]
    );
  }

  await sendOtpEmail(destination, code, purpose);
  return { ticket, expiresAt };
}

// Xác thực mã OTP theo ticket + mục đích. Trả về payload đã lưu nếu đúng, ném
// OtpError (thông báo phù hợp để hiển thị cho người dùng) nếu sai/hết hạn/hết lượt.
async function verifyOtp({ ticket, code, purpose }) {
  const result = await pool.query('SELECT * FROM otp_codes WHERE ticket = $1 AND purpose = $2', [ticket, purpose]);
  const row = result.rows[0];
  if (!row) throw new OtpError(400, 'Phiên xác thực không hợp lệ, vui lòng thử lại từ đầu.');
  if (row.consumed_at) throw new OtpError(400, 'Mã OTP này đã được sử dụng, vui lòng thử lại từ đầu.');
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw new OtpError(400, 'Mã OTP đã hết hạn, vui lòng bấm gửi lại mã.');
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    throw new OtpError(429, 'Bạn đã nhập sai quá nhiều lần, vui lòng bấm gửi lại mã mới.');
  }

  const ok = bcrypt.compareSync(String(code || ''), row.code_hash);
  if (!ok) {
    await pool.query('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1', [row.id]);
    throw new OtpError(400, 'Mã OTP không đúng.');
  }

  await pool.query('UPDATE otp_codes SET consumed_at = now() WHERE id = $1', [row.id]);
  return row.payload;
}

module.exports = { createOtp, verifyOtp, OtpError };
