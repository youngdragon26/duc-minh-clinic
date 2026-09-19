const { pool } = require('../db');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VN = "'Asia/Ho_Chi_Minh'";

// Ngày Việt Nam dạng YYYY-MM-DD, lệch `offsetDays` so với hôm nay.
function vnDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
}

function normalizeRange(from, to, defaultDays) {
  const f = DATE_RE.test(String(from)) ? String(from) : vnDate(-(defaultDays - 1));
  const t = DATE_RE.test(String(to)) ? String(to) : vnDate(0);
  return f <= t ? { from: f, to: t } : { from: t, to: f };
}

// Doanh thu = tổng hoá đơn ĐÃ THU TIỀN, tính theo ngày thu (paid_at, giờ Việt Nam),
// không tính theo ngày khám — vì tiền thực sự vào quỹ vào ngày thu.
async function revenueSeries({ from, to, group }) {
  const trunc = group === 'month' ? 'month' : 'day';
  const fmt = group === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD';
  const r = await pool.query(
    `SELECT to_char(date_trunc('${trunc}', paid_at AT TIME ZONE ${VN}), '${fmt}') AS period,
            COALESCE(SUM(total_amount), 0)::bigint AS total, COUNT(*)::int AS invoices
     FROM invoices
     WHERE status = 'da_thanh_toan' AND (paid_at AT TIME ZONE ${VN})::date BETWEEN $1 AND $2
     GROUP BY 1 ORDER BY 1`,
    [from, to]
  );
  return r.rows.map((x) => ({ period: x.period, total: Number(x.total), invoices: x.invoices }));
}

async function specialtySeries({ from, to }) {
  const r = await pool.query(
    `SELECT specialty,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'hoan_thanh')::int AS completed,
            COUNT(*) FILTER (WHERE status = 'da_huy')::int AS cancelled
     FROM appointments
     WHERE appointment_date BETWEEN $1 AND $2
     GROUP BY specialty ORDER BY total DESC, specialty`,
    [from, to]
  );
  return r.rows;
}

async function totals({ from, to }) {
  const [paid, unpaid, appts] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(total_amount),0)::bigint AS total, COUNT(*)::int AS n FROM invoices
       WHERE status = 'da_thanh_toan' AND (paid_at AT TIME ZONE ${VN})::date BETWEEN $1 AND $2`, [from, to]),
    pool.query("SELECT COALESCE(SUM(total_amount),0)::bigint AS total, COUNT(*)::int AS n FROM invoices WHERE status = 'chua_thanh_toan'"),
    pool.query('SELECT COUNT(*)::int AS n FROM appointments WHERE appointment_date BETWEEN $1 AND $2', [from, to]),
  ]);
  return {
    revenue: Number(paid.rows[0].total),
    paidInvoices: paid.rows[0].n,
    unpaidAmount: Number(unpaid.rows[0].total),
    unpaidInvoices: unpaid.rows[0].n,
    appointments: appts.rows[0].n,
  };
}

module.exports = { normalizeRange, revenueSeries, specialtySeries, totals, vnDate };
