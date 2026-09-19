// Công cụ (function calling) cho "Trợ lý AI cá nhân" trong không gian làm việc.
// Mỗi công cụ chỉ được gọi bởi các vai trò khai báo trong `roles`, và luôn tự
// giới hạn dữ liệu theo người đang đăng nhập (bệnh nhân chỉ thấy dữ liệu của
// mình, bác sĩ chỉ thấy ca của mình) — việc này do code ở đây đảm bảo, không
// dựa vào việc "dặn" mô hình.
const { pool } = require('../db');
const { APPOINTMENT_STATUS_LABELS } = require('../constants');
const { normalizeRange, revenueSeries, specialtySeries, totals, vnDate } = require('./stats');
const { ACTION_LABELS } = require('./audit');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TODAY_VN = "(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date";
const day = (d) => (d instanceof Date ? d.toLocaleDateString('en-CA') : String(d).slice(0, 10));

const dateProp = { type: 'string', description: 'Ngày định dạng YYYY-MM-DD (giờ Việt Nam).' };

const TOOLS = {
  my_appointments: {
    roles: ['patient'],
    declaration: {
      name: 'my_appointments',
      description: 'Lấy các lịch hẹn khám gần đây và sắp tới CỦA CHÍNH người dùng đang đăng nhập (ngày, giờ, chuyên khoa, bác sĩ, trạng thái).',
      parameters: { type: 'object', properties: {} },
    },
    async run(_args, user) {
      const r = await pool.query(
        `SELECT a.appointment_date, a.appointment_time, a.specialty, a.status, d.name AS doctor
         FROM appointments a LEFT JOIN users d ON d.id = a.doctor_id
         WHERE a.patient_id = $1 ORDER BY a.appointment_date DESC, a.appointment_time DESC LIMIT 10`,
        [user.id]
      );
      return { appointments: r.rows.map((x) => ({ ngay: day(x.appointment_date), gio: x.appointment_time, chuyenKhoa: x.specialty, bacSi: x.doctor || 'chưa chỉ định', trangThai: APPOINTMENT_STATUS_LABELS[x.status] || x.status })) };
    },
  },

  my_records: {
    roles: ['patient'],
    declaration: {
      name: 'my_records',
      description: 'Lấy các hồ sơ khám và đơn thuốc gần nhất CỦA CHÍNH người dùng (số đơn, chẩn đoán, thuốc, liều dùng). Dùng khi hỏi về đơn thuốc, chẩn đoán, lần khám trước.',
      parameters: { type: 'object', properties: {} },
    },
    async run(_args, user) {
      const r = await pool.query(
        `SELECT mr.id, mr.diagnosis, mr.notes, a.appointment_date, a.specialty, d.name AS doctor,
                (SELECT COALESCE(json_agg(json_build_object('thuoc', m.name, 'lieuDung', pi.dosage, 'soLuong', pi.quantity, 'donVi', m.unit) ORDER BY pi.id), '[]'::json)
                 FROM prescription_items pi JOIN medicines m ON m.id = pi.medicine_id WHERE pi.medical_record_id = mr.id) AS items
         FROM medical_records mr
         JOIN appointments a ON a.id = mr.appointment_id
         JOIN users d ON d.id = mr.doctor_id
         WHERE mr.patient_id = $1 ORDER BY mr.created_at DESC LIMIT 5`,
        [user.id]
      );
      return { records: r.rows.map((x) => ({ soDon: 'DT-' + String(x.id).padStart(6, '0'), ngay: day(x.appointment_date), chuyenKhoa: x.specialty, bacSi: x.doctor, chanDoan: x.diagnosis, ghiChuBacSi: x.notes, donThuoc: x.items })) };
    },
  },

  my_invoices: {
    roles: ['patient'],
    declaration: {
      name: 'my_invoices',
      description: 'Lấy các hoá đơn gần đây CỦA CHÍNH người dùng (số hoá đơn, tổng tiền, đã thanh toán hay chưa).',
      parameters: { type: 'object', properties: {} },
    },
    async run(_args, user) {
      const r = await pool.query(
        `SELECT inv.id, inv.total_amount, inv.status, inv.payment_method, a.appointment_date, a.specialty
         FROM invoices inv JOIN appointments a ON a.id = inv.appointment_id
         WHERE inv.patient_id = $1 ORDER BY inv.created_at DESC LIMIT 10`,
        [user.id]
      );
      return { invoices: r.rows.map((x) => ({ soHoaDon: 'HD-' + String(x.id).padStart(6, '0'), ngayKham: day(x.appointment_date), chuyenKhoa: x.specialty, tongTienVND: x.total_amount, daThanhToan: x.status === 'da_thanh_toan' })) };
    },
  },

  my_followups: {
    roles: ['patient'],
    declaration: {
      name: 'my_followups',
      description: 'Lấy các lịch TÁI KHÁM bác sĩ đã hẹn cho CHÍNH người dùng đang đăng nhập (ngày tái khám, dặn dò).',
      parameters: { type: 'object', properties: {} },
    },
    async run(_args, user) {
      const r = await pool.query(
        `SELECT to_char(f.followup_date,'YYYY-MM-DD') AS date, f.note, d.name AS doctor
         FROM followups f JOIN users d ON d.id = f.doctor_id
         WHERE f.patient_id = $1 AND f.status = 'cho' ORDER BY f.followup_date`,
        [user.id]
      );
      return { followups: r.rows.map((x) => ({ ngay: x.date, bacSi: x.doctor, danDo: x.note })) };
    },
  },

  appointments_by_date: {
    roles: ['doctor', 'staff', 'admin'],
    declaration: {
      name: 'appointments_by_date',
      description: 'Liệt kê lịch hẹn khám trong 1 ngày (mặc định hôm nay). Bác sĩ chỉ thấy lịch của CHÍNH mình; nhân viên/admin thấy toàn phòng khám.',
      parameters: { type: 'object', properties: { date: dateProp } },
    },
    async run(args, user) {
      const date = DATE_RE.test(String(args.date)) ? args.date : vnDate(0);
      const params = [date];
      let extra = '';
      if (user.role === 'doctor') { params.push(user.id); extra = ' AND a.doctor_id = $2'; }
      const r = await pool.query(
        `SELECT a.appointment_time, a.specialty, a.status, p.name AS patient, d.name AS doctor
         FROM appointments a JOIN users p ON p.id = a.patient_id LEFT JOIN users d ON d.id = a.doctor_id
         WHERE a.appointment_date = $1${extra} ORDER BY a.appointment_time LIMIT 60`,
        params
      );
      return { ngay: date, soLich: r.rows.length, lich: r.rows.map((x) => ({ gio: x.appointment_time, benhNhan: x.patient, chuyenKhoa: x.specialty, bacSi: x.doctor || 'chưa chỉ định', trangThai: APPOINTMENT_STATUS_LABELS[x.status] || x.status })) };
    },
  },

  followups_overview: {
    roles: ['doctor', 'staff', 'admin'],
    declaration: {
      name: 'followups_overview',
      description: 'Danh sách lịch TÁI KHÁM còn chờ, chia nhóm quá hạn / hôm nay / sắp tới. Bác sĩ chỉ thấy của CHÍNH mình; nhân viên/admin thấy toàn bộ.',
      parameters: { type: 'object', properties: {} },
    },
    async run(_args, user) {
      const params = [];
      let extra = '';
      if (user.role === 'doctor') { params.push(user.id); extra = ' AND f.doctor_id = $1'; }
      const r = await pool.query(
        `SELECT to_char(f.followup_date,'YYYY-MM-DD') AS date, f.note, p.name AS patient, d.name AS doctor,
                CASE WHEN f.followup_date < ${TODAY_VN} THEN 'quaHan' WHEN f.followup_date = ${TODAY_VN} THEN 'homNay' ELSE 'sapToi' END AS bucket
         FROM followups f JOIN users p ON p.id = f.patient_id JOIN users d ON d.id = f.doctor_id
         WHERE f.status = 'cho'${extra} ORDER BY f.followup_date LIMIT 60`,
        params
      );
      const out = { quaHan: [], homNay: [], sapToi: [] };
      for (const x of r.rows) out[x.bucket].push({ ngay: x.date, benhNhan: x.patient, bacSi: x.doctor, ghiChu: x.note });
      return out;
    },
  },

  unpaid_invoices: {
    roles: ['staff', 'admin'],
    declaration: {
      name: 'unpaid_invoices',
      description: 'Danh sách hoá đơn CHƯA thu tiền và tổng số tiền còn phải thu.',
      parameters: { type: 'object', properties: {} },
    },
    async run() {
      const r = await pool.query(
        `SELECT inv.id, inv.total_amount, p.name AS patient, a.appointment_date, a.specialty
         FROM invoices inv JOIN users p ON p.id = inv.patient_id JOIN appointments a ON a.id = inv.appointment_id
         WHERE inv.status = 'chua_thanh_toan' ORDER BY inv.created_at DESC LIMIT 40`
      );
      return { soHoaDon: r.rows.length, tongPhaiThuVND: r.rows.reduce((s, x) => s + x.total_amount, 0), hoaDon: r.rows.map((x) => ({ so: 'HD-' + String(x.id).padStart(6, '0'), benhNhan: x.patient, ngayKham: day(x.appointment_date), chuyenKhoa: x.specialty, soTienVND: x.total_amount })) };
    },
  },

  revenue_stats: {
    roles: ['admin'],
    declaration: {
      name: 'revenue_stats',
      description: 'Thống kê DOANH THU (chỉ tính hoá đơn đã thu tiền, theo ngày thu) và số lịch hẹn trong 1 khoảng ngày, kèm chuỗi theo ngày hoặc theo tháng. Mặc định 30 ngày gần nhất.',
      parameters: {
        type: 'object',
        properties: {
          from: dateProp,
          to: dateProp,
          group: { type: 'string', description: '"day" (theo ngày) hoặc "month" (theo tháng). Mặc định day.' },
        },
      },
    },
    async run(args) {
      const group = args.group === 'month' ? 'month' : 'day';
      const range = normalizeRange(args.from, args.to, group === 'month' ? 365 : 30);
      const [summary, series] = await Promise.all([totals(range), revenueSeries({ ...range, group })]);
      return { tuNgay: range.from, denNgay: range.to, doanhThuVND: summary.revenue, soHoaDonDaThu: summary.paidInvoices, soLichHen: summary.appointments, congNoChuaThuVND: summary.unpaidAmount, theo: group === 'month' ? 'tháng' : 'ngày', chuoi: series.map((x) => ({ ky: x.period, doanhThuVND: x.total, soHoaDon: x.invoices })) };
    },
  },

  specialty_stats: {
    roles: ['admin'],
    declaration: {
      name: 'specialty_stats',
      description: 'Thống kê SỐ CA KHÁM theo chuyên khoa (tổng, hoàn thành, đã huỷ) trong 1 khoảng ngày. Mặc định 30 ngày gần nhất.',
      parameters: { type: 'object', properties: { from: dateProp, to: dateProp } },
    },
    async run(args) {
      const range = normalizeRange(args.from, args.to, 30);
      return { tuNgay: range.from, denNgay: range.to, chuyenKhoa: await specialtySeries(range) };
    },
  },

  recent_audit_logs: {
    roles: ['admin'],
    declaration: {
      name: 'recent_audit_logs',
      description: 'Nhật ký hoạt động gần đây (ai đã đổi vai trò, sửa giá, huỷ lịch, thu tiền...). Dùng khi admin hỏi ai đã làm gì.',
      parameters: { type: 'object', properties: { limit: { type: 'integer', description: 'Số dòng, tối đa 30, mặc định 15.' } } },
    },
    async run(args) {
      const limit = Math.min(Math.max(Number(args.limit) || 15, 1), 30);
      const r = await pool.query('SELECT user_name, user_role, action, detail, created_at FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT $1', [limit]);
      return { logs: r.rows.map((x) => ({ luc: x.created_at.toISOString(), nguoiLam: x.user_name, vaiTro: x.user_role, hanhDong: ACTION_LABELS[x.action] || x.action, chiTiet: x.detail })) };
    },
  },
};

function toolsForRole(role) {
  return Object.values(TOOLS).filter((t) => t.roles.includes(role));
}

// Chạy 1 công cụ do mô hình gọi; từ chối nếu vai trò của người dùng không được dùng công cụ đó.
async function runTool(name, args, user) {
  const tool = TOOLS[name];
  if (!tool || !tool.roles.includes(user.role)) return { error: 'Công cụ không khả dụng cho tài khoản này.' };
  try {
    return await tool.run(args || {}, user);
  } catch (e) {
    console.error('Lỗi công cụ trợ lý', name, e);
    return { error: 'Không lấy được dữ liệu, thử lại sau.' };
  }
}

module.exports = { toolsForRole, runTool };
