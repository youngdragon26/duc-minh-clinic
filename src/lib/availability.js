const { pool } = require('../db');

// Khung giờ khám cố định của phòng khám: 07:00 - 20:30, mỗi 30 phút 1 slot
// (vd 07:00, 07:30, 08:00...) — không chỉ giới hạn ở giờ tròn.
const FIXED_SLOTS = Array.from({ length: 28 }, (_, i) => {
  const h = 7 + Math.floor(i / 2);
  const m = i % 2 === 0 ? '00' : '30';
  return String(h).padStart(2, '0') + ':' + m;
});

// Tra cứu khung giờ còn trống cho 1 chuyên khoa vào 1 ngày cụ thể — dùng chung
// cho cả trang đặt lịch (lưới lịch) và tool đặt lịch của trợ lý AI, để 2 nơi
// luôn thấy đúng 1 nguồn sự thật thay vì suy đoán khác nhau.
// doctorId (nếu có) thu hẹp kết quả về đúng 1 bác sĩ thay vì toàn bộ chuyên khoa.
// excludeAppointmentId: khi đang SỬA 1 lịch hẹn, bỏ qua chính lịch hẹn đó khỏi
// danh sách "đã đặt" — nếu không, khung giờ hiện tại của lịch hẹn sẽ bị coi là
// hết chỗ ngay trên chính lưới dùng để sửa nó.
//
// Lịch "không chọn bác sĩ cụ thể" (doctor_id NULL) vẫn chiếm 1 bác sĩ của chuyên
// khoa ở khung giờ đó (bác sĩ nhận ca lúc khám) — nên 1 khung giờ chỉ còn chỗ khi
// số bác sĩ rảnh > số lịch chưa gắn bác sĩ. Thiếu bước này thì đặt được vô hạn lịch
// không chọn bác sĩ vào cùng 1 giờ, và lịch đặt đích danh bác sĩ có thể "cướp" mất
// bác sĩ duy nhất mà lịch chưa gắn bác sĩ đang trông vào.
async function getAvailableSlots({ specialty, date, doctorId = null, excludeAppointmentId = null }) {
  // Bác sĩ specialty = NULL là "bác sĩ tổng quát", phụ trách được mọi chuyên khoa.
  // Luôn lấy cả nhóm bác sĩ của chuyên khoa (kể cả khi hỏi 1 bác sĩ) để tính sức chứa.
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

  // Ca trực theo tuần (UC009) — bác sĩ CHƯA được admin phân ca nào (0 dòng, ở bất
  // kỳ thứ nào) thì coi như làm việc cả ngày theo khung giờ chung (hành vi mặc
  // định cũ, để không phá vỡ các bác sĩ chưa cấu hình lịch riêng); bác sĩ đã có
  // ít nhất 1 ca thì CHỈ mở đúng khung giờ ca trực của ĐÚNG thứ trong tuần này —
  // không có ca cho thứ này nghĩa là bác sĩ nghỉ hôm đó.
  const shiftsRes = await pool.query(
    'SELECT doctor_id, weekday, start_time, end_time FROM doctor_shifts WHERE doctor_id = ANY($1::int[])',
    [doctorIds]
  );
  const shiftsByDoctor = {};
  for (const row of shiftsRes.rows) {
    (shiftsByDoctor[row.doctor_id] ||= []).push(row);
  }
  // getUTCDay() cùng quy ước 0=Chủ nhật với EXTRACT(DOW) của Postgres — parse mốc
  // UTC 00:00 để không lệch thứ theo múi giờ máy chủ.
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
  // Còn chỗ khi số bác sĩ rảnh lúc đó nhiều hơn số lịch chưa gắn bác sĩ đang chờ nhận ca.
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

// Kiểm tra 1 bác sĩ có đang trong ca trực vào đúng ngày/giờ cụ thể hay không —
// dùng ở BƯỚC ĐẶT LỊCH THẬT (appointmentService.js) để chặn đặt/sửa lịch vào giờ
// bác sĩ không làm việc, khác với getAvailableSlots ở trên chỉ phục vụ HIỂN THỊ
// lưới giờ trống. Cùng quy tắc "chưa cấu hình ca nào thì coi như làm cả ngày".
async function isDoctorWorkingAt(doctorId, date, time) {
  const shiftsRes = await pool.query('SELECT weekday, start_time, end_time FROM doctor_shifts WHERE doctor_id = $1', [doctorId]);
  if (shiftsRes.rows.length === 0) return true;
  const weekday = new Date(date + 'T00:00:00Z').getUTCDay();
  return shiftsRes.rows.some((s) => s.weekday === weekday
    && time >= String(s.start_time).slice(0, 5) && time < String(s.end_time).slice(0, 5));
}

// Khung giờ còn nhận thêm 1 lịch không (đúng theo quy tắc sức chứa ở getAvailableSlots) —
// dùng ở BƯỚC ĐẶT/SỬA LỊCH THẬT, vì lịch không chọn bác sĩ không có ràng buộc trùng ở CSDL.
async function isSlotOpen({ specialty, date, time, doctorId = null, excludeAppointmentId = null }) {
  const { slots } = await getAvailableSlots({ specialty, date, doctorId, excludeAppointmentId });
  return slots.some((s) => s.time === time && s.available);
}

module.exports = { getAvailableSlots, FIXED_SLOTS, isDoctorWorkingAt, isSlotOpen };
