const express = require('express');
const { pool } = require('../db');
const { authenticate, requireAdmin, requireRole } = require('../middleware/auth');
const { SPECIALTIES, INVOICE_STATUSES } = require('../constants');

const router = express.Router();
router.use(authenticate);

const STAFF_ROLES = ['staff', 'doctor', 'admin'];

// ---------- Bảng giá dịch vụ (phí khám theo chuyên khoa) ----------

router.get('/service-prices', async (req, res) => {
  try {
    const result = await pool.query('SELECT specialty, price FROM service_prices');
    const bySpecialty = Object.fromEntries(result.rows.map((r) => [r.specialty, r.price]));
    const prices = SPECIALTIES.map((s) => ({
      specialty: s,
      price: Object.prototype.hasOwnProperty.call(bySpecialty, s) ? bySpecialty[s] : null,
      configured: Object.prototype.hasOwnProperty.call(bySpecialty, s),
    }));
    res.json({ prices });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

router.put('/service-prices/:specialty', requireAdmin, async (req, res) => {
  try {
    const specialty = decodeURIComponent(req.params.specialty);
    if (!SPECIALTIES.includes(specialty)) {
      return res.status(400).json({ error: 'Chuyên khoa không hợp lệ.' });
    }
    const price = Number(req.body?.price);
    if (!Number.isFinite(price) || price < 0) {
      return res.status(400).json({ error: 'Giá khám không hợp lệ.' });
    }
    await pool.query(
      `INSERT INTO service_prices (specialty, price) VALUES ($1, $2)
       ON CONFLICT (specialty) DO UPDATE SET price = EXCLUDED.price`,
      [specialty, price]
    );
    res.json({ specialty, price });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

// ---------- Hoá đơn ----------

function publicInvoice(inv) {
  return {
    id: inv.id,
    appointmentId: inv.appointment_id,
    patientId: inv.patient_id,
    patientName: inv.patient_name,
    specialty: inv.specialty,
    date: inv.appointment_date,
    totalAmount: inv.total_amount,
    status: inv.status,
    paidAt: inv.paid_at,
    createdAt: inv.created_at,
  };
}

const INVOICE_SELECT = `
  SELECT inv.*, p.name AS patient_name, a.specialty, a.appointment_date
  FROM invoices inv
  JOIN users p ON p.id = inv.patient_id
  JOIN appointments a ON a.id = inv.appointment_id
`;

async function attachInvoiceItems(inv) {
  const items = await pool.query(
    'SELECT id, description, quantity, unit_price AS "unitPrice", subtotal FROM invoice_items WHERE invoice_id = $1 ORDER BY id',
    [inv.id]
  );
  return { ...publicInvoice(inv), items: items.rows };
}

// Lập hoá đơn cho 1 lịch hẹn đã khám xong — tự tính từ phí khám (theo chuyên khoa)
// + đơn thuốc đã kê (nếu có). Chỉ Nhân viên/Admin được lập hoá đơn.
router.post('/invoices', requireRole('staff', 'admin'), async (req, res) => {
  try {
    const appointmentId = Number(req.body?.appointmentId);
    if (!appointmentId) return res.status(400).json({ error: 'Thiếu lịch hẹn.' });

    const apptRes = await pool.query('SELECT * FROM appointments WHERE id = $1', [appointmentId]);
    if (apptRes.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy lịch hẹn.' });
    const appt = apptRes.rows[0];
    if (appt.status !== 'hoan_thanh') {
      return res.status(400).json({ error: 'Chỉ lập được hoá đơn cho lịch hẹn đã Hoàn thành khám.' });
    }

    const priceRow = await pool.query('SELECT price FROM service_prices WHERE specialty = $1', [appt.specialty]);
    if (priceRow.rows.length === 0) {
      return res.status(400).json({
        error: `Chưa thiết lập giá khám cho chuyên khoa "${appt.specialty}". Vào Bảng giá dịch vụ để thiết lập trước.`,
      });
    }
    const consultationFee = priceRow.rows[0].price;

    const recordRes = await pool.query('SELECT id FROM medical_records WHERE appointment_id = $1', [appointmentId]);
    let prescriptionItems = [];
    if (recordRes.rows.length > 0) {
      const itemsRes = await pool.query(
        `SELECT pi.quantity, m.name, m.price FROM prescription_items pi
         JOIN medicines m ON m.id = pi.medicine_id WHERE pi.medical_record_id = $1`,
        [recordRes.rows[0].id]
      );
      prescriptionItems = itemsRes.rows;
    }

    const lineItems = [
      { description: `Phí khám: ${appt.specialty}`, quantity: 1, unitPrice: consultationFee, subtotal: consultationFee },
      ...prescriptionItems.map((it) => ({
        description: it.name,
        quantity: it.quantity,
        unitPrice: it.price,
        subtotal: it.quantity * it.price,
      })),
    ];
    const totalAmount = lineItems.reduce((sum, it) => sum + it.subtotal, 0);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const invRes = await client.query(
        `INSERT INTO invoices (appointment_id, patient_id, created_by, total_amount)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [appointmentId, appt.patient_id, req.user.id, totalAmount]
      );
      const invoiceId = invRes.rows[0].id;
      for (const it of lineItems) {
        await client.query(
          'INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, subtotal) VALUES ($1,$2,$3,$4,$5)',
          [invoiceId, it.description, it.quantity, it.unitPrice, it.subtotal]
        );
      }
      await client.query('COMMIT');

      const full = await pool.query(INVOICE_SELECT + ' WHERE inv.id = $1', [invoiceId]);
      res.status(201).json({ invoice: await attachInvoiceItems(full.rows[0]) });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'Lịch hẹn này đã có hoá đơn.' });
    }
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

router.get('/invoices/mine', async (req, res) => {
  try {
    const result = await pool.query(INVOICE_SELECT + ' WHERE inv.patient_id = $1 ORDER BY inv.created_at DESC', [req.user.id]);
    res.json({ invoices: await Promise.all(result.rows.map(attachInvoiceItems)) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

router.get('/invoices', requireRole(...STAFF_ROLES), async (req, res) => {
  try {
    const { status, date } = req.query;
    const conditions = [];
    const params = [];
    if (status) { params.push(status); conditions.push(`inv.status = $${params.length}`); }
    if (date) { params.push(date); conditions.push(`a.appointment_date = $${params.length}`); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const result = await pool.query(`${INVOICE_SELECT} ${where} ORDER BY inv.created_at DESC`, params);
    res.json({ invoices: await Promise.all(result.rows.map(attachInvoiceItems)) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

router.get('/invoices/by-appointment/:appointmentId', async (req, res) => {
  try {
    const result = await pool.query(INVOICE_SELECT + ' WHERE inv.appointment_id = $1', [Number(req.params.appointmentId)]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Chưa có hoá đơn cho lịch hẹn này.' });
    const inv = result.rows[0];
    if (!STAFF_ROLES.includes(req.user.role) && inv.patient_id !== req.user.id) {
      return res.status(403).json({ error: 'Bạn không có quyền xem hoá đơn này.' });
    }
    res.json({ invoice: await attachInvoiceItems(inv) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

router.patch('/invoices/:id/status', requireRole('staff', 'admin'), async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!INVOICE_STATUSES.includes(status)) return res.status(400).json({ error: 'Trạng thái không hợp lệ.' });
    const result = await pool.query(
      `UPDATE invoices SET status = $1, paid_at = CASE WHEN $1 = 'da_thanh_toan' THEN now() ELSE NULL END
       WHERE id = $2 RETURNING id`,
      [status, Number(req.params.id)]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy hoá đơn.' });
    const full = await pool.query(INVOICE_SELECT + ' WHERE inv.id = $1', [result.rows[0].id]);
    res.json({ invoice: await attachInvoiceItems(full.rows[0]) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

module.exports = router;
