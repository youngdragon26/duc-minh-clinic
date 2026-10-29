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

// ---------- Chuẩn hoá tin nhắn gõ sai ----------
// Đo thật: gõ không dấu ("dau hong") làm cả 3 tầng hiểu sai — RAG ra tài liệu Răng – Hàm – Mặt,
// detectSpecialty chỉ khớp được chữ "ho" (→ Nội), model đọc "noi man do va ngua" thành "màn hình".
const stripAccents = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');

// Viết tắt/teencode và lỗi gõ hay gặp → từ đầy đủ. Không đưa vào các từ hai nghĩa (vd "hog" vừa là
// "không" vừa có thể là "họng", "kg" là ki-lô-gam).
const SHORTHAND = {
  ko: 'không', k: 'không', kh: 'không', hok: 'không', khog: 'không', 'khôg': 'không', 'khôgn': 'không', 'kô': 'không',
  vs: 'với', dc: 'được', 'đc': 'được', 'đươc': 'được', 'dươc': 'được', 'bít': 'biết', bik: 'biết', j: 'gì', z: 'vậy',
  ntn: 'như thế nào', bn: 'bao nhiêu', r: 'rồi', oy: 'rồi', cx: 'cũng', cg: 'cũng', trc: 'trước', mk: 'mình', mik: 'mình',
  e: 'em', bs: 'bác sĩ', pk: 'phòng khám', sdt: 'số điện thoại', 'sđt': 'số điện thoại', ng: 'người',
  'phỉa': 'phải', phai: 'phải', 'trả lười': 'trả lời', 'tl': 'trả lời',
  h: 'giờ', t2: 'thứ 2', t3: 'thứ 3', t4: 'thứ 4', t5: 'thứ 5', t6: 'thứ 6', t7: 'thứ 7', cn: 'chủ nhật',
  'bao nhiu': 'bao nhiêu', nhiu: 'nhiêu', 'bnhiu': 'bao nhiêu',
};

