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
    // "mai"/"mốt" đứng riêng (vd trả lời cụt "mai", hoặc "9h sáng mai") cũng phải bắt được —
    // nhưng không bắt chữ "Mai" trong họ tên ("Nguyễn Thị Mai"), nên chỉ nhận khi đi sau
    // ngày/sáng/trưa/chiều/tối/hôm hoặc khi cả tin nhắn chỉ có đúng 1 từ đó.
    const relative = [
      [/hôm nay|(?:sáng|trưa|chiều|tối) nay/, 0, 'hôm nay'],
      [/(?:ngày|sáng|trưa|chiều|tối|hôm) mai|hôm sau|^\s*mai\s*[.!?]*\s*$/, 1, 'ngày mai'],
      [/ngày kia|(?:ngày|sáng|trưa|chiều|tối|hôm) mốt|^\s*mốt\s*[.!?]*\s*$/, 2, 'ngày kia'],
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

// Khớp nguyên từ tiếng Việt (\b của JS không hiểu chữ có dấu: "bé" trong "bé gái" không khớp).
const words = (...alts) => new RegExp(`(?<!\\p{L})(?:${alts.join('|')})(?!\\p{L})`, 'gu');

// [chuyên khoa, từ khoá]. Nhi khoa và Sản phụ khoa xét trước: quyết định bởi NGƯỜI khám (trẻ em,
// người mang thai) chứ không bởi triệu chứng. Các khoa còn lại chấm theo số từ khoá khớp; bằng
// điểm thì khoa đứng trước thắng — Nội tổng quát để cuối vì triệu chứng của nó chung chung nhất
// ("đau họng và sốt" → Tai – Mũi – Họng, không phải Nội). Model nhỏ hay gợi ý sai khoa (đã gặp:
// "đau họng" → "Nhi khoa"), nên phần này tính sẵn rồi đưa vào prompt như dữ kiện.
const PERSON_RULES = [
  ['Nhi khoa', words('con (?:tôi|mình|em|nhà tôi|nhà mình)', 'bé', 'cháu', 'trẻ', 'em bé', 'sơ sinh', 'khoa nhi', 'nhi khoa', '\\d{1,2} tháng tuổi')],
  ['Sản phụ khoa', words('mang thai', 'có thai', 'có bầu', 'bầu', 'thai', 'khám thai', 'kinh nguyệt', 'trễ kinh', 'chậm kinh', 'rong kinh', 'đau bụng kinh', 'khí hư', 'phụ khoa', 'sản khoa', 'sản phụ khoa', 'âm đạo')],
];
const SYMPTOM_RULES = [
  ['Răng – Hàm – Mặt', words('răng', 'nướu', 'nha khoa', 'hôi miệng', '(?:sưng|viêm|chảy máu|tụt) lợi', 'quai hàm', 'hàm (?:trên|dưới)', 'niềng')],
  ['Tai – Mũi – Họng', words('họng', 'amidan', 'amiđan', 'tai(?! nạn| biến)', 'mũi', 'xoang', 'khàn tiếng', 'mất tiếng', 'chảy máu cam', 'tai mũi họng')],
  ['Da liễu', words('ngứa', 'mụn', 'mẩn', 'nổi mẩn', 'phát ban', 'mề đay', 'nấm', 'vảy nến', 'chàm', 'rụng tóc', 'lang ben', 'zona', 'da liễu', '(?:trên|ngoài|ở) da', 'da (?:mặt|tay|chân|đầu|bị)')],
  ['Nội tổng quát', words('sốt', 'ho', 'đau bụng', 'tiêu chảy', 'đau đầu', 'chóng mặt', 'huyết áp', 'tiểu đường', 'đường huyết', 'mỡ máu', 'mệt mỏi', 'dạ dày', 'khó tiêu', 'buồn nôn', 'nôn', 'táo bón', 'cảm cúm', 'cúm', 'bị cảm', 'cảm lạnh', 'khám sức khỏe', 'khám sức khoẻ', 'khám tổng quát', 'nội khoa', 'nội tổng quát', 'tim', 'gan', 'sỏi thận', 'đau thận')],
];

// Trả về { specialty, keywords } hoặc null nếu tin nhắn không nhắc triệu chứng/chuyên khoa nào.
function detectSpecialty(message) {
  const lower = String(message || '').toLowerCase();
  const matches = (re) => [...new Set([...lower.matchAll(re)].map((m) => m[0]))];
  for (const [specialty, re] of PERSON_RULES) {
    const keywords = matches(re);
    if (keywords.length) return { specialty, keywords };
  }
  let best = null;
  for (const [specialty, re] of SYMPTOM_RULES) {
    const keywords = matches(re);
    if (keywords.length && (!best || keywords.length > best.keywords.length)) best = { specialty, keywords };
  }
  return best;
}

const EMERGENCY_RE = words('khó thở', 'đau ngực', 'tức ngực', 'bất tỉnh', 'ngất', 'co giật', 'chảy máu nhiều', 'nôn ra máu', 'đột quỵ', 'méo miệng', 'liệt', 'ngừng thở', 'tím tái', 'lơ mơ');

// Dấu hiệu có thể cấp cứu — trả về các từ khớp (mảng rỗng nếu không có).
function detectEmergency(message) {
  return [...new Set([...String(message || '').toLowerCase().matchAll(EMERGENCY_RE)].map((m) => m[0]))];
}

const WEEKDAY_WORDS = { '2': 1, hai: 1, '3': 2, ba: 2, '4': 3, 'tư': 3, '5': 4, 'năm': 4, '6': 5, 'sáu': 5, '7': 6, 'bảy': 6 };
const SLOT_INTENT_RE = /trống|rảnh|còn (?:giờ|lịch|chỗ|slot)|giờ nào|khung giờ|lịch khám (?:nào|ngày|tuần|hôm)|(?:check|kiểm tra|xem) lịch|còn lịch/;
// "Lịch của tôi", "tôi đã đặt"… là hỏi lịch hẹn của chính khách (công cụ my_appointments), không phải lịch trống.
const OWN_APPOINTMENT_RE = /lịch(?: hẹn| khám)? của (?:tôi|mình|em)|(?:tôi|mình|em) đã đặt/;

// Khách hỏi lịch trống? Trả về { dates: ['YYYY-MM-DD', ...] } (tối đa 6 ngày, bỏ Chủ nhật trừ khi
// hỏi đúng Chủ nhật) hoặc null. Không nói ngày thì lấy 3 ngày khám gần nhất kể từ hôm nay.
// Model nhỏ hay chỉ hứa "mình sẽ kiểm tra rồi báo lại" mà không gọi công cụ — code tra sẵn thay nó.
function detectSlotQuery(message, todayISO) {
  const lower = String(message || '').toLowerCase();
  if (!SLOT_INTENT_RE.test(lower) || OWN_APPOINTMENT_RE.test(lower)) return null;

  const todayDow = new Date(todayISO + 'T00:00:00Z').getUTCDay();
  const nextWeek = /tuần (?:sau|tới)/.test(lower);
  const openDaysFrom = (startISO, endISO) => {
    const out = [];
    for (let iso = startISO; iso <= endISO; iso = addDaysISO(iso, 1)) {
      if (new Date(iso + 'T00:00:00Z').getUTCDay() !== 0) out.push(iso);
    }
    return out;
  };
  // Thứ Hai của tuần chứa hôm nay (tuần tính từ Thứ Hai tới Chủ nhật).
  const mondayISO = addDaysISO(todayISO, -((todayDow + 6) % 7));

  let dates = [];
  const wd = lower.match(/thứ\s*(2|3|4|5|6|7|hai|ba|tư|năm|sáu|bảy)(?!\p{L})|chủ nhật/u);
  if (wd) {
    const target = wd[0] === 'chủ nhật' ? 7 : WEEKDAY_WORDS[wd[1]];
    let iso = addDaysISO(mondayISO, target - 1 + (nextWeek ? 7 : 0));
    if (iso < todayISO) iso = addDaysISO(iso, 7);
    dates = [iso];
  } else if (/tuần này/.test(lower)) {
    dates = openDaysFrom(todayISO, addDaysISO(mondayISO, 5));
  } else if (nextWeek) {
    dates = openDaysFrom(addDaysISO(mondayISO, 7), addDaysISO(mondayISO, 12));
  } else {
    const dm = lower.match(/(?<![\d/])(\d{1,2})\s*[/.-]\s*(\d{1,2})(?![\d/])/);
    if (dm) {
      const iso = `${todayISO.slice(0, 4)}-${pad(Number(dm[2]))}-${pad(Number(dm[1]))}`;
      if (!Number.isNaN(new Date(iso + 'T00:00:00Z').getTime()) && iso >= todayISO) dates = [iso];
    } else if (/ngày kia|(?:ngày|hôm) mốt/.test(lower)) {
      dates = [addDaysISO(todayISO, 2)];
    } else if (/(?:ngày|sáng|trưa|chiều|tối|hôm) mai|(?<!\p{L})mai(?!\p{L})/u.test(lower)) {
      dates = [addDaysISO(todayISO, 1)];
    } else if (/hôm nay|(?:sáng|trưa|chiều|tối) nay/.test(lower)) {
      dates = [todayISO];
    } else {
      dates = openDaysFrom(todayISO, addDaysISO(todayISO, 6)).slice(0, 3);
    }
  }
  return { dates: dates.slice(0, 6) };
}

// Bảng ngày + thứ của 2 tuần tới, đưa thẳng vào system prompt: model (nhất là model nhỏ chạy
// trên máy) hay tính sai "thứ 6 tuần này"/"mai" ra ngày và thứ — tra bảng thì không sai được.
function upcomingDaysNote(todayISO, days = 14) {
  const lines = [];
  for (let i = 0; i < days; i++) {
    const iso = addDaysISO(todayISO, i);
    const label = i === 0 ? ' — HÔM NAY' : i === 1 ? ' — ngày mai' : i === 2 ? ' — ngày kia' : '';
    lines.push(`- ${describeDate(iso)}${label}`);
  }
  return ['Lịch các ngày tới (dùng bảng này để quy đổi "mai", "thứ 6 tuần này"... ra ngày cụ thể, KHÔNG tự tính):', ...lines].join('\n');
}

module.exports = {
  analyzeMessage,
  isBlankMessage,
  upcomingDaysNote,
  describeDate,
  detectSpecialty,
  detectEmergency,
  detectSlotQuery,
};
