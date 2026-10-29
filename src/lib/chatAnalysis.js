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
  // "khao" lẻ là "khao khát" — chỉ sửa khi đi với chữ hay gặp sau "khoa" (đo thật: "tại sao không thể khám khao khác").
  'khao khác': 'khoa khác', 'khao khac': 'khoa khác', 'khao nào': 'khoa nào', 'khao nao': 'khoa nào',
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
  'vi sao': 'vì sao', 'sao lai': 'sao lại', 'ly do': 'lý do', 'khoa khac': 'khoa khác', 'chuyen khoa khac': 'chuyên khoa khác',
  'dau goi': 'đau gối', 'dau dau goi': 'đau đầu gối', 'dau vai': 'đau vai', 'dau chan': 'đau chân', 'dau tay': 'đau tay',
  'xuong khop': 'xương khớp', 'co xuong khop': 'cơ xương khớp', 'than kinh': 'thần kinh', 'tim mach': 'tim mạch', 'tiet nieu': 'tiết niệu',
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
  // "tai sao" là "tại sao" — trừ khi than đau tai ("đau tai sao mãi không khỏi"). Đo thật: "tai sao lai kham khoa noi"
  // bị gợi ý Tai – Mũi – Họng.
  text = text.replace(/(?<!(?:đau|ù|viêm|ngứa|nhức|dau|u|viem|ngua|nhuc) )(?<!\p{L})tai sao(?!\p{L})/giu, 'tại sao');
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
  // "đau đầu gối" là đau khớp gối, không phải đau đầu (đo thật: bị hiểu là đau đầu, hỏi lại thì giải thích sai).
  ['Nội tổng quát', words('sốt', 'ho', 'đau bụng', 'tiêu chảy', 'đau đầu(?! gối)', 'nhức đầu(?! gối)', 'chóng mặt', 'huyết áp', 'tiểu đường', 'đường huyết', 'mỡ máu', 'mệt mỏi', 'dạ dày', 'khó tiêu', 'ợ chua', 'trào ngược', 'thượng vị', 'buồn nôn', 'nôn', 'táo bón', 'cảm cúm', 'cúm', 'bị cảm', 'cảm lạnh', 'khám sức khỏe', 'khám sức khoẻ', 'khám tổng quát', 'nội khoa', 'nội tổng quát', 'khoa nội', 'khám nội', 'tim', 'gan', 'sỏi thận', 'đau thận',
    'hay quên', 'trí nhớ', 'sụt cân', 'thiếu máu', 'covid', 'cúm a',
    // Cách nói đảo trật tự / dân dã (đo thật vòng 6: "bụng đau", "đau quặn vùng rốn", "đầy bụng" không nhận ra).
    'bụng (?:đau|chướng)', 'đầu (?:đau|nhức)', 'đau quặn', '(?:quanh|vùng|ở) rốn', 'đầy bụng', 'chướng bụng', 'ợ hơi',
    'đi ngoài', 'phân lỏng', 'ớn lạnh', 'lúc nóng lúc lạnh', 'khát nước', 'phù (?:chân|mặt|người)', 'đánh trống ngực', 'hồi hộp', 'vàng da', 'phân đen', 'rét run',
    // Phòng khám không có khoa Nam học — Nội tổng quát khám ban đầu.
    'tinh hoàn', 'xuất tinh', 'cương dương',
    // Phòng khám không có khoa Cơ xương khớp, Tiết niệu, Hậu môn – trực tràng — các triệu chứng này
    // do Nội tổng quát khám ban đầu.
    '(?:đau|sưng|mỏi|nhức|cứng) (?:đầu gối|khớp gối|lưng|khớp|vai|gáy|cổ|gối|chân|tay|hông|háng|xương|gót chân|cổ tay|cổ chân|mắt cá|bắp chân|đùi|cột sống)',
    'đầu gối', 'cổ tay', 'cổ chân', 'mắt cá chân', 'xương khớp', 'thoái hoá', 'thoái hóa', 'thoát vị', 'đĩa đệm', 'cột sống', 'loãng xương', 'bong gân', 'chuột rút', 'viêm khớp',
    'gai (?:cột sống|xương)', 'tê (?:tay|chân|bì)', 'gout', 'gút', 'tiểu (?:buốt|rắt|ra máu|nhiều|đêm)',
    'trĩ', 'mất ngủ', 'khó ngủ', 'đau nửa đầu', 'run tay', 'tuyến giáp', 'bướu cổ')],
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
// "rẻ" phải là nguyên từ — "trẻ em" từng bị trả lời bằng bảng giá.
const PRICE_RE = /giá|bao nhiêu tiền|hết bao nhiêu|trả bao nhiêu|còn bao nhiêu|chi phí|tốn bao nhiêu|đắt|(?<!\p{L})rẻ(?!\p{L})|phí khám/u;
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

