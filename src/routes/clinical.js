const express = require('express');
const { pool } = require('../db');
const { authenticate, requireAdmin, requireRole } = require('../middleware/auth');
const { INTERACTION_SEVERITIES } = require('../constants');

const router = express.Router();
router.use(authenticate);

const STAFF_ROLES = ['staff', 'doctor', 'admin'];

// ---------- Danh mục thuốc ----------

router.get('/medicines', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, unit, created_at AS "createdAt" FROM medicines ORDER BY name');
    res.json({ medicines: result.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

router.post('/medicines', requireAdmin, async (req, res) => {
  try {
    const { name, unit } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Thiếu tên thuốc.' });
    const existing = await pool.query('SELECT id FROM medicines WHERE name = $1', [name.trim()]);
    if (existing.rows.length > 0) return res.status(409).json({ error: 'Thuốc này đã có trong danh mục.' });
    const result = await pool.query(
      'INSERT INTO medicines (name, unit) VALUES ($1, $2) RETURNING id, name, unit, created_at AS "createdAt"',
      [name.trim(), (unit && unit.trim()) || 'viên']
    );
    res.status(201).json({ medicine: result.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

router.delete('/medicines/:id', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM medicines WHERE id = $1', [Number(req.params.id)]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Không tìm thấy thuốc.' });
    res.status(204).end();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

// ---------- Tương tác thuốc ----------

router.get('/interactions', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT di.id, di.severity, di.description,
             ma.id AS "medicineAId", ma.name AS "medicineAName",
             mb.id AS "medicineBId", mb.name AS "medicineBName"
      FROM drug_interactions di
      JOIN medicines ma ON ma.id = di.medicine_a_id
      JOIN medicines mb ON mb.id = di.medicine_b_id
      ORDER BY di.severity DESC, ma.name
    `);
    res.json({ interactions: result.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

router.post('/interactions', requireAdmin, async (req, res) => {
  try {
    const { medicineAId, medicineBId, severity, description } = req.body || {};
    const a = Number(medicineAId);
    const b = Number(medicineBId);
    if (!a || !b || a === b) {
      return res.status(400).json({ error: 'Vui lòng chọn 2 loại thuốc khác nhau.' });
    }
    if (!INTERACTION_SEVERITIES.includes(severity)) {
      return res.status(400).json({ error: 'Mức độ nghiêm trọng không hợp lệ.' });
    }
    if (!description) {
      return res.status(400).json({ error: 'Thiếu mô tả tương tác.' });
    }
    const result = await pool.query(
      'INSERT INTO drug_interactions (medicine_a_id, medicine_b_id, severity, description) VALUES ($1,$2,$3,$4) RETURNING id',
      [a, b, severity, description.trim()]
    );
    res.status(201).json({ id: result.rows[0].id });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'Cặp thuốc này đã có quy tắc tương tác.' });
    }
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

router.delete('/interactions/:id', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM drug_interactions WHERE id = $1', [Number(req.params.id)]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Không tìm thấy quy tắc tương tác.' });
    res.status(204).end();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

async function findInteractions(medicineIds) {
  const ids = [...new Set(medicineIds.map(Number))].filter(Boolean);
  if (ids.length < 2) return [];
  const result = await pool.query(
    `SELECT di.severity, di.description, ma.name AS "medicineAName", mb.name AS "medicineBName"
     FROM drug_interactions di
     JOIN medicines ma ON ma.id = di.medicine_a_id
     JOIN medicines mb ON mb.id = di.medicine_b_id
     WHERE di.medicine_a_id = ANY($1::int[]) AND di.medicine_b_id = ANY($1::int[])`,
    [ids]
  );
  return result.rows;
}

// Bác sĩ gọi khi đang chọn thuốc để kê đơn, xem cảnh báo ngay trước khi lưu.
router.post('/check-interactions', async (req, res) => {
  try {
    const { medicineIds } = req.body || {};
    if (!Array.isArray(medicineIds)) {
      return res.status(400).json({ error: 'Thiếu danh sách thuốc cần kiểm tra.' });
    }
    const warnings = await findInteractions(medicineIds);
    res.json({ warnings });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

// ---------- Hồ sơ khám bệnh + đơn thuốc ----------

function publicRecord(r) {
  return {
    id: r.id,
    appointmentId: r.appointment_id,
    patientId: r.patient_id,
    doctorId: r.doctor_id,
    doctorName: r.doctor_name,
    specialty: r.specialty,
    date: r.appointment_date,
    symptoms: r.symptoms,
    diagnosis: r.diagnosis,
    notes: r.notes,
    createdAt: r.created_at,
  };
}

const RECORD_SELECT = `
  SELECT mr.*, d.name AS doctor_name, a.specialty, a.appointment_date
  FROM medical_records mr
  JOIN users d ON d.id = mr.doctor_id
  JOIN appointments a ON a.id = mr.appointment_id
`;

async function attachItems(record) {
  const items = await pool.query(
    `SELECT pi.id, pi.dosage, pi.quantity, m.id AS "medicineId", m.name AS "medicineName", m.unit
     FROM prescription_items pi JOIN medicines m ON m.id = pi.medicine_id
     WHERE pi.medical_record_id = $1 ORDER BY pi.id`,
    [record.id]
  );
  return { ...publicRecord(record), items: items.rows };
}

// Bác sĩ tạo hồ sơ khám + đơn thuốc cho 1 lịch hẹn — tự động đánh dấu lịch hẹn Hoàn thành.
router.post('/records', requireRole('doctor'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { appointmentId, symptoms, diagnosis, notes, items } = req.body || {};
    const apptId = Number(appointmentId);
    if (!apptId || !diagnosis) {
      return res.status(400).json({ error: 'Thiếu lịch hẹn hoặc chẩn đoán.' });
    }
    const list = Array.isArray(items) ? items : [];

    const apptRes = await client.query('SELECT * FROM appointments WHERE id = $1', [apptId]);
    if (apptRes.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy lịch hẹn.' });
    const appt = apptRes.rows[0];
    if (appt.doctor_id && appt.doctor_id !== req.user.id) {
      return res.status(403).json({ error: 'Bạn không phải bác sĩ phụ trách lịch hẹn này.' });
    }
    if (appt.status === 'da_huy') {
      return res.status(400).json({ error: 'Lịch hẹn này đã bị huỷ.' });
    }

    if (list.length > 0) {
      const ids = list.map((it) => Number(it.medicineId));
      const found = await client.query('SELECT id FROM medicines WHERE id = ANY($1::int[])', [ids]);
      if (found.rows.length !== new Set(ids).size) {
        return res.status(400).json({ error: 'Có thuốc trong đơn không tồn tại trong danh mục.' });
      }
    }

    await client.query('BEGIN');

    // Nếu lịch hẹn ban đầu chưa chỉ định bác sĩ cụ thể, bác sĩ khám sẽ được gán vào đây.
    const inserted = await client.query(
      `INSERT INTO medical_records (appointment_id, patient_id, doctor_id, symptoms, diagnosis, notes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [apptId, appt.patient_id, req.user.id, symptoms || null, diagnosis.trim(), notes || null]
    );
    const recordId = inserted.rows[0].id;

    for (const it of list) {
      await client.query(
        'INSERT INTO prescription_items (medical_record_id, medicine_id, dosage, quantity) VALUES ($1,$2,$3,$4)',
        [recordId, Number(it.medicineId), String(it.dosage || '').trim() || 'Theo chỉ định', Number(it.quantity) || 1]
      );
    }

    await client.query(
      "UPDATE appointments SET status = 'hoan_thanh', doctor_id = $1 WHERE id = $2",
      [req.user.id, apptId]
    );

    await client.query('COMMIT');

    const warnings = await findInteractions(list.map((it) => it.medicineId));
    const full = await pool.query(RECORD_SELECT + ' WHERE mr.id = $1', [recordId]);
    const record = await attachItems(full.rows[0]);
    res.status(201).json({ record, warnings });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') {
      return res.status(409).json({ error: 'Lịch hẹn này đã có hồ sơ khám.' });
    }
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  } finally {
    client.release();
  }
});

// Bệnh nhân xem lịch sử khám bệnh của chính mình.
router.get('/records/mine', async (req, res) => {
  try {
    const result = await pool.query(
      RECORD_SELECT + ' WHERE mr.patient_id = $1 ORDER BY mr.created_at DESC',
      [req.user.id]
    );
    const records = await Promise.all(result.rows.map(attachItems));
    res.json({ records });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

// Xem hồ sơ khám của 1 lịch hẹn cụ thể — nhân viên/bác sĩ/admin xem mọi hồ sơ,
// bệnh nhân chỉ xem được hồ sơ của chính mình.
router.get('/records/by-appointment/:appointmentId', async (req, res) => {
  try {
    const result = await pool.query(RECORD_SELECT + ' WHERE mr.appointment_id = $1', [Number(req.params.appointmentId)]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Chưa có hồ sơ khám cho lịch hẹn này.' });
    const record = result.rows[0];
    if (!STAFF_ROLES.includes(req.user.role) && record.patient_id !== req.user.id) {
      return res.status(403).json({ error: 'Bạn không có quyền xem hồ sơ này.' });
    }
    res.json({ record: await attachItems(record) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

module.exports = router;
