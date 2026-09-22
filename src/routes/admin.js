const express = require('express');
const bcrypt = require('bcryptjs');
const { pool, ROLES } = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { SPECIALTIES } = require('../constants');
const { logAudit, ACTION_LABELS } = require('../lib/audit');

const router = express.Router();
router.use(authenticate, requireAdmin);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicUser(u) {
  return {
    id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role,
    specialty: u.specialty, bio: u.bio, isActive: u.is_active, createdAt: u.created_at,
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
    const { name, email, phone, password, role, specialty, bio } = req.body || {};

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
      'INSERT INTO users (name, email, phone, password_hash, role, specialty, bio) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [name.trim(), email.toLowerCase(), phone || null, passwordHash, role, role === 'doctor' ? specialty : null, role === 'doctor' && bio ? String(bio).trim() : null]
    );
    await logAudit(req.user, 'user.create', 'user', result.rows[0].id, { name: result.rows[0].name, role: result.rows[0].role });
    res.status(201).json({ user: publicUser(result.rows[0]) });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'Email hoặc số điện thoại này đã được sử dụng.' });
    }
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
    const before = await pool.query('SELECT name, role FROM users WHERE id = $1', [id]);
    const result = await pool.query('UPDATE users SET role = $1 WHERE id = $2 RETURNING *', [role, id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy tài khoản.' });
    await logAudit(req.user, 'user.role_change', 'user', id, { name: result.rows[0].name, from: before.rows[0]?.role, to: role });
    res.json({ user: publicUser(result.rows[0]) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

// Khoá/mở khoá tài khoản (UC012: quản lý trạng thái tài khoản, tách biệt với
// RBAC ở trên) — tài khoản bị khoá không đăng nhập được và JWT cũ (nếu có) cũng
// mất hiệu lực ngay (xem middleware/auth.js), nhưng toàn bộ dữ liệu vẫn giữ nguyên.
router.patch('/users/:id/status', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { isActive } = req.body || {};
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ error: 'Thiếu trạng thái tài khoản (isActive).' });
    }
    if (id === req.user.id && !isActive) {
      return res.status(400).json({ error: 'Không thể tự khoá tài khoản của chính mình.' });
    }
    const result = await pool.query('UPDATE users SET is_active = $1 WHERE id = $2 RETURNING *', [isActive, id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy tài khoản.' });
    await logAudit(req.user, 'user.status_change', 'user', id, { name: result.rows[0].name, isActive });
    res.json({ user: publicUser(result.rows[0]) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

// Sửa lý lịch/giới thiệu bác sĩ (hiện cho bệnh nhân xem khi đặt lịch) — tách
// riêng khỏi việc đổi vai trò vì đây là thông tin hồ sơ, không phải phân quyền.
router.patch('/users/:id/bio', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { bio } = req.body || {};
    const result = await pool.query(
      'UPDATE users SET bio = $1 WHERE id = $2 RETURNING *',
      [bio ? String(bio).trim() : null, id]
    );
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
    const target = await pool.query('SELECT name, role FROM users WHERE id = $1', [id]);
    const result = await pool.query('DELETE FROM users WHERE id = $1', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Không tìm thấy tài khoản.' });
    await logAudit(req.user, 'user.delete', 'user', id, { name: target.rows[0]?.name, role: target.rows[0]?.role });
    res.status(204).end();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

// Nhật ký hoạt động — admin xem 200 dòng gần nhất, lọc theo loại hành động nếu cần.
router.get('/audit-logs', async (req, res) => {
  try {
    const { action } = req.query;
    const params = [];
    let where = '';
    if (action) { params.push(action); where = 'WHERE action = $1'; }
    const result = await pool.query(
      `SELECT id, user_id AS "userId", user_name AS "userName", user_role AS "userRole", action, entity,
              entity_id AS "entityId", detail, created_at AS "createdAt"
       FROM audit_logs ${where} ORDER BY created_at DESC, id DESC LIMIT 200`,
      params
    );
    res.json({ logs: result.rows.map((l) => ({ ...l, actionLabel: ACTION_LABELS[l.action] || l.action })), actions: ACTION_LABELS });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

module.exports = router;
