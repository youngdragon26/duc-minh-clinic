// Phân tích TẤT ĐỊNH tin nhắn của bệnh nhân trước khi đưa cho AI: nhận diện số điện
// thoại/tuổi/ngày/giờ và kiểm tra hợp lệ theo ĐÚNG quy tắc của hệ thống đặt lịch.
// Kết quả được đưa vào prompt như "dữ kiện đã kiểm tra" — AI không phải tự đếm chữ số
// hay tự quy đổi "25/9", "9 giờ" (việc mà model hay sai), và không tốn thêm lượt gọi AI.
const WEEKDAYS = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
const OPEN_MIN = 7 * 60;      // 07:00
const LAST_SLOT_MIN = 20 * 60 + 30; // 20:30
const pad = (n) => String(n).padStart(2, '0');

// Tin nhắn không có chữ hay số nào (rỗng, chỉ dấu câu/emoji) — không có gì để trả lời.
function isBlankMessage(message) {
  return !/[\p{L}\p{N}]/u.test(String(message || ''));
}

function addDaysISO(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function describeDate(iso) {
  const wd = WEEKDAYS[new Date(iso + 'T00:00:00Z').getUTCDay()];
  return `${iso} (${wd})`;
}

function analyzeMessage(message, todayISO) {
  const text = String(message || '');
  const lower = text.toLowerCase();
  const notes = [];

  // ---- Số điện thoại: chuỗi ≥6 chữ số liền nhau, hoặc các nhóm 3-4 số cách nhau bằng dấu cách/chấm/gạch
  // (vd "0912 345 678"). Nhóm 1-2 chữ số phía sau KHÔNG được gộp vào — nếu không "0353102966 25 tuổi"
  // bị hiểu thành số 12 chữ số "035310296625" và báo sai số điện thoại hợp lệ. ----
  const phoneRe = /(?<![\d/])\+?\d+(?:[ .-]\d{3,4})*(?![\d/])/g;
  for (const m of text.matchAll(phoneRe)) {
    let digits = m[0].replace(/\D/g, '');
    if (m[0].startsWith('+84')) digits = '0' + digits.slice(2);
    if (digits.length < 6) continue;
    if (digits.length >= 9 && digits.length <= 11) {
      notes.push(digits.startsWith('0')
        ? `Số điện thoại "${digits}": HỢP LỆ (${digits.length} chữ số).`
        : `Số điện thoại "${digits}": đủ ${digits.length} chữ số nhưng KHÔNG bắt đầu bằng 0 — nên hỏi lại khách để chắc chắn.`);
    } else {
      notes.push(`Số điện thoại "${digits}": KHÔNG HỢP LỆ (${digits.length} chữ số, hệ thống cần 9-11 chữ số) — phải xin khách gửi lại đúng số.`);
    }
  }

  // ---- Tuổi ----
  const ageMatch = lower.match(/(\d{1,3})\s*tuổi/) || lower.match(/tuổi\s*(?:là|:)?\s*(\d{1,3})/);
  if (ageMatch) {
    const age = Number(ageMatch[1]);
    notes.push(age >= 0 && age <= 120
      ? `Tuổi: ${age} (hợp lệ).`
      : `Tuổi "${age}": KHÔNG HỢP LỆ (hệ thống chỉ nhận 0-120) — hỏi lại khách.`);
  }

  // ---- Ngày ----
  if (todayISO) {
    const year = Number(todayISO.slice(0, 4));
    const relative = [
      [/hôm nay/, 0, 'hôm nay'],
      [/ngày mai|hôm sau/, 1, 'ngày mai'],
      [/ngày kia|ngày mốt/, 2, 'ngày kia'],
    ];
    for (const [re, offset, label] of relative) {
      if (re.test(lower)) notes.push(`Ngày khách nói "${label}" = ${describeDate(addDaysISO(todayISO, offset))}.`);
    }
    const dm = lower.match(/(?<![\d/])(\d{1,2})\s*[/.-]\s*(\d{1,2})(?:\s*[/.-]\s*(\d{2,4}))?(?![\d/])/)
      || lower.match(/ngày\s*(\d{1,2})\s*tháng\s*(\d{1,2})(?:\s*(?:năm)?\s*(\d{4}))?/);
    if (dm) {
      const d = Number(dm[1]);
      const mo = Number(dm[2]);
      let y = dm[3] ? Number(dm[3]) : year;
      if (dm[3] && dm[3].length === 2) y += 2000;
      const dt = new Date(Date.UTC(y, mo - 1, d));
      const real = dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
      if (!real) {
        notes.push(`Ngày "${dm[0].trim()}": KHÔNG TỒN TẠI trên lịch — hỏi lại khách ngày khám.`);
      } else {
        const iso = `${y}-${pad(mo)}-${pad(d)}`;
        notes.push(iso < todayISO
          ? `Ngày "${dm[0].trim()}" = ${describeDate(iso)}: ĐÃ QUA (hôm nay là ${todayISO}) — không đặt được, hỏi lại khách.`
          : `Ngày "${dm[0].trim()}" = ${describeDate(iso)}${new Date(iso + 'T00:00:00Z').getUTCDay() === 0 ? ' — là CHỦ NHẬT (khám theo hẹn trước, cần bác sĩ đồng ý)' : ''}.`);
      }
    }
  }

  // ---- Giờ ----
  const tm = lower.match(/(?<!\d)(\d{1,2})\s*(?:giờ|h(?![\p{L}])|:)\s*(\d{1,2})?/u);
  if (tm) {
    let hour = Number(tm[1]);
    const minute = tm[2] !== undefined ? Number(tm[2]) : 0;
    const pm = /chiều|tối/.test(lower);
    if (pm && hour >= 1 && hour <= 11) hour += 12;
    const total = hour * 60 + minute;
    const label = `${pad(hour)}:${pad(minute)}`;
    if (hour > 23 || minute > 59) {
      notes.push(`Giờ "${tm[0].trim()}": KHÔNG HỢP LỆ — hỏi lại khách.`);
    } else if (total < OPEN_MIN || total > LAST_SLOT_MIN) {
      notes.push(`Giờ ${label}: NGOÀI giờ khám (chỉ nhận 07:00-20:30) — mời khách chọn giờ khác.`);
    } else if (minute % 30 !== 0) {
      notes.push(`Giờ ${label}: không phải mốc hợp lệ (mỗi khung 30 phút: xx:00 hoặc xx:30) — đề nghị khách chọn ${pad(hour)}:00 hoặc ${pad(hour)}:30.`);
    } else {
      notes.push(`Giờ khách nói = ${label} (hợp lệ, cần check_available_slots để xem còn trống không).`);
    }
  }

  return notes;
}

module.exports = { analyzeMessage, isBlankMessage };
