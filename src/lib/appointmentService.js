const { pool } = require('../db');
const { SPECIALTIES, GENDERS, DISCOUNT_CATEGORIES } = require('../constants');
const { FIXED_SLOTS, isDoctorWorkingAt } = require('./availability');

const STAFF_ROLES = ['staff', 'doctor', 'admin'];
// Chỉ sửa/huỷ được lịch hẹn khi chưa bắt đầu khám — tránh sửa "sau lưng" 1 buổi
// khám đang/đã diễn ra.
const EDITABLE_STATUSES = ['cho_xac_nhan', 'da_xac_nhan'];

// Chủ nhật phòng khám KHÔNG khám thường xuyên: chỉ khám theo hẹn trước với 1 bác
// sĩ cụ thể, phải đặt chậm nhất vào Thứ 3 của tuần đó, và chỉ có hiệu lực khi
// chính bác sĩ đó xác nhận (xem route đổi trạng thái). Bệnh nhân/AI phải theo đủ
// quy tắc này; nhân viên/bác sĩ/admin nhập hộ thì không bị giới hạn hạn chót
// (vì đã trao đổi trực tiếp với bác sĩ).
function isSundayISO(dateStr) {
  return new Date(dateStr + 'T00:00:00Z').getUTCDay() === 0;
}
function vnTodayISO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
}
// Hạn chót đặt lịch cho 1 ngày Chủ nhật = Thứ 3 cùng tuần = 5 ngày trước đó.
function sundayDeadlineISO(sundayStr) {
  const d = new Date(sundayStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 5);
  return d.toISOString().slice(0, 10);
}

