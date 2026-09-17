const { pool } = require('../db');
const { SPECIALTIES, GENDERS } = require('../constants');
const { FIXED_SLOTS } = require('./availability');

// Lỗi do dữ liệu đầu vào sai (khách nhập thiếu/sai, giờ đã có người đặt...) —
// khác lỗi hệ thống, để nơi gọi (route HTTP hoặc tool AI) biết trả thông báo
// rõ ràng cho người dùng thay vì báo "lỗi máy chủ" chung chung.
class BookingError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// Tạo 1 lịch hẹn — dùng chung cho cả form đặt lịch trên web (route POST
// /api/appointments) và tool book_appointment mà trợ lý AI gọi, để 2 đường
// đặt lịch luôn áp dụng đúng 1 bộ quy tắc kiểm tra, không lệch nhau.
async function createAppointment({ patientId, specialty, doctorId, date, time, note, contactName, contactPhone, age, gender }) {
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

  let doctorIdNum = null;
  if (doctorId) {
    doctorIdNum = Number(doctorId);
    const doc = await pool.query("SELECT id, specialty FROM users WHERE id = $1 AND role = 'doctor'", [doctorIdNum]);
    if (doc.rows.length === 0) {
      throw new BookingError('Không tìm thấy bác sĩ này.');
    }
    if (doc.rows[0].specialty && doc.rows[0].specialty !== specialty) {
      throw new BookingError('Bác sĩ này không thuộc chuyên khoa đã chọn.');
    }
  }

  try {
    const inserted = await pool.query(
      `INSERT INTO appointments
         (patient_id, doctor_id, specialty, appointment_date, appointment_time, note, contact_name, contact_phone, age, gender)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [patientId, doctorIdNum, specialty, date, time, note || null, String(contactName).trim(), String(contactPhone).trim(), ageNum, gender]
    );
    return inserted.rows[0].id;
  } catch (e) {
    if (e.code === '23505') {
      throw new BookingError('Khung giờ này của bác sĩ đã có người đặt, vui lòng chọn giờ khác.', 409);
    }
    throw e;
  }
}

module.exports = { createAppointment, BookingError };
