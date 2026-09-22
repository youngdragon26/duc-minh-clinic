const jwt = require('jsonwebtoken');
const { pool } = require('../db');

// JWT sống tới 7 ngày và không có cơ chế thu hồi — nếu admin khoá 1 tài khoản
// giữa chừng mà không kiểm tra lại is_active ở đây, token cũ vẫn dùng được suốt
// 7 ngày, coi như tính năng khoá tài khoản vô nghĩa. Vì vậy phải tra CSDL is_active
// mỗi request thay vì chỉ tin nguyên payload trong JWT.
async function isAccountActive(userId) {
  const result = await pool.query('SELECT is_active FROM users WHERE id = $1', [userId]);
  return result.rows.length > 0 && result.rows[0].is_active;
}

async function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Thiếu token đăng nhập.' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (!(await isAccountActive(payload.id))) {
      return res.status(403).json({ error: 'Tài khoản của bạn đã bị khoá, vui lòng liên hệ quản trị viên.' });
    }
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token không hợp lệ hoặc đã hết hạn.' });
  }
}

// Dùng cho route công khai (không bắt buộc đăng nhập) nhưng vẫn muốn biết
// khách CÓ đăng nhập hay không để bật thêm tính năng (vd trợ lý AI chỉ đặt
// lịch được khi nhận diện được người dùng) — token sai/hết hạn/tài khoản đã bị
// khoá thì coi như khách chưa đăng nhập thay vì chặn hẳn request.
async function optionalAuthenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    req.user = null;
    return next();
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = (await isAccountActive(payload.id)) ? payload : null;
  } catch (e) {
    req.user = null;
  }
  next();
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Chỉ quản trị viên mới được truy cập.' });
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ error: 'Bạn không có quyền thực hiện thao tác này.' });
    }
    next();
  };
}

module.exports = { authenticate, optionalAuthenticate, requireAdmin, requireRole };
