const { pool } = require('../db');

// Khung giờ khám cố định của phòng khám: 07:00 - 20:00, mỗi giờ 1 slot.
const FIXED_SLOTS = Array.from({ length: 14 }, (_, i) => String(7 + i).padStart(2, '0') + ':00');

// Tra cứu khung giờ còn trống cho 1 chuyên khoa vào 1 ngày cụ thể — dùng chung
// cho cả trang đặt lịch (lưới lịch) và tool đặt lịch của trợ lý AI, để 2 nơi
// luôn thấy đúng 1 nguồn sự thật thay vì suy đoán khác nhau.
// doctorId (nếu có) thu hẹp kết quả về đúng 1 bác sĩ thay vì toàn bộ chuyên khoa.
async function getAvailableSlots({ specialty, date, doctorId = null }) {
  const params = [specialty];
  // Bác sĩ specialty = NULL là "bác sĩ tổng quát", phụ trách được mọi chuyên khoa.
  let doctorSql = "SELECT id, name FROM users WHERE role = 'doctor' AND (specialty = $1 OR specialty IS NULL)";
  if (doctorId) {
    params.push(doctorId);
    doctorSql += ` AND id = $${params.length}`;
  }
  doctorSql += ' ORDER BY name';
  const doctorsRes = await pool.query(doctorSql, params);

  if (doctorsRes.rows.length === 0) {
    return { doctors: [], slots: FIXED_SLOTS.map((time) => ({ time, available: false })) };
  }

  const doctorIds = doctorsRes.rows.map((d) => d.id);
  const bookedRes = await pool.query(
    `SELECT doctor_id, appointment_time FROM appointments
     WHERE appointment_date = $1 AND status <> 'da_huy' AND doctor_id = ANY($2::int[])`,
    [date, doctorIds]
  );
  const bookedByDoctor = {};
  for (const row of bookedRes.rows) {
    if (!bookedByDoctor[row.doctor_id]) bookedByDoctor[row.doctor_id] = new Set();
    bookedByDoctor[row.doctor_id].add(row.appointment_time);
  }

  const doctors = doctorsRes.rows.map((d) => {
    const booked = bookedByDoctor[d.id] || new Set();
    return { doctorId: d.id, doctorName: d.name, freeSlots: FIXED_SLOTS.filter((s) => !booked.has(s)) };
  });

  const slots = FIXED_SLOTS.map((time) => ({
    time,
    available: doctors.some((d) => d.freeSlots.includes(time)),
  }));

  return { doctors, slots };
}

module.exports = { getAvailableSlots, FIXED_SLOTS };