// Cụm từ không dấu → có dấu, chỉ áp dụng khi cả tin nhắn gần như không có dấu. Ưu tiên cụm dài
// ("dau hong" → "đau họng") vì 1 từ không dấu lẻ thường nhiều nghĩa ("hong": họng/không/hồng).
const ACCENT_PHRASES = {
  toi: 'tôi', minh: 'mình', ban: 'bạn', chau: 'cháu', 'con toi': 'con tôi', 'con minh': 'con mình', 'be nha': 'bé nhà',
  bi: 'bị', va: 'và', voi: 'với', cua: 'của', khong: 'không', co: 'có', nen: 'nên', nao: 'nào', gi: 'gì', la: 'là', ten: 'tên',
  'the nao': 'thế nào', 'bao nhieu': 'bao nhiêu', 'bao lau': 'bao lâu', duoc: 'được', can: 'cần', muon: 'muốn',
  hoi: 'hỏi', 'cho hoi': 'cho hỏi', giup: 'giúp', qua: 'quá', nhieu: 'nhiều', nhe: 'nhẹ', lau: 'lâu', roi: 'rồi', chua: 'chưa',
  'xin chao': 'xin chào', 'cam on': 'cảm ơn', 'mo cua': 'mở cửa', 'dong cua': 'đóng cửa', 'lam viec': 'làm việc',
  may: 'mấy', 'nhuc dau': 'nhức đầu', 'te bi': 'tê bì', 'kho nuot': 'khó nuốt', 'o chua': 'ợ chua',
  // Tên chuyên khoa gõ không dấu ("khoa rang": "rang" đứng riêng có thể là răng/ràng).
  'khoa rang': 'khoa răng', 'kham rang': 'khám răng', 'rang ham mat': 'răng hàm mặt', 'da lieu': 'da liễu',
  'tai mui hong': 'tai mũi họng', 'noi tong quat': 'nội tổng quát', 'san phu khoa': 'sản phụ khoa', 'khoa san': 'khoa sản',
  'kham san': 'khám sản', 'khoa noi': 'khoa nội', 'kham noi': 'khám nội', 'ca nguoi': 'cả người', 'toan than': 'toàn thân',
  // "rang" lẻ: trong ngữ cảnh phòng khám gần như luôn là "răng" ("gia kham rang bao nhieu"); "ro rang" vẫn là "rõ ràng".
  rang: 'răng', 'ro rang': 'rõ ràng', 'con khong': 'còn không', 'o ron': 'ở rốn', 'quanh ron': 'quanh rốn', 'tu toi qua': 'từ tối qua', 'phu khoa': 'phụ khoa', 'kham da': 'khám da',
  ngay: 'ngày', 'hom nay': 'hôm nay', 'ngay mai': 'ngày mai', 'hom qua': 'hôm qua', 'tuan nay': 'tuần này',
  'tuan sau': 'tuần sau', 'tuan toi': 'tuần tới', 'thu hai': 'thứ hai', 'thu ba': 'thứ ba', 'thu tu': 'thứ tư',
  'thu nam': 'thứ năm', 'thu sau': 'thứ sáu', 'thu bay': 'thứ bảy', 'chu nhat': 'chủ nhật', sang: 'sáng', chieu: 'chiều',
  gio: 'giờ', 'may gio': 'mấy giờ', 'may ngay': 'mấy ngày', 'may hom': 'mấy hôm', thang: 'tháng', tuoi: 'tuổi', 'thang tuoi': 'tháng tuổi',
  lich: 'lịch', 'lich kham': 'lịch khám', 'lich trong': 'lịch trống', 'con trong': 'còn trống', 'con lich': 'còn lịch',
  'con gio': 'còn giờ', 'trong khong': 'trống không', 'dat lich': 'đặt lịch', kham: 'khám', 'kham benh': 'khám bệnh',
  'chuyen khoa': 'chuyên khoa', 'bac si': 'bác sĩ', 'phong kham': 'phòng khám', gia: 'giá', 'gia kham': 'giá khám',
  'gio lam viec': 'giờ làm việc', 'dia chi': 'địa chỉ', 'o dau': 'ở đâu', thuoc: 'thuốc', 'khang sinh': 'kháng sinh', uong: 'uống',
  dau: 'đau', 'dau hong': 'đau họng', 'viem hong': 'viêm họng', 'rat hong': 'rát họng', 'ho khan': 'ho khan',
  'ho co dom': 'ho có đờm', sot: 'sốt', 'sot cao': 'sốt cao', 'sot nhe': 'sốt nhẹ', 'so mui': 'sổ mũi', 'nghet mui': 'nghẹt mũi',
  mui: 'mũi', 'dau tai': 'đau tai', 'u tai': 'ù tai', 'chay mu tai': 'chảy mủ tai', 'viem xoang': 'viêm xoang', 'khan tieng': 'khàn tiếng',
  'dau rang': 'đau răng', 'sau rang': 'sâu răng', 'nho rang': 'nhổ răng', 'sung loi': 'sưng lợi', 'viem loi': 'viêm lợi',
  'chay mau chan rang': 'chảy máu chân răng', ngua: 'ngứa', 'noi man': 'nổi mẩn', 'man do': 'mẩn đỏ', 'phat ban': 'phát ban',
  mun: 'mụn', 'me day': 'mề đay', 'di ung': 'dị ứng', 'rung toc': 'rụng tóc', 'dau bung': 'đau bụng', 'tieu chay': 'tiêu chảy',
  'dau dau': 'đau đầu', 'chong mat': 'chóng mặt', 'buon non': 'buồn nôn', non: 'nôn', 'met moi': 'mệt mỏi', met: 'mệt',
  'khong khoe': 'không khỏe', 'kho tho': 'khó thở', 'dau nguc': 'đau ngực', 'tuc nguc': 'tức ngực', ngat: 'ngất',
  'bat tinh': 'bất tỉnh', 'co giat': 'co giật', 'huyet ap': 'huyết áp', 'tieu duong': 'tiểu đường', 'da day': 'dạ dày',
  'kho tieu': 'khó tiêu', 'tao bon': 'táo bón', 'cam cum': 'cảm cúm', 'dau lung': 'đau lưng', 'dau khop': 'đau khớp',
  'mang thai': 'mang thai', 'co thai': 'có thai', 'co bau': 'có bầu', 'kham thai': 'khám thai', 'kinh nguyet': 'kinh nguyệt',
  'tre kinh': 'trễ kinh', 'tre em': 'trẻ em', tre: 'trẻ', 'em be': 'em bé', be: 'bé', 'so sinh': 'sơ sinh', nu: 'nữ',
};
const shorthandRe = new RegExp(`(?<![\\p{L}\\d])(?:${Object.keys(SHORTHAND).sort((a, b) => b.length - a.length).join('|')})(?![\\p{L}\\d])`, 'giu');
const accentRe = new RegExp(`(?<!\\p{L})(?:${Object.keys(ACCENT_PHRASES).sort((a, b) => b.length - a.length).join('|')})(?!\\p{L})`, 'gu');
// Cụm NHIỀU chữ còn được thêm dấu cả trong tin gõ lẫn có dấu/không dấu ("đau hongggg" → "đau họng"): mỗi
// chữ của cụm khớp dạng không dấu hoặc dạng đúng. Chữ lẻ ("hong") thì không — quá nhiều nghĩa. Bỏ cụm có
// "trong" (trong/trống): "trong không khí" không được thành "trống không khí".
const MIXED_PHRASES = Object.entries(ACCENT_PHRASES).filter(([k]) => k.includes(' ') && !/\btrong\b/.test(k))
  .map(([k, v]) => {
    const kw = k.split(' ');
    const vw = v.split(' ');
    return [new RegExp(`(?<!\\p{L})${kw.map((w, i) => `(?:${w}|${vw[i]})`).join(' ')}(?!\\p{L})`, 'giu'), v];
  });

