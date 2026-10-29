const express = require('express');
const { pool } = require('../db');
const { authenticate, optionalAuthenticate, requireAdmin, requireRole } = require('../middleware/auth');
const { SPECIALTIES, GENDERS, DISCOUNT_CATEGORY_LABELS } = require('../constants');
const { chunkText } = require('../lib/chunk');
const { embedText, toVectorLiteral } = require('../lib/embeddings');
const { getAvailableSlots } = require('../lib/availability');
const { createAppointment, BookingError, isSundayISO, sundayDeadlineISO } = require('../lib/appointmentService');
const { toolsForRole, runTool } = require('../lib/assistantTools');
const {
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
  detectDoseTimingQuestion,
  detectFirstAid,
  detectOwnDataQuestion,
  detectPrivacyRequest,
  detectInsult,
  detectEnglish,
  englishReply,
  detectPriceQuestion,
  detectFacilityInfo,
  detectBookingFaq,
  detectServiceQuestion,
  detectLabResultQuestion,
  detectNeedTestQuestion,
  detectOwnDataKind,
  normalizeMessage,
} = require('../lib/chatAnalysis');
const { tryEmbedQuestion, findExamples } = require('../lib/chatExamples');
const { logAudit } = require('../lib/audit');
const llm = require('../lib/llm');
const { intParam } = require('../middleware/params');
const { withRetry, aiErrorResponse } = llm;

// Công cụ tra cứu dữ liệu của chính bệnh nhân đã đăng nhập, dùng trong khung chat chính.
const PATIENT_TOOL_NAMES = ['my_appointments', 'my_records', 'my_invoices', 'my_followups'];

const MAX_MESSAGE_LENGTH = 1000;
const HISTORY_TURNS_FOR_MODEL = 12;

// Lưu 1 lượt hỏi-đáp (chỉ khi đã đăng nhập). Lỗi lưu không làm hỏng câu trả lời.
async function persistTurn(userId, conversationId, userText, replyText, channel = 'main') {
  try {
    let convId = conversationId;
    if (!convId) {
      const title = userText.replace(/\s+/g, ' ').trim().slice(0, 60) || 'Cuộc trò chuyện';
      const c = await pool.query('INSERT INTO chat_conversations (user_id, title, channel) VALUES ($1,$2,$3) RETURNING id', [userId, title, channel]);
      convId = c.rows[0].id;
    } else {
      await pool.query('UPDATE chat_conversations SET updated_at = now() WHERE id = $1', [convId]);
    }
    await pool.query(
      `INSERT INTO chat_messages (conversation_id, role, content) VALUES ($1,'user',$2), ($1,'assistant',$3)`,
      [convId, userText, replyText]
    );
    return convId;
  } catch (e) {
    console.error('Không lưu được lịch sử chat:', e.message);
    return conversationId || null;
  }
}

const router = express.Router();
router.param('id', intParam);
router.param('appointmentId', intParam);

// Ngữ cảnh lấy từ CSDL thật của phòng khám: giá khám, bác sĩ theo chuyên khoa.
async function buildClinicContext() {
  const [prices, doctors, discounts] = await Promise.all([
    pool.query('SELECT specialty, price FROM service_prices'),
    pool.query("SELECT id, name, specialty FROM users WHERE role = 'doctor' ORDER BY specialty, name"),
    pool.query('SELECT category, percent FROM discount_rates'),
  ]);
  const priceMap = Object.fromEntries(prices.rows.map((r) => [r.specialty, r.price]));
  // Bác sĩ specialty = NULL là bác sĩ tổng quát, liệt kê ở mọi chuyên khoa.
  const generalDoctors = doctors.rows.filter((d) => !d.specialty).map((d) => d.name);
  const bySpecialty = {};
  for (const d of doctors.rows) {
    if (!d.specialty) continue;
    if (!bySpecialty[d.specialty]) bySpecialty[d.specialty] = [];
    bySpecialty[d.specialty].push(d.name);
  }
  const describeSpecialty = (s) => {
    const price = priceMap[s] != null ? priceMap[s].toLocaleString('vi-VN') + 'đ' : 'chưa niêm yết';
    const docNames = [...(bySpecialty[s] || []), ...generalDoctors];
    const docs = docNames.length ? docNames.join(', ') : 'chưa có bác sĩ phụ trách';
    return `giá khám ${price}; bác sĩ: ${docs}`;
  };
  const specialtyLines = SPECIALTIES.map((s) => `- ${s}: ${describeSpecialty(s)}`).join('\n');
  const discountText = discounts.rows.length
    ? discounts.rows.map((r) => `${DISCOUNT_CATEGORY_LABELS[r.category] || r.category} giảm ${r.percent}%`).join(', ')
      + ' — chỉ giảm tiền khám (không giảm tiền thuốc), mỗi lần khám áp dụng 1 loại; chọn khi đặt lịch và mang thẻ để nhân viên kiểm tra lúc thanh toán.'
    : 'chưa có chương trình giảm giá.';

  const text = [
    'Thông tin phòng khám (chỉ dùng đúng dữ kiện dưới đây, không bịa thêm):',
    '- Tên: Phòng khám Đa khoa Đức Minh.',
    '- Địa chỉ: Phường Túc Duyên, TP. Thái Nguyên.',
    '- Hotline: 0974 755 333.',
    '- Giờ làm việc: 7:00–21:00, Thứ 2 – Thứ 7. Chủ nhật KHÔNG khám thường xuyên, chỉ có người trực cho trường hợp đột xuất: muốn khám Chủ nhật phải hẹn trước với 1 bác sĩ cụ thể, đặt chậm nhất Thứ 3 của tuần đó, và chỉ được khám khi chính bác sĩ đó đồng ý (lịch sẽ ở trạng thái chờ xác nhận cho tới khi bác sĩ đồng ý).',
    '- Cách đặt lịch: đăng nhập/đăng ký tại /tai-khoan.html rồi đặt lịch tại /dat-lich.html.',
    '',
    '- Thanh toán: tiền mặt tại quầy hoặc chuyển khoản (quét mã QR ở trang /ho-so.html).',
    `- Giảm giá: ${discountText}`,
    '',
    'Chuyên khoa, giá khám và bác sĩ hiện có:',
    specialtyLines,
    ...(generalDoctors.length ? [`(${generalDoctors.join(', ')}: bác sĩ tổng quát, khám được mọi chuyên khoa.)`] : []),
  ].join('\n');
  const discountPercent = Object.fromEntries(discounts.rows.map((r) => [r.category, r.percent]));
  return { text, describeSpecialty, priceOf: (s) => (priceMap[s] != null ? priceMap[s] : null), discountPercent, doctors: doctors.rows };
}

const formatVnd = (n) => n.toLocaleString('vi-VN') + 'đ';

// Lịch làm việc của bác sĩ có tên trong tin (doctor_shifts); không có ca = khám theo giờ chung.
const DOCTOR_SCHEDULE_RE = /thứ mấy|lịch làm|ca trực|làm (?:việc )?(?:vào )?(?:ngày|hôm|thứ) nào|khám (?:vào )?(?:ngày|hôm|thứ) (?:nào|mấy)|(?:có )?khám (?:thứ|chủ nhật|hôm)|(?:có )?làm (?:việc )?(?:vào )?(?:thứ \d|thứ (?:hai|ba|tư|năm|sáu|bảy)|chủ nhật|cuối tuần)/i;
const plainName = (d) => d.name.replace(/^BS\.\s*/i, '').toLowerCase();
// Bác sĩ được nhắc trong tin: đủ họ tên, hoặc phần đuôi họ tên ngay sau "bác sĩ" ("bác sĩ ơi cho em hỏi" không khớp BS. Hoàng Thị Em).
const nameTails = (d) => plainName(d).split(' ').map((_, i, parts) => parts.slice(i).join(' '));
const doctorsNamed = (clinic, lower) => clinic.doctors.filter((d) => lower.includes(plainName(d))
  || new RegExp(`(?:bác sĩ|bs)\\.? (?:${nameTails(d).join('|')})(?!\\p{L})`, 'iu').test(lower));

async function doctorScheduleReply(clinic, msg, contextText) {
  if (!DOCTOR_SCHEDULE_RE.test(msg)) return null;
  const lower = msg.toLowerCase();
  let doctors = doctorsNamed(clinic, lower);
  if (!doctors.length && /(?:bác sĩ|bs) (?:đó|ấy|này)/i.test(msg)) doctors = doctorsNamed(clinic, contextText.toLowerCase());
  if (!doctors.length) return null;
  const days = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];
  const lines = [];
  for (const doctor of doctors) {
    const shifts = (await pool.query(
      "SELECT weekday, to_char(start_time, 'HH24:MI') AS s, to_char(end_time, 'HH24:MI') AS e FROM doctor_shifts WHERE doctor_id = $1 ORDER BY weekday, start_time",
      [doctor.id]
    )).rows;
    const role = doctor.specialty ? `bác sĩ chuyên khoa ${doctor.specialty}` : 'bác sĩ tổng quát, khám được mọi chuyên khoa';
    lines.push(shifts.length
      ? `${doctor.name} (${role}) có ca trực: ${shifts.map((x) => `${days[x.weekday]} ${x.s}–${x.e}`).join('; ')}.`
      : `${doctor.name} (${role}) khám theo giờ chung: 7:00–21:00 từ Thứ 2 đến Thứ 7; Chủ nhật chỉ khám theo hẹn trước và cần bác sĩ đồng ý.`);
  }
  return [...lines, 'Bạn hỏi mình lịch trống theo ngày để xem giờ còn trống nhé.'].join('\n');
}

// "Bác sĩ là ai / bác sĩ nào" → danh sách bác sĩ của chuyên khoa đang bàn.
const DOCTOR_WHO_RE = /bác sĩ(?: \p{L}+){0,3} (?:là ai|tên (?:là )?gì|gồm (?:những )?ai)|bác sĩ nào|ai (?:là bác sĩ|khám)/iu;
function doctorListReply(clinic, specialty) {
  if (specialty) return `Bác sĩ khám chuyên khoa ${specialty}: ${clinic.describeSpecialty(specialty).replace(/^.*bác sĩ: /, '')}. Khi đặt lịch bạn có thể chọn bác sĩ cụ thể.`;
  return ['Bác sĩ theo từng chuyên khoa:', ...SPECIALTIES.map((s) => `- ${s}: ${clinic.describeSpecialty(s).replace(/^.*bác sĩ: /, '')}`)].join('\n');
}

// Hỏi về 1 bác sĩ theo tên: trả lời theo danh sách bác sĩ thật, không đánh giá trình độ.
const NOT_A_NAME = new Set('có khám làm là ở giỏi nào đó ấy này nhi nội sản da răng tai nữ nam tên chuyên của giúp cho được ơi trực hôm mấy bao nói bảo kê dặn tư vấn khoa tổng quát gia đình riêng'.split(' '));
const ABOUT_DOCTOR_RE = /(?:bác sĩ|bs)\.?\s+(?:\p{L}+\s+){1,3}(?:có (?:làm|khám|còn|ở|giỏi|tốt)|còn làm|làm ở|là ai|giỏi|tốt không|có tâm|uy tín|tay nghề|kinh nghiệm|khám (?:gì|khoa gì|chuyên khoa gì|bệnh gì)|(?:thuộc |ở )?khoa (?:gì|nào)|chuyên (?:khoa )?(?:gì|về gì))/u;
function doctorNameReply(clinic, msg) {
  const lower = msg.toLowerCase();
  if (!ABOUT_DOCTOR_RE.test(lower)) return null;
  const m = lower.match(/(?:bác sĩ|bs)\.?\s+((?:\p{L}+\s+){0,2}\p{L}+)/u);
  if (!m) return null;
  const words = [];
  for (const w of m[1].split(/\s+/)) { if (NOT_A_NAME.has(w)) break; words.push(w); }
  if (!words.length) return null;
  const doctors = doctorsNamed(clinic, lower);
  const role = (d) => (d.specialty ? `bác sĩ chuyên khoa ${d.specialty}` : 'bác sĩ tổng quát, khám được mọi chuyên khoa');
  if (!doctors.length) {
    const name = words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
    return `Phòng khám hiện không có bác sĩ tên ${name}. ${doctorListReply(clinic, null)}`;
  }
  if (/giỏi|tốt không|có tâm|uy tín|tay nghề|kinh nghiệm|đánh giá|review/.test(lower)) {
    return `Mình không đánh giá hay so sánh trình độ các bác sĩ. ${doctors.map((d) => `${d.name} là ${role(d)}`).join('; ')}. Bạn có thể chọn bác sĩ này khi đặt lịch tại /dat-lich.html.`;
  }
  return `${doctors.map((d) => `${d.name} là ${role(d)} của phòng khám`).join('; ')}. Bạn có thể chọn bác sĩ này khi đặt lịch tại /dat-lich.html, hoặc hỏi mình lịch làm việc của bác sĩ.`;
}

// Dữ liệu của chính bệnh nhân: code gọi công cụ rồi trả lời (model nhỏ không tự gọi công cụ).
async function ownDataReply(kind, msg, user, todayVN) {
  const dmy = (iso) => String(iso).slice(0, 10).split('-').reverse().join('/');
  const lower = msg.toLowerCase();
  const latestOnly = /gần nhất|lần trước|mới nhất|lần cuối/.test(lower);
  if (kind === 'appointments') {
    let rows = (await runTool('my_appointments', {}, user)).appointments || [];
    const named = detectSpecialty(msg);
    if (named) rows = rows.filter((r) => r.chuyenKhoa === named.specialty);
    const upcoming = /sắp tới|tới đây|sắp đến|tiếp theo/.test(lower);
    if (upcoming) rows = rows.filter((r) => r.ngay >= todayVN && r.trangThai !== 'Đã huỷ');
    if (!rows.length) {
      return `${upcoming ? 'Bạn chưa có lịch hẹn nào sắp tới' : 'Mình không thấy lịch hẹn nào'}${named ? ` của chuyên khoa ${named.specialty}` : ''}. Bạn có thể đặt lịch tại /dat-lich.html hoặc nhắn mình chuyên khoa, ngày giờ muốn khám để mình đặt giúp.`;
    }
    return [
      'Lịch hẹn của bạn (mới nhất trước):',
      ...rows.slice(0, latestOnly ? 1 : 5).map((r) => `- ${dmy(r.ngay)} lúc ${String(r.gio).slice(0, 5)} — ${r.chuyenKhoa}, ${r.bacSi === 'chưa chỉ định' ? 'chưa chỉ định bác sĩ' : r.bacSi} — ${r.trangThai}`),
      'Bạn xem chi tiết, đổi hoặc huỷ lịch ở mục "Tất cả lịch hẹn của tôi" trên trang /dat-lich.html.',
    ].join('\n');
  }
  if (kind === 'records') {
    const rows = (await runTool('my_records', {}, user)).records || [];
    await logAudit(user, 'record.self_view', 'medical_record', null, { count: rows.length, via: 'ai_chat' });
    if (!rows.length) return 'Bạn chưa có hồ sơ khám nào trên hệ thống — hồ sơ và đơn thuốc chỉ có sau khi bác sĩ khám và ghi lại. Bạn xem lại ở trang Hồ sơ khám (/ho-so.html).';
    if (/(?:những|các) khoa|khoa nào/.test(lower)) {
      return `Theo hồ sơ khám, bạn đã khám: ${[...new Set(rows.map((r) => r.chuyenKhoa))].join(', ')}. Bạn xem chi tiết từng lần khám ở trang Hồ sơ khám (/ho-so.html).`;
    }
    return [
      latestOnly ? 'Lần khám gần nhất của bạn:' : 'Các lần khám gần đây của bạn:',
      ...rows.slice(0, latestOnly ? 1 : 3).map((r) => [
        `- ${dmy(r.ngay)} — ${r.chuyenKhoa}, ${r.bacSi} (đơn ${r.soDon}): chẩn đoán ${r.chanDoan || 'chưa ghi'}`,
        ...(r.donThuoc || []).map((t) => `  • ${t.thuoc}: ${t.lieuDung || 'theo chỉ dẫn của bác sĩ'} (${t.soLuong} ${t.donVi || ''})`.replace(/\s+\)/, ')')),
      ].join('\n')),
      'Mình chỉ nhắc lại đúng những gì bác sĩ đã ghi; thắc mắc về thuốc hay liều dùng bạn hỏi lại bác sĩ. Xem đầy đủ ở trang Hồ sơ khám (/ho-so.html).',
    ].join('\n');
  }
  if (kind === 'invoices') {
    const rows = (await runTool('my_invoices', {}, user)).invoices || [];
    await logAudit(user, 'invoice.self_view', 'invoice', null, { count: rows.length, via: 'ai_chat' });
    if (!rows.length) return 'Bạn chưa có hoá đơn nào trên hệ thống — hoá đơn được lập sau khi khám xong.';
    const unpaid = rows.some((r) => !r.daThanhToan);
    return [
      'Hoá đơn của bạn (mới nhất trước):',
      ...rows.slice(0, latestOnly ? 1 : 5).map((r) => `- ${r.soHoaDon} — khám ${r.chuyenKhoa} ngày ${dmy(r.ngayKham)}: ${formatVnd(Number(r.tongTienVND))} — ${r.daThanhToan ? 'đã thanh toán' : 'CHƯA thanh toán'}`),
      unpaid ? 'Hoá đơn chưa thanh toán bạn trả bằng tiền mặt tại quầy hoặc quét mã QR ở trang Hồ sơ khám (/ho-so.html).' : 'Bạn xem chi tiết từng hoá đơn ở trang Hồ sơ khám (/ho-so.html).',
    ].join('\n');
  }
  const rows = (await runTool('my_followups', {}, user)).followups || [];
  if (!rows.length) return 'Hiện bạn chưa có lịch tái khám nào bác sĩ hẹn. Nếu bác sĩ dặn tái khám mà chưa thấy lịch, bạn gọi hotline 0974 755 333 hoặc tự đặt lịch tại /dat-lich.html.';
  return ['Lịch tái khám bác sĩ đã hẹn cho bạn:', ...rows.map((r) => `- ${dmy(r.ngay)} với ${r.bacSi}${r.danDo ? ` — dặn dò: ${r.danDo}` : ''}`)].join('\n');
}

