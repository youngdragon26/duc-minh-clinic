const express = require('express');
const bcrypt = require('bcryptjs');
const { pool, ROLES } = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { SPECIALTIES } = require('../constants');

const router = express.Router();
router.use(authenticate, requireAdmin);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicUser(u) {
  return {
    id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role,
    specialty: u.specialty, createdAt: u.created_at,
  };
}

router.get('/users', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM users ORDER BY created_at DESC');
    res.json({ users: result.rows.map(publicUser) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

// Admin tạo trực tiếp tài khoản Bác sĩ/Nhân viên/Bệnh nhân/Admin — không qua
// form đăng ký công khai, để không ai tự phong mình làm bác sĩ/nhân viên.
router.post('/users', async (req, res) => {
  try {
    const { name, email, phone, password, role, specialty } = req.body || {};

    if (!name || !email || !password || !role) {
      return res.status(400).json({ error: 'Thiếu họ tên, email, mật khẩu hoặc vai trò.' });
    }
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Email không hợp lệ.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Mật khẩu phải có ít nhất 6 ký tự.' });
    }
    if (!ROLES.includes(role)) {
      return res.status(400).json({ error: 'Vai trò không hợp lệ.' });
    }
    if (role === 'doctor' && !SPECIALTIES.includes(specialty)) {
      return res.status(400).json({ error: 'Vui lòng chọn đúng chuyên khoa cho bác sĩ.' });
    }

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Email này đã được đăng ký.' });
    }

    const passwordHash = bcrypt.hashSync(password, 10);
    const result = await pool.query(
      'INSERT INTO users (name, email, phone, password_hash, role, specialty) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [name.trim(), email.toLowerCase(), phone || null, passwordHash, role, role === 'doctor' ? specialty : null]
    );
    res.status(201).json({ user: publicUser(result.rows[0]) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

router.patch('/users/:id/role', async (req, res) => {
  try {
    const { role } = req.body || {};
    if (!ROLES.includes(role)) {
      return res.status(400).json({ error: 'Vai trò không hợp lệ.' });
    }
    const id = Number(req.params.id);
    if (id === req.user.id && role !== 'admin') {
      return res.status(400).json({ error: 'Không thể tự hạ quyền của chính mình.' });
    }
    const result = await pool.query('UPDATE users SET role = $1 WHERE id = $2 RETURNING *', [role, id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy tài khoản.' });
    res.json({ user: publicUser(result.rows[0]) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

router.delete('/users/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (id === req.user.id) {
      return res.status(400).json({ error: 'Không thể tự xoá tài khoản của chính mình.' });
    }
    const result = await pool.query('DELETE FROM users WHERE id = $1', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Không tìm thấy tài khoản.' });
    res.status(204).end();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

module.exports = router;