// Chữ cái lặp do gõ: chuỗi ≥3 chữ cùng gốc ("haaay") trong từ, hoặc ≥2 ở cuối từ ("họngg", "bịi").
// Không gộp "ưu" cuối từ ("hưu", "cừu") — đó là vần thật chứ không phải gõ lặp.
function collapseRepeats(word) {
  const chars = [...word];
  const out = [];
  for (let i = 0; i < chars.length; i++) {
    let j = i;
    while (j + 1 < chars.length && stripAccents(chars[j + 1]).toLowerCase() === stripAccents(chars[i]).toLowerCase()) j++;
    const run = j - i + 1;
    const atEnd = j === chars.length - 1;
    // Chữ ư (cả ừ, ữ…) mang dấu móc U+031B — stripAccents cũng bỏ dấu móc nên phải xét riêng.
    const realVowel = run === 2 && chars[i].normalize('NFD').includes('̛');
    if (run >= 3 || (run === 2 && atEnd && !realVowel)) {
      // Giữ chữ mang dấu (vd "bịi" → "bị") nếu có, không thì giữ chữ đầu.
      out.push(chars.slice(i, j + 1).find((c) => stripAccents(c) !== c) || chars[i]);
    } else {
      out.push(...chars.slice(i, j + 1));
    }
    i = j;
  }
  return out.join('');
}

// Trả về { text, changed }: text là bản đã chuẩn hoá để đưa cho RAG, các bước nhận diện và model.
function normalizeMessage(message) {
  const original = String(message || '');
  let text = original.replace(/\p{L}+/gu, collapseRepeats);
  // Đếm tỉ lệ chữ có dấu TRƯỚC khi đổi viết tắt — "pk mo cua may h" sau khi đổi "pk" thành "phòng khám"
  // sẽ có dấu và bị bỏ qua bước thêm dấu cho phần còn lại.
  const letters = text.match(/\p{L}/gu) || [];
  const accented = letters.filter((c) => stripAccents(c) !== c).length;
  text = text.replace(shorthandRe, (m) => SHORTHAND[m.toLowerCase()] || m);
  if (letters.length >= 6 && accented / letters.length < 0.03) {
    text = text.toLowerCase().replace(accentRe, (m) => ACCENT_PHRASES[m]);
  } else {
    for (const [re, value] of MIXED_PHRASES) text = text.replace(re, value);
  }
  return { text, changed: text !== original };
}