const FACILITY_REPLIES = {
  address: 'Phòng khám Đa khoa Đức Minh ở Phường Túc Duyên, TP. Thái Nguyên. Bạn gọi hotline 0974 755 333 để được chỉ đường cụ thể nhé.',
  contact: 'Bạn liên hệ phòng khám qua hotline 0974 755 333, hoặc nhắn Zalo cùng số 0974 755 333 (nút Zalo ở góc phải màn hình). Mình chưa có thông tin về email hay fanpage chính thức.',
  payment: 'Phòng khám nhận thanh toán bằng tiền mặt tại quầy hoặc chuyển khoản (quét mã QR ở trang Hồ sơ khám /ho-so.html sau khi đăng nhập). Các hình thức khác như quẹt thẻ hay ví điện tử mình chưa có thông tin chính xác — bạn gọi hotline 0974 755 333 để hỏi trước nhé.',
  feedback: 'Bạn có thể góp ý hoặc phản ánh qua hotline 0974 755 333 (hoặc Zalo cùng số), hay trực tiếp với nhân viên tại quầy để phòng khám tiếp nhận.',
  unknown: 'Mình chưa có thông tin chính xác về việc này. Bạn gọi hotline 0974 755 333 để được giải đáp nhé.',
};

// Câu hỏi quanh việc đặt lịch. Website chưa có chức năng tự lấy lại mật khẩu.
const BOOKING_FAQ_REPLIES = {
  password: 'Hiện website chưa có chức năng tự lấy lại mật khẩu. Bạn gọi hotline 0974 755 333 để nhân viên hỗ trợ khôi phục tài khoản nhé — mình không xem hay đổi được mật khẩu qua chat.',
  fee: 'Đặt lịch khám (trên trang /dat-lich.html hoặc qua chat sau khi đăng nhập) và đăng ký tài khoản đều miễn phí; huỷ lịch cũng không mất phí. Bạn chỉ trả tiền khám (và tiền thuốc nếu có) khi đến khám.',
  walkin: 'Mình chưa có thông tin chính xác về việc khám không hẹn trước. Bạn nên đặt lịch trước tại /dat-lich.html để chắc chắn có bác sĩ và không phải chờ; nếu muốn đến thẳng, bạn gọi hotline 0974 755 333 hỏi trước nhé.',
  relative: 'Được bạn nhé — khi đặt lịch bạn điền họ tên, tuổi, giới tính và số điện thoại của người đi khám (trẻ em thì chọn chuyên khoa Nhi khoa). Bạn đăng nhập tại /tai-khoan.html rồi đặt tại /dat-lich.html, hoặc nhắn mình đặt qua chat sau khi đăng nhập.',
  late: 'Mình chưa có quy định chính xác về việc đến trễ giờ hẹn. Nếu biết mình sẽ đến muộn, bạn gọi hotline 0974 755 333 báo trước để phòng khám sắp xếp; hoặc đổi sang khung giờ khác ở mục "Tất cả lịch hẹn của tôi" trên trang /dat-lich.html.',
  duration: 'Mỗi lịch hẹn được xếp theo khung 30 phút. Tổng thời gian ở phòng khám còn tuỳ tình trạng bệnh và việc bác sĩ có chỉ định thêm xét nghiệm hay không, nên mình không báo chính xác được; bạn nên đến sớm vài phút trước giờ hẹn.',
};

// Trả lời hỏi giá bằng số liệu CSDL, giảm giá tính sẵn.
function priceReply(clinic, price, specialty) {
  const priceText = (s) => {
    const p = clinic.priceOf(s);
    return p != null ? formatVnd(p) : 'chưa niêm yết';
  };
  if (price.policy) {
    const rates = Object.entries(clinic.discountPercent).map(([c, p]) => `${DISCOUNT_CATEGORY_LABELS[c] || c} giảm ${p}%`);
    if (!rates.length) return 'Hiện phòng khám chưa có chương trình giảm giá, bạn gọi hotline 0974 755 333 để hỏi thêm nhé.';
    if (price.both) {
      return `Các mức giảm không cộng dồn: mỗi lần khám chỉ áp dụng 1 loại giảm giá (${rates.join(', ')}). Bạn có cả 2 loại thẻ thì chọn loại giảm nhiều hơn khi đặt lịch và mang thẻ đó để nhân viên kiểm tra lúc thanh toán; giảm giá chỉ tính trên tiền khám, không giảm tiền thuốc.`;
    }
    const asked = price.discount && clinic.discountPercent[price.discount] != null
      ? `Có bạn nhé — ${DISCOUNT_CATEGORY_LABELS[price.discount]} được giảm ${clinic.discountPercent[price.discount]}% tiền khám. `
      : '';
    return `${asked}Phòng khám đang giảm giá: ${rates.join(', ')}. Chỉ giảm tiền khám (không giảm tiền thuốc), mỗi lần khám áp dụng 1 loại; bạn chọn khi đặt lịch và mang thẻ để nhân viên kiểm tra lúc thanh toán.`;
  }
  if (price.list || !specialty) {
    return [
      'Giá khám từng chuyên khoa hiện tại:',
      ...SPECIALTIES.map((s) => `- ${s}: ${priceText(s)}`),
      'Giá khám chưa gồm tiền thuốc. Khoa chưa niêm yết giá, bạn gọi hotline 0974 755 333 để hỏi.',
    ].join('\n');
  }
  const base = clinic.priceOf(specialty);
  if (base == null) return `Giá khám chuyên khoa ${specialty} hiện chưa niêm yết, bạn gọi hotline 0974 755 333 để được báo giá nhé.`;
  const percent = price.discount && clinic.discountPercent[price.discount];
  if (!percent) return `Giá khám chuyên khoa ${specialty} là ${formatVnd(base)} (chưa gồm tiền thuốc).`;
  const label = DISCOUNT_CATEGORY_LABELS[price.discount] || price.discount;
  return `Giá khám chuyên khoa ${specialty} là ${formatVnd(base)}; có ${label} được giảm ${percent}% còn ${formatVnd(Math.round(base * (100 - percent) / 100))}. `
    + 'Giảm giá chỉ áp dụng cho tiền khám (không giảm tiền thuốc); bạn chọn loại giảm giá khi đặt lịch và mang thẻ khi đến khám.';
}

// Tool tra khung giờ còn trống thật trong CSDL.
const checkSlotsDeclaration = {
  name: 'check_available_slots',
  description:
    'Kiểm tra các khung giờ khám còn trống của phòng khám cho 1 chuyên khoa vào 1 ngày cụ thể. ' +
    'Dùng khi bệnh nhân hỏi về lịch trống, muốn biết còn giờ nào có thể đặt, hoặc hỏi có bác sĩ nào rảnh không.',
  parameters: {
    type: 'object',
    properties: {
      specialty: { type: 'string', description: 'Tên chuyên khoa, phải khớp đúng 1 trong các chuyên khoa đã liệt kê ở trên.' },
      date: { type: 'string', description: 'Ngày muốn kiểm tra, định dạng YYYY-MM-DD. Tự tính ra ngày cụ thể nếu khách nói "hôm nay"/"ngày mai"/"thứ 6 tuần này".' },
    },
    required: ['specialty', 'date'],
  },
};

async function checkAvailableSlots({ specialty, date }) {
  if (!SPECIALTIES.includes(specialty)) {
    return { error: `Chuyên khoa không hợp lệ. Các chuyên khoa hiện có: ${SPECIALTIES.join(', ')}` };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    return { error: 'Ngày không hợp lệ, cần đúng định dạng YYYY-MM-DD.' };
  }

  const { doctors } = await getAvailableSlots({ specialty, date });
  if (doctors.length === 0) {
    return { specialty, date, available: false, message: `Chuyên khoa ${specialty} hiện chưa có bác sĩ phụ trách.` };
  }
  const sundayNote = isSundayISO(date)
    ? `Ngày này là CHỦ NHẬT: không khám thường xuyên, chỉ khám theo hẹn trước với 1 bác sĩ cụ thể, phải đặt chậm nhất ngày ${sundayDeadlineISO(date)} (Thứ 3), và cần bác sĩ đồng ý. Các khung giờ dưới đây chỉ là giờ chưa có ai đặt, KHÔNG có nghĩa là chắc chắn được khám.`
    : undefined;
  return { specialty, date, available: doctors.some((d) => d.freeSlots.length > 0), doctors, ...(sundayNote ? { sundayNote } : {}) };
}

// Gộp các khung 30 phút liền nhau: ['07:00', '07:30', '08:00', '10:00'] → '07:00–08:00, 10:00'.
function slotRanges(slots) {
  const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  const ranges = [];
  for (const t of slots) {
    const last = ranges[ranges.length - 1];
    if (last && toMin(t) - toMin(last[1]) === 30) last[1] = t;
    else ranges.push([t, t]);
  }
  return ranges.map(([a, b]) => (a === b ? a : `${a}–${b}`)).join(', ');
}

// Tra sẵn lịch trống cho các ngày khách hỏi rồi đưa vào prompt (model nhỏ hay hứa "sẽ kiểm tra" mà không gọi tool).
const PERIOD_RANGES = { 'sáng': ['00:00', '12:00'], 'chiều': ['12:00', '18:00'], 'tối': ['18:00', '24:00'] };

async function slotFacts(specialty, dates, todayVN, period) {
  // Bỏ các giờ đã qua của hôm nay, và giờ ngoài buổi khách hỏi.
  const nowVN = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' });
  const [from, to] = PERIOD_RANGES[period] || ['00:00', '24:00'];
  const results = await Promise.all(dates.map((date) => checkAvailableSlots({ specialty, date })));
  return results.map((r, i) => {
    const [y, m, d] = dates[i].split('-');
    const label = `${describeDate(dates[i]).match(/\((.+)\)/)[1]} ${d}/${m}/${y}`;
    if (r.error || !r.doctors) return `- ${label}: ${r.error || r.message}`;
    const docs = r.doctors.map((d) => {
      const inPeriod = d.freeSlots.filter((t) => t >= from && t < to);
      const free = inPeriod.filter((t) => dates[i] !== todayVN || t > nowVN);
      return `${d.doctorName}: ${free.length ? slotRanges(free) : inPeriod.length ? 'đã qua giờ khám' : 'hết chỗ'}`;
    });
    return `- ${label}${PERIOD_RANGES[period] ? ` (buổi ${period})` : ''}: ${docs.join('; ')}${r.sundayNote ? ' (Chủ nhật: chỉ khám theo hẹn trước, cần bác sĩ đồng ý)' : ''}`;
  });
}

const BOOKING_INTENT_RE = /đặt (?:lịch|hẹn|khám|cho|giúp|giùm|luôn|hộ)|đặt được không|book/i;
// Triệu chứng toàn thân — không đủ để đổi khoa đã gợi ý theo triệu chứng cụ thể trước đó.
const GENERAL_SYMPTOM_RE = /^(?:sốt|ho|mệt mỏi|ớn lạnh|rét run|cảm cúm|cúm|bị cảm|cảm lạnh)$/;

// Khách hỏi đúng 1 khung giờ: trả lời thẳng khung đó, kín thì gợi ý giờ trống gần nhất.
async function timeSlotReply({ specialty, date, time, todayVN, loggedIn }) {
  const [y, m, d] = date.split('-');
  const label = `${time} ngày ${d}/${m}/${y} khoa ${specialty}`;
  const nowVN = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' });
  const cta = loggedIn
    ? 'Bạn có muốn mình đặt lịch giúp luôn không?'
    : 'Bạn đăng nhập tại /tai-khoan.html rồi nhắn lại để mình đặt giúp, hoặc tự đặt tại /dat-lich.html.';
  const { doctors } = await getAvailableSlots({ specialty, date });
  const upcoming = (t) => date !== todayVN || t > nowVN;
  const free = upcoming(time) ? doctors.filter((doc) => doc.freeSlots.includes(time)).map((doc) => doc.doctorName) : [];
  if (free.length) return `Khung ${label} còn trống với: ${free.join(', ')}. ${cta}`;
  const nearest = [...new Set(doctors.flatMap((doc) => doc.freeSlots))].filter(upcoming)
    .sort((a, b) => Math.abs(toMinutes(a) - toMinutes(time)) - Math.abs(toMinutes(b) - toMinutes(time))).slice(0, 3).sort();
  const reason = upcoming(time) ? 'đã kín' : 'đã qua';
  return nearest.length
    ? `Khung ${label} ${reason}. Giờ còn trống gần nhất hôm đó: ${nearest.join(', ')}. ${cta}`
    : `Khung ${label} ${reason} và ngày này không còn giờ trống. Bạn chọn ngày khác nhé.`;
}
const toMinutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

// Chuyên khoa đang bàn: ưu tiên tin mới, rồi lần ngược lịch sử (tin khách trước, câu trả lời trợ lý sau).
function specialtyFromConversation(message, turns) {
  const fromMessage = detectSpecialty(message);
  if (fromMessage) return fromMessage.specialty;
  // Trẻ em / mang thai quyết định chuyên khoa cho cả hội thoại, xét mọi lượt của khách.
  const userTurns = turns.filter((t) => t.role === 'user').reverse().map((t) => detectSpecialty(normalizeMessage(t.content).text));
  const person = userTurns.find((s) => s && s.byPerson);
  if (person) return person.specialty;
  // Chuyên khoa trợ lý vừa gợi ý; bỏ qua câu nhắc từ 2 khoa trở lên (bảng giá, danh sách khoa).
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role !== 'assistant') continue;
    const named = SPECIALTIES.filter((s) => new RegExp(s.replace(/\s*–\s*/g, '\\s*[–-]\\s*'), 'i').test(turns[i].content));
    if (named.length === 1) return named[0];
  }
  const fromUser = userTurns.find(Boolean);
  return fromUser ? fromUser.specialty : null;
}

// Tin gần nhất của khách có triệu chứng thuộc chuyên khoa đang bàn — làm lý do cho "tại sao khám khoa này".
function symptomSource(specialty, message, turns) {
  // Bỏ tên khoa khỏi câu, không thì lý do thành "vì bạn kể tai, mũi, họng".
  const texts = [message, ...turns.filter((t) => t.role === 'user').reverse().map((t) => normalizeMessage(t.content).text)]
    .map((t) => t.replace(/tai\s*[–-]?\s*mũi\s*[–-]?\s*họng|răng\s*[–-]?\s*hàm\s*[–-]?\s*mặt/giu, ' '));
  for (const text of texts) {
    const detected = detectSpecialty(text);
    if (detected && detected.specialty === specialty && (detected.byPerson || symptomKeywords(detected).length)) return detected;
  }
  return { specialty, keywords: [] };
}