// ---------- Giải thích chuyên khoa đã gợi ý ----------
// Đo thật: khách hỏi tiếp "tại sao lại khám khoa nội tổng quát", "tại sao không thể khám khoa khác" — model nhỏ
// chỉ lặp lại nguyên câu gợi ý cũ. Lý do chọn khoa xác định được từ từ khoá nên code tự giải thích.
const SPECIALTY_SCOPE = {
  'Nội tổng quát': 'khám ban đầu các bệnh nội khoa và triệu chứng toàn thân ở người lớn (sốt, ho, đau đầu, tiêu hoá, huyết áp, xương khớp…)',
  'Nhi khoa': 'chuyên khám cho trẻ em — thuốc, liều dùng và cách khám ở trẻ khác người lớn',
  'Tai – Mũi – Họng': 'chuyên khám các bệnh ở tai, mũi, họng và xoang',
  'Da liễu': 'chuyên khám các bệnh về da, tóc, móng và dị ứng, mẩn ngứa ngoài da',
  'Sản phụ khoa': 'chuyên khám thai, kinh nguyệt và các vấn đề phụ khoa',
  'Răng – Hàm – Mặt': 'chuyên khám răng, lợi, miệng và khớp hàm',
};
// Từ khoá chỉ là TÊN khoa ("khám nội", "da liễu") — không phải triệu chứng để làm lý do.
const NAME_KEYWORD_RE = /^(?:nha khoa|tai mũi họng|da liễu|khám da|khoa da|nội khoa|nội tổng quát|khoa nội|khám nội|phụ khoa|sản khoa|sản phụ khoa|khoa sản|khám sản|nhi)$/;
const symptomKeywords = (detected) => (detected ? detected.keywords.filter((k) => !NAME_KEYWORD_RE.test(k)) : []);

// Khoa phòng khám KHÔNG có: [tên, triệu chứng thuộc khoa đó (do Nội tổng quát khám ban đầu), cách khách gọi tên khoa].
const MISSING_DEPARTMENTS = [
  ['Cơ xương khớp', words('đầu gối', 'gối', 'khớp', 'lưng', 'vai', 'gáy', 'cổ tay', 'cổ chân', 'mắt cá', 'hông', 'háng', 'xương', 'cột sống', 'đĩa đệm',
    'thoát vị', 'thoái ho[áa]', 'bong gân', 'chuột rút', 'gout', 'gút', 'gót chân', 'bắp chân', 'đùi'), 'cơ xương khớp|xương khớp|chấn thương chỉnh hình|chỉnh hình|chấn thương'],
  ['Thần kinh', words('tê (?:tay|chân|bì)', 'mất ngủ', 'khó ngủ', 'đau nửa đầu', 'hay quên', 'trí nhớ', 'run tay'), 'thần kinh'],
  ['Tim mạch', words('tim', 'huyết áp', 'đánh trống ngực', 'hồi hộp', 'mỡ máu'), 'tim mạch|tim'],
  ['Tiết niệu', words('tiểu (?:buốt|rắt|ra máu|nhiều|đêm)', 'sỏi thận', 'đau thận'), 'tiết niệu'],
  ['Nam khoa', words('tinh hoàn', 'xuất tinh', 'cương dương'), 'nam khoa|nam học'],
  ['Hậu môn – trực tràng', words('trĩ', 'hậu môn'), 'hậu môn|trực tràng'],
  ['Nội tiết', words('tiểu đường', 'đường huyết', 'tuyến giáp', 'bướu cổ'), 'nội tiết'],
  ['Tiêu hoá', words('dạ dày', 'trào ngược', 'ợ chua', 'khó tiêu', 'đại tràng'), 'tiêu hoá|tiêu hóa'],
  ['Hô hấp', words('phổi', 'hen suyễn'), 'hô hấp|phổi'],
  ['Tâm thần – Tâm lý', words('trầm cảm', 'lo âu', 'căng thẳng'), 'tâm thần|tâm lý'],
  ['Ung bướu', words('ung thư', 'khối u'), 'ung bướu|ung thư'],
];
const MISSING_DEPARTMENT_ASK = MISSING_DEPARTMENTS.map(([name, , asked]) =>
  [name, new RegExp(`(?<!\\p{L})(?:chuyên khoa|khoa|bác sĩ|khám|chuyên)(?: \\p{L}+){0,2} (?:${asked})(?!\\p{L})`, 'iu')]);