// [chuyên khoa, từ khoá]. Nhi khoa và Sản phụ khoa xét trước: quyết định bởi NGƯỜI khám (trẻ em,
// người mang thai) chứ không bởi triệu chứng. Các khoa còn lại chấm theo số từ khoá khớp; bằng
// điểm thì khoa đứng trước thắng — Nội tổng quát để cuối vì triệu chứng của nó chung chung nhất
// ("đau họng và sốt" → Tai – Mũi – Họng, không phải Nội). Model nhỏ hay gợi ý sai khoa (đã gặp:
// "đau họng" → "Nhi khoa"), nên phần này tính sẵn rồi đưa vào prompt như dữ kiện.
const PERSON_RULES = [
  ['Nhi khoa', words('con (?:tôi|mình|em|nhà tôi|nhà mình)', 'con (?:trai|gái)', 'thằng cu', 'cu (?:nhà|con)', 'đứa (?:nhỏ|bé|con)', 'con nhỏ',
    'bé', 'cháu', 'trẻ', 'em bé', 'sơ sinh', 'nhi', '\\d{1,2} tháng tuổi')],
  ['Sản phụ khoa', words('mang thai', 'có thai', 'có bầu', 'bầu', 'thai', 'khám thai', 'kinh nguyệt', 'trễ kinh', 'chậm kinh', 'rong kinh', 'đau bụng kinh', 'hành kinh', 'chu kỳ kinh', 'nghén', 'khí hư', 'vùng kín', 'phụ khoa', 'sản khoa', 'sản phụ khoa', 'khoa sản', 'khám sản', 'âm đạo')],
];
const SYMPTOM_RULES = [
  ['Răng – Hàm – Mặt', words('răng', 'nướu', 'nha khoa', 'hôi miệng', '(?:sưng|viêm|chảy máu|tụt) lợi', 'quai hàm', 'hàm (?:trên|dưới)', 'niềng',
    'nhiệt miệng', 'lở miệng', 'loét miệng', 'lưỡi', 'khớp hàm', 'hàm (?:kêu|đau)')],
  ['Tai – Mũi – Họng', words('họng', 'amidan', 'amiđan', 'tai(?! nạn| biến)', 'mũi', 'xoang', 'khàn tiếng', 'mất tiếng', 'chảy máu cam', 'tai mũi họng', 'khó nuốt', 'nuốt (?:đau|vướng)',
    'điếc', 'nghe kém', 'ngáy', 'hắt hơi')],
  ['Da liễu', words('ngứa', 'mụn', 'mẩn', 'nổi mẩn', 'phát ban', 'mề đay', 'nấm', 'vảy nến', 'chàm', 'rụng tóc', 'lang ben', 'zona', 'dị ứng', 'da liễu', '(?:trên|ngoài|ở) da', 'da (?:mặt|tay|chân|đầu|bị|khô)',
    'nám', 'sạm da', 'rạn da', 'hôi nách', 'mụn cóc', 'tóc (?:gãy|rụng)', 'khám da', 'khoa da')],
  ['Nội tổng quát', words('sốt', 'ho', 'đau bụng', 'tiêu chảy', 'đau đầu', 'nhức đầu', 'chóng mặt', 'huyết áp', 'tiểu đường', 'đường huyết', 'mỡ máu', 'mệt mỏi', 'dạ dày', 'khó tiêu', 'ợ chua', 'trào ngược', 'thượng vị', 'buồn nôn', 'nôn', 'táo bón', 'cảm cúm', 'cúm', 'bị cảm', 'cảm lạnh', 'khám sức khỏe', 'khám sức khoẻ', 'khám tổng quát', 'nội khoa', 'nội tổng quát', 'khoa nội', 'khám nội', 'tim', 'gan', 'sỏi thận', 'đau thận',
    'hay quên', 'trí nhớ', 'sụt cân', 'thiếu máu', 'covid', 'cúm a',
    // Cách nói đảo trật tự / dân dã (đo thật vòng 6: "bụng đau", "đau quặn vùng rốn", "đầy bụng" không nhận ra).
    'bụng (?:đau|chướng)', 'đầu (?:đau|nhức)', 'đau quặn', '(?:quanh|vùng|ở) rốn', 'đầy bụng', 'chướng bụng', 'ợ hơi',
    'đi ngoài', 'phân lỏng', 'ớn lạnh', 'lúc nóng lúc lạnh', 'khát nước', 'phù (?:chân|mặt|người)', 'đánh trống ngực', 'hồi hộp', 'vàng da', 'phân đen', 'rét run',
    // Phòng khám không có khoa Nam học — Nội tổng quát khám ban đầu.
    'tinh hoàn', 'xuất tinh', 'cương dương',
    // Phòng khám không có khoa Cơ xương khớp, Tiết niệu, Hậu môn – trực tràng — các triệu chứng này
    // do Nội tổng quát khám ban đầu.
    'đau (?:lưng|khớp|vai|gáy|cổ|gối|chân|tay)', 'tê (?:tay|chân|bì)', 'gout', 'gút', 'tiểu (?:buốt|rắt|ra máu|nhiều|đêm)',
    'trĩ', 'mất ngủ', 'khó ngủ', 'đau nửa đầu')],
];

// "dị ứng (thuốc) kháng sinh" là khai tiền sử dị ứng, không phải hỏi mua kháng sinh (đo thật vòng 5).
const PRESCRIPTION_RE = words('(?<!dị ứng )(?<!dị ứng thuốc )kháng sinh', 'kê đơn', 'thuốc kê đơn', 'corticoid', 'thuốc ngủ', 'thuốc an thần');
// "bệnh nhân", "bệnh viện", "khám có đau không" không phải than ốm (đo thật vòng 5).
const VAGUE_RE = words('(?<!có )đau(?! không)', 'mệt', 'mệt mỏi', 'không khỏe', 'không khoẻ', 'khó chịu', 'ốm', 'bệnh(?! nhân| viện| án)');
// "vàng da vàng mắt" là bệnh gan/mật (Nội), không phải bệnh mắt.
const EYE_RE = words('(?<!vàng )mắt', 'cận thị', 'loạn thị', 'viễn thị');

// Regex của words() có cờ g nên .test() nhớ vị trí lần trước — dùng hàm này thay vì gọi .test() trực tiếp.
const has = (re, message) => {
  re.lastIndex = 0;
  return re.test(String(message || '').toLowerCase());
};