// Trả lời "tại sao khám khoa X" / "khoa khác được không" theo chuyên khoa và triệu chứng đã bàn.
function specialtyFollowUpReply(kind, specialty, named, message, turns, lastAssistantText = '') {
  const source = symptomSource(specialty, message, turns);
  const reason = explainSpecialty(source);
  const askSlots = `Bạn có muốn mình xem lịch trống khoa ${specialty} không?`;
  const full = named === specialty || (kind === 'why' && !named)
    ? `${reason} Còn nguyên nhân cụ thể thì bác sĩ cần thăm khám trực tiếp mới xác định được. ${askSlots}`
    : null;
  // Khách hỏi lại lần nữa — nói gọn, khác chữ.
  if (lastAssistantText && sameReply(full || reason, lastAssistantText)) {
    const keywords = symptomKeywords(source);
    const missing = specialty === 'Nội tổng quát' ? missingDepartmentFor(keywords) : null;
    const what = keywords.length ? keywords.join(', ') : 'vấn đề của bạn';
    return [
      missing
        ? `Nói gọn lại: phòng khám không có bác sĩ chuyên ${missing}, nên bác sĩ Nội tổng quát (khám chung cho người lớn) sẽ khám ${what} cho bạn trước.`
        : `Nói gọn lại: ${what} thuộc đúng chuyên môn của khoa ${specialty}, nên khám ở đó là phù hợp nhất.`,
      'Nếu khám xong cần điều trị chuyên sâu hoặc chưa đỡ, bác sĩ sẽ hướng dẫn bước tiếp theo và giới thiệu nơi khám phù hợp.',
      askSlots,
    ].join(' ');
  }
  if (full) return full;
  return [
    named && named !== specialty
      ? `Khoa ${named} ${SPECIALTY_SCOPE[named]}, không phải khoa phù hợp nhất với triệu chứng bạn kể.`
      : `Phòng khám có 6 chuyên khoa: ${SPECIALTIES.join(', ')}.`,
    reason,
    'Bạn vẫn có thể chọn khoa khác khi đặt lịch, nhưng bác sĩ khoa đó có thể sẽ chuyển bạn về đúng khoa nên đi đúng khoa ngay từ đầu sẽ đỡ mất thời gian.',
    askSlots,
  ].join(' ');
}

// ---------- Đặt lịch qua chat do code điều khiển (khách đã đăng nhập) ----------
// Gom thông tin từ các tin của khách, hỏi phần thiếu, tra giờ trống, tóm tắt rồi đặt khi khách xác nhận.
// Bản tóm tắt khớp isSummary trong index.html để hiện 3 nút.
const BOOKING_SUMMARY_HEAD = 'Mình tóm tắt thông tin đặt lịch:';
const BOOKING_DONE_RE = /^(?:Đặt lịch thành công|Đã gửi yêu cầu khám Chủ nhật|Mình đã huỷ yêu cầu đặt lịch)/;
const CONFIRM_RE = /xác nhận|đúng rồi|đồng ý|chốt|đặt (?:đi|luôn|giúp|nhé)|^\s*(?:ok\p{L}*|oke|có|ừ+|vâng|dạ|được|đúng)\b/iu;
const CANCEL_RE = /không (?:muốn )?đặt|(?:huỷ|hủy) (?:yêu cầu|đặt|việc đặt)|^\s*thôi(?: không đặt nữa| bỏ qua)?\s*[.!]*$|từ chối/i;
const FLOW_PROMPT_RE = /^(?:Để đặt lịch, mình cần thêm|Mình đã ghi nhận)/;
const EDIT_RE = /sửa|đổi|thay|nhầm|sai/i;
const GENDER_LABEL = { nam: 'Nam', nu: 'Nữ', khac: 'Khác' };
const isoToVN = (iso) => iso.split('-').reverse().join('/');

function parseSummary(text) {
  const field = (label) => (text.match(new RegExp(`- ${label}: (.+)`)) || [])[1];
  const date = field('Ngày khám');
  const gender = field('Giới tính');
  return {
    specialty: field('Chuyên khoa'),
    date: date && date.match(/(\d{2})\/(\d{2})\/(\d{4})/).slice(1).reverse().join('-'),
    time: field('Giờ khám'),
    fullName: field('Họ tên'),
    phone: field('Số điện thoại'),
    age: Number(field('Tuổi')),
    gender: Object.keys(GENDER_LABEL).find((k) => GENDER_LABEL[k] === gender),
    note: field('Lý do khám'),
  };
}

async function bookingFlowReply({ msg, userText, turns, user, todayVN, lastAssistantText }) {
  const lastIsSummary = lastAssistantText.startsWith(BOOKING_SUMMARY_HEAD);
  const lastIsFlow = lastIsSummary || FLOW_PROMPT_RE.test(lastAssistantText);
  if (lastIsFlow && CANCEL_RE.test(msg)) {
    return 'Mình đã huỷ yêu cầu đặt lịch này — chưa có lịch nào được đặt. Bạn cần mình hỗ trợ gì thêm không?';
  }
  if (lastIsSummary && CONFIRM_RE.test(msg) && !EDIT_RE.test(msg)) {
    const result = await bookAppointmentTool(parseSummary(lastAssistantText), user);
    return result.success
      ? `${result.message} Bạn xem và quản lý lịch ở mục "Tất cả lịch hẹn của tôi" tại /dat-lich.html.`
      : `Chưa đặt được lịch: ${result.error} Bạn nhắn thông tin cần đổi (vd: đổi sang 10h, hoặc ngày khác) để mình đặt lại nhé.`;
  }

  // Chỉ xét các tin từ sau lần đặt/huỷ gần nhất.
  let start = 0;
  turns.forEach((t, i) => { if (t.role === 'assistant' && BOOKING_DONE_RE.test(t.content)) start = i + 1; });
  const windowTurns = turns.slice(start);
  const userTexts = [...windowTurns.filter((t) => t.role === 'user').map((t) => t.content), userText];
  const ownDetails = parsePatientDetails(userText);
  const ownDate = parseBookingDate(msg, todayVN);
  const ownTime = parseBookingTime(msg);
  // Tin cụt ("không", "ok") ngay sau câu hỏi của luồng: nhắc lại phần còn thiếu.
  const shortReply = lastIsFlow && !lastIsSummary && msg.trim().split(/\s+/).length <= 3;
  const contributes = Object.keys(ownDetails).length || ownDate || ownTime || detectSpecialty(msg) || BOOKING_INTENT_RE.test(msg) || shortReply;
  const active = lastIsFlow || userTexts.some((t) => BOOKING_INTENT_RE.test(normalizeMessage(t).text) || parsePatientDetails(t).phone);
  if (lastIsFlow && EDIT_RE.test(msg) && !ownDate && !ownTime && !Object.keys(ownDetails).length && !detectSpecialty(msg)) {
    return 'Bạn muốn sửa mục nào: chuyên khoa, ngày, giờ, họ tên, số điện thoại, tuổi hay giới tính? Bạn nhắn luôn thông tin mới giúp mình (vd: đổi sang 10h, hoặc ngày 5/11).';
  }
  if (!active || !contributes) return null;

  // Gom thông tin, tin sau ghi đè tin trước.
  const info = {};
  const problems = [];
  for (const raw of userTexts) {
    const text = normalizeMessage(raw).text;
    Object.assign(info, parsePatientDetails(raw));
    for (const [key, value] of [['date', parseBookingDate(text, todayVN)], ['time', parseBookingTime(text)]]) {
      if (!value) continue;
      if (typeof value === 'string') info[key] = value;
      else if (raw === userText) problems.push(value.invalid);
      else delete info[key];
    }
    const detected = detectSpecialty(text);
    if (detected && symptomKeywords(detected).length && !BOOKING_INTENT_RE.test(text)) info.note = raw.trim().slice(0, 200);
  }
  info.specialty = specialtyFromConversation(msg, windowTurns) || specialtyFromConversation(msg, turns);
  if (info.date && info.date < todayVN) {
    problems.push(`ngày ${isoToVN(info.date)} đã qua`);
    delete info.date;
  }
  if (info.date && isSundayISO(info.date)) {
    problems.push(`${isoToVN(info.date)} là Chủ nhật — Chủ nhật chỉ khám theo hẹn trước với 1 bác sĩ cụ thể, đặt chậm nhất Thứ 3 tuần đó (bạn đặt tại /dat-lich.html để chọn bác sĩ)`);
    delete info.date;
  }
  if (info.phone && !/^0\d{8,10}$/.test(info.phone)) {
    problems.push(`số điện thoại ${info.phone} chưa đúng (cần 9-11 chữ số, bắt đầu bằng 0)`);
    delete info.phone;
  }
  if (info.age !== undefined && !(info.age >= 0 && info.age <= 120)) {
    problems.push(`tuổi ${info.age} không hợp lệ`);
    delete info.age;
  }
  // Giờ khách chọn phải còn trống thật (và chưa qua nếu là hôm nay).
  if (info.specialty && info.date && info.time) {
    const { doctors } = await getAvailableSlots({ specialty: info.specialty, date: info.date });
    const nowVN = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' });
    const upcoming = (t) => info.date !== todayVN || t > nowVN;
    if (!(upcoming(info.time) && doctors.some((d) => d.freeSlots.includes(info.time)))) {
      const nearest = [...new Set(doctors.flatMap((d) => d.freeSlots))].filter(upcoming)
        .sort((a, b) => Math.abs(toMinutes(a) - toMinutes(info.time)) - Math.abs(toMinutes(b) - toMinutes(info.time))).slice(0, 3).sort();
      problems.push(`khung ${info.time} ngày ${isoToVN(info.date)} khoa ${info.specialty} ${upcoming(info.time) ? 'đã kín' : 'đã qua'}`
        + (nearest.length ? ` (giờ còn trống gần nhất: ${nearest.join(', ')})` : ' và ngày này không còn giờ trống'));
      delete info.time;
    }
  }

  const missing = [
    !info.specialty && 'triệu chứng hoặc chuyên khoa muốn khám', !info.date && 'ngày khám', !info.time && 'giờ khám',
    !info.fullName && 'họ tên người khám', !info.phone && 'số điện thoại', info.age === undefined && 'tuổi', !info.gender && 'giới tính',
  ].filter(Boolean);
  const problemText = problems.length ? `Lưu ý: ${problems.join('; ')}. ` : '';
  if (missing.length) {
    const got = [
      info.specialty && `chuyên khoa ${info.specialty}`, info.date && `ngày ${isoToVN(info.date)} (${describeDate(info.date).replace(/^.*\(|\)$/g, '')})`,
      info.time && `giờ ${info.time}`, info.fullName && `họ tên ${info.fullName}`, info.phone && `số điện thoại ${info.phone}`,
      info.age !== undefined && `${info.age} tuổi`, info.gender && `giới tính ${GENDER_LABEL[info.gender]}`,
    ].filter(Boolean);
    return [
      got.length ? `Mình đã ghi nhận: ${got.join(', ')}.` : 'Để đặt lịch, mình cần thêm vài thông tin.',
      problemText + `Bạn cho mình thêm ${missing.join(', ')} nhé.`,
    ].join(' ');
  }
  return [
    BOOKING_SUMMARY_HEAD,
    `- Chuyên khoa: ${info.specialty}`,
    `- Ngày khám: ${isoToVN(info.date)} (${describeDate(info.date).replace(/^.*\(|\)$/g, '')})`,
    `- Giờ khám: ${info.time}`,
    `- Họ tên: ${info.fullName}`,
    `- Số điện thoại: ${info.phone}`,
    `- Tuổi: ${info.age}`,
    `- Giới tính: ${GENDER_LABEL[info.gender]}`,
    ...(info.note ? [`- Lý do khám: ${info.note}`] : []),
    'Lịch CHƯA được đặt — bạn bấm "OK, đặt lịch" hoặc trả lời "xác nhận" để mình đặt, hoặc nhắn mục cần sửa.',
    ...(problemText ? [problemText.trim()] : []),
  ].join('\n');
}

// Hai câu trả lời gần như trùng chữ (≥ 80% từ chung).
function sameReply(a, b) {
  const wordSet = (s) => new Set(s.toLowerCase().match(/[\p{L}\d]+/gu) || []);
  const x = wordSet(a);
  const y = wordSet(b);
  const common = [...x].filter((w) => y.has(w)).length;
  return common / Math.max(x.size, y.size, 1) >= 0.8;
}

// Tool đặt lịch thật — chỉ gọi khi đủ thông tin và khách đã xác nhận.
const bookAppointmentDeclaration = {
  name: 'book_appointment',
  description:
    'Đặt lịch khám CHÍNH THỨC vào hệ thống cho khách đang chat (khách phải đang đăng nhập). ' +
    'CHỈ gọi công cụ này sau khi đã tóm tắt đầy đủ thông tin đặt lịch cho khách và khách đã xác nhận rõ ràng ' +
    '(vd: "đúng rồi", "xác nhận", "ok đặt giúp mình") — TUYỆT ĐỐI KHÔNG tự gọi công cụ này khi khách chưa xác nhận.',
  parameters: {
    type: 'object',
    properties: {
      specialty: { type: 'string', description: 'Tên chuyên khoa, phải khớp đúng 1 trong các chuyên khoa đã liệt kê ở trên.' },
      doctorName: { type: 'string', description: 'Tên bác sĩ muốn khám, nếu khách có chỉ định cụ thể (không bắt buộc).' },
      date: { type: 'string', description: 'Ngày khám, định dạng YYYY-MM-DD.' },
      time: { type: 'string', description: 'Giờ khám, định dạng HH:MM, trong khung 07:00-20:30, mỗi 30 phút 1 slot (vd 07:00, 07:30, 08:00...).' },
      fullName: { type: 'string', description: 'Họ tên người đi khám (có thể khác tên tài khoản, vd đặt hộ người thân).' },
      phone: { type: 'string', description: 'Số điện thoại liên hệ, 9-11 chữ số.' },
      age: { type: 'integer', description: 'Tuổi của người đi khám.' },
      gender: { type: 'string', enum: GENDERS, description: 'Giới tính của người đi khám: nam, nu, hoặc khac.' },
      note: { type: 'string', description: 'Lý do khám / triệu chứng, nếu khách có kể (không bắt buộc).' },
    },
    required: ['specialty', 'date', 'time', 'fullName', 'phone', 'age', 'gender'],
  },
};

async function bookAppointmentTool(args, user) {
  if (!user) {
    return { error: 'Khách chưa đăng nhập nên chưa đặt lịch được. Hãy báo khách đăng nhập/đăng ký tại /tai-khoan.html rồi quay lại chat để đặt lịch tiếp.' };
  }
  try {
    let doctorId = null;
    if (args.doctorName) {
      const doc = await pool.query(
        "SELECT id, name FROM users WHERE role = 'doctor' AND name ILIKE $1 AND (specialty = $2 OR specialty IS NULL)",
        ['%' + args.doctorName + '%', args.specialty]
      );
      if (doc.rows.length === 0) {
        return { error: `Không tìm thấy bác sĩ tên "${args.doctorName}" thuộc chuyên khoa ${args.specialty}. Hỏi lại khách tên bác sĩ khác hoặc bỏ qua để không chỉ định bác sĩ cụ thể.` };
      }
      doctorId = doc.rows[0].id;
    }
    const appointmentId = await createAppointment({
      patientId: user.id,
      specialty: args.specialty,
      doctorId,
      date: args.date,
      time: args.time,
      note: args.note,
      contactName: args.fullName,
      contactPhone: args.phone,
      age: args.age,
      gender: args.gender,
    });
    return {
      success: true,
      appointmentId,
      message: isSundayISO(args.date)
        ? `Đã gửi yêu cầu khám Chủ nhật (mã #${appointmentId}). Lịch CHỈ có hiệu lực khi bác sĩ đã chọn đồng ý — khách sẽ thấy trạng thái đổi sang Đã xác nhận; nếu cần gấp nên gọi hotline 0974 755 333.`
        : `Đặt lịch thành công (mã #${appointmentId}), trạng thái: chờ nhân viên xác nhận.`,
    };
  } catch (e) {
    if (e instanceof BookingError) return { error: e.message };
    console.error(e);
    return { error: 'Có lỗi hệ thống khi đặt lịch, hãy báo khách thử lại sau hoặc gọi hotline 0974 755 333.' };
  }
}

// ---------- RAG: Retrieval ----------
// Tìm các đoạn tri thức gần nhất bằng cosine similarity (pgvector <=>), kèm tên tài liệu nguồn.
async function retrieveKnowledge(query, k = 4, taskType = 'RETRIEVAL_QUERY') {
  // Nhúng câu hỏi cần Gemini — không có GEMINI_API_KEY thì trả lời không kèm tài liệu.
  if (!process.env.GEMINI_API_KEY) return [];
  try {
    const queryVector = await embedText(query, taskType);
    const literal = toVectorLiteral(queryVector);
    const result = await pool.query(
      `SELECT c.id AS chunk_id, c.content, d.title, 1 - (c.embedding <=> $1::vector) AS similarity
       FROM kb_chunks c JOIN kb_documents d ON d.id = c.document_id
       WHERE c.embedding IS NOT NULL
       ORDER BY c.embedding <=> $1::vector
       LIMIT $2`,
      [literal, k]
    );
    return result.rows;
  } catch (e) {
    // Hết hạn ngạch nhúng lặp lại ở mọi lượt — chỉ in 1 dòng.
    console.error('Retrieval error:', String((e && e.message) || e).slice(0, 160));
    return []; // Retrieval lỗi không nên làm sập cả chatbot — chỉ mất phần ngữ cảnh bổ sung.
  }
}

// ---------- RAG nâng cao: Multi-Query + HyDE (gộp trong 1 lượt gọi model) ----------
// HyDE: câu trả lời giả định được nhúng như tài liệu (RETRIEVAL_DOCUMENT) để cùng không gian với các chunk.
// Chạy tuần tự trước câu trả lời nên mặc định TẮT với Ollama; AI_QUERY_EXPANSION=true/false để ép.
const QUERY_EXPANSION_ENABLED = process.env.AI_QUERY_EXPANSION
  ? process.env.AI_QUERY_EXPANSION === 'true'
  : llm.PROVIDER !== 'ollama';