const missingDepartmentFor = (keywords) => {
  const found = MISSING_DEPARTMENTS.find(([, re]) => has(re, keywords.join(', ')));
  return found ? found[0] : null;
};

// Khách hỏi/đòi khám 1 khoa phòng khám không có ("có khoa cơ xương khớp không", "khám tim mạch ở đâu") → tên khoa.
function detectMissingDepartmentQuestion(message) {
  const lower = String(message || '').toLowerCase();
  const found = MISSING_DEPARTMENT_ASK.find(([, re]) => re.test(lower));
  return found ? found[0] : null;
}

// Lý do gợi ý chuyên khoa — detected là kết quả detectSpecialty (của tin có triệu chứng).
function explainSpecialty(detected) {
  const { specialty } = detected;
  const keywords = symptomKeywords(detected);
  const missing = specialty === 'Nội tổng quát' ? missingDepartmentFor(keywords) : null;
  const because = detected.byPerson && specialty === 'Nhi khoa' ? 'người đi khám là trẻ em'
    : keywords.length ? `bạn kể ${keywords.map((k) => `"${k}"`).join(', ')}` : '';
  return [
    because ? `Mình gợi ý chuyên khoa ${specialty} vì ${because}: khoa này ${SPECIALTY_SCOPE[specialty]}.` : `Chuyên khoa ${specialty} ${SPECIALTY_SCOPE[specialty]}.`,
    missing ? `Phòng khám chưa có khoa ${missing} riêng, nên vấn đề này do bác sĩ Nội tổng quát khám ban đầu; nếu cần khám chuyên sâu, bác sĩ sẽ tư vấn nơi khám tiếp phù hợp.` : '',
  ].filter(Boolean).join(' ');
}