// Hỏi về kháng sinh/thuốc kê đơn — đo thật: model hiểu sai "uống kháng sinh gì để hết viêm họng" và
// đòi thông tin đặt lịch thay vì nói rõ không được tự dùng kháng sinh.
const detectPrescriptionQuestion = (message) => has(PRESCRIPTION_RE, message);

// Than đau/mệt chung chung, không nói rõ chỗ nào ("đau quá", "tôi thấy không khỏe") — phải hỏi lại
// triệu chứng chứ chưa đòi thông tin đặt lịch (model nhỏ hay đòi luôn số điện thoại, tuổi).
const isVagueComplaint = (message) => has(VAGUE_RE, message) && !detectSpecialty(message) && !has(EYE_RE, message);

// Phòng khám không có chuyên khoa Mắt.
const mentionsEye = (message) => has(EYE_RE, message);

// Yêu cầu rõ ràng ngoài phạm vi phòng khám. Đo thật: dù prompt cấm, model nhỏ vẫn làm thơ, giải toán.
// Chỉ liệt kê mẫu chắc chắn (phép tính phải có số — "bệnh nhân" không bị bắt nhầm thành phép nhân;
// không dùng / : - x vì trùng ngày "5/11", giờ "9:30", số điện thoại "0912-345").
// Hai loại: NHIỆM VỤ ngoài phạm vi (làm thơ, dịch, viết code…) luôn từ chối kể cả khi câu có nhắc triệu
// chứng (đo thật: "dịch sang tiếng Anh: tôi bị đau đầu" → model dịch luôn); CHỦ ĐỀ ngoài phạm vi (thời tiết,
// giá vàng…) chỉ từ chối khi câu không nói gì về sức khỏe ("dị ứng thời tiết" là câu hỏi da liễu).
const OFF_TOPIC_TASK_RE = words(
  '(?:làm|viết|sáng tác) (?:\\p{L}+ )?(?:bài )?thơ', 'bài thơ', 'kể (?:\\p{L}+ ){0,4}(?:chuyện|truyện)',
  'viết (?:giùm|giúp|hộ|cho)?(?: \\p{L}+)? ?(?:bài|văn|truyện|email|thư|đơn|code)', 'code (?:python|java|js)', 'lập trình',
  'giải (?:\\p{L}+ )?(?:bài )?(?:toán|phương trình)', 'phương trình', 'dịch (?:sang|giúp|câu)', 'công thức nấu', 'tóm tắt'
);
const OFF_TOPIC_SUBJECT_RE = words(
  '(?<!ứng )thời tiết', 'trời (?:có )?(?:mưa|nắng)', 'giá (?:vàng|xăng|dầu|đô|usd|bitcoin|cổ phiếu|chứng khoán)',
  'bóng đá', 'world cup', 'xổ số', 'lô đề', 'nấu (?:món|ăn)', 'tin tức', 'âm lịch',
  // Rủ rê / tán tỉnh — model từng đáp cộc "Bạn đang nói gì vậy?".
  'đi chơi', 'hẹn hò', 'làm người yêu', 'kết bạn', 'đi cà phê', 'đi ăn'
);
const ARITHMETIC_RE = /\d+\s*(?:[+*×]|nhân|chia|cộng|trừ)\s*\d+/i;
const detectOffTopicTask = (message) => has(OFF_TOPIC_TASK_RE, message) || ARITHMETIC_RE.test(String(message || ''));
const detectOffTopic = (message) => detectOffTopicTask(message) || has(OFF_TOPIC_SUBJECT_RE, message);

// Ý nghĩ tự sát/tự hại — đo thật: model trả lời lẫn tiếng Anh ("Tôi rất sorry") và đưa hotline phòng khám.
// Luôn trả lời cố định, ở mọi chế độ.
const CRISIS_RE = words('tự tử', 'tự sát', 'muốn chết', 'không muốn sống', 'tự làm hại', 'tự hại', 'kết liễu', 'kết thúc cuộc đời');
const detectCrisis = (message) => has(CRISIS_RE, message);

// Hỏi liều thuốc cụ thể — đo thật: model tự đưa liều paracetamol sai ("không quá 4 viên/ngày").
// Kèm hỏi chọn thuốc ("thuốc giảm đau nào tốt nhất", "mua thuốc gì để hết ngứa") — vòng 6 bị hiểu là than đau.
const DOSE_RE = words('mấy viên', 'bao nhiêu viên', 'liều(?: dùng| lượng)?', 'uống mấy lần', 'uống bao nhiêu', 'mấy gói', 'bao nhiêu ml',
  'thuốc (?:\\p{L}+ ){0,3}(?:nào|gì) (?:tốt|hiệu quả|nhanh)', '(?:mua|dùng|uống) thuốc gì', 'thuốc (?:\\p{L}+ ){0,2}loại nào');
const detectDoseQuestion = (message) => has(DOSE_RE, message);

