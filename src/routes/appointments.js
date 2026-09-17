const express = require('express');
const { pool } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { SPECIALTIES, APPOINTMENT_STATUSES } = require('../constants');
const { createAppointment, BookingError } = require('../lib/appointmentService');
const { getAvailableSlots } = require('../lib/availability');

const router = express.Router();
router.use(authenticate);

const STAFF_ROLES = ['staff', 'doctor', 'admin'];

const APPT_SELECT = `
  SELECT a.*, p.name AS patient_name, p.phone AS patient_phone, d.name AS doctor_name,
         EXISTS(SELECT 1 FROM invoices i WHERE i.appointment_id = a.id) AS has_invoice
  FROM appointments a
  JOIN users p ON p.id = a.patient_id
  LEFT JOIN users d ON d.id = a.doctor_id
`;

function publicAppointment(a) {
  return {
    id: a.id,
    patientId: a.patient_id,
    patientName: a.patient_name,
    patientPhone: a.patient_phone,
    doctorId: a.doctor_id,
    doctorName: a.doctor_name,
    specialty: a.specialty,
    date: a.appointment_date,
    time: a.appointment_time,
    status: a.status,
    note: a.note,
    contactName: a.contact_name,
    contactPhone: a.contact_phone,
    age: a.age,
    gender: a.gender,
    hasInvoice: a.has_invoice,
    createdAt: a.created_at,
  };
}

// Danh sách bác sĩ (lọc theo chuyên khoa) để bệnh nhân chọn khi đặt lịch.
// Bác sĩ có specialty = NULL được coi là "bác sĩ tổng quát" phụ trách được mọi
// chuyên khoa, nên hiện diện ở mọi kết quả lọc theo chuyên khoa.
router.get('/doctors', async (req, res) => {
  try {
    const { specialty } = req.query;
    const params = [];
    let sql = "SELECT id, name, specialty FROM users WHERE role = 'doctor'";
    if (specialty) {
      params.push(specialty);
      sql += ` AND (specialty = $${params.length} OR specialty IS NULL)`;
    }
    sql += ' ORDER BY name';
    const result = await pool.query(sql, params);
    res.json({ doctors: result.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { specialty, doctorId, date, time, note, contactName, contactPhone, age, gender } = req.body || {};
    const id = await createAppointment({
      patientId: req.user.id, specialty, doctorId, date, time, note, contactName, contactPhone, age, gender,
    });
    const full = await pool.query(APPT_SELECT + ' WHERE a.id = $1', [id]);
    res.status(201).json({ appointment: publicAppointment(full.rows[0]) });
  } catch (e) {
    if (e instanceof BookingError) {
      return res.status(e.status).json({ error: e.message });
    }
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

// Khung giờ còn trống cho 1 chuyên khoa (và bác sĩ cụ thể nếu có) vào 1 ngày —
// nguồn dữ liệu cho lưới lịch tuần ở trang đặt lịch.
router.get('/availability', async (req, res) => {
  try {
    const { specialty, date, doctorId } = req.query;
    if (!specialty || !SPECIALTIES.includes(specialty)) {
      return res.status(400).json({ error: 'Chuyên khoa không hợp lệ.' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
      return res.status(400).json({ error: 'Ngày không hợp lệ.' });
    }
    const { slots } = await getAvailableSlots({ specialty, date, doctorId: doctorId ? Number(doctorId) : null });
    res.json({ specialty, date, slots });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

// Lịch hẹn của chính người đang đăng nhập.
router.get('/mine', async (req, res) => {
  try {
    const result = await pool.query(
      APPT_SELECT + ' WHERE a.patient_id = $1 ORDER BY a.appointment_date DESC, a.appointment_time DESC',
      [req.user.id]
    );
    res.json({ appointments: result.rows.map(publicAppointment) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

// Chi tiết 1 lịch hẹn — nhân viên/bác sĩ/admin xem mọi lịch hẹn, bệnh nhân chỉ xem của mình.
// Lưu ý: route này phải đặt SAU '/mine' và '/doctors' ở trên — Express khớp theo thứ tự
// đăng ký, nên 2 đường dẫn cố định đó luôn được ưu tiên trước khi rơi vào ':id'.
router.get('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'Không tìm thấy lịch hẹn.' });
    const result = await pool.query(APPT_SELECT + ' WHERE a.id = $1', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy lịch hẹn.' });
    const appt = result.rows[0];
    if (!STAFF_ROLES.includes(req.user.role) && appt.patient_id !== req.user.id) {
      return res.status(403).json({ error: 'Bạn không có quyền xem lịch hẹn này.' });
    }
    res.json({ appointment: publicAppointment(appt) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

// Hàng đợi khám — chỉ Nhân viên/Bác sĩ/Admin xem được toàn bộ.
router.get('/', requireRole(...STAFF_ROLES), async (req, res) => {
  try {
    const { date, status } = req.query;
    const conditions = [];
    const params = [];
    if (date) { params.push(date); conditions.push(`a.appointment_date = $${params.length}`); }
    if (status) { params.push(status); conditions.push(`a.status = $${params.length}`); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const result = await pool.query(
      `${APPT_SELECT} ${where} ORDER BY a.appointment_date, a.appointment_time`,
      params
    );
    res.json({ appointments: result.rows.map(publicAppointment) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

router.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!APPOINTMENT_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Trạng thái không hợp lệ.' });
    }
    const id = Number(req.params.id);
    const existing = await pool.query('SELECT * FROM appointments WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Không tìm thấy lịch hẹn.' });
    }
    const appt = existing.rows[0];
    const isStaffLike = STAFF_ROLES.includes(req.user.role);
    const isOwner = appt.patient_id === req.user.id;

    // Nhân viên/bác sĩ/admin đổi được mọi trạng thái; bệnh nhân chỉ được tự huỷ
    // lịch hẹn của chính mình, không đổi sang trạng thái khác.
    if (!isStaffLike && !(isOwner && status === 'da_huy')) {
      return res.status(403).json({ error: 'Bạn chỉ có thể huỷ lịch hẹn của chính mình.' });
    }

    const updated = await pool.query('UPDATE appointments SET status = $1 WHERE id = $2 RETURNING id', [status, id]);
    const full = await pool.query(APPT_SELECT + ' WHERE a.id = $1', [updated.rows[0].id]);
    res.json({ appointment: publicAppointment(full.rows[0]) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

module.exports = router;