// Câu hỏi tiếp nối về chuyên khoa vừa gợi ý: 'other' (muốn/hỏi khoa khác) | 'why' (vì sao khoa này, có chắc không,
// khoa đó khám được không) | null. "đau tai sao…" là than đau tai, không phải "tại sao".
const SPECIALTY_REF = '(?:chuyên )?khoa|khám (?:nội|nhi|sản|da|răng|tai)|nội tổng quát|nhi khoa|da liễu|sản phụ khoa|tai mũi họng|răng hàm mặt|bác sĩ (?:nội|nhi|sản|da)';
const WHY_WORDS = '(?:tại sao|(?<!(?:đau|ù|viêm|ngứa|nhức) )tai sao|vì sao|sao (?:lại|phải|không|mình phải)|lý do|căn cứ|dựa vào đâu)';
const OTHER_SPECIALTY_RE = /(?:chuyên khoa|khoa|chỗ|bên|nơi) (?:nào )?khác|đổi (?:sang )?(?:chuyên )?khoa|không muốn khám (?:khoa |chuyên khoa )?(?:nội|nhi|sản|da|răng|tai)|(?:khám|sang|qua) (?:khoa |chuyên khoa )?(?:nội|nhi|sản|da liễu|da|răng|tai mũi họng)(?: \p{L}+){0,3} (?:được không|thay|thì sao|có được không|có sao không)/u;
const WHY_SPECIALTY_RE = new RegExp(`${WHY_WORDS}[^.?!]{0,40}(?:${SPECIALTY_REF})|(?:${SPECIALTY_REF})[^.?!]{0,40}(?:tại sao|vì sao|là sao)`
  // Hỏi cụt cả tin ("tại sao", "vì sao vậy", "là sao") ngay sau lời gợi ý khoa.
  + '|^\\s*(?:hả,? )?(?:tại sao|tạisao|vì sao|sao|là sao|why)(?: lại)?(?: vậy| thế| v)?\\s*[?!.]*\\s*$'
  + '|(?:khám|điều trị|chữa)[^.?!]{0,20}không (?:khỏi|đỡ|hết) thì (?:sao|làm sao|thế nào)'
  + '|(?:có )?chắc (?:chắn )?(?:không|chưa|là đúng)|đúng khoa (?:không|chưa)|khoa (?:đó|này|ấy) (?:có )?(?:đúng|phù hợp)'
  + '|(?:khoa|bác sĩ) (?:đó|này|ấy|nội|nhi|sản|da liễu)(?: \\p{L}+){0,3} (?:có )?(?:khám|chữa|điều trị|xem|biết|giỏi|rành|chuyên)(?: được| cho| về)?[^.?!]{0,30}(?:không|chứ)', 'iu');
// Hỏi 1 khoa khám những gì ("nội tổng quát là khoa gì") → tên khoa. Đo thật: model bịa "khám được mọi chuyên khoa".
const SCOPE_ASK = [
  ['Nội tổng quát', 'nội tổng quát|khoa nội|nội khoa'], ['Nhi khoa', 'nhi khoa|khoa nhi'], ['Tai – Mũi – Họng', 'tai mũi họng'],
  ['Da liễu', 'da liễu'], ['Sản phụ khoa', 'sản phụ khoa|khoa sản'], ['Răng – Hàm – Mặt', 'răng hàm mặt'],
].map(([name, alt]) => [name, new RegExp(`(?:${alt})(?: \\p{L}+){0,2} (?:là (?:khoa |chuyên khoa )?gì|khám (?:những |các )?(?:gì|bệnh gì|bệnh nào)|chuyên (?:về )?gì|gồm (?:những )?gì)`, 'iu')]);
function detectSpecialtyScopeQuestion(message) {
  const lower = String(message || '').toLowerCase().replace(/\s*[–-]\s*/g, ' ');
  const found = SCOPE_ASK.find(([, re]) => re.test(lower));
  return found ? found[0] : null;
}

// Hỏi triệu chứng có nguy hiểm/nặng không — đo thật: model khẳng định "đau đầu gối không phải tình trạng nghiêm trọng".
const DANGER_RE = words('(?:có )?nguy hiểm (?:không|ko|chứ|lắm không)', 'có (?:nặng|nghiêm trọng|đáng lo) (?:không|ko|lắm không)', 'có bị (?:gì|làm sao) không', 'có phải (?:bệnh )?(?:nặng|ung thư) không');
const detectDangerQuestion = (message) => has(DANGER_RE, message);

function detectSpecialtyFollowUp(message) {
  const lower = String(message || '').toLowerCase();
  // "khám nội không khỏi thì sao" hỏi bước tiếp theo, không phải đòi đổi khoa.
  if (OTHER_SPECIALTY_RE.test(lower) && !/không (?:khỏi|đỡ|hết)/.test(lower)) return 'other';
  if (WHY_SPECIALTY_RE.test(lower)) return 'why';
  return null;
}

