const express = require('express');
const { pool } = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { logAudit } = require('../lib/audit');

const router = express.Router();
router.use(authenticate);

const TIME_RE = /^\d{2}:\d{2}$/;

function publicShift(s) {
  return {
    id: s.id,
    doctorId: s.doctor_id,
    weekday: s.weekday,
    startTime: String(s.start_time).slice(0, 5),
    endTime: String(s.end_time).slice(0, 5),
  };
}

// Admin xem ca trực của bất kỳ bác sĩ nào (để quản lý); bác sĩ chỉ xem được của
// chính mình (để tự kiểm tra lịch làm việc do admin phân công).
router.get('/doctor-shifts', async (req, res) => {
  try {
    const doctorId = Number(req.query.doctorId) || req.user.id;
    if (req.user.role !== 'admin' && doctorId !== req.user.id) {
      return res.status(403).json({ error: 'Bạn chỉ xem được lịch làm việc của chính mình.' });
    }
    const result = await pool.query(
      'SELECT * FROM doctor_shifts WHERE doctor_id = $1 ORDER BY weekday, start_time',
      [doctorId]
    );
    res.json({ shifts: result.rows.map(publicShift) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

router.post('/doctor-shifts', requireAdmin, async (req, res) => {
  try {
    const { doctorId, weekday, startTime, endTime } = req.body || {};
    const did = Number(doctorId);
    const wd = Number(weekday);
    if (!did || !Number.isInteger(wd) || wd < 0 || wd > 6) {
      return res.status(400).json({ error: 'Thiếu bác sĩ hoặc thứ trong tuần không hợp lệ.' });
    }
    if (!TIME_RE.test(startTime) || !TIME_RE.test(endTime) || startTime >= endTime) {
      return res.status(400).json({ error: 'Giờ bắt đầu phải nhỏ hơn giờ kết thúc, định dạng HH:MM.' });
    }
    const doc = await pool.query("SELECT id, name FROM users WHERE id = $1 AND role = 'doctor'", [did]);
    if (doc.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy bác sĩ.' });

    const result = await pool.query(
      'INSERT INTO doctor_shifts (doctor_id, weekday, start_time, end_time) VALUES ($1,$2,$3,$4) RETURNING *',
      [did, wd, startTime, endTime]
    );
    await logAudit(req.user, 'schedule.shift_add', 'doctor_shift', result.rows[0].id, {
      doctorName: doc.rows[0].name, weekday: wd, startTime, endTime,
    });
    res.status(201).json({ shift: publicShift(result.rows[0]) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

router.delete('/doctor-shifts/:id', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM doctor_shifts WHERE id = $1 RETURNING *', [Number(req.params.id)]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy ca trực.' });
    await logAudit(req.user, 'schedule.shift_remove', 'doctor_shift', result.rows[0].id, {
      weekday: result.rows[0].weekday,
      startTime: String(result.rows[0].start_time).slice(0, 5),
      endTime: String(result.rows[0].end_time).slice(0, 5),
    });
    res.status(204).end();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

module.exports = router;