// Hỏi dữ liệu của chính khách (đơn thuốc, hoá đơn, hồ sơ, lịch hẹn) — chỉ tra được khi đã đăng nhập.
// Đo thật: khách chưa đăng nhập hỏi "hoá đơn của tôi đã thanh toán chưa" → model bịa "bạn chưa thanh toán".
const OWN_DATA_RE = /(?:đơn thuốc|hoá đơn|hóa đơn|hồ sơ|kết quả (?:khám|xét nghiệm)|lịch(?: hẹn| khám)?|tái khám)[^.?!]{0,25}(?:của (?:tôi|mình|em)|lần trước|đã (?:thanh toán|trả)|gần nhất)|(?:tôi|mình|em) (?:đã (?:thanh toán|trả tiền|đặt lịch|khám)|có lịch (?:hẹn|khám))/i;
const detectOwnDataQuestion = (message) => OWN_DATA_RE.test(String(message || ''));

// Đòi dữ liệu người khác / thông tin nội bộ / lệnh ghi đè hướng dẫn (prompt injection). Đo thật vòng 5:
// "danh sách số điện thoại bệnh nhân" bị hiểu thành than ốm; "mật khẩu admin" trả lời vòng vo.
const PRIVACY_RE = /(?:danh sách|thông tin|số điện thoại|sđt|địa chỉ|dữ liệu|hồ sơ)[^.?!]{0,25}(?:bệnh nhân|khách hàng|người khác|của người)|mật khẩu|password|system prompt|prompt (?:của bạn|hệ thống)|hướng dẫn (?:hệ thống|trước đó)|(?:toàn bộ|tất cả) dữ liệu|bỏ qua (?:mọi|tất cả|các) (?:hướng dẫn|quy tắc)|ignore (?:previous|all|the)/i;
const detectPrivacyRequest = (message) => PRIVACY_RE.test(String(message || ''));

const INSULT_RE = words('ngu', 'vô dụng', 'như cc', 'cc', 'đm', 'dm', 'đmm', 'vcl', 'vkl', 'đéo', 'dở hơi', 'chán bot', 'bot (?:dở|ngu|tệ|lởm)', 'lởm');
const detectInsult = (message) => has(INSULT_RE, message);

// Tin viết bằng tiếng Anh (chỉ ký tự ASCII, có từ tiếng Anh thông dụng, ≥3 từ).
const detectEnglish = (message) => {
  const s = String(message || '').trim();
  return /^[\x00-\x7F]+$/.test(s) && s.split(/\s+/).length >= 3 && /\b(?:i|you|the|is|are|have|what|which|how|do|does|can|my|a)\b/i.test(s);
};

// Hỏi giá: trả về { list: true } (bảng giá / so sánh các khoa) hoặc { discount: 'bhyt'|'sinh_vien'|null } hoặc null.
const PRICE_RE = /giá|bao nhiêu tiền|hết bao nhiêu|trả bao nhiêu|còn bao nhiêu|chi phí|tốn bao nhiêu|đắt|rẻ|phí khám/;
function detectPriceQuestion(message) {
  const lower = String(message || '').toLowerCase();
  if (!PRICE_RE.test(lower) || /giá (?:vàng|xăng|dầu|đô|usd)/.test(lower) || /giá thuốc/.test(lower)) return null;
  if (/bảng giá|các (?:chuyên )?khoa|từng (?:chuyên )?khoa|đắt hơn|rẻ hơn|rẻ nhất|đắt nhất|so với/.test(lower)) return { list: true };
  const discount = /bhyt|bảo hiểm/.test(lower) ? 'bhyt' : /sinh viên/.test(lower) ? 'sinh_vien' : null;
  // "Có giảm giá cho sinh viên không" hỏi CHÍNH SÁCH giảm giá, không hỏi số tiền phải trả.
  if (/giảm/.test(lower) && !/bao nhiêu tiền|hết bao nhiêu|trả bao nhiêu|còn bao nhiêu|giá khám/.test(lower)) return { policy: true, discount };
  return { list: false, discount };
}

// Hỏi tiện ích/liên hệ — trả về loại: 'address' | 'contact' | 'feedback' | 'unknown' (chưa có thông tin) | null.
// Đo thật vòng 5: model nói "không thể cung cấp địa chỉ" (có sẵn), bịa "đang tuyển dụng", "không có bãi đỗ ô tô".
function detectFacilityInfo(message) {
  const lower = String(message || '').toLowerCase();
  if (/chỉ đường|đường đi|bản đồ|google map|đến phòng khám (?:thế nào|bằng cách nào)/.test(lower)) return 'address';
  // "viết giùm email xin nghỉ ốm" là nhờ viết hộ (ngoài phạm vi), không phải hỏi email phòng khám.
  if (/zalo|fanpage|facebook|(?<!viết (?:\p{L}+ )?)email|e-mail|website|liên hệ/u.test(lower)) return 'contact';
  if (/góp ý|khiếu nại|phản ánh|phàn nàn/.test(lower)) return 'feedback';
  if (/gửi xe|đỗ xe|đậu xe|bãi (?:xe|đỗ)|ô tô|thang máy|khuyết tật|xe lăn|atm|trả góp|tuyển dụng|việc làm|hợp tác|căng tin|nhà vệ sinh/.test(lower)) return 'unknown';
  return null;
}

