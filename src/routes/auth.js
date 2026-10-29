const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { authenticate } = require('../middleware/auth');
const { createOtp, verifyOtp, OtpError } = require('../lib/otp');
const { logAudit } = require('../lib/audit');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Bật bước OTP (2FA) bằng REQUIRE_OTP=true (mặc định tắt: chưa cấu hình SMTP thì OTP chỉ in ra log server).
const OTP_REQUIRED = process.env.REQUIRE_OTP === 'true';

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, specialty: u.specialty, isActive: u.is_active, createdAt: u.created_at };
}

// Che bớt email trả về lúc chờ nhập OTP ("mi***@gmail.com").
function maskEmail(email) {
  const [user, domain] = String(email).split('@');
  if (!domain) return String(email);
  const visible = user.slice(0, Math.min(2, user.length));
  return `${visible}${'*'.repeat(Math.max(user.length - visible.length, 1))}@${domain}`;
}

function otpErrorOr500(e, res) {
  if (e instanceof OtpError) return res.status(e.status).json({ error: e.message });
  console.error(e);
  return res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
}

// Bước 1/2 đăng ký: kiểm tra rồi gửi OTP — tài khoản chỉ tạo khi xác thực đúng mã.
router.post('/register', async (req, res) => {
  try {
    const { name, email, phone, password, adminCode } = req.body || {};

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Thiếu họ tên, email hoặc mật khẩu.' });
    }
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Email không hợp lệ.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Mật khẩu phải có ít nhất 6 ký tự.' });
    }

    const normalizedEmail = email.toLowerCase();
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Email này đã được đăng ký.' });
    }

    // Đăng ký admin phải có đúng ADMIN_REGISTER_CODE.
    const role = (adminCode && process.env.ADMIN_REGISTER_CODE && adminCode === process.env.ADMIN_REGISTER_CODE)
      ? 'admin'
      : 'patient';

    const passwordHash = bcrypt.hashSync(password, 10);
    const normalizedPhone = phone ? String(phone).trim() : null;

    if (!OTP_REQUIRED) {
      // OTP tắt → tạo tài khoản và đăng nhập luôn.
      const result = await pool.query(
        'INSERT INTO users (name, email, phone, password_hash, role) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [name.trim(), normalizedEmail, normalizedPhone, passwordHash, role]
      );
      const user = result.rows[0];
      return res.status(201).json({ token: signToken(user), user: publicUser(user) });
    }

    const { ticket, expiresAt } = await createOtp({
      destination: normalizedEmail,
      purpose: 'register',
      payload: { name: name.trim(), email: normalizedEmail, phone: normalizedPhone, passwordHash, role },
    });
    res.json({ ticket, expiresAt, email: maskEmail(normalizedEmail), message: 'Đã gửi mã xác thực OTP tới email của bạn.' });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'Email hoặc số điện thoại này đã được sử dụng.' });
    }
    otpErrorOr500(e, res);
  }
});

// Bước 2/2 đăng ký: đúng mã OTP thì tạo tài khoản + đăng nhập.
router.post('/register/verify', async (req, res) => {
  try {
    const { ticket, code } = req.body || {};
    if (!ticket || !code) return res.status(400).json({ error: 'Thiếu mã xác thực.' });

    const payload = await verifyOtp({ ticket, code, purpose: 'register' });

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [payload.email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Email này đã được đăng ký.' });
    }

    const result = await pool.query(
      'INSERT INTO users (name, email, phone, password_hash, role) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [payload.name, payload.email, payload.phone, payload.passwordHash, payload.role]
    );

    const user = result.rows[0];
    const token = signToken(user);
    res.status(201).json({ token, user: publicUser(user) });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'Email hoặc số điện thoại này đã được sử dụng.' });
    }
    otpErrorOr500(e, res);
  }
});

// Bước 1/2 đăng nhập: kiểm tra SĐT/Email + mật khẩu rồi gửi OTP — chưa cấp token.
router.post('/login', async (req, res) => {
  try {
    const { identifier, email, password } = req.body || {};
    const rawIdentifier = String(identifier || email || '').trim();
    if (!rawIdentifier || !password) {
      return res.status(400).json({ error: 'Thiếu email/số điện thoại hoặc mật khẩu.' });
    }

    const isEmail = EMAIL_RE.test(rawIdentifier);
    const result = isEmail
      ? await pool.query('SELECT * FROM users WHERE email = $1', [rawIdentifier.toLowerCase()])
      : await pool.query('SELECT * FROM users WHERE phone = $1', [rawIdentifier]);
    const user = result.rows[0];
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      // Ghi log cả khi không tìm thấy tài khoản — để phát hiện dò mật khẩu hàng loạt.
      await logAudit(user || null, 'auth.login_failed', 'user', user?.id ?? null, { identifier: rawIdentifier });
      return res.status(401).json({ error: 'Email/số điện thoại hoặc mật khẩu không đúng.' });
    }
    if (!user.is_active) {
      await logAudit(user, 'auth.login_blocked', 'user', user.id, {});
      return res.status(403).json({ error: 'Tài khoản của bạn đã bị khoá, vui lòng liên hệ quản trị viên.' });
    }

    if (!OTP_REQUIRED) {
      // OTP tắt → cấp JWT ngay.
      await logAudit(user, 'auth.login', 'user', user.id, {});
      return res.json({ token: signToken(user), user: publicUser(user) });
    }
    if (!user.email) {
      return res.status(400).json({ error: 'Tài khoản chưa có email để nhận mã OTP, liên hệ quản trị viên.' });
    }

    const { ticket, expiresAt } = await createOtp({
      destination: user.email,
      purpose: 'login',
      payload: { userId: user.id },
    });
    res.json({ ticket, expiresAt, email: maskEmail(user.email), message: 'Đã gửi mã xác thực OTP tới email của bạn.' });
  } catch (e) {
    otpErrorOr500(e, res);
  }
});

// Bước 2/2 đăng nhập: đúng mã OTP thì cấp JWT.
router.post('/login/verify', async (req, res) => {
  try {
    const { ticket, code } = req.body || {};
    if (!ticket || !code) return res.status(400).json({ error: 'Thiếu mã xác thực.' });

    const payload = await verifyOtp({ ticket, code, purpose: 'login' });
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [payload.userId]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'Không tìm thấy tài khoản.' });
    // Tài khoản có thể bị khoá giữa bước 1 và 2.
    if (!user.is_active) {
      return res.status(403).json({ error: 'Tài khoản của bạn đã bị khoá, vui lòng liên hệ quản trị viên.' });
    }

    const token = signToken(user);
    await logAudit(user, 'auth.login', 'user', user.id, {});
    res.json({ token, user: publicUser(user) });
  } catch (e) {
    otpErrorOr500(e, res);
  }
});

router.get('/me', authenticate, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'Không tìm thấy tài khoản.' });
    res.json({ user: publicUser(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

module.exports = router;
