const express = require('express');
const { pool } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { SPECIALTIES, APPOINTMENT_STATUSES } = require('../constants');

const router = express.Router();
router.use(authenticate);

const STAFF_ROLES = ['staff', 'doctor', 'admin'];

const APPT_SELECT = `
  SELECT a.*, p.name AS patient_name, p.phone AS patient_phone, d.name AS doctor_name
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
    createdAt: a.created_at,
  };
}

// Danh sách bác sĩ (lọc theo chuyên khoa) để bệnh nhân chọn khi đặt lịch.
router.get('/doctors', async (req, res) => {
  try {
    const { specialty } = req.query;
    const params = [];
    let sql = "SELECT id, name, specialty FROM users WHERE role = 'doctor'";
    if (specialty) {
      params.push(specialty);
      sql += ` AND specialty = $${params.length}`;
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
    const { specialty, doctorId, date, time, note } = req.body || {};

    if (!specialty || !date || !time) {
      return res.status(400).json({ error: 'Thiếu chuyên khoa, ngày hoặc giờ khám.' });
    }
    if (!SPECIALTIES.includes(specialty)) {
      return res.status(400).json({ error: 'Chuyên khoa không hợp lệ.' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Ngày khám không hợp lệ.' });
    }
    const dateObj = new Date(date + 'T00:00:00');
    if (Number.isNaN(dateObj.getTime())) {
      return res.status(400).json({ error: 'Ngày khám không hợp lệ.' });
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (dateObj < today) {
      return res.status(400).json({ error: 'Không thể đặt lịch cho ngày đã qua.' });
    }

    let doctorIdNum = null;
    if (doctorId) {
      doctorIdNum = Number(doctorId);
      const doc = await pool.query("SELECT id, specialty FROM users WHERE id = $1 AND role = 'doctor'", [doctorIdNum]);
      if (doc.rows.length === 0) {
        return res.status(400).json({ error: 'Không tìm thấy bác sĩ này.' });
      }
      if (doc.rows[0].specialty && doc.rows[0].specialty !== specialty) {
        return res.status(400).json({ error: 'Bác sĩ này không thuộc chuyên khoa đã chọn.' });
      }
    }

    const inserted = await pool.query(
      `INSERT INTO appointments (patient_id, doctor_id, specialty, appointment_date, appointment_time, note)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [req.user.id, doctorIdNum, specialty, date, time, note || null]
    );
    const full = await pool.query(APPT_SELECT + ' WHERE a.id = $1', [inserted.rows[0].id]);
    res.status(201).json({ appointment: publicAppointment(full.rows[0]) });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'Khung giờ này của bác sĩ đã có người đặt, vui lòng chọn giờ khác.' });
    }
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