// Prompt rút gọn cho model nhỏ: mặc định BẬT với Ollama; AI_COMPACT_PROMPT=true/false để ép.
const COMPACT_PROMPT = process.env.AI_COMPACT_PROMPT
  ? process.env.AI_COMPACT_PROMPT === 'true'
  : llm.PROVIDER === 'ollama';

async function expandQuery(message) {
  if (!QUERY_EXPANSION_ENABLED || !llm.isConfigured()) return { queries: [], hypotheticalAnswer: null };
  // Tin chỉ có số hoặc 1 từ thì không mở rộng — tiết kiệm lượt gọi.
  if ((message.match(/\p{L}+/gu) || []).length < 2) return { queries: [], hypotheticalAnswer: null };
  try {
    const parsed = await llm.generateJSON({
      prompt: `Câu hỏi gốc của bệnh nhân: "${message}"`,
      system: [
        'Bạn hỗ trợ cải thiện tìm kiếm cho 1 chatbot phòng khám. Câu hỏi gốc của bệnh nhân thường',
        'ngắn, thiếu ngữ cảnh hoặc có thể hiểu theo nhiều cách khác nhau. Với câu hỏi gốc được cung cấp:',
        '1. Sinh ra 3 GIẢ THUYẾT/DIỄN GIẢI KHÁC NHAU về điều bệnh nhân thực sự muốn hỏi — mỗi biến',
        '   thể khai thác 1 khả năng/góc nhìn khác nhau (không phải chỉ đổi từ ngữ mà vẫn giữ nguyên',
        '   đúng 1 ý gốc), để không bỏ sót tài liệu liên quan tới cách hiểu mà bệnh nhân không nói rõ.',
        '2. Viết 1 đoạn "câu trả lời giả định" ngắn (2-3 câu) — hình dung nếu có 1 tài liệu y tế trả lời',
        '   đúng câu hỏi này thì nó sẽ viết như thế nào, không cần đúng sự thật, chỉ cần đúng văn phong.',
      ].join('\n'),
      schema: {
        type: 'object',
        properties: {
          queries: { type: 'array', items: { type: 'string' } },
          hypotheticalAnswer: { type: 'string' },
        },
        required: ['queries', 'hypotheticalAnswer'],
      },
    });
    return {
      queries: Array.isArray(parsed.queries) ? parsed.queries.filter((q) => typeof q === 'string').slice(0, 3) : [],
      hypotheticalAnswer: typeof parsed.hypotheticalAnswer === 'string' ? parsed.hypotheticalAnswer : null,
    };
  } catch (e) {
    console.error('Query expansion error:', e);
    // Lỗi (kể cả hết quota) thì tìm bằng câu hỏi gốc.
    return { queries: [], hypotheticalAnswer: null };
  }
}

// Retrieval cho câu gốc + các biến thể + HyDE, mỗi đoạn giữ điểm cao nhất, lấy top-k chung.
async function retrieveKnowledgeExpanded(message, k = 4) {
  const { queries, hypotheticalAnswer } = await expandQuery(message);
  const searchTexts = [message, ...queries];

  const resultsPerText = await Promise.all([
    ...searchTexts.map((text) => retrieveKnowledge(text, k, 'RETRIEVAL_QUERY')),
    ...(hypotheticalAnswer ? [retrieveKnowledge(hypotheticalAnswer, k, 'RETRIEVAL_DOCUMENT')] : []),
  ]);

  const bestByChunk = new Map();
  for (const rows of resultsPerText) {
    for (const row of rows) {
      const existing = bestByChunk.get(row.chunk_id);
      if (!existing || row.similarity > existing.similarity) {
        bestByChunk.set(row.chunk_id, row);
      }
    }
  }

  return [...bestByChunk.values()].sort((a, b) => b.similarity - a.similarity).slice(0, k);
}

