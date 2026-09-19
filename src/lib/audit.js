const { pool } = require('../db');

// Ghi 1 dòng nhật ký hoạt động. Không bao giờ ném lỗi ra ngoài: nhật ký hỏng
// không được làm hỏng thao tác chính (thu tiền, huỷ lịch...) của người dùng.
async function logAudit(user, action, entity, entityId, detail) {
  try {
    await pool.query(
      `INSERT INTO audit_logs (user_id, user_name, user_role, action, entity, entity_id, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [user?.id ?? null, user?.name ?? null, user?.role ?? null, action, entity || null, entityId ?? null, detail ? JSON.stringify(detail) : null]
    );
  } catch (e) {
    console.error('Không ghi được nhật ký hoạt động:', e.message);
  }
}

// Nhãn tiếng Việt cho từng loại hành động, dùng khi hiển thị ở giao diện admin.
const ACTION_LABELS = {
  'user.role_change': 'Đổi vai trò tài khoản',
  'user.create': 'Tạo tài khoản',
  'user.delete': 'Xoá tài khoản',
  'price.service': 'Sửa giá khám',
  'price.medicine': 'Sửa giá thuốc',
  'price.discount': 'Sửa % giảm giá',
  'appointment.status': 'Đổi trạng thái lịch hẹn',
  'appointment.cancel': 'Huỷ lịch hẹn',
  'invoice.create': 'Lập hoá đơn',
  'invoice.paid': 'Thu tiền hoá đơn',
  'invoice.unpaid': 'Bỏ đánh dấu đã thu tiền',
  'record.create': 'Lưu hồ sơ khám',
  'followup.create': 'Đặt lịch tái khám',
};

module.exports = { logAudit, ACTION_LABELS };
