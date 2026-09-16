const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, createdAt: u.created_at };
}

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

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Email này đã được đăng ký.' });
    }

    // Đăng ký thành admin chỉ khi biết đúng mã quản trị (đặt trong .env) —
    // tránh việc ai cũng tự đăng ký được tài khoản admin từ form công khai.
    const role = (adminCode && process.env.ADMIN_REGISTER_CODE && adminCode === process.env.ADMIN_REGISTER_CODE)
      ? 'admin'
      : 'patient';

    const passwordHash = bcrypt.hashSync(password, 10);

    const result = await pool.query(
      'INSERT INTO users (name, email, phone, password_hash, role) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [name.trim(), email.toLowerCase(), phone || null, passwordHash, role]
    );

    const user = result.rows[0];
    const token = signToken(user);
    res.status(201).json({ token, user: publicUser(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Thiếu email hoặc mật khẩu.' });
    }
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [String(email).toLowerCase()]);
    const user = result.rows[0];
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Email hoặc mật khẩu không đúng.' });
    }
    const token = signToken(user);
    res.json({ token, user: publicUser(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
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