// Chatbot công khai — không bắt buộc đăng nhập; có Bearer token thì bật đặt lịch và tra dữ liệu cá nhân.
router.post('/chat', optionalAuthenticate, async (req, res) => {
  if (!llm.isConfigured()) {
    return res.status(503).json({ error: llm.NOT_CONFIGURED_ERROR });
  }
  try {
    const { message, history, conversationId } = req.body || {};
    const userText = typeof message === 'string' ? message.trim() : '';
    let convId = req.user && Number.isInteger(Number(conversationId)) ? Number(conversationId) : null;

    // Tin trống / chỉ dấu câu: trả lời hướng dẫn ngay, không gọi AI, không lưu lịch sử.
    if (isBlankMessage(userText)) {
      return res.json({
        reply: 'Mình chưa nhận được nội dung nào từ bạn. Bạn nhập câu hỏi hoặc thông tin cần gửi nhé — ví dụ: "Tôi bị đau họng, nên khám khoa nào?" hoặc "Tôi muốn đặt lịch khám răng ngày mai".',
        conversationId: convId,
      });
    }
    if (userText.length > MAX_MESSAGE_LENGTH) {
      return res.json({
        reply: `Tin nhắn của bạn dài quá (${userText.length} ký tự, tối đa ${MAX_MESSAGE_LENGTH}). Bạn tóm tắt ngắn lại giúp mình nhé.`,
        conversationId: convId,
      });
    }

    // Đã đăng nhập: lấy lịch sử từ CSDL; không đúng chủ sở hữu thì coi như cuộc trò chuyện mới.
    let savedTurns = null;
    if (convId) {
      const owned = await pool.query("SELECT id FROM chat_conversations WHERE id = $1 AND user_id = $2 AND channel = 'main'", [convId, req.user.id]);
      if (owned.rows.length === 0) {
        convId = null;
      } else {
        const rows = await pool.query(
          'SELECT role, content FROM (SELECT id, role, content FROM chat_messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT $2) t ORDER BY id',
          [convId, HISTORY_TURNS_FOR_MODEL]
        );
        savedTurns = rows.rows;
      }
    }

    const historySource = savedTurns || (Array.isArray(history) ? history : []);
    const turns = historySource
      .filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string')
      .slice(-HISTORY_TURNS_FOR_MODEL);

    // Bản chuẩn hoá dùng cho nhận diện, RAG và gửi model; lịch sử vẫn lưu nguyên văn.
    const msg = normalizeMessage(userText).text;
    const reply = async (text) => {
      if (req.user) convId = await persistTurn(req.user.id, convId, userText, text);
      return res.json({ reply: text, conversationId: convId });
    };

    // Ý nghĩ tự sát/tự hại: trả lời an toàn cố định ở mọi chế độ.
    if (detectCrisis(msg)) {
      return reply('Mình rất tiếc khi bạn đang phải trải qua cảm giác này, và mình muốn bạn được an toàn. Nếu bạn đang có ý định làm hại bản thân, hãy gọi ngay cấp cứu 115 hoặc đến cơ sở y tế gần nhất, và báo cho một người thân hay bạn bè bạn tin tưởng để họ ở bên bạn lúc này. Bạn không phải đối mặt với chuyện này một mình — khi sẵn sàng, bạn có thể đặt lịch khám để bác sĩ hỗ trợ và giới thiệu chuyên gia phù hợp.');
    }
    // Đòi dữ liệu người khác / thông tin nội bộ / ghi đè hướng dẫn: từ chối cố định ở mọi chế độ.
    if (detectPrivacyRequest(msg)) {
      return reply('Mình không thể cung cấp thông tin cá nhân của người khác hay thông tin nội bộ của hệ thống. Mình chỉ hỗ trợ các việc về khám chữa bệnh: chuyên khoa phù hợp, giờ làm việc, giá khám và đặt lịch.');
    }
    if (COMPACT_PROMPT && detectInsult(msg)) {
      return reply('Mình xin lỗi nếu câu trả lời trước chưa giúp được bạn. Bạn cho mình biết bạn cần gì — triệu chứng, giá khám hay lịch trống — mình trả lời lại cho đúng nhé; hoặc gọi hotline 0974 755 333 để gặp nhân viên.');
    }
    // Kiểm tra trên văn bản gốc — bước thêm dấu biến "can" thành "cần".
    if (COMPACT_PROMPT && detectEnglish(userText)) return reply(englishReply(userText));

    const prepStart = Date.now();
    const [clinic, retrieved, examples] = await Promise.all([
      buildClinicContext(),
      retrieveKnowledgeExpanded(msg),
      findExamples(msg),
    ]);
    if (process.env.AI_DEBUG === 'true') console.log(`[chat] lấy ngữ cảnh CSDL + tìm tài liệu RAG + câu mẫu: ${((Date.now() - prepStart) / 1000).toFixed(1)}s`);
    const todayVN = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });

    // Dữ kiện tính tất định (chatAnalysis.js) — model chỉ diễn đạt lại.
    const facts = analyzeMessage(msg, todayVN).map((n) => `- ${n}`);
    // Đang đặt lịch dở (có số điện thoại, hoặc có tuổi khi đang thu thập thông tin) — các lối tắt bên dưới không cắt ngang.
    const inBookingFlow = turns.slice(-4).some((t) => /họ tên|số điện thoại|xác nhận|đặt lịch/i.test(t.content));
    const bookingDetails = facts.some((f) => /Số điện thoại/.test(f)) || (inBookingFlow && facts.some((f) => /Tuổi/.test(f)));
    const emergency = detectEmergency(msg);
    if (emergency.length) {
      facts.unshift(`- CẤP CỨU: khách nói "${emergency.join(', ')}" → câu ĐẦU TIÊN phải khuyên gọi cấp cứu 115 hoặc đến ngay cơ sở y tế gần nhất.`);
    }
    let slotQuery = detectSlotQuery(msg, todayVN);
    const lastAssistant = [...turns].reverse().find((t) => t.role === 'assistant');
    const lastAssistantText = lastAssistant ? lastAssistant.content : '';
    // Vừa xem lịch trống rồi chỉ nói ngày ("thứ 3") — tra lại đúng ngày đó.
    if (!slotQuery && /^Lịch còn trống khoa/.test(lastAssistantText) && !/\d{1,2}\s*(?:h|giờ|:)/.test(msg)
      && /thứ|chủ nhật|mai|ngày kia|hôm nay|\d{1,2}\s*[/.-]\s*\d{1,2}/.test(msg)) {
      slotQuery = detectSlotQuery(`${msg} còn trống không`, todayVN);
    }
    let suggested = detectSpecialty(msg);
    // Hội thoại về trẻ em/mang thai: tin sau chỉ nói triệu chứng vẫn thuộc Nhi/Sản, trừ khi khách nói rõ là chính mình.
    const userSpecialties = turns.filter((t) => t.role === 'user').reverse().map((t) => detectSpecialty(normalizeMessage(t.content).text));
    if (suggested && !suggested.byPerson && !/(?<!\p{L})(?:tôi|mình|em) (?:cũng )?(?:đang )?bị/u.test(msg)) {
      const person = userSpecialties.find((s) => s && s.byPerson);
      if (person) suggested = { ...person, keywords: suggested.keywords };
    }
    // Tin chỉ thêm triệu chứng toàn thân sau triệu chứng của 1 khoa cụ thể — giữ khoa đó.
    if (suggested && suggested.specialty === 'Nội tổng quát' && suggested.keywords.every((k) => GENERAL_SYMPTOM_RE.test(k))) {
      const earlier = userSpecialties.slice(0, 3).find((s) => s && !s.byPerson && s.specialty !== 'Nội tổng quát');
      if (earlier) suggested = { ...earlier, keywords: [...earlier.keywords, ...suggested.keywords] };
    }

    // ---- Trả lời cố định bằng code (chỉ với prompt rút gọn, không cắt ngang khi đang đặt lịch dở) ----
    const shortcutOk = COMPACT_PROMPT && !bookingDetails;
    if (shortcutOk && emergency.length) {
      return reply([
        `⚠️ Triệu chứng "${emergency.join(', ')}" có thể là dấu hiệu nguy hiểm — bạn hãy gọi cấp cứu 115 hoặc đến ngay cơ sở y tế gần nhất, đừng chờ đặt lịch.`,
        suggested ? `Khi tình trạng đã ổn định, bạn có thể tái khám chuyên khoa ${suggested.specialty} tại phòng khám.` : '',
      ].filter(Boolean).join('\n\n'));
    }
    const firstAid = shortcutOk ? detectFirstAid(msg) : null;
    if (firstAid === 'bite') {
      return reply('Bị chó, mèo cắn hoặc cào: bạn rửa ngay vết thương dưới vòi nước chảy với xà phòng khoảng 15 phút, sát trùng rồi băng nhẹ, và đến cơ sở y tế hoặc trung tâm y tế dự phòng càng sớm càng tốt để được tư vấn tiêm phòng dại (và uốn ván). Vết cắn sâu, chảy máu nhiều hay ở mặt, cổ, tay thì cần đi cấp cứu ngay. Phòng khám chưa có thông tin chính xác về dịch vụ tiêm phòng dại — bạn gọi hotline 0974 755 333 nếu muốn hỏi thêm.');
    }
    if (firstAid === 'burn') {
      return reply('Bỏng nhẹ: bạn xả vết bỏng dưới vòi nước mát (không dùng nước đá) khoảng 15–20 phút, tháo nhẫn, đồng hồ gần chỗ bỏng, rồi che bằng gạc sạch; không bôi kem đánh răng, nước mắm hay dầu và không chọc vỡ bóng nước. Bỏng rộng hơn lòng bàn tay, bỏng sâu (da trắng bệch hoặc cháy đen), bỏng ở mặt, bộ phận sinh dục, bỏng do điện, hoá chất hay bỏng ở trẻ nhỏ thì cần đến cơ sở y tế ngay hoặc gọi 115.');
    }
    // Chưa đăng nhập mà gửi thông tin người khám — lịch chưa được đặt; nói rõ để khách không tưởng đã xong.
    if (COMPACT_PROMPT && !req.user && bookingDetails && !emergency.length) {
      const specialty = specialtyFromConversation(msg, turns);
      return reply([
        'Mình đã nhận thông tin của bạn, nhưng lịch hẹn CHƯA được đặt: chatbot chỉ đặt lịch được cho tài khoản đã đăng nhập.',
        `Bạn đăng nhập hoặc đăng ký miễn phí tại /tai-khoan.html rồi nhắn lại${specialty ? ` chuyên khoa ${specialty}` : ' chuyên khoa'} và giờ muốn khám để mình đặt ngay, hoặc tự đặt tại /dat-lich.html.`,
      ].join(' '));
    }
    // Câu hỏi quanh việc đặt lịch phải trả lời trước nhánh nhắc đăng nhập; đặt cho người nhà khi đã đăng nhập thì để luồng đặt lịch xử lý.
    const bookingFaq = shortcutOk && !slotQuery ? detectBookingFaq(msg) : null;
    if (bookingFaq && !(bookingFaq === 'relative' && req.user)) return reply(BOOKING_FAQ_REPLIES[bookingFaq]);
    if (shortcutOk && !slotQuery && /ở đâu|địa chỉ/.test(msg) && detectHoursQuestion(msg)) {
      return reply('Phòng khám Đa khoa Đức Minh ở Phường Túc Duyên, TP. Thái Nguyên; làm việc 7:00–21:00 từ Thứ 2 đến Thứ 7 (khung giờ khám muộn nhất 20:30). Chủ nhật chỉ khám theo hẹn trước với 1 bác sĩ cụ thể. Hotline: 0974 755 333.');
    }
    if (COMPACT_PROMPT && !req.user && !emergency.length && !slotQuery && BOOKING_INTENT_RE.test(msg)) {
      const picked = lastAssistantText.match(/^Khung (\d{2}:\d{2} ngày [\d/]+ khoa .+?) còn trống/);
      const specialty = suggested ? suggested.specialty : specialtyFromConversation(msg, turns);
      return reply([
        picked ? `Khung ${picked[1]} vẫn đang trống.` : specialty ? `Chuyên khoa phù hợp là ${specialty}.` : '',
        'Để mình đặt lịch qua chat, bạn cần đăng nhập (hoặc đăng ký miễn phí) tại /tai-khoan.html — lịch hẹn được lưu vào tài khoản để bạn xem, đổi, huỷ và theo dõi trạng thái xác nhận, đồng thời tránh người lạ đặt lịch ảo.',
        'Đăng nhập xong bạn quay lại đây nhắn chuyên khoa và giờ muốn khám, mình đặt ngay; hoặc bạn tự đặt tại /dat-lich.html.',
      ].filter(Boolean).join(' '));
    }
    // Đã đăng nhập: tra dữ liệu cá nhân, rồi luồng đặt lịch do code điều khiển (mọi chế độ). Hỏi lịch trống chung chung thì để nhánh lịch trống.
    const ownData = req.user && req.user.role === 'patient' && !emergency.length ? detectOwnDataKind(msg) : null;
    if (ownData) return reply(await ownDataReply(ownData, msg, req.user, todayVN));
    if (req.user && !emergency.length && !(slotQuery && !parseBookingTime(msg))) {
      const flow = await bookingFlowReply({ msg, userText, turns, user: req.user, todayVN, lastAssistantText });
      if (flow) return reply(flow);
    }
    // Gần như trùng 1 câu mẫu cùng chuyên khoa → trả nguyên câu mẫu. Tin quá ngắn phụ thuộc ngữ cảnh nên bỏ qua.
    const topExample = examples[0];
    const sameSpecialty = (detectSpecialty(topExample ? topExample.question : '') || {}).specialty === (suggested || {}).specialty;
    if (shortcutOk && !slotQuery && topExample && topExample.direct && sameSpecialty && msg.split(/\s+/).length >= 3) {
      return reply(topExample.answer);
    }
    if (shortcutOk && !req.user && detectOwnDataQuestion(msg)) {
      return reply('Để xem đơn thuốc, hoá đơn, hồ sơ khám hay lịch hẹn của bạn, bạn cần đăng nhập tại /tai-khoan.html. Sau khi đăng nhập, bạn hỏi lại ở đây để mình tra cứu, hoặc xem trực tiếp ở trang Hồ sơ khám (/ho-so.html) và mục lịch hẹn ở /dat-lich.html.');
    }
    if (shortcutOk && !slotQuery && detectDoseQuestion(msg)) {
      return reply([
        detectPrescriptionQuestion(msg) ? 'Kháng sinh và thuốc kê đơn chỉ dùng khi bác sĩ đã khám và kê đơn — bạn đừng tự mua uống.' : '',
        detectDoseTimingQuestion(msg) ? 'Uống trước hay sau ăn, cách nhau bao lâu, uống chung với gì được là tuỳ từng thuốc — bạn làm đúng theo đơn của bác sĩ hoặc tờ hướng dẫn sử dụng, chưa rõ thì hỏi dược sĩ nơi bán thuốc.' : '',
        'Liều thuốc phụ thuộc tuổi, cân nặng, bệnh lý và các thuốc đang dùng nên mình không đưa liều cụ thể được. Bạn dùng đúng theo tờ hướng dẫn sử dụng hoặc hỏi bác sĩ, dược sĩ; trẻ em, phụ nữ có thai hay đang cho con bú cần hỏi bác sĩ trước khi dùng.',
        suggested ? `Nếu cần khám, chuyên khoa phù hợp là ${suggested.specialty}.` : '',
      ].filter(Boolean).join(' '));
    }
    if (shortcutOk && !slotQuery && (detectOffTopicTask(msg) || (!suggested && detectOffTopic(msg)))) {
      return reply('Mình là trợ lý của Phòng khám Đa khoa Đức Minh nên chỉ hỗ trợ được các việc về khám chữa bệnh thôi bạn nhé. Bạn cần hỏi về chuyên khoa, giờ làm việc hay đặt lịch khám không?');
    }
    if (shortcutOk && !slotQuery && detectOtherFacilityQuestion(msg)) {
      return reply([
        'Mình chỉ có thông tin về Phòng khám Đa khoa Đức Minh nên không đánh giá hay giới thiệu được cơ sở y tế khác.',
        suggested
          ? `Nếu bạn muốn khám tại Đức Minh, chuyên khoa phù hợp là ${suggested.specialty} — mình có thể giúp xem lịch trống.`
          : 'Nếu bạn muốn khám tại Đức Minh, mình có thể giúp tìm chuyên khoa và lịch trống.',
      ].join(' '));
    }
    // Chưa đăng nhập, vừa xem lịch trống rồi chọn giờ — tra lại đúng khoa + ngày của lịch vừa xem.
    const pickedTime = (facts.find((f) => /Giờ khách nói = (\d{2}:\d{2})/.test(f)) || '').match(/(\d{2}:\d{2})/);
    const shownSlots = lastAssistantText.match(/^Lịch còn trống khoa (.+?):[\s\S]*?(\d{2})\/(\d{2})\/(\d{4})/);
    if (shortcutOk && !req.user && !slotQuery && pickedTime && shownSlots && SPECIALTIES.includes(shownSlots[1])) {
      const dateNote = facts.find((f) => /= (\d{4}-\d{2}-\d{2})/.test(f));
      const date = dateNote ? dateNote.match(/(\d{4}-\d{2}-\d{2})/)[1] : `${shownSlots[4]}-${shownSlots[3]}-${shownSlots[2]}`;
      return reply(await timeSlotReply({ specialty: shownSlots[1], date, time: pickedTime[1], todayVN, loggedIn: false }));
    }
    const service = detectServiceQuestion(msg);
    if (shortcutOk && !slotQuery && service && !/gồm|bao gồm/.test(msg)) {
      return reply([
        `Mình chưa có thông tin chính xác về dịch vụ ${service} và giá của dịch vụ này tại phòng khám — bạn gọi hotline 0974 755 333 để được xác nhận trước nhé.`,
        suggested ? `Bạn có thể đặt lịch khám chuyên khoa ${suggested.specialty}; bác sĩ sẽ tư vấn và chỉ định nếu cần.` : 'Khi khám, nếu cần làm thêm dịch vụ nào bác sĩ sẽ chỉ định và báo chi phí trước.',
      ].join(' '));
    }
    if (shortcutOk && !slotQuery && detectNeedTestQuestion(msg)) {
      const testSpecialty = suggested ? suggested.specialty : specialtyFromConversation(msg, turns);
      return reply([
        'Có cần chụp phim, xét nghiệm hay siêu âm hay không là do bác sĩ quyết định sau khi khám trực tiếp, nên mình không trả lời thay được.',
        testSpecialty ? `Bạn đặt lịch khám chuyên khoa ${testSpecialty}; nếu cần làm thêm, bác sĩ sẽ chỉ định và báo chi phí trước.` : 'Khi khám, nếu cần làm thêm, bác sĩ sẽ chỉ định và báo chi phí trước.',
      ].join(' '));
    }
    const previousUserText = (turns.filter((t) => t.role === 'user').pop() || {}).content || '';
    if (shortcutOk && !slotQuery && detectLabResultQuestion(msg, normalizeMessage(previousUserText).text)) {
      return reply(`Mình không đọc được kết quả xét nghiệm thay bác sĩ: cùng một con số có thể bình thường hay bất thường tuỳ lúc đo (lúc đói hay sau ăn), đơn vị đo, tuổi và bệnh nền. Bạn mang phiếu kết quả đến khám chuyên khoa ${suggested && suggested.byPerson ? suggested.specialty : 'Nội tổng quát'} để bác sĩ giải thích và tư vấn nhé.`);
    }
    // Câu "giá đã gồm xét nghiệm/thuốc chưa", "trả góp" để quy trình chính.
    let price = detectPriceQuestion(msg);
    // Vừa trả lời giá, khách hỏi tiếp cụt: "sinh viên thì sao", "còn bhyt", "cả 2 thì sao".
    if (!price && /^Giá khám chuyên khoa|^Có bạn nhé — .*giảm/.test(lastAssistantText) && msg.split(/\s+/).length <= 6) {
      if (/cả (?:2|hai)|cộng dồn|gộp|cùng lúc/.test(msg)) price = { policy: true, discount: null, both: true };
      else if (/bhyt|bảo hiểm|sinh viên/.test(msg)) price = detectPriceQuestion(`${msg} còn bao nhiêu`);
    }
    // "vậy còn bao nhiêu" sau "sinh viên có giảm không" — lấy loại giảm giá khách vừa nhắc.
    if (price && !price.list && !price.policy && !price.discount) {
      const said = turns.filter((t) => t.role === 'user').slice(-4).map((t) => t.content.toLowerCase()).join(' ');
      price.discount = /bhyt|bảo hiểm/.test(said) ? 'bhyt' : /sinh viên/.test(said) ? 'sinh_vien' : null;
    }
    if (shortcutOk && !slotQuery && price && !/gồm|xét nghiệm|trả góp|giá thuốc/i.test(msg)) {
      const priceSpecialty = suggested ? suggested.specialty : specialtyFromConversation(msg, turns);
      return reply([priceReply(clinic, price, priceSpecialty), DOCTOR_WHO_RE.test(msg) ? doctorListReply(clinic, priceSpecialty) : ''].filter(Boolean).join('\n'));
    }
    const facility = detectFacilityInfo(msg);
    if (shortcutOk && !slotQuery && facility) return reply(FACILITY_REPLIES[facility]);
    const schedule = shortcutOk && !slotQuery ? await doctorScheduleReply(clinic, msg, `${lastAssistantText}\n${previousUserText}`) : null;
    if (schedule) return reply(schedule);
    const aboutDoctor = shortcutOk && !slotQuery ? doctorNameReply(clinic, msg) : null;
    if (aboutDoctor) return reply(aboutDoctor);
    const conversationSpecialty = suggested ? suggested.specialty : specialtyFromConversation(msg, turns);
    if (shortcutOk && !slotQuery && DOCTOR_WHO_RE.test(msg)) return reply(doctorListReply(clinic, conversationSpecialty));
    if (shortcutOk && !slotQuery && /(?:bao nhiêu|mấy) bác sĩ|số (?:lượng )?bác sĩ/.test(msg)) {
      return reply(`Phòng khám hiện có ${clinic.doctors.length} bác sĩ. ${doctorListReply(clinic, null)}`);
    }
    if (shortcutOk && !slotQuery && !suggested && /(?:mấy|bao nhiêu|những|các) (?:chuyên )?khoa(?! khác| nhi| sản| nội| da| răng| tai)/u.test(msg)) {
      return reply(`Phòng khám Đa khoa Đức Minh có ${SPECIALTIES.length} chuyên khoa: ${SPECIALTIES.join(', ')}. Bạn kể triệu chứng để mình gợi ý khoa phù hợp nhé.`);
    }
    // Khoa phòng khám không có — nói rõ và ai khám thay.
    const missingAsked = detectMissingDepartmentQuestion(msg);
    if (shortcutOk && !slotQuery && missingAsked) {
      const firstStop = ['Nhi khoa', 'Sản phụ khoa'].includes(conversationSpecialty) ? conversationSpecialty : 'Nội tổng quát';
      return reply(`Phòng khám Đa khoa Đức Minh hiện chưa có khoa ${missingAsked} riêng; các chuyên khoa hiện có: ${SPECIALTIES.join(', ')}. Các vấn đề về ${missingAsked} bạn có thể khám ban đầu ở chuyên khoa ${firstStop} (${clinic.describeSpecialty(firstStop)}); nếu cần khám chuyên sâu, bác sĩ sẽ tư vấn nơi khám tiếp phù hợp. Bạn có muốn mình xem lịch trống không?`);
    }
    const scopeAsked = detectSpecialtyScopeQuestion(msg);
    if (shortcutOk && !slotQuery && scopeAsked) {
      return reply(`Chuyên khoa ${scopeAsked} ${SPECIALTY_SCOPE[scopeAsked]} (${clinic.describeSpecialty(scopeAsked)}). Bạn kể triệu chứng để mình xem khoa này có phù hợp không nhé.`);
    }
    // "Có nguy hiểm không" — không tự đánh giá, chỉ nêu dấu hiệu cần đi khám sớm/cấp cứu.
    if (shortcutOk && !slotQuery && detectDangerQuestion(msg)) {
      return reply([
        'Mình không chẩn đoán hay đánh giá được mức độ nặng nhẹ qua tin nhắn — việc đó cần bác sĩ thăm khám trực tiếp.',
        'Bạn nên đi khám sớm nếu triệu chứng kéo dài vài ngày không đỡ, ngày càng nặng hơn hoặc kèm sốt; nếu đau dữ dội, khó thở, ngất hay chảy máu nhiều thì gọi cấp cứu 115 ngay.',
        conversationSpecialty ? `Chuyên khoa phù hợp để khám là ${conversationSpecialty} — bạn có muốn mình xem lịch trống không?` : '',
      ].filter(Boolean).join(' '));
    }
    const followUp = detectSpecialtyFollowUp(msg);
    const priorSpecialty = specialtyFromConversation('', turns);
    // "sao không khám nhi": "nhi" chỉ là tên khoa, không phải triệu chứng.
    const ownSymptoms = suggested && symptomKeywords(suggested).length > 0;
    const namedSpecialty = suggested && !ownSymptoms ? suggested.specialty : null;
    const followUpSpecialty = ownSymptoms ? suggested.specialty : priorSpecialty || namedSpecialty;
    // Mở đầu bằng "khám da liễu được không" không phải câu hỏi tiếp nối.
    if (shortcutOk && !slotQuery && followUp && followUpSpecialty && (priorSpecialty || ownSymptoms || followUp === 'why')) {
      return reply(specialtyFollowUpReply(followUp, followUpSpecialty, namedSpecialty, msg, turns, lastAssistantText));
    }
    if (shortcutOk && !slotQuery && conversationSpecialty && /khoa nào|nên khám (?:gì|ở khoa nào)|khám gì|chuyên khoa gì/i.test(msg)) {
      return reply(`Bạn nên khám chuyên khoa ${conversationSpecialty} (${clinic.describeSpecialty(conversationSpecialty)}). Bạn có muốn mình xem lịch trống không?`);
    }
    if (shortcutOk && !slotQuery && !conversationSpecialty && /khoa nào|nên khám (?:gì|ở đâu)|khám gì/i.test(msg)) {
      return reply(`Bạn kể giúp mình triệu chứng (khó chịu ở đâu, từ bao giờ) và người đi khám là người lớn, trẻ em hay người đang mang thai để mình gợi ý đúng khoa nhé. Phòng khám có ${SPECIALTIES.length} chuyên khoa: ${SPECIALTIES.join(', ')}.`);
    }
    if (shortcutOk && !slotQuery && /(?:huỷ|hủy|đổi|dời|sửa)[^.?!]{0,15}(?:lịch|giờ khám|ngày khám|sang ngày)/i.test(msg)) {
      return reply('Bạn đăng nhập rồi vào trang Đặt lịch (/dat-lich.html), mục "Tất cả lịch hẹn của tôi": bấm "Huỷ" để huỷ, hoặc chọn lịch để sửa ngày giờ (chỉ sửa được khi lịch đang chờ xác nhận hoặc đã xác nhận). Huỷ lịch trên hệ thống không mất phí; cần hỗ trợ thì gọi hotline 0974 755 333.');
    }

    const plainQuestion = shortcutOk && !slotQuery && !suggested;
    // Tin cụt mở đầu hội thoại; có lịch sử thì để model hiểu theo ngữ cảnh.
    if (plainQuestion && !turns.length && /^(?:ok\p{L}*|oke|vâng|dạ|ừ+|uh+|có|không|hả|gì|gì cơ|sao|sao cơ|không hiểu|nói lại(?: đi)?|bạn nói lại(?: đi)?|ê+|bot ơi|có ai không|test|abc|hi+|hihi+|haha+|hello|alo+|[\d\s.+-]+)[\s?!.]*$/iu.test(msg)) {
      return reply('Chào bạn! Mình là trợ lý ảo của Phòng khám Đa khoa Đức Minh. Bạn cần hỏi về chuyên khoa phù hợp với triệu chứng, giờ làm việc, giá khám hay đặt lịch khám?');
    }
    if (plainQuestion && detectIdentityQuestion(msg)) {
      return reply('Mình là trợ lý ảo (AI) của Phòng khám Đa khoa Đức Minh, giúp bạn tìm chuyên khoa phù hợp, xem giờ làm việc, lịch trống và đặt lịch khám. Mình không phải bác sĩ nên không thay được việc thăm khám trực tiếp.');
    }
    // Khung khám liên tục 07:00–20:30 (FIXED_SLOTS), không nghỉ trưa.
    if (plainQuestion && detectHoursQuestion(msg) && !detectHolidayQuestion(msg)) {
      return reply('Phòng khám làm việc 7:00–21:00 từ Thứ 2 đến Thứ 7, nhận khám liên tục cả buổi trưa (khung giờ khám muộn nhất 20:30). Chủ nhật không khám thường xuyên — chỉ khám theo hẹn trước với 1 bác sĩ cụ thể, đặt chậm nhất Thứ 3 tuần đó và cần bác sĩ đồng ý.');
    }
    if (plainQuestion && detectHolidayQuestion(msg)) {
      return reply('Lịch làm việc ngày lễ, Tết có thể thay đổi nên mình chưa có thông tin chính xác. Bạn gọi hotline 0974 755 333 để hỏi trước khi đến nhé. Ngày thường phòng khám làm việc 7:00–21:00, Thứ 2 đến Thứ 7.');
    }
    if (plainQuestion && !conversationSpecialty && isVagueComplaint(msg)) {
      return reply('Bạn đang đau hay khó chịu ở đâu, từ bao giờ, và có kèm sốt hay triệu chứng nào khác không? Bạn kể thêm để mình gợi ý đúng chuyên khoa nhé. Nếu đau dữ dội, khó thở hoặc ngất thì hãy gọi cấp cứu 115.');
    }
    // Không có khoa Mắt — kể cả với trẻ em.
    if (shortcutOk && !slotQuery && (!suggested || suggested.byPerson) && mentionsEye(msg)) {
      return reply('Phòng khám Đa khoa Đức Minh hiện chưa có chuyên khoa Mắt, bạn nên đến cơ sở chuyên khoa mắt để được khám. Nếu mắt đau nhiều, nhìn mờ đột ngột hoặc bị chấn thương thì cần đi khám ngay.');
    }

    if (slotQuery) {
      const specialty = specialtyFromConversation(msg, turns);
      // Ngày không có thật / đã qua.
      const badDate = facts.find((f) => /KHÔNG TỒN TẠI|ĐÃ QUA/.test(f));
      if (COMPACT_PROMPT && !emergency.length && !bookingDetails && (badDate || /hôm qua|hôm kia|tuần trước/.test(msg))) {
        const shown = badDate ? (badDate.match(/Ngày "([^"]+)"/) || [])[1] : null;
        return reply(`${shown ? `Ngày ${shown} ${/ĐÃ QUA/.test(badDate) ? 'đã qua' : 'không có trên lịch'}` : 'Ngày bạn hỏi đã qua'} nên không xem hay đặt lịch được. Bạn cho mình ngày khác (từ hôm nay ${todayVN.split('-').reverse().join('/')} trở đi) để mình xem lịch trống nhé.`);
      }
      const askedTime = (facts.find((f) => /Giờ khách nói = \d{2}:\d{2}/.test(f)) || '').match(/\d{2}:\d{2}/);
      if (COMPACT_PROMPT && !emergency.length && !bookingDetails && specialty && askedTime && slotQuery.dates.length === 1) {
        return reply(await timeSlotReply({ specialty, date: slotQuery.dates[0], time: askedTime[0], todayVN, loggedIn: !!req.user }));
      }
      const slotLines = specialty ? await slotFacts(specialty, slotQuery.dates, todayVN, slotQuery.period) : null;
      // Câu trả lời xác định hoàn toàn từ dữ liệu — code trả lời luôn.
      if (COMPACT_PROMPT && !emergency.length && !bookingDetails) {
        return reply(slotLines
          ? [
              `Lịch còn trống khoa ${specialty}:`,
              ...slotLines,
              req.user
                ? 'Bạn muốn chọn giờ nào? Mình có thể đặt lịch giúp bạn luôn.'
                : 'Bạn muốn chọn giờ nào? Bạn đăng nhập tại /tai-khoan.html để mình đặt giúp, hoặc tự đặt tại /dat-lich.html.',
            ].join('\n')
          : [
              askedTime ? 'Phòng khám nhận khám 7:00–21:00 từ Thứ 2 đến Thứ 7 (khung giờ khám muộn nhất 20:30).' : '',
              `Bạn muốn xem lịch trống của chuyên khoa nào? Phòng khám có: ${SPECIALTIES.join(', ')}.`,
            ].filter(Boolean).join(' '));
      }
      facts.push(
        ...(slotLines
          ? [
              `- LỊCH TRỐNG THẬT khoa ${specialty} (hệ thống vừa tra — KHÔNG cần gọi check_available_slots cho các ngày này):`,
              ...slotLines.map((l) => '  ' + l),
              '  → Báo lại đúng các khoảng giờ trên (gọn, theo từng bác sĩ), rồi hỏi khách muốn chọn giờ nào hoặc có muốn đặt lịch không.',
            ]
          : [`- Khách hỏi lịch trống nhưng CHƯA RÕ chuyên khoa → hỏi lại khách muốn khám chuyên khoa nào (${SPECIALTIES.join(', ')}).`])
      );
    }
    if (!req.user && BOOKING_INTENT_RE.test(msg)) {
      facts.push('- Khách muốn đặt lịch nhưng CHƯA ĐĂNG NHẬP → hướng dẫn khách đăng nhập/đăng ký tại /tai-khoan.html rồi quay lại chat, hoặc tự đặt tại /dat-lich.html.');
    }
    if (!slotQuery && suggested) {
      facts.push(`- CHUYÊN KHOA PHÙ HỢP: ${suggested.specialty} (vì khách nói "${suggested.keywords.join(', ')}") — ${clinic.describeSpecialty(suggested.specialty)}. Gợi ý ĐÚNG chuyên khoa này và chỉ nêu bác sĩ của chuyên khoa này.`);
      // Không để tài liệu RAG về trẻ em khiến model hỏi tuổi bé khi người lớn hỏi.
      if (suggested.specialty !== 'Nhi khoa') facts.push('- Người khám là NGƯỜI LỚN (khách không nhắc tới trẻ em) — không hỏi tuổi/cân nặng của bé.');
    }
    const missingDepartment = suggested && suggested.specialty === 'Nội tổng quát' ? missingDepartmentFor(symptomKeywords(suggested)) : null;
    if (!slotQuery && missingDepartment) {
      facts.push(`- Phòng khám CHƯA CÓ khoa ${missingDepartment} riêng → nói rõ bác sĩ Nội tổng quát khám ban đầu, cần thì tư vấn nơi khám chuyên sâu.`);
    }
    if (followUp && followUpSpecialty) {
      facts.push(`- Khách hỏi lại về chuyên khoa → giải thích lý do, KHÔNG lặp lại câu trả lời trước: ${explainSpecialty(symptomSource(followUpSpecialty, msg, turns))}`);
    }
    if (missingAsked) {
      facts.push(`- Phòng khám CHƯA CÓ khoa ${missingAsked} → nói rõ, nêu 6 chuyên khoa hiện có và mời khám ban đầu ở Nội tổng quát.`);
    }
    const prescription = detectPrescriptionQuestion(msg);
    if (prescription) {
      facts.push('- Khách hỏi về KHÁNG SINH/THUỐC KÊ ĐƠN → nói rõ: chỉ dùng khi bác sĩ đã khám và kê đơn, không tự mua uống; không nêu tên hay liều kháng sinh nào; mời khách đi khám.');
    }
    if (isVagueComplaint(msg)) {
      facts.push('- Khách chỉ than CHUNG CHUNG, chưa rõ triệu chứng → hỏi lại cụ thể: khó chịu/đau ở đâu, từ bao giờ, có sốt hay triệu chứng nào khác. CHƯA hỏi số điện thoại hay thông tin đặt lịch.');
    }
    if (mentionsEye(msg)) {
      facts.push('- Phòng khám CHƯA CÓ chuyên khoa Mắt → nói rõ điều này và khuyên khách đến cơ sở chuyên khoa mắt; không tự nêu tên cơ sở cụ thể nào.');
    }
    const analysisBlock = facts.length
      ? ['KẾT QUẢ KIỂM TRA TỰ ĐỘNG tin nhắn MỚI NHẤT của khách (do hệ thống tính, ĐÚNG TUYỆT ĐỐI — tin theo đây, không tự đếm/tính lại):', ...facts].join('\n')
      : '';

    const examplesBlock = examples.length
      ? [
          'CÂU TRẢ LỜI MẪU do phòng khám soạn cho các câu hỏi tương tự — bắt chước nội dung và cách trả lời:',
          ...examples.map((e) => `Khách: ${e.question}\nTrợ lý: ${e.answer}`),
        ].join('\n\n')
      : '';

    const knowledgeBlock = retrieved.length
      ? [
          'Tài liệu tham khảo tìm được (có thể liên quan hoặc không, tự đánh giá; nếu dùng thì ghi "(Nguồn: <tên tài liệu>)" cuối câu):',
          ...retrieved.map((r) => `--- ${r.title} ---\n${r.content}`),
        ].join('\n\n')
      : 'Không tìm thấy tài liệu tham khảo nào liên quan trong cơ sở tri thức.';

    // Nêu thẳng tên tài liệu khớp nhất — model bám sát hơn so với 1 quy tắc chung chung.
    const topHit = retrieved[0];
    const groundingNote = topHit && topHit.similarity > 0.6
      ? `LƯU Ý QUAN TRỌNG: tài liệu khớp nhất với câu hỏi hiện tại là "${topHit.title}". Nếu câu hỏi liên quan tới triệu chứng hoặc nên khám chuyên khoa nào, PHẢI trả lời theo đúng tài liệu này — TUYỆT ĐỐI KHÔNG tự nêu ra 1 chuyên khoa khác không xuất hiện trong "Tài liệu tham khảo" ở trên.`
      : '';

    const isPatient = req.user?.role === 'patient';
    const patientTools = isPatient ? toolsForRole('patient').filter((t) => PATIENT_TOOL_NAMES.includes(t.declaration.name)) : [];
    const loginNote = req.user
      ? `Khách hiện ĐANG ĐĂNG NHẬP (tên: ${req.user.name || 'bệnh nhân'}) nên có thể đặt lịch trực tiếp qua chat bằng công cụ book_appointment.`
      : 'Khách CHƯA đăng nhập nên KHÔNG thể đặt lịch qua chat — nếu khách muốn đặt lịch, báo khách đăng nhập/đăng ký tại /tai-khoan.html trước rồi quay lại chat, hoặc tự đặt tại /dat-lich.html.';
    const patientNote = isPatient
      ? [
          'KHÁCH LÀ BỆNH NHÂN ĐÃ ĐĂNG NHẬP — ngoài hỏi đáp và đặt lịch, bạn còn tra cứu được dữ liệu CỦA CHÍNH họ bằng công cụ: my_appointments (lịch hẹn), my_records (hồ sơ khám, đơn thuốc, chẩn đoán), my_invoices (hoá đơn, đã thanh toán chưa), my_followups (lịch tái khám).',
          '- Khi khách hỏi về lịch hẹn/đơn thuốc/hoá đơn/tái khám của họ ("lịch của tôi", "đơn thuốc gần nhất", "tôi đã trả tiền chưa"...) PHẢI gọi công cụ tương ứng rồi mới trả lời; mọi số liệu, tên, ngày giờ, tiền, thuốc phải lấy từ kết quả công cụ, TUYỆT ĐỐI KHÔNG bịa hay đoán. Công cụ trả rỗng thì nói thẳng là chưa có dữ liệu.',
          '- Tiền viết dạng 1.500.000đ, ngày viết dạng dd/mm/yyyy. Xưng "mình", gọi khách là "bạn", không đoán giới tính qua tên.',
          '- Khi giải thích đơn thuốc: chỉ nhắc lại đúng thuốc và liều bác sĩ đã ghi, KHÔNG chẩn đoán, KHÔNG tự đổi liều hay kê thêm thuốc; nhắc hỏi lại bác sĩ nếu còn thắc mắc hoặc có dấu hiệu bất thường.',
          '- Bạn chỉ tra cứu được, không sửa dữ liệu: muốn thanh toán hoá đơn thì chỉ khách vào trang Hồ sơ khám (/ho-so.html) để quét mã QR.',
        ].join('\n')
      : '';

    const toolLines = [
      '- check_available_slots: tra khung giờ còn trống THẬT của 1 chuyên khoa vào 1 ngày.',
      '- book_appointment: đặt lịch THẬT, chỉ dùng khi khách đang đăng nhập và đã xác nhận.',
      ...patientTools.map((t) => `- ${t.declaration.name}: ${t.declaration.description}`),
    ];

    // Bản rút gọn: ít quy tắc, đánh số, phần kiểm tra tự động đặt CUỐI prompt (model nhỏ bám phần gần câu hỏi hơn).
    const compactPrompt = [
      'Bạn là trợ lý ảo của Phòng khám Đa khoa Đức Minh. Trả lời bằng tiếng Việt, ngắn gọn 2-4 câu, thân thiện. Xưng "mình", gọi khách là "bạn".',
      `Hôm nay là ${describeDate(todayVN)}.`,
      upcomingDaysNote(todayVN, 8),
      loginNote,
      '',
      clinic.text,
      '',
      knowledgeBlock,
      '',
      patientNote,
      '',
      'Công cụ:',
      ...toolLines,
      '',
      'QUY TẮC:',
      '1. Chỉ dùng dữ kiện có trong prompt này (thông tin phòng khám, kết quả kiểm tra tự động, kết quả công cụ, tài liệu). Không bịa giá, bác sĩ, giờ trống, thuốc.',
      '2. Không chẩn đoán bệnh thay bác sĩ. Tên thuốc/liều dùng chỉ nêu khi có trong "Tài liệu tham khảo", ghi (Nguồn: ...) và nhắc chỉ để tham khảo. Với trẻ em không nêu liều, khuyên cho bé đi khám.',
      // Không đặt cụm từ trong ngoặc kép: model nhỏ chép nguyên văn.
      '3. Không hứa hẹn làm việc gì sau đó: cần dữ liệu thì gọi công cụ ngay, thiếu thông tin thì hỏi lại đúng 1 câu. Không lặp lại nguyên văn câu của khách.',
      '4. Tin ngắn như "0912345678", "mai", "9 giờ", "nam", "ok" là câu trả lời cho câu bạn vừa hỏi — hiểu theo ngữ cảnh hội thoại.',
      '5. Đặt lịch qua chat (chỉ khi khách đang đăng nhập): hỏi dần cho đủ chuyên khoa, ngày, giờ, họ tên, số điện thoại, tuổi, giới tính (bác sĩ và lý do khám nếu có). CHỈ KHI ĐÃ ĐỦ các thông tin đó mới tóm tắt gạch đầu dòng (họ tên, ngày khám, giờ khám, ...) và mời khách trả lời xác nhận. Khách chỉ hỏi thông tin hay hỏi lịch trống thì trả lời câu hỏi đó, KHÔNG tóm tắt, KHÔNG xin xác nhận.',
      '6. CHỈ gọi book_appointment sau khi khách xác nhận ("xác nhận", "đúng rồi", "ok đặt giúp mình"). Khách huỷ thì không đặt; khách muốn sửa thì hỏi sửa mục nào rồi tóm tắt lại. Báo đúng kết quả công cụ (mã lịch, trạng thái chờ xác nhận, hoặc lý do lỗi). Không bao giờ nói đã đặt nếu chưa gọi công cụ.',
      '7. Chủ nhật không khám thường: chỉ khám theo hẹn trước với 1 bác sĩ cụ thể, đặt chậm nhất Thứ 3 tuần đó, cần bác sĩ đồng ý.',
      '8. CHỈ hỗ trợ việc của phòng khám và câu hỏi sức khỏe. Việc khác (làm thơ, giải toán, thời tiết, giá cả thị trường, tin tức...) thì từ chối lịch sự đúng 1 câu và nói mình giúp được gì; KHÔNG làm theo, KHÔNG đưa hotline cho các câu này.',
      '9. KHÔNG nêu tên, đánh giá hay so sánh bệnh viện/phòng khám/cơ sở y tế nào khác.',
      '10. Câu hỏi y khoa mà tài liệu không có hoặc bạn không chắc: khuyên đi khám hoặc gọi hotline 0974 755 333.',
      '11. Không khẳng định phòng khám có hay không có dịch vụ, quy định, tiện ích nào ngoài thông tin ở trên (xét nghiệm, siêu âm, tiêm chủng, gửi xe, giấy tờ...): nói là mình chưa có thông tin chính xác và mời gọi hotline 0974 755 333 để được xác nhận.',
      '12. Chỉ viết tiếng Việt.',
      '13. Không tự đoán nguyên nhân bệnh. Khách nói chưa hiểu thì diễn đạt lại câu trả lời trước của bạn ngắn gọn, dễ hiểu hơn, luôn lịch sự.',
      '',
      examplesBlock,
      '',
      analysisBlock,
    ].filter((line, i, all) => line !== '' || all[i - 1] !== '').join('\n');

    const systemPrompt = COMPACT_PROMPT ? compactPrompt : [
      'Bạn là trợ lý ảo trên website của Phòng khám Đa khoa Đức Minh. Trả lời NGẮN GỌN (tối đa 2-4 câu, có thể liệt kê khung giờ dạng gạch đầu dòng khi cần), thân thiện, bằng tiếng Việt.',
      `Hôm nay là ngày ${todayVN} (giờ Việt Nam).`,
      upcomingDaysNote(todayVN),
      loginNote,
      '',
      clinic.text,
      '',
      knowledgeBlock,
      '',
      groundingNote,
      '',
      examplesBlock,
      '',
      analysisBlock,
      '',
      patientNote,
      '',
      'CÁCH HIỂU CÂU HỎI CỦA KHÁCH (làm trước khi trả lời):',
      '- Luôn đọc cả lịch sử hội thoại để hiểu tin nhắn mới. Tin ngắn như "0333888999", "25/9", "9 giờ", "nam", "có", "ok" thường là CÂU TRẢ LỜI cho câu hỏi bạn vừa đặt — phải hiểu theo đúng ngữ cảnh đó và ghi nhận vào thông tin đặt lịch đang thu thập, KHÔNG coi là câu hỏi mới ngoài phạm vi.',
      '- Khách có thể gửi nhiều thông tin trong 1 tin (vd "ngày 25/9, 9 giờ, 0333888999 Tuân, 20 tuổi, nam"): tách đủ từng phần, ghi nhận phần đúng, chỉ hỏi lại phần còn thiếu hoặc sai.',
      '- Khi khách đổi ý (đổi ngày/giờ/chuyên khoa) thì cập nhật theo thông tin mới nhất, bỏ thông tin cũ bị thay thế.',
      '- Khi câu hỏi mơ hồ (vd chỉ nói "đặt lịch", "đau quá") hãy hỏi lại đúng 1 câu làm rõ, đừng đoán bừa và đừng trả lời lan man.',
      '- Nếu khách hỏi lại điều bạn đã trả lời hoặc nói "gì cơ", hãy diễn đạt lại ngắn gọn, dễ hiểu hơn thay vì lặp nguyên văn.',
      '',
      'KHI KHÁCH GỬI THÔNG TIN SAI, THIẾU HOẶC TRỐNG:',
      '- Dựa vào "KẾT QUẢ KIỂM TRA TỰ ĐỘNG" ở trên: phần nào ghi HỢP LỆ thì ghi nhận luôn; phần nào KHÔNG HỢP LỆ / ĐÃ QUA / NGOÀI giờ khám thì nói RÕ đó là thông tin nào, sai ở đâu (vd "số 0123456 mới có 7 chữ số, cần 9-11 chữ số") rồi xin khách gửi lại đúng phần đó. Không hỏi lại những phần đã hợp lệ.',
      '- Nếu khách chỉ gửi 1 phần (vd chỉ gửi số điện thoại) thì ghi nhận phần đó và hỏi tiếp phần còn thiếu, đừng bắt đầu lại từ đầu. Khi nào đủ thông tin mới tóm tắt.',
      '- Nếu khách gửi lại đúng thông tin sai như cũ, đừng lặp nguyên câu trước — nói ngắn gọn khác đi và cho 1 ví dụ đúng định dạng (vd số điện thoại: 0912345678).',
      '- Nếu tin nhắn khó hiểu/không rõ nghĩa, nói thẳng là bạn chưa hiểu và hỏi lại khách muốn hỏi về việc gì (giờ làm việc, chuyên khoa, đặt lịch...) kèm 1-2 gợi ý; TUYỆT ĐỐI KHÔNG trả lời "không có thông tin" hay đẩy khách sang hotline khi tin nhắn thực ra là câu trả lời cho câu hỏi của bạn.',
      '- Nếu công cụ book_appointment trả về lỗi, báo đúng lý do lỗi đó bằng lời dễ hiểu và hỏi lại đúng thông tin cần sửa.',
      '',
      `Bạn có ${2 + patientTools.length} công cụ:`,
      '- check_available_slots: tra cứu khung giờ khám còn trống THẬT trong hệ thống — luôn dùng công cụ này khi khách hỏi về lịch trống, đừng tự đoán.',
      '- book_appointment: đặt lịch khám THẬT vào hệ thống, chỉ dùng được khi khách đang đăng nhập.',
      ...patientTools.map((t) => `- ${t.declaration.name}: ${t.declaration.description}`),
      '',
      'Quy trình đặt lịch qua chat (làm đúng thứ tự, không bỏ bước):',
      '1. Khi khách muốn AI đặt lịch giúp (không chỉ hỏi thông tin), thu thập đủ: chuyên khoa, ngày, giờ, tên bác sĩ muốn khám (nếu có), họ tên người đi khám, số điện thoại liên hệ, tuổi, giới tính, lý do khám (nếu khách kể). Hỏi từng phần còn thiếu, đừng hỏi dồn hết 1 lúc nếu khách chưa cung cấp đủ.',
      '2. Dùng check_available_slots để xác nhận khung giờ khách chọn còn trống trước khi tóm tắt.',
      '3. TÓM TẮT LẠI đầy đủ thông tin (chuyên khoa, bác sĩ, ngày giờ, họ tên, sđt, tuổi, giới tính, lý do khám) dạng gạch đầu dòng, rồi KẾT THÚC bằng đúng câu: Bạn trả lời "xác nhận" để mình đặt lịch, hoặc cho mình biết thông tin cần sửa nhé. (Nói rõ lịch CHƯA được đặt cho tới khi khách xác nhận.)',
      '4. CHỈ SAU KHI khách xác nhận rõ ràng (vd "xác nhận", "đúng rồi", "ok đặt giúp mình", "chốt đi") mới được gọi book_appointment. Yêu cầu chỉnh sửa hoặc kiểm tra lại (vd "check lại đi", "sai rồi") KHÔNG phải xác nhận. Khi khách đã xác nhận thì GỌI book_appointment NGAY trong lượt trả lời đó, không hỏi xác nhận thêm lần nữa. TUYỆT ĐỐI KHÔNG gọi book_appointment khi chưa có xác nhận, và KHÔNG tự bịa ra việc "đã đặt lịch thành công" nếu chưa thực sự gọi công cụ này.',
      '4b. Sau bản tóm tắt khách có 3 lựa chọn (giao diện hiện 3 nút): "Xác nhận, đặt lịch giúp mình" -> đặt ngay theo mục 4; "Mình không muốn đặt lịch nữa, huỷ yêu cầu này" (hoặc nói tương tự: từ chối, thôi, không đặt nữa, huỷ) -> KHÔNG gọi book_appointment, xác nhận ngắn gọn rằng chưa có lịch nào được đặt, bỏ thông tin đặt lịch đang thu thập và hỏi khách cần hỗ trợ gì khác; "Mình muốn sửa lại thông tin đặt lịch" -> hỏi khách muốn sửa mục nào (chuyên khoa, ngày giờ, bác sĩ, họ tên, số điện thoại, tuổi, giới tính hay lý do khám), cập nhật rồi tóm tắt lại từ đầu và kết thúc bằng câu xin xác nhận như mục 3.',
      '5. Sau khi book_appointment trả kết quả, báo lại đúng kết quả đó cho khách (kể cả khi lỗi, vd giờ đã có người đặt — thì xin lỗi và mời khách chọn giờ khác). Khi đặt thành công, nói rõ mã lịch, ngày giờ, trạng thái "chờ nhân viên xác nhận" và chỉ khách xem lịch tại mục "Tất cả lịch hẹn của tôi" ở trang /dat-lich.html (hoặc "Lịch hẹn sắp tới" trong Không gian bệnh nhân).',
      '',
      'Quy tắc:',
      '- Xưng hô: luôn xưng "mình" và gọi khách là "bạn", nhất quán suốt cuộc trò chuyện. KHÔNG xưng "em/tôi" và KHÔNG gọi khách là anh/chị/ông/bà, kể cả khi khách đã cho biết giới tính hay tên.',
      '- Ưu tiên dùng thông tin trong "Tài liệu tham khảo" ở trên nếu liên quan tới câu hỏi; nếu tài liệu không liên quan thì bỏ qua, không nhắc tới nó.',
      '- Nếu 1 tài liệu tham khảo có tiêu đề đúng tên 1 chuyên khoa và nội dung khớp với triệu chứng khách mô tả, PHẢI gợi ý đúng chuyên khoa đó — KHÔNG tự đổi sang chuyên khoa khác dựa theo suy luận/kiến thức riêng của bạn.',
      '- Gợi ý chuyên khoa nên khám dựa trên triệu chứng khách mô tả, KHÔNG tự chẩn đoán bệnh thay bác sĩ.',
      '- Chỉ được nêu tên thuốc/liều dùng/cách xử lý khi thông tin đó có sẵn trong "Tài liệu tham khảo" ở trên — TUYỆT ĐỐI KHÔNG tự bịa thêm tên thuốc hay liều dùng ngoài tài liệu. Khi nêu, luôn trích dẫn (Nguồn: ...) và kèm câu nhắc đây chỉ là thông tin tham khảo, cần đến khám bác sĩ nếu triệu chứng không đỡ hoặc nặng hơn.',
      '- Với trẻ em: luôn hỏi rõ tuổi/cân nặng trước khi nêu bất kỳ thông tin liều dùng nào từ tài liệu tham khảo, và luôn khuyên nên để bác sĩ khám trực tiếp thay vì tự dùng thuốc tại nhà.',
      '- Nếu triệu chứng nghe nghiêm trọng/cấp cứu (khó thở, đau ngực dữ dội, chảy máu nhiều, bất tỉnh...), khuyên gọi cấp cứu 115 hoặc đến ngay cơ sở y tế gần nhất.',
      '- Chỉ khi câu hỏi thực sự ngoài phạm vi phòng khám (không phải câu trả lời cho câu hỏi bạn vừa đặt) hoặc bạn không chắc về thông tin y khoa, mới khuyên gọi hotline 0974 755 333.',
      '- Khám Chủ nhật: nói rõ đây không phải ngày khám thường, chỉ khám theo hẹn trước, phải chọn 1 bác sĩ cụ thể, đặt chậm nhất Thứ 3 của tuần đó và cần bác sĩ đồng ý. Không hứa chắc chắn khám được; nếu công cụ báo lỗi thì báo đúng lý do đó cho khách.',
      '- Nếu khách chỉ hỏi lịch trống (chưa nhờ đặt giúp), báo lịch trống rồi hỏi khách có muốn AI đặt giúp luôn không, hoặc nhắc khách có thể tự đặt tại /dat-lich.html.',
    ].join('\n');

    const text = await llm.chatWithTools({
      system: systemPrompt,
      history: turns,
      message: msg,
      declarations: [checkSlotsDeclaration, bookAppointmentDeclaration, ...patientTools.map((t) => t.declaration)],
      // Nhiệt độ thấp để bám sát tài liệu tham khảo.
      temperature: 0.3,
      maxRounds: 3,
      handleCall: async (name, args) => {
        if (name === 'check_available_slots') return checkAvailableSlots(args);
        if (name === 'book_appointment') return bookAppointmentTool(args, req.user);
        if (isPatient && PATIENT_TOOL_NAMES.includes(name)) {
          // runTool tự giới hạn theo req.user.id; ghi nhật ký như khi bệnh nhân tự mở trang.
          const output = await runTool(name, args, req.user);
          if (output.error) { /* tra cứu lỗi thì chưa xem được gì, không ghi nhật ký */ }
          else if (name === 'my_records') await logAudit(req.user, 'record.self_view', 'medical_record', null, { count: (output.records || []).length, via: 'ai_chat' });
          else if (name === 'my_invoices') await logAudit(req.user, 'invoice.self_view', 'invoice', null, { count: (output.invoices || []).length, via: 'ai_chat' });
          return output;
        }
        return { error: 'Công cụ không được hỗ trợ.' };
      },
    });
    let answer = text;
    // Lọc các câu thừa/sai model nhỏ hay thêm; lọc hết thì ghép câu trả lời từ dữ kiện đã có.
    if (COMPACT_PROMPT && answer) {
      answer = answer.replace(/\s*\(Nguồn:\s*https?:[^)]*\)/gi, '').replace(/\p{Script=Han}+/gu, '').replace(/\bsorry\b/gi, 'tiếc').replace(/[ \t]{2,}/g, ' ');
      // Chỉ tách câu ở dấu câu theo sau là khoảng trắng — không làm đứt "/dat-lich.html".
      const sentences = answer.match(/[^\n]+?(?:[.!?](?=\s|$)|$)\s*|\n+/g) || [answer];
      const otherSpecialties = suggested
        ? SPECIALTIES.filter((s) => s !== suggested.specialty).map((s) => new RegExp(s.replace(/\s*–\s*/g, '\\s*[–-]\\s*'), 'i'))
        : [];
      const isQuestion = (s) => s.trim().endsWith('?');
      const drop = (s) => /mình (?:sẽ |đang |có thể )?(?:(?:giúp|hỗ trợ)(?: bạn)? )?(?:kiểm tra|xem|check|đặt) lịch|mình (?:sẽ |đang |có thể )?(?:giúp|hỗ trợ)(?: bạn)? (?:kiểm tra|xem|check|đặt)|mình sẽ (?:kiểm tra|xem|check|hỗ trợ)|sẽ báo lại|(?:mình|tôi) sẽ kiểm tra/i.test(s) && !isQuestion(s)
        || /(?:dùng|uống) (?:thêm )?thuốc (?:hỗ trợ|ngủ|an thần|giảm đau|kháng sinh)|thuốc hỗ trợ ngủ/i.test(s)
        || /chườm (?:đá|lạnh|nước đá)|(?:không cần|nên) ngừng (?:uống )?thuốc/i.test(s)
        || (suggested && /chuyên khoa nào/i.test(s))
        || otherSpecialties.some((re) => re.test(s))
        || /đang nói gì vậy/i.test(s)
        || /book_appointment|check_available_slots|my_(?:appointments|records|invoices|followups)|công cụ/i.test(s)
        || (/mình xin (?:phép )?(?:kiểm tra|xem|check)/i.test(s) && !isQuestion(s))
        || /^\s*bạn (?:đang )?bị [^.?!,\n]{1,40}[.!]?\s*$/i.test(s)
        || /một trong hai cách này|Lịch CHƯA được đặt/i.test(s)
        || (/^[\x00-\x7F]+$/.test(s.trim()) && /\b(?:the|is|are|you|I|am|to|of|and|have)\b/.test(s))
        // Tự đoán nguyên nhân bệnh — chẩn đoán là việc của bác sĩ.
        || /(?:có thể|thường) (?:là )?do |(?:xảy ra|gây ra|chủ yếu|thường) do |có thể (?:là )?(?:bị )?bệnh \S|có thể (?:là )?dấu hiệu (?:của )?(?:thiếu|bệnh|rối loạn|nhiễm|viêm|virus)/i.test(s)
        || (!slotQuery && !isQuestion(s)
          && /khung giờ|giờ trống|lịch trống|còn trống|hết (?:chỗ|lịch)|(?:hôm nay|ngày mai) hoặc|trong ngày hôm nay/i.test(s));
      answer = sentences.filter((s) => !drop(s)).join('').trim();
      if (!answer && suggested) {
        answer = `Bạn nên khám chuyên khoa ${suggested.specialty} (${clinic.describeSpecialty(suggested.specialty)}). Bạn có muốn mình xem lịch trống không?`;
      }
    }
    answer = answer || 'Mình chưa hiểu rõ ý bạn. Bạn nói lại cụ thể hơn giúp mình nhé (ví dụ: hỏi giờ làm việc, chuyên khoa phù hợp hoặc đặt lịch khám).';
    // Những ý bắt buộc không phó mặc cho model: 115 khi cấp cứu, cảnh báo kháng sinh, đúng chuyên khoa.
    if (suggested && !slotQuery && !emergency.length) {
      const specialtyRe = new RegExp(suggested.specialty.replace(/\s*–\s*/g, '\\s*[–-]\\s*'), 'i');
      if (!specialtyRe.test(answer)) answer = `Bạn nên khám chuyên khoa ${suggested.specialty}.\n\n${answer}`;
      if (missingDepartment && !/chưa có (?:chuyên )?khoa/i.test(answer)) {
        answer += `\n\nPhòng khám chưa có khoa ${missingDepartment} riêng, nên vấn đề này do bác sĩ Nội tổng quát khám ban đầu; nếu cần khám chuyên sâu, bác sĩ sẽ tư vấn nơi khám tiếp phù hợp.`;
      }
    }
    if (lastAssistantText && sameReply(answer, lastAssistantText)) {
      answer = conversationSpecialty
        ? specialtyFollowUpReply('why', conversationSpecialty, null, msg, turns, lastAssistantText)
        : 'Mình vừa trả lời ý này ở trên. Bạn muốn hỏi rõ thêm điều gì — lý do chọn chuyên khoa, giá khám, bác sĩ hay lịch trống — để mình trả lời đúng ý nhé?';
    }
    if (prescription && !/kê đơn/i.test(answer)) {
      answer = `💊 Kháng sinh và thuốc kê đơn chỉ dùng khi bác sĩ đã khám và kê đơn — bạn đừng tự mua uống.\n\n${answer}`;
    }
    if (emergency.length && !/115/.test(answer)) {
      answer = `⚠️ Triệu chứng "${emergency.join(', ')}" có thể là dấu hiệu nguy hiểm — bạn hãy gọi cấp cứu 115 hoặc đến ngay cơ sở y tế gần nhất.\n\n${answer}`;
    }
    // Khách chưa đăng nhập gửi thông tin đặt lịch — nhắc cần đăng nhập, tránh tưởng đã đặt xong.
    if (!req.user && (bookingDetails || BOOKING_INTENT_RE.test(msg)) && !/đăng nhập|tai-khoan/i.test(answer)) {
      answer += '\n\nĐể mình đặt lịch qua chat, bạn cần đăng nhập/đăng ký tại /tai-khoan.html rồi nhắn lại; hoặc bạn tự đặt tại /dat-lich.html. Lịch CHƯA được đặt cho tới khi bạn làm một trong hai cách này.';
    }
    return reply(answer);
  } catch (e) {
    console.error(e);
    const { status, error } = aiErrorResponse(e);
    res.status(status).json({ error });
  }
});

