const express = require('express');
const { pool } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit } = require('../lib/audit');

const router = express.Router();
router.use(authenticate);

const TODAY_VN = "(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = ['cho', 'da_den', 'da_huy'];

// bucket tính ngay trong SQL theo ngày Việt Nam: chỉ lịch còn "chờ" mới được
// xếp quá hạn/hôm nay/sắp tới, lịch đã đến hoặc đã huỷ thì vào nhóm "xong".
const FOLLOWUP_SELECT = `
  SELECT f.id, f.medical_record_id AS "medicalRecordId", f.patient_id AS "patientId", f.doctor_id AS "doctorId",
         to_char(f.followup_date, 'YYYY-MM-DD') AS date, f.note, f.status,
         p.name AS "patientName", COALESCE(a.contact_phone, p.phone) AS "patientPhone",
         d.name AS "doctorName", mr.diagnosis,
         CASE
           WHEN f.status <> 'cho' THEN 'xong'
           WHEN f.followup_date < ${TODAY_VN} THEN 'qua_han'
           WHEN f.followup_date = ${TODAY_VN} THEN 'hom_nay'
           ELSE 'sap_toi'
         END AS bucket
  FROM followups f
  JOIN users p ON p.id = f.patient_id
  JOIN users d ON d.id = f.doctor_id
  JOIN medical_records mr ON mr.id = f.medical_record_id
  JOIN appointments a ON a.id = mr.appointment_id
`;

// Bác sĩ đặt lịch tái khám cho 1 hồ sơ khám do chính mình lập.
router.post('/', requireRole('doctor'), async (req, res) => {
  try {
    const { medicalRecordId, date, note } = req.body || {};
    if (!DATE_RE.test(String(date))) return res.status(400).json({ error: 'Ngày tái khám không hợp lệ.' });
    const rec = await pool.query('SELECT id, patient_id, doctor_id FROM medical_records WHERE id = $1', [Number(medicalRecordId)]);
    if (rec.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy hồ sơ khám.' });
    if (rec.rows[0].doctor_id !== req.user.id) {
      return res.status(403).json({ error: 'Chỉ bác sĩ đã khám mới đặt được lịch tái khám.' });
    }
    const today = await pool.query(`SELECT ${TODAY_VN}::text AS d`);
    if (String(date) < today.rows[0].d) return res.status(400).json({ error: 'Ngày tái khám không được ở quá khứ.' });

    const inserted = await pool.query(
      'INSERT INTO followups (medical_record_id, patient_id, doctor_id, followup_date, note) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [rec.rows[0].id, rec.rows[0].patient_id, req.user.id, date, note ? String(note).trim() : null]
    );
    await logAudit(req.user, 'followup.create', 'followup', inserted.rows[0].id, { patientId: rec.rows[0].patient_id, date });
    const full = await pool.query(FOLLOWUP_SELECT + ' WHERE f.id = $1', [inserted.rows[0].id]);
    res.status(201).json({ followup: full.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

// Bệnh nhân xem lịch tái khám của chính mình (đặt TRƯỚC các route khác có tham số).
router.get('/mine', async (req, res) => {
  try {
    const result = await pool.query(FOLLOWUP_SELECT + ' WHERE f.patient_id = $1 ORDER BY f.followup_date', [req.user.id]);
    res.json({ followups: result.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

// Bác sĩ thấy lịch tái khám của chính mình; nhân viên/admin thấy toàn bộ
// (để gọi nhắc bệnh nhân). Lịch đã xử lý chỉ giữ lại 7 ngày gần nhất.
router.get('/', requireRole('doctor', 'staff', 'admin'), async (req, res) => {
  try {
    const params = [];
    let where = "WHERE (f.status = 'cho' OR f.followup_date >= " + TODAY_VN + " - 7)";
    if (req.user.role === 'doctor') { params.push(req.user.id); where += ` AND f.doctor_id = $${params.length}`; }
    const result = await pool.query(FOLLOWUP_SELECT + ` ${where} ORDER BY f.followup_date, f.id`, params);
    res.json({ followups: result.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

router.patch('/:id/status', requireRole('doctor', 'staff', 'admin'), async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Trạng thái không hợp lệ.' });
    const id = Number(req.params.id);
    const found = await pool.query('SELECT doctor_id FROM followups WHERE id = $1', [id]);
    if (found.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy lịch tái khám.' });
    if (req.user.role === 'doctor' && found.rows[0].doctor_id !== req.user.id) {
      return res.status(403).json({ error: 'Đây không phải lịch tái khám của bạn.' });
    }
    await pool.query('UPDATE followups SET status = $1 WHERE id = $2', [status, id]);
    const full = await pool.query(FOLLOWUP_SELECT + ' WHERE f.id = $1', [id]);
    res.json({ followup: full.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

module.exports = router;