// Hỏi trợ lý là ai/ai làm ra. Đo thật: kể cả có câu mẫu, model vẫn bịa "được tạo ra bởi đội ngũ kỹ
// thuật và thiết kế của phòng khám" ở 3/3 lần chạy.
const IDENTITY_RE = words(
  '(?:bạn|em|mày) là (?:ai|gì|người hay máy)', 'ai (?:tạo|làm|lập trình|phát triển|viết|xây dựng) ra (?:bạn|em|mày)',
  '(?:bạn|em|mày) do ai', '(?:bạn|em|mày) có phải (?:là )?(?:người|bác sĩ|robot|máy|ai|chatgpt)', '(?:bạn|em) tên (?:là )?gì',
  '(?:bạn|em) (?:có )?thông minh', '(?:bạn|em) (?:dùng|là) (?:chatgpt|gemini|gpt)',
  '(?:bạn|em) (?:có thể )?(?:giúp|hỗ trợ|làm) (?:được )?(?:gì|những gì)', '(?:ai|người nào) đang (?:trả lời|nói chuyện|chat)',
  '(?:bot|chatbot) (?:này )?là (?:gì|ai)'
);
const detectIdentityQuestion = (message) => has(IDENTITY_RE, message);

// Hỏi đánh giá/giới thiệu cơ sở y tế khác. Đo thật: model lúc có lúc không vẫn nêu tên bệnh viện, có lần
// bịa "Bệnh viện Đa khoa Đức Minh". Không bắt "phòng khám ở đâu" (đó là hỏi địa chỉ của chính phòng khám).
const OTHER_FACILITY_RE = words(
  'bệnh viện (?:\\p{L}+ ){0,4}(?:nào|tốt nhất|uy tín)', '(?:phòng khám|cơ sở(?: y tế)?) (?:nào|khác) (?:\\p{L}+ ){0,3}(?:tốt|uy tín)',
  'so sánh (?:\\p{L}+ ){0,3}(?:bệnh viện|phòng khám)', 'nên (?:đi )?(?:bệnh viện|viện) nào'
);
const detectOtherFacilityQuestion = (message) => has(OTHER_FACILITY_RE, message);

// Hỏi giờ/ngày làm việc chung ("thứ bảy có khám không", "trưa có nghỉ không") — vòng 6 model trả lời mơ hồ.
const HOURS_RE = /(?:thứ (?:2|3|4|5|6|7|hai|ba|tư|năm|sáu|bảy)|chủ nhật|buổi trưa|trưa|buổi tối|tối|mấy giờ)[^.?!]{0,25}(?:có )?(?:khám|làm việc|làm|mở cửa|nghỉ|đóng cửa)(?: không)?\s*[?!.]*$|giờ (?:làm việc|mở cửa|đóng cửa)/;
const detectHoursQuestion = (message) => HOURS_RE.test(String(message || '').toLowerCase());

// Hỏi lịch làm việc ngày lễ/Tết — phòng khám chưa cung cấp, đo thật model bịa "vẫn hoạt động bình thường".
const HOLIDAY_RE = words('tết', 'ngày lễ', 'nghỉ lễ', 'lễ (?:30/4|2/9|quốc khánh)', 'giỗ tổ');
const detectHolidayQuestion = (message) => has(HOLIDAY_RE, message);

// Trả về { specialty, keywords, byPerson } hoặc null nếu tin nhắn không nhắc triệu chứng/chuyên khoa nào.
// byPerson = xác định theo NGƯỜI khám (trẻ em / mang thai) — vẫn đúng cho cả các tin sau trong hội thoại.
function detectSpecialty(message) {
  const lower = String(message || '').toLowerCase();
  const matches = (re) => [...new Set([...lower.matchAll(re)].map((m) => m[0]))];
  for (const [specialty, re] of PERSON_RULES) {
    const keywords = matches(re);
    if (!keywords.length) continue;
    // Trẻ em bị bệnh răng miệng vẫn khám Răng – Hàm – Mặt (vd "con tôi bị sâu răng sữa").
    const teeth = specialty === 'Nhi khoa' && matches(SYMPTOM_RULES[0][1]);
    if (teeth && teeth.length) return { specialty: SYMPTOM_RULES[0][0], keywords: teeth, byPerson: false };
    return { specialty, keywords, byPerson: true };
  }
  let best = null;
  for (const [specialty, re] of SYMPTOM_RULES) {
    const keywords = matches(re);
    if (keywords.length && (!best || keywords.length > best.keywords.length)) best = { specialty, keywords };
  }
  return best;
}