// Laptop chạy Ollama báo địa chỉ đường hầm (scripts/ollama-tunnel.js). Bắt buộc đúng OLLAMA_API_KEY —
// ai đăng ký được URL sẽ nhận toàn bộ câu hỏi của bệnh nhân. Không đặt khoá = tắt endpoint.
router.post('/ollama-endpoint', (req, res) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!llm.checkOllamaKey(token)) return res.status(401).json({ error: 'Sai hoặc thiếu khoá OLLAMA_API_KEY.' });
  const url = String((req.body && req.body.url) || '');
  if (!/^https:\/\/[a-z0-9.-]+\/?$/i.test(url)) return res.status(400).json({ error: 'Địa chỉ đường hầm phải có dạng https://tên-miền.' });
  llm.setRemoteOllama(url);
  res.json({ ok: true, model: llm.PROVIDER_LABEL });
});

router.use(authenticate);

// ---------- Lịch sử trò chuyện của bệnh nhân (chỉ chủ tài khoản xem được) ----------

router.get('/conversations', async (req, res) => {
  try {
    const channel = req.query.channel === 'assistant' ? 'assistant' : 'main';
    const result = await pool.query(
      `SELECT c.id, c.title, c.updated_at AS "updatedAt",
              (SELECT content FROM chat_messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS "lastMessage"
       FROM chat_conversations c WHERE c.user_id = $1 AND c.channel = $2 ORDER BY c.updated_at DESC LIMIT 50`,
      [req.user.id, channel]
    );
    res.json({ conversations: result.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

router.get('/conversations/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'Không tìm thấy cuộc trò chuyện.' });
    const conv = await pool.query('SELECT id, title FROM chat_conversations WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    if (conv.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy cuộc trò chuyện.' });
    const messages = await pool.query(
      'SELECT role, content, created_at AS "createdAt" FROM chat_messages WHERE conversation_id = $1 ORDER BY id LIMIT 500',
      [id]
    );
    res.json({ conversation: conv.rows[0], messages: messages.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

router.delete('/conversations/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'Không tìm thấy cuộc trò chuyện.' });
    const result = await pool.query('DELETE FROM chat_conversations WHERE id = $1 AND user_id = $2 RETURNING id', [id, req.user.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy cuộc trò chuyện.' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

// ---------- Quản lý cơ sở tri thức — chỉ admin ----------

router.get('/kb', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT d.id, d.title, d.content, d.created_at AS "createdAt",
             (SELECT COUNT(*) FROM kb_chunks c WHERE c.document_id = d.id)::int AS "chunkCount"
      FROM kb_documents d ORDER BY d.created_at DESC
    `);
    res.json({ documents: result.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

router.post('/kb', requireAdmin, async (req, res) => {
  // Nhúng tài liệu luôn dùng Gemini (kể cả khi AI_PROVIDER=ollama).
  if (!process.env.GEMINI_API_KEY) return res.status(503).json({ error: 'Chưa cấu hình GEMINI_API_KEY nên chưa nhúng được tài liệu vào cơ sở tri thức.' });
  try {
    const { title, content } = req.body || {};
    if (!title || !content || !content.trim()) {
      return res.status(400).json({ error: 'Thiếu tiêu đề hoặc nội dung tài liệu.' });
    }

    const chunks = chunkText(content, 500, 100);
    if (chunks.length === 0) {
      return res.status(400).json({ error: 'Nội dung quá ngắn hoặc không hợp lệ.' });
    }

    // Nhúng xong mọi chunk rồi mới ghi CSDL — không lưu tài liệu dở dang nếu Gemini lỗi giữa chừng.
    const embeddings = [];
    for (const chunk of chunks) {
      embeddings.push(await withRetry(() => embedText(chunk, 'RETRIEVAL_DOCUMENT')));
    }

    const dbClient = await pool.connect();
    try {
      await dbClient.query('BEGIN');
      const docRes = await dbClient.query(
        'INSERT INTO kb_documents (title, content, created_by) VALUES ($1,$2,$3) RETURNING id, title, content, created_at AS "createdAt"',
        [title.trim(), content.trim(), req.user.id]
      );
      const doc = docRes.rows[0];
      for (let i = 0; i < chunks.length; i++) {
        await dbClient.query(
          'INSERT INTO kb_chunks (document_id, chunk_index, content, embedding) VALUES ($1,$2,$3,$4::vector)',
          [doc.id, i, chunks[i], toVectorLiteral(embeddings[i])]
        );
      }
      await dbClient.query('COMMIT');
      res.status(201).json({ document: { ...doc, chunkCount: chunks.length } });
    } catch (e) {
      await dbClient.query('ROLLBACK');
      throw e;
    } finally {
      dbClient.release();
    }
  } catch (e) {
    console.error(e);
    const { status, error } = aiErrorResponse(e);
    res.status(status).json({ error });
  }
});

router.delete('/kb/:id', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM kb_documents WHERE id = $1', [Number(req.params.id)]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Không tìm thấy tài liệu.' });
    res.status(204).end();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

// ---------- Câu trả lời mẫu cho chatbot (lib/chatExamples.js) — chỉ admin ----------

const EXAMPLE_FIELDS = 'id, question, answer, created_at AS "createdAt", updated_at AS "updatedAt"';

function readExample(body) {
  const question = String((body && body.question) || '').trim();
  const answer = String((body && body.answer) || '').trim();
  if (question.length < 2 || question.length > 500) return { error: 'Câu hỏi cần từ 2 đến 500 ký tự.' };
  if (!answer || answer.length > 2000) return { error: 'Câu trả lời không được trống và tối đa 2000 ký tự.' };
  return { question, answer };
}

router.get('/examples', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`SELECT ${EXAMPLE_FIELDS} FROM chat_examples ORDER BY updated_at DESC`);
    res.json({ examples: result.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

// Thử 1 câu hỏi xem chatbot lấy những câu mẫu nào (và độ giống).
router.post('/examples/match', requireAdmin, async (req, res) => {
  try {
    const question = normalizeMessage(String((req.body && req.body.question) || '')).text.trim();
    if (!question) return res.status(400).json({ error: 'Nhập câu hỏi cần thử.' });
    res.json({ normalized: question, matches: await findExamples(question, 5) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

// Không nhúng được (Ollama tắt) vẫn lưu — câu mẫu dùng được qua so khớp chữ.
router.post('/examples', requireAdmin, async (req, res) => {
  const input = readExample(req.body);
  if (input.error) return res.status(400).json({ error: input.error });
  try {
    const vector = await tryEmbedQuestion(normalizeMessage(input.question).text);
    const result = await pool.query(
      `INSERT INTO chat_examples (question, answer, local_embedding, created_by) VALUES ($1,$2,$3::vector,$4) RETURNING ${EXAMPLE_FIELDS}`,
      [input.question, input.answer, vector, req.user.id]
    );
    logAudit(req.user, 'chat_example.create', 'chat_example', result.rows[0].id, { question: input.question });
    res.status(201).json({ example: result.rows[0] });
  } catch (e) {
    console.error(e);
    const { status, error } = aiErrorResponse(e);
    res.status(status).json({ error });
  }
});

router.put('/examples/:id', requireAdmin, async (req, res) => {
  const input = readExample(req.body);
  if (input.error) return res.status(400).json({ error: input.error });
  try {
    const current = await pool.query('SELECT question FROM chat_examples WHERE id = $1', [Number(req.params.id)]);
    if (current.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy câu trả lời mẫu.' });
    // Chỉ nhúng lại khi đổi câu hỏi; nhúng lỗi thì xoá vector cũ để không tìm theo nghĩa câu hỏi cũ.
    const questionChanged = current.rows[0].question !== input.question;
    const vector = questionChanged ? await tryEmbedQuestion(normalizeMessage(input.question).text) : null;
    const result = await pool.query(
      `UPDATE chat_examples SET question = $1, answer = $2,
         local_embedding = CASE WHEN $3 THEN $4::vector ELSE local_embedding END, updated_at = now()
       WHERE id = $5 RETURNING ${EXAMPLE_FIELDS}`,
      [input.question, input.answer, questionChanged, vector, Number(req.params.id)]
    );
    logAudit(req.user, 'chat_example.update', 'chat_example', result.rows[0].id, { question: input.question });
    res.json({ example: result.rows[0] });
  } catch (e) {
    console.error(e);
    const { status, error } = aiErrorResponse(e);
    res.status(status).json({ error });
  }
});

router.delete('/examples/:id', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM chat_examples WHERE id = $1 RETURNING question', [Number(req.params.id)]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Không tìm thấy câu trả lời mẫu.' });
    logAudit(req.user, 'chat_example.delete', 'chat_example', Number(req.params.id), { question: result.rows[0].question });
    res.status(204).end();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Có lỗi máy chủ, thử lại sau.' });
  }
});

// Bác sĩ/nhân viên/admin xem tóm tắt AI về lịch sử khám của 1 bệnh nhân.
router.post('/summarize-patient', requireRole('doctor', 'staff', 'admin'), async (req, res) => {
  if (!llm.isConfigured()) {
    return res.status(503).json({ error: llm.NOT_CONFIGURED_ERROR });
  }
  try {
    const patientId = Number(req.body?.patientId);
    if (!patientId) return res.status(400).json({ error: 'Thiếu mã bệnh nhân.' });

    const records = await pool.query(
      `SELECT mr.id, mr.symptoms, mr.diagnosis, mr.notes, a.appointment_date, a.specialty,
              (SELECT COALESCE(json_agg(json_build_object('name', m.name, 'dosage', pi.dosage, 'quantity', pi.quantity)), '[]'::json)
               FROM prescription_items pi JOIN medicines m ON m.id = pi.medicine_id WHERE pi.medical_record_id = mr.id) AS items
       FROM medical_records mr
       JOIN appointments a ON a.id = mr.appointment_id
       WHERE mr.patient_id = $1
       ORDER BY mr.created_at DESC LIMIT 10`,
      [patientId]
    );

    if (records.rows.length === 0) {
      return res.json({ summary: 'Bệnh nhân chưa có hồ sơ khám nào trước đây.' });
    }

    const historyText = records.rows
      .map((r, i) => {
        const meds = r.items.length
          ? r.items.map((it) => `${it.name} (${it.dosage}, SL ${it.quantity})`).join('; ')
          : 'không kê đơn';
        return `${i + 1}. ${new Date(r.appointment_date).toLocaleDateString('vi-VN')} - ${r.specialty}\n   Triệu chứng: ${r.symptoms || '—'}\n   Chẩn đoán: ${r.diagnosis}\n   Đơn thuốc: ${meds}\n   Ghi chú: ${r.notes || '—'}`;
      })
      .join('\n\n');

    const systemPrompt =
      'Bạn hỗ trợ bác sĩ tại phòng khám tóm tắt nhanh bệnh sử một bệnh nhân trước khi khám. ' +
      'Viết bằng tiếng Việt, súc tích, dạng gạch đầu dòng, nêu bật các lần khám gần đây, chẩn đoán lặp lại (nếu có), ' +
      'và các thuốc đã dùng đáng chú ý (đặc biệt nếu có thể liên quan tới lần khám tới). ' +
      'Chỉ dùng dữ liệu được cung cấp, không suy đoán hay bổ sung thông tin y khoa khác.';

    const summary = await llm.generateText({ system: systemPrompt, prompt: 'Lịch sử khám bệnh:\n\n' + historyText });
    res.json({ summary });
  } catch (e) {
    console.error(e);
    const { status, error } = aiErrorResponse(e);
    res.status(status).json({ error });
  }
});

// ---------- Trợ lý AI theo vai trò (không gian làm việc) — bắt buộc đăng nhập, công cụ ở lib/assistantTools.js ----------
const ASSISTANT_ROLE_INFO = {
  patient: 'Bệnh nhân. Bạn giúp họ theo dõi lịch hẹn, hiểu đơn thuốc/hoá đơn/lịch tái khám của CHÍNH họ.',
  doctor: 'Bác sĩ. Bạn giúp họ nắm nhanh ca khám hôm nay, lịch tái khám quá hạn/hôm nay/sắp tới của bệnh nhân họ phụ trách.',
  staff: 'Nhân viên tư vấn/tiếp đón. Bạn giúp họ nắm lịch hẹn trong ngày, hoá đơn chưa thu và lịch tái khám cần nhắc bệnh nhân.',
  admin: 'Quản trị viên. Bạn giúp họ đọc số liệu vận hành: doanh thu, số ca theo chuyên khoa, công nợ, nhật ký hoạt động; có thể đưa nhận xét ngắn dựa trên số liệu.',
};

router.post('/assistant', async (req, res) => {
  if (!llm.isConfigured()) {
    return res.status(503).json({ error: llm.NOT_CONFIGURED_ERROR });
  }
  try {
    const { message, history, conversationId } = req.body || {};
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Thiếu nội dung câu hỏi.' });
    }
    const userText = message.trim();
    let convId = Number.isInteger(Number(conversationId)) && Number(conversationId) > 0 ? Number(conversationId) : null;
    // Lịch sử lấy từ CSDL, không tin dữ liệu client gửi lên.
    let savedTurns = null;
    if (convId) {
      const owned = await pool.query("SELECT id FROM chat_conversations WHERE id = $1 AND user_id = $2 AND channel = 'assistant'", [convId, req.user.id]);
      if (owned.rows.length === 0) {
        convId = null;
      } else {
        const rows = await pool.query(
          'SELECT role, content FROM (SELECT id, role, content FROM chat_messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT $2) t ORDER BY id',
          [convId, HISTORY_TURNS_FOR_MODEL]
        );
        savedTurns = rows.rows;
      }
    }
    const tools = toolsForRole(req.user.role);
    const todayVN = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });

    const systemPrompt = [
      'Bạn là trợ lý AI cá nhân của Phòng khám Đa khoa Đức Minh, đang trò chuyện với ' + req.user.name + '.',
      'Vai trò người dùng: ' + (ASSISTANT_ROLE_INFO[req.user.role] || ASSISTANT_ROLE_INFO.patient),
      'Hôm nay là ngày ' + todayVN + ' (giờ Việt Nam). Trả lời bằng tiếng Việt, ngắn gọn, thân thiện; dùng gạch đầu dòng khi liệt kê.',
      '',
      'Quy tắc bắt buộc:',
      '- Mọi số liệu, tên, ngày giờ, tiền, thuốc PHẢI lấy từ kết quả công cụ. TUYỆT ĐỐI KHÔNG bịa hay đoán. Câu hỏi cần dữ liệu thì gọi công cụ trước khi trả lời; công cụ trả rỗng thì nói thẳng là chưa có dữ liệu.',
      '- Xưng "mình" và gọi người dùng là "bạn" (hoặc "bác sĩ" với bác sĩ). KHÔNG đoán giới tính qua tên nên không dùng anh/chị/ông/bà.',
      '- Tiền viết dạng 1.500.000đ. Ngày viết dạng dd/mm/yyyy.',
      '- KHÔNG chẩn đoán bệnh, KHÔNG tự đổi liều hay kê thuốc mới. Khi giải thích đơn thuốc của bệnh nhân, chỉ nhắc lại đúng thuốc và liều bác sĩ đã ghi, rồi nhắc hỏi lại bác sĩ nếu còn thắc mắc hoặc có dấu hiệu bất thường.',
      '- Triệu chứng nghe nghiêm trọng (khó thở, đau ngực dữ dội, chảy máu nhiều, bất tỉnh...): khuyên gọi cấp cứu 115 ngay.',
      '- Bạn CHỈ tra cứu được, không thể sửa dữ liệu. Muốn đặt lịch, thu tiền, sửa giá... thì chỉ dẫn người dùng thao tác ở trang tương ứng.',
      '- Câu hỏi ngoài phạm vi phòng khám hoặc ngoài quyền hạn của người dùng: từ chối lịch sự; cần hỗ trợ thêm thì gọi hotline 0974 755 333.',
      '- Khi được nhờ nhận xét số liệu (admin): nêu 2-3 điểm đáng chú ý chỉ dựa trên số đã tra cứu, nói rõ đó là nhận xét tham khảo.',
    ].join('\n');

    const turns = (savedTurns || (Array.isArray(history) ? history : []))
      .filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string')
      .slice(-HISTORY_TURNS_FOR_MODEL);

    const text = await llm.chatWithTools({
      system: systemPrompt,
      history: turns,
      message: userText,
      declarations: tools.map((t) => t.declaration),
      temperature: 0.2,
      maxRounds: 4,
      handleCall: (name, args) => runTool(name, args, req.user),
    });
    const reply = text || 'Mình chưa có câu trả lời phù hợp. Bạn thử hỏi cụ thể hơn, hoặc gọi hotline 0974 755 333 nhé.';
    convId = await persistTurn(req.user.id, convId, userText, reply, 'assistant');
    res.json({ reply, conversationId: convId });
  } catch (e) {
    console.error(e);
    const { status, error } = aiErrorResponse(e);
    res.status(status).json({ error });
  }
});

module.exports = router;
