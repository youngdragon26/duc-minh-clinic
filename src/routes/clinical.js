const express = require('express');
const { pool } = require('../db');
const { authenticate, requireAdmin, requireRole } = require('../middleware/auth');
const { INTERACTION_SEVERITIES } = require('../constants');
const { logAudit } = require('../lib/audit');

const router = express.Router();
router.use(authenticate);

const STAFF_ROLES = ['staff', 'doctor', 'admin'];

// ---------- Danh mục thuốc ----------

router.get('/medicines', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, unit, price, group_name AS "groupName", created_at AS "createdAt" FROM medicines ORDER BY name');
    res.json({ medicines: result.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

router.post('/medicines', requireAdmin, async (req, res) => {
  try {
    const { name, unit, price, groupName } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Thiếu tên thuốc.' });
    const priceNum = Number(price) || 0;
    if (priceNum < 0) return res.status(400).json({ error: 'Giá thuốc không hợp lệ.' });
    const existing = await pool.query('SELECT id FROM medicines WHERE name = $1', [name.trim()]);
    if (existing.rows.length > 0) return res.status(409).json({ error: 'Thuốc này đã có trong danh mục.' });
    const result = await pool.query(
      'INSERT INTO medicines (name, unit, price, group_name) VALUES ($1, $2, $3, $4) RETURNING id, name, unit, price, group_name AS "groupName", created_at AS "createdAt"',
      [name.trim(), (unit && unit.trim()) || 'viên', priceNum, groupName ? String(groupName).trim() : null]
    );
    res.status(201).json({ medicine: result.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

router.patch('/medicines/:id', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const current = await pool.query('SELECT price, group_name FROM medicines WHERE id = $1', [id]);
    if (current.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy thuốc.' });

    // Cho sửa từng phần (giá hoặc nhóm thuốc) — mỗi ô trên bảng admin lưu độc lập,
    // không bắt phải gửi kèm cả 2 trường nếu chỉ đổi 1 ô.
    const priceNum = req.body?.price !== undefined ? Number(req.body.price) : current.rows[0].price;
    if (!Number.isFinite(priceNum) || priceNum < 0) return res.status(400).json({ error: 'Giá thuốc không hợp lệ.' });
    const groupName = req.body?.groupName !== undefined
      ? (req.body.groupName ? String(req.body.groupName).trim() : null)
      : current.rows[0].group_name;

    const result = await pool.query(
      'UPDATE medicines SET price = $1, group_name = $2 WHERE id = $3 RETURNING id, name, unit, price, group_name AS "groupName", created_at AS "createdAt"',
      [priceNum, groupName, id]
    );
    if (req.body?.price !== undefined && priceNum !== current.rows[0].price) {
      await logAudit(req.user, 'price.medicine', 'medicine', id, { name: result.rows[0].name, from: current.rows[0].price, to: priceNum });
    }
    res.json({ medicine: result.rows[0] });
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
    `SELECT di.severity, di.description,
            ma.id AS "medicineAId", ma.name AS "medicineAName",
            mb.id AS "medicineBId", mb.name AS "medicineBName"
     FROM drug_interactions di
     JOIN medicines ma ON ma.id = di.medicine_a_id
     JOIN medicines mb ON mb.id = di.medicine_b_id
     WHERE di.medicine_a_id = ANY($1::int[]) AND di.medicine_b_id = ANY($1::int[])`,
    [ids]
  );
  return result.rows;
}

// Gợi ý thuốc thay thế (UC006): các thuốc khác cùng "nhóm thuốc/hoạt chất" với
// targetMedicineId, đánh dấu "safe: false" cho thuốc thay thế nào lại tương tác
// với 1 thuốc khác đang có trong đơn (restMedicineIds) — để bác sĩ không vô tình
// chọn 1 thuốc thay thế nhưng vẫn dính tương tác nguy hiểm với phần còn lại của đơn.
async function suggestSubstitutes(targetMedicineId, restMedicineIds = []) {
  const target = await pool.query('SELECT group_name FROM medicines WHERE id = $1', [targetMedicineId]);
  const groupName = target.rows[0]?.group_name;
  if (!groupName) return [];

  const candidates = await pool.query(
    'SELECT id, name, unit, price FROM medicines WHERE group_name = $1 AND id <> $2 ORDER BY name',
    [groupName, targetMedicineId]
  );
  if (candidates.rows.length === 0) return [];

  const restIds = [...new Set(restMedicineIds.map(Number))].filter((id) => Boolean(id) && id !== targetMedicineId);
  if (restIds.length === 0) return candidates.rows.map((c) => ({ ...c, safe: true }));

  const candidateIds = candidates.rows.map((c) => c.id);
  const conflicts = await pool.query(
    `SELECT medicine_a_id, medicine_b_id FROM drug_interactions
     WHERE (medicine_a_id = ANY($1::int[]) AND medicine_b_id = ANY($2::int[]))
        OR (medicine_a_id = ANY($2::int[]) AND medicine_b_id = ANY($1::int[]))`,
    [candidateIds, restIds]
  );
  const conflicting = new Set();
  for (const row of conflicts.rows) {
    conflicting.add(candidateIds.includes(row.medicine_a_id) ? row.medicine_a_id : row.medicine_b_id);
  }
  return candidates.rows.map((c) => ({ ...c, safe: !conflicting.has(c.id) }));
}

// Tra thuốc thay thế cho 1 thuốc cụ thể, dùng độc lập với cảnh báo tương tác (vd
// bác sĩ muốn xem thuốc thay thế ngay khi vừa chọn 1 thuốc, chưa cần có cảnh báo
// gì). "otherMedicineIds" là các thuốc khác đã có trong đơn đang soạn (nếu có), để
// đánh dấu luôn thuốc thay thế nào có nguy cơ tương tác với phần còn lại của đơn.
router.get('/medicines/:id/substitutes', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'Không tìm thấy thuốc.' });
    const otherIds = String(req.query.otherMedicineIds || '').split(',').map(Number).filter(Boolean);
    const substitutes = await suggestSubstitutes(id, otherIds);
    res.json({ substitutes });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

// Bác sĩ gọi khi đang chọn thuốc để kê đơn, xem cảnh báo ngay trước khi lưu — kèm
// gợi ý thuốc thay thế (cùng nhóm) cho từng thuốc dính cảnh báo, để bác sĩ có thể
// đổi ngay sang 1 lựa chọn an toàn hơn thay vì chỉ được báo "có tương tác".
router.post('/check-interactions', async (req, res) => {
  try {
    const { medicineIds } = req.body || {};
    if (!Array.isArray(medicineIds)) {
      return res.status(400).json({ error: 'Thiếu danh sách thuốc cần kiểm tra.' });
    }
    const warnings = await findInteractions(medicineIds);

    const allIds = [...new Set(medicineIds.map(Number))].filter(Boolean);
    const substitutesCache = new Map();
    const substitutesFor = async (medicineId) => {
      if (!substitutesCache.has(medicineId)) {
        substitutesCache.set(medicineId, await suggestSubstitutes(medicineId, allIds.filter((mid) => mid !== medicineId)));
      }
      return substitutesCache.get(medicineId);
    };

    const warningsWithSuggestions = await Promise.all(warnings.map(async (w) => ({
      ...w,
      substitutesA: await substitutesFor(w.medicineAId),
      substitutesB: await substitutesFor(w.medicineBId),
    })));

    res.json({ warnings: warningsWithSuggestions });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

// ---------- Hồ sơ khám bệnh + đơn thuốc ----------

// Số đơn thuốc hiển thị: DT-000001 (lấy từ id tự tăng của hồ sơ khám).
const prescriptionCode = (id) => 'DT-' + String(id).padStart(6, '0');

function publicRecord(r) {
  return {
    id: r.id,
    code: prescriptionCode(r.id),
    patientName: r.patient_name,
    patientAge: r.age,
    patientGender: r.gender,
    patientPhone: r.contact_phone,
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
  SELECT mr.*, d.name AS doctor_name, p.name AS patient_name, a.specialty, a.appointment_date,
         a.age, a.gender, a.contact_phone
  FROM medical_records mr
  JOIN users d ON d.id = mr.doctor_id
  JOIN users p ON p.id = mr.patient_id
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
    await logAudit(req.user, 'record.create', 'medical_record', recordId, { appointmentId: apptId, patientId: appt.patient_id, medicines: list.length });

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

// Bệnh nhân xem lịch sử khám bệnh của chính mình — ghi audit log lượt tự truy cập
// (yêu cầu bảo mật NFR: "Ghi nhật ký mọi lượt bệnh nhân tự truy cập hồ sơ").
router.get('/records/mine', async (req, res) => {
  try {
    const result = await pool.query(
      RECORD_SELECT + ' WHERE mr.patient_id = $1 ORDER BY mr.created_at DESC',
      [req.user.id]
    );
    const records = await Promise.all(result.rows.map(attachItems));
    if (req.user.role === 'patient') {
      await logAudit(req.user, 'record.self_view', 'medical_record', null, { count: records.length });
    }
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
    if (req.user.role === 'patient') {
      await logAudit(req.user, 'record.self_view', 'medical_record', record.id, { via: 'by-appointment' });
    }
    res.json({ record: await attachItems(record) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

// Chi tiết 1 hồ sơ khám/đơn thuốc theo id (dùng cho trang in) — đặt SAU
// '/records/mine' và '/records/by-appointment/...' để 2 đường dẫn cố định khớp trước.
router.get('/records/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'Không tìm thấy hồ sơ khám.' });
    const result = await pool.query(RECORD_SELECT + ' WHERE mr.id = $1', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy hồ sơ khám.' });
    const record = result.rows[0];
    if (!STAFF_ROLES.includes(req.user.role) && record.patient_id !== req.user.id) {
      return res.status(403).json({ error: 'Bạn không có quyền xem hồ sơ này.' });
    }
    if (req.user.role === 'patient') {
      await logAudit(req.user, 'record.self_view', 'medical_record', record.id, { via: 'by-id' });
    }
    res.json({ record: await attachItems(record) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

module.exports = router;