// Đo thật vòng 4: "yếu nửa người" (dấu hiệu đột quỵ) bị model đoán là "mất điện giải".
const EMERGENCY_RE = words('khó thở', 'đau ngực', 'tức ngực', 'bất tỉnh', 'ngất', 'co giật', 'chảy máu nhiều', 'nôn ra máu', 'ho ra máu',
  'đi ngoài ra máu', 'đau bụng (?:quằn quại|dữ dội)', 'đau đầu dữ dội', 'đột quỵ', 'méo miệng', 'yếu nửa người', 'liệt', 'ngừng thở',
  // Vòng 6: "nghẹt thở", "ngực đau thắt", "nói ngọng, tay yếu" (đột quỵ), "ngã đập đầu", "ngã không đứng dậy được".
  'nghẹt thở', 'ngực (?:đau|tức)', 'đau thắt ngực', 'nói ngọng', 'nói khó', '(?:tay|chân) yếu', 'yếu (?:tay|chân)', 'tê nửa người',
  '(?:đập|va|chấn thương) đầu', 'ngã (?:\\p{L}+ ){0,2}không (?:đứng|dậy)', 'gãy (?:xương|tay|chân)', 'trật khớp',
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

// ---------- Thu thập thông tin đặt lịch qua chat ----------
// Đo thật: qwen3:1.7b không tự gọi được công cụ đặt lịch — hỏi vòng vo, hiểu "ngày 1" thành "1/10 (ngày mai)",
// rồi bảo khách "đặt lịch bằng công cụ book_appointment". Code tự gom thông tin từ các tin của khách.

// Ngày khám trong 1 tin → 'YYYY-MM-DD' | { invalid: 'mô tả' } | null. "ngày 1" (không nói tháng) = ngày 1 sắp tới.
function parseBookingDate(message, todayISO) {
  const lower = String(message || '').toLowerCase();
  if (/hôm nay|(?:sáng|trưa|chiều|tối) nay/.test(lower)) return todayISO;
  if (/ngày kia|(?:ngày|hôm) mốt/.test(lower)) return addDaysISO(todayISO, 2);
  if (/(?:ngày|sáng|trưa|chiều|tối|hôm) mai|^\s*mai(?!\p{L})|(?<!\p{L})mai\s*(?:lúc\s*)?\d{1,2}\s*(?:h|giờ)/u.test(lower)) return addDaysISO(todayISO, 1);
  const year = Number(todayISO.slice(0, 4));
  const real = (y, mo, d) => {
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
  };
  const dm = lower.match(/(?<![\d/:])(\d{1,2})\s*[/.-]\s*(\d{1,2})(?:\s*[/.-]\s*(\d{2,4}))?(?![\d/:])/)
    || lower.match(/ngày\s*(\d{1,2})\s*tháng\s*(\d{1,2})(?:\s*(?:năm)?\s*(\d{4}))?/);
  if (dm) {
    const d = Number(dm[1]);
    const mo = Number(dm[2]);
    let y = dm[3] ? Number(dm[3]) : year;
    if (dm[3] && dm[3].length === 2) y += 2000;
    if (!real(y, mo, d)) return { invalid: `ngày "${dm[0].trim()}" không có trên lịch` };
    let iso = `${y}-${pad(mo)}-${pad(d)}`;
    // Không nói năm mà ngày đã qua trong năm nay → hiểu là năm sau (vd đặt "5/1" vào tháng 12).
    if (!dm[3] && iso < todayISO) iso = `${y + 1}-${pad(mo)}-${pad(d)}`;
    return iso;
  }
  const dayOnly = lower.match(/ngày\s*(\d{1,2})(?!\s*(?:tháng|[/.-]|\d|ngày|tuổi))/);
  if (dayOnly) {
    const d = Number(dayOnly[1]);
    let y = year;
    let mo = Number(todayISO.slice(5, 7));
    if (d < Number(todayISO.slice(8, 10))) mo += 1;
    if (mo > 12) { mo = 1; y += 1; }
    if (!real(y, mo, d)) return { invalid: `tháng ${mo} không có ngày ${d}` };
    return `${y}-${pad(mo)}-${pad(d)}`;
  }
  const wd = lower.match(/thứ\s*(2|3|4|5|6|7|hai|ba|tư|năm|sáu|bảy)(?!\p{L})|chủ nhật/u);
  if (wd) {
    const target = wd[0] === 'chủ nhật' ? 0 : WEEKDAY_WORDS[wd[1]];
    const todayDow = new Date(todayISO + 'T00:00:00Z').getUTCDay();
    let diff = (target - todayDow + 7) % 7;
    if (/tuần (?:sau|tới)/.test(lower)) diff = ((target + 6) % 7) - ((todayDow + 6) % 7) + 7;
    return addDaysISO(todayISO, diff);
  }
  return null;
}

// Giờ khám trong 1 tin → 'HH:MM' | { invalid } | null. "9h", "9 giờ 30", "2h chiều", "9h rưỡi".
function parseBookingTime(message) {
  const lower = String(message || '').toLowerCase();
  const tm = lower.match(/(?<![\d/])(\d{1,2})\s*(?:giờ|h(?!\p{L})|:)\s*(rưỡi|\d{1,2})?/u);
  if (!tm) return null;
  let hour = Number(tm[1]);
  const minute = tm[2] === 'rưỡi' ? 30 : tm[2] ? Number(tm[2]) : 0;
  if (/chiều|tối/.test(lower) && hour >= 1 && hour <= 11) hour += 12;
  const total = hour * 60 + minute;
  if (hour > 23 || minute > 59) return { invalid: `giờ "${tm[0].trim()}" không hợp lệ` };
  if (total < OPEN_MIN || total > LAST_SLOT_MIN) return { invalid: `${pad(hour)}:${pad(minute)} ngoài giờ khám (07:00–20:30)` };
  if (minute % 30 !== 0) return { invalid: `${pad(hour)}:${pad(minute)} không phải mốc đặt lịch (mỗi khung 30 phút: ${pad(hour)}:00 hoặc ${pad(hour)}:30)` };
  return `${pad(hour)}:${pad(minute)}`;
}

// Từ không thể là họ tên — loại tin như "bị đau bụng", "ngày 1 lúc 9h" khỏi việc đoán tên.
const NOT_NAME_WORDS = new Set(('bị đau khám ngày giờ lúc mai mốt nay hôm tuần thứ chủ nhật sáng trưa chiều tối tuổi số điện thoại sđt sdt '
  + 'giới tính là của tôi mình em tên họ và đặt lịch hẹn cho giúp muốn khoa chuyên bác sĩ không có được ok xác nhận '
  + 'sửa đổi huỷ hủy thôi rồi nhé ạ với tháng năm sinh lý do vì triệu chứng cần vâng dạ đúng').split(' '));
const titleCase = (s) => s.replace(/\p{L}+/gu, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
const isCapitalized = (w) => w[0] !== w[0].toLowerCase();

// Đoán họ tên trong phần chữ còn lại: tách đoạn theo dấu câu/số; ưu tiên cụm 2-5 chữ viết hoa đầu ("…khám nội mai
// 10h, Phạm Văn Bình"), không thì cả đoạn 2-5 chữ không chứa từ thông thường ("thân tuấn vũ").
function guessName(rest) {
  const segments = rest.split(/[\d,;:.+/\n-]+/).map((s) => s.trim().split(/\s+/).filter(Boolean)).filter((s) => s.length);
  for (const words of segments) {
    const runs = [];
    let run = [];
    for (const w of [...words, '']) {
      if (w && isCapitalized(w)) run.push(w);
      else { if (run.length >= 2 && run.length <= 5) runs.push(run); run = []; }
    }
    if (runs.length) return runs[runs.length - 1].join(' ');
  }
  const plain = segments.find((words) => words.length >= 2 && words.length <= 5 && words.every((w) => !NOT_NAME_WORDS.has(w.toLowerCase())));
  return plain ? titleCase(plain.join(' ')) : null;
}

// Thông tin người khám trong 1 tin (văn bản GỐC khách gõ — tên riêng không được thêm dấu tự động).
function parsePatientDetails(message) {
  const text = String(message || '');
  const lower = text.toLowerCase();
  const out = {};
  // Nhóm số cách nhau phải ≥3 chữ số — "0912345 40 tuổi" không được gộp thành số điện thoại 9 chữ số.
  const phoneMatch = text.match(/(?<![\d/])(?:\+84|0)\d{2,3}(?:[ .-]?\d{3,4}){1,2}(?![\d/])/);
  if (phoneMatch) {
    let digits = phoneMatch[0].replace(/\D/g, '');
    if (digits.startsWith('84')) digits = '0' + digits.slice(2);
    out.phone = digits;
  }
  const ageMatch = lower.match(/(\d{1,3})\s*tuổi/) || lower.match(/tuổi\s*(?:là|:)?\s*(\d{1,3})/);
  // Tin khai thông tin ("thân tuấn vũ 21 nam 0353012966"): số 1-3 chữ số đứng riêng, không phải ngày/giờ, là tuổi.
  const bareAge = !ageMatch && (phoneMatch || /(?<!\p{L})(?:nam|nữ|nu)(?!\p{L})/u.test(lower))
    && lower.replace(phoneMatch ? phoneMatch[0] : '', ' ').match(/(?<![\d/:\p{L}])(\d{1,3})(?![\d/:]|\s*(?:h(?!\p{L})|giờ|tháng|ngày))/u);
  // Cả tin chỉ có 1 số ("45") là câu trả lời cho câu hỏi tuổi.
  const onlyNumber = lower.match(/^\s*(\d{1,3})\s*$/);
  const age = ageMatch || bareAge || onlyNumber;
  if (age && !/(?:ngày|lúc|thứ|tháng)\s*$/.test(lower.slice(0, age.index))) out.age = Number(age[1]);
  // Khớp trên văn bản gốc (không phân biệt hoa thường) để bỏ đúng vị trí chữ giới tính khỏi phần đoán tên.
  const gender = text.match(/giới tính\s*(?:là|:)?\s*(nam|nữ|nu|khác)/iu)
    || text.match(/(?:^|[\d,;.]\s*|\s(?:là|tuổi)\s+)(nam|nữ|nu)(?!\p{L})/iu);
  if (gender) {
    const g = gender[1].toLowerCase();
    out.gender = g === 'nam' ? 'nam' : g === 'khác' ? 'khac' : 'nu';
  }
  const named = text.match(/(?:họ (?:và )?tên|tên(?: (?:tôi|mình|em|bệnh nhân|người khám))?)\s*(?:là|:)\s*([\p{L} ]{2,40}?)(?=\s*(?:[,;.\d]|$|\s(?:sinh|năm|số|sđt|sdt|tuổi|giới)(?!\p{L})))/iu);
  if (named) {
    out.fullName = titleCase(named[1].trim());
  } else if (out.phone || out.age !== undefined) {
    // Bỏ đúng chữ giới tính đã nhận ra (theo vị trí) — "Nam" trong "Nguyễn Văn Nam 30 tuổi" là tên.
    const withoutGender = gender ? text.slice(0, gender.index) + ' , ' + text.slice(gender.index + gender[0].length) : text;
    const name = guessName(withoutGender.replace(phoneMatch ? phoneMatch[0] : '', ' , ')
      .replace(/(?<!\p{L})(?:số điện thoại|so dien thoai|sđt|sdt|giới tính|gioi tinh|tuổi|tuoi)\s*(?:là|la|:)?(?!\p{L})/giu, ' , '));
    if (name) out.fullName = name;
  }
  return out;
}

module.exports = {
  analyzeMessage,
  parseBookingDate,
  parseBookingTime,
  parsePatientDetails,
  isBlankMessage,
  upcomingDaysNote,
  describeDate,
  detectSpecialty,
  symptomKeywords,
  missingDepartmentFor,
  detectMissingDepartmentQuestion,
  explainSpecialty,
  detectSpecialtyFollowUp,
  detectSpecialtyScopeQuestion,
  detectDangerQuestion,
  SPECIALTY_SCOPE,
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
