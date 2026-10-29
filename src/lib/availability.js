const { pool } = require('../db');

// Khung giờ khám cố định: 07:00 - 20:30, mỗi 30 phút 1 slot.
const FIXED_SLOTS = Array.from({ length: 28 }, (_, i) => {
  const h = 7 + Math.floor(i / 2);
  const m = i % 2 === 0 ? '00' : '30';
  return String(h).padStart(2, '0') + ':' + m;
});

// Khung giờ còn trống của 1 chuyên khoa vào 1 ngày — nguồn duy nhất cho cả lưới đặt lịch và tool của chatbot.
// doctorId thu hẹp về 1 bác sĩ; excludeAppointmentId bỏ qua chính lịch đang sửa.
// Lịch không chọn bác sĩ (doctor_id NULL) vẫn chiếm 1 bác sĩ của chuyên khoa: khung còn chỗ khi bác sĩ rảnh > lịch chưa gắn bác sĩ.
async function getAvailableSlots({ specialty, date, doctorId = null, excludeAppointmentId = null }) {
  // Bác sĩ specialty = NULL khám được mọi chuyên khoa. Luôn lấy cả nhóm để tính sức chứa.
  const doctorsRes = await pool.query(
    "SELECT id, name FROM users WHERE role = 'doctor' AND (specialty = $1 OR specialty IS NULL) ORDER BY name",
    [specialty]
  );

  if (doctorsRes.rows.length === 0) {
    return { doctors: [], slots: FIXED_SLOTS.map((time) => ({ time, available: false })) };
  }

  const doctorIds = doctorsRes.rows.map((d) => d.id);
  const bookedParams = [date, doctorIds, specialty];
  let bookedSql = `SELECT doctor_id, appointment_time FROM appointments
     WHERE appointment_date = $1 AND status <> 'da_huy'
       AND (doctor_id = ANY($2::int[]) OR (doctor_id IS NULL AND specialty = $3))`;
  if (excludeAppointmentId) {
    bookedParams.push(excludeAppointmentId);
    bookedSql += ` AND id <> $${bookedParams.length}`;
  }
  const bookedRes = await pool.query(bookedSql, bookedParams);
  const bookedByDoctor = {};
  const unassignedAt = {};
  for (const row of bookedRes.rows) {
    if (row.doctor_id === null) {
      unassignedAt[row.appointment_time] = (unassignedAt[row.appointment_time] || 0) + 1;
      continue;
    }
    if (!bookedByDoctor[row.doctor_id]) bookedByDoctor[row.doctor_id] = new Set();
    bookedByDoctor[row.doctor_id].add(row.appointment_time);
  }

  // Bác sĩ chưa có ca nào = làm cả ngày theo giờ chung; đã có ca thì chỉ mở đúng ca của thứ đó.
  const shiftsRes = await pool.query(
    'SELECT doctor_id, weekday, start_time, end_time FROM doctor_shifts WHERE doctor_id = ANY($1::int[])',
    [doctorIds]
  );
  const shiftsByDoctor = {};
  for (const row of shiftsRes.rows) {
    (shiftsByDoctor[row.doctor_id] ||= []).push(row);
  }
  // Parse mốc UTC 00:00 để getUTCDay() không lệch theo múi giờ máy chủ.
  const weekday = new Date(date + 'T00:00:00Z').getUTCDay();

  const team = doctorsRes.rows.map((d) => {
    const booked = bookedByDoctor[d.id] || new Set();
    const allShifts = shiftsByDoctor[d.id] || [];
    const allowedSlots = allShifts.length === 0
      ? FIXED_SLOTS
      : FIXED_SLOTS.filter((time) => allShifts.some((s) => s.weekday === weekday
          && time >= String(s.start_time).slice(0, 5) && time < String(s.end_time).slice(0, 5)));
    return { doctorId: d.id, doctorName: d.name, freeSlots: allowedSlots.filter((s) => !booked.has(s)) };
  });
  const hasRoom = (time) => team.filter((d) => d.freeSlots.includes(time)).length > (unassignedAt[time] || 0);
  const doctors = team
    .filter((d) => !doctorId || d.doctorId === Number(doctorId))
    .map((d) => ({ ...d, freeSlots: d.freeSlots.filter(hasRoom) }));

  const slots = FIXED_SLOTS.map((time) => ({
    time,
    available: doctors.some((d) => d.freeSlots.includes(time)),
  }));

  return { doctors, slots };
}

// Bác sĩ có trong ca trực vào ngày/giờ đó không — dùng khi đặt/sửa lịch thật (appointmentService.js).
async function isDoctorWorkingAt(doctorId, date, time) {
  const shiftsRes = await pool.query('SELECT weekday, start_time, end_time FROM doctor_shifts WHERE doctor_id = $1', [doctorId]);
  if (shiftsRes.rows.length === 0) return true;
  const weekday = new Date(date + 'T00:00:00Z').getUTCDay();
  return shiftsRes.rows.some((s) => s.weekday === weekday
    && time >= String(s.start_time).slice(0, 5) && time < String(s.end_time).slice(0, 5));
}

// Khung giờ còn nhận thêm 1 lịch không — dùng khi đặt/sửa lịch thật (lịch không chọn bác sĩ không có ràng buộc ở CSDL).
async function isSlotOpen({ specialty, date, time, doctorId = null, excludeAppointmentId = null }) {
  const { slots } = await getAvailableSlots({ specialty, date, doctorId, excludeAppointmentId });
  return slots.some((s) => s.time === time && s.available);
}

module.exports = { getAvailableSlots, FIXED_SLOTS, isDoctorWorkingAt, isSlotOpen };