// Đo thật vòng 4: "yếu nửa người" (dấu hiệu đột quỵ) bị model đoán là "mất điện giải".
const EMERGENCY_RE = words('khó thở', 'đau ngực', 'tức ngực', 'bất tỉnh', 'ngất', 'co giật', 'chảy máu nhiều', 'nôn ra máu', 'ho ra máu',
  'đi ngoài ra máu', 'đau bụng (?:quằn quại|dữ dội)', 'đau đầu dữ dội', 'đột quỵ', 'méo miệng', 'yếu nửa người', 'liệt', 'ngừng thở',
  // Vòng 6: "nghẹt thở", "ngực đau thắt", "nói ngọng, tay yếu" (đột quỵ), "ngã đập đầu", "ngã không đứng dậy được".
  'nghẹt thở', 'ngực (?:đau|tức)', 'đau thắt ngực', 'nói ngọng', 'nói khó', '(?:tay|chân) yếu', 'yếu (?:tay|chân)', 'tê nửa người',
  '(?:đập|va|chấn thương) đầu', 'ngã (?:\\p{L}+ ){0,2}không (?:đứng|dậy)',
  'tím tái', 'lơ mơ', 'vỡ ối', 'dữ dội (?:và )?đột ngột', 'đột ngột (?:\\p{L}+ )?dữ dội', '(?:mang thai|có thai|bầu)(?:[ ,.]+[\\p{L}\\d]+){0,4}[ ,.]+(?:ra máu|ra nước|đau bụng từng cơn|đau bụng dữ dội)');

// Dấu hiệu có thể cấp cứu — trả về các từ khớp (mảng rỗng nếu không có).
function detectEmergency(message) {
  return [...new Set([...String(message || '').toLowerCase().matchAll(EMERGENCY_RE)].map((m) => m[0]))];
}

const WEEKDAY_WORDS = { '2': 1, hai: 1, '3': 2, ba: 2, '4': 3, 'tư': 3, '5': 4, 'năm': 4, '6': 5, 'sáu': 5, '7': 6, 'bảy': 6 };
// "có chỗ" KHÔNG tính (đo thật: "có chỗ gửi xe không" bị trả lời bằng danh sách lịch trống).
// "đánh trống ngực" là triệu chứng tim mạch, không phải hỏi lịch trống (đo thật vòng 4).
// Vòng 6: "mai khám nhi được không", "lịch khám nhi mai còn không".
const SLOT_INTENT_RE = /(?<!đánh )trống|rảnh|còn (?:giờ|lịch|chỗ|slot)|có (?:lịch|giờ khám|ai khám)|còn khám (?:được )?không|giờ nào|khung giờ|lịch khám (?:nào|ngày|tuần|hôm|thứ|chủ nhật)|(?:check|kiểm tra|xem) lịch|lịch[^.?!]{0,30}(?:còn|có)[^.?!]{0,10}không|(?:mai|hôm nay|ngày mai|ngày kia|thứ \d|chủ nhật)[^.?!]{0,20}khám[^.?!]{0,15}được không|khám[^.?!]{0,20}(?:mai|hôm nay|ngày mai|ngày kia|thứ \d|chủ nhật)[^.?!]{0,10}được không|(?:mai|hôm nay|ngày kia|thứ \d|chủ nhật|\d{1,2}\s*(?:h|giờ))[^.?!]{0,25}còn (?:không|chỗ|được)/;
// "Lịch của tôi", "tôi đã đặt", "tôi có lịch hẹn nào"… là hỏi lịch hẹn của chính khách (my_appointments), không phải lịch trống.
const OWN_APPOINTMENT_RE = /lịch(?: hẹn| khám)? của (?:tôi|mình|em)|(?:tôi|mình|em) (?:đã đặt|có lịch)/;

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
  detectPrescriptionQuestion,
  isVagueComplaint,
  mentionsEye,
  detectOffTopic,
  detectOffTopicTask,
  detectIdentityQuestion,
  detectOtherFacilityQuestion,
  detectHolidayQuestion,
  detectHoursQuestion,
  detectCrisis,
  detectDoseQuestion,
  detectOwnDataQuestion,
  detectPrivacyRequest,
  detectInsult,
  detectEnglish,
  detectPriceQuestion,
  detectFacilityInfo,
  normalizeMessage,
};