// Lỗi do dữ liệu đầu vào sai (khách nhập thiếu/sai, giờ đã có người đặt...) —
// khác lỗi hệ thống, để nơi gọi (route HTTP hoặc tool AI) biết trả thông báo
// rõ ràng cho người dùng thay vì báo "lỗi máy chủ" chung chung.
class BookingError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// Kiểm tra + chuẩn hoá các trường chung cho cả tạo mới lẫn sửa lịch hẹn — dùng
// chung để 2 đường (đặt lịch lần đầu / sửa lịch đã đặt) luôn áp cùng 1 quy tắc.
function validateBookingFields({ specialty, date, time, contactName, contactPhone, age, gender, discountCategory, doctorId, skipSundayDeadline }) {
  if (!specialty || !date || !time) {
    throw new BookingError('Thiếu chuyên khoa, ngày hoặc giờ khám.');
  }
  if (!SPECIALTIES.includes(specialty)) {
    throw new BookingError('Chuyên khoa không hợp lệ.');
  }
  if (!contactName || !String(contactName).trim()) {
    throw new BookingError('Thiếu họ tên người khám.');
  }
  if (!contactPhone || !/^[0-9]{9,11}$/.test(String(contactPhone).trim())) {
    throw new BookingError('Số điện thoại không hợp lệ (cần 9-11 chữ số).');
  }
  const ageNum = Number(age);
  if (!Number.isInteger(ageNum) || ageNum < 0 || ageNum > 120) {
    throw new BookingError('Tuổi không hợp lệ.');
  }
  if (!GENDERS.includes(gender)) {
    throw new BookingError('Giới tính không hợp lệ.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new BookingError('Ngày khám không hợp lệ.');
  }
  const dateObj = new Date(date + 'T00:00:00');
  if (Number.isNaN(dateObj.getTime())) {
    throw new BookingError('Ngày khám không hợp lệ.');
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (dateObj < today) {
    throw new BookingError('Không thể đặt lịch cho ngày đã qua.');
  }
  if (!FIXED_SLOTS.includes(time)) {
    throw new BookingError('Giờ khám không hợp lệ.');
  }
  if (isSundayISO(date)) {
    if (!doctorId) throw new BookingError('Chủ nhật phòng khám chỉ khám theo hẹn trước với một bác sĩ cụ thể. Vui lòng chọn bác sĩ muốn khám.');
    if (!skipSundayDeadline && vnTodayISO() > sundayDeadlineISO(date)) {
      throw new BookingError('Lịch khám Chủ nhật cần đặt chậm nhất vào Thứ 3 của tuần đó để bác sĩ kịp xem xét. Vui lòng chọn ngày khác hoặc gọi hotline 0974 755 333.');
    }
  }
  const discountCategoryNorm = discountCategory || null;
  if (discountCategoryNorm && !DISCOUNT_CATEGORIES.includes(discountCategoryNorm)) {
    throw new BookingError('Đối tượng ưu tiên không hợp lệ.');
  }
  return {
    ageNum,
    contactName: String(contactName).trim(),
    contactPhone: String(contactPhone).trim(),
    discountCategory: discountCategoryNorm,
  };
}

async function resolveDoctorId(doctorId, specialty) {
  if (!doctorId) return null;
  const doctorIdNum = Number(doctorId);
  const doc = await pool.query("SELECT id, specialty FROM users WHERE id = $1 AND role = 'doctor'", [doctorIdNum]);
  if (doc.rows.length === 0) {
    throw new BookingError('Không tìm thấy bác sĩ này.');
  }
  if (doc.rows[0].specialty && doc.rows[0].specialty !== specialty) {
    throw new BookingError('Bác sĩ này không thuộc chuyên khoa đã chọn.');
  }
  return doctorIdNum;
}

// Tạo 1 lịch hẹn — dùng chung cho cả form đặt lịch trên web (route POST
// /api/appointments) và tool book_appointment mà trợ lý AI gọi, để 2 đường
// đặt lịch luôn áp dụng đúng 1 bộ quy tắc kiểm tra, không lệch nhau.
async function createAppointment({ patientId, specialty, doctorId, date, time, note, contactName, contactPhone, age, gender, discountCategory }) {
  const normalized = validateBookingFields({ specialty, date, time, contactName, contactPhone, age, gender, discountCategory, doctorId });
  const doctorIdNum = await resolveDoctorId(doctorId, specialty);
  if (doctorIdNum && !(await isDoctorWorkingAt(doctorIdNum, date, time))) {
    throw new BookingError('Bác sĩ không có ca trực vào khung giờ này, vui lòng chọn giờ khác trong lịch làm việc của bác sĩ.');
  }

  try {
    const inserted = await pool.query(
      `INSERT INTO appointments
         (patient_id, doctor_id, specialty, appointment_date, appointment_time, note, contact_name, contact_phone, age, gender, discount_category)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [patientId, doctorIdNum, specialty, date, time, note || null, normalized.contactName, normalized.contactPhone, normalized.ageNum, gender, normalized.discountCategory]
    );
    return inserted.rows[0].id;
  } catch (e) {
    if (e.code === '23505') {
      throw new BookingError('Khung giờ này của bác sĩ đã có người đặt, vui lòng chọn giờ khác.', 409);
    }
    throw e;
  }
}

// Sửa 1 lịch hẹn đã đặt (thông tin liên hệ và/hoặc ngày giờ) — chuyên khoa giữ
// nguyên như lúc đặt (muốn đổi chuyên khoa thì huỷ rồi đặt lại). Bệnh nhân chỉ
// sửa được lịch của chính mình và khi lịch chưa bắt đầu khám; nhân viên/bác
// sĩ/admin sửa được mọi lịch hẹn còn trong 2 trạng thái đó (vd sửa hộ SĐT sai).
async function updateAppointment({ id, requester, doctorId, date, time, note, contactName, contactPhone, age, gender, discountCategory }) {
  const existing = await pool.query('SELECT * FROM appointments WHERE id = $1', [id]);
  if (existing.rows.length === 0) {
    throw new BookingError('Không tìm thấy lịch hẹn.', 404);
  }
  const appt = existing.rows[0];

  const isStaffLike = STAFF_ROLES.includes(requester.role);
  if (!isStaffLike && appt.patient_id !== requester.id) {
    throw new BookingError('Bạn không có quyền sửa lịch hẹn này.', 403);
  }
  if (!EDITABLE_STATUSES.includes(appt.status)) {
    throw new BookingError('Chỉ sửa được lịch hẹn đang ở trạng thái Chờ xác nhận hoặc Đã xác nhận.');
  }

  const normalized = validateBookingFields({
    specialty: appt.specialty, date, time, contactName, contactPhone, age, gender, discountCategory,
    doctorId, skipSundayDeadline: isStaffLike,
  });
  const doctorIdNum = await resolveDoctorId(doctorId, appt.specialty);
  // Nhân viên/bác sĩ/admin sửa lịch coi như đã trao đổi trực tiếp với bác sĩ
  // (giống lý do bỏ qua hạn chót Chủ nhật ở trên) nên không bị chặn bởi ca trực;
  // bệnh nhân tự sửa lịch của mình vẫn phải theo đúng ca trực như lúc đặt mới.
  if (!isStaffLike && doctorIdNum && !(await isDoctorWorkingAt(doctorIdNum, date, time))) {
    throw new BookingError('Bác sĩ không có ca trực vào khung giờ này, vui lòng chọn giờ khác trong lịch làm việc của bác sĩ.');
  }

  try {
    const updated = await pool.query(
      `UPDATE appointments SET
         doctor_id = $1, appointment_date = $2, appointment_time = $3, note = $4,
         contact_name = $5, contact_phone = $6, age = $7, gender = $8, discount_category = $9
       WHERE id = $10 RETURNING id`,
      [doctorIdNum, date, time, note || null, normalized.contactName, normalized.contactPhone, normalized.ageNum, gender, normalized.discountCategory, id]
    );
    return updated.rows[0].id;
  } catch (e) {
    if (e.code === '23505') {
      throw new BookingError('Khung giờ này của bác sĩ đã có người đặt, vui lòng chọn giờ khác.', 409);
    }
    throw e;
  }
}

module.exports = { createAppointment, updateAppointment, BookingError, isSundayISO, sundayDeadlineISO };
