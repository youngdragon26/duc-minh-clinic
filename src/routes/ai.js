const express = require('express');
const { pool } = require('../db');
const { authenticate, optionalAuthenticate, requireAdmin, requireRole } = require('../middleware/auth');
const { SPECIALTIES, GENDERS } = require('../constants');
const { chunkText } = require('../lib/chunk');
const { embedText, toVectorLiteral } = require('../lib/embeddings');
const { getAvailableSlots } = require('../lib/availability');
const { createAppointment, BookingError, isSundayISO, sundayDeadlineISO } = require('../lib/appointmentService');
const { toolsForRole, runTool } = require('../lib/assistantTools');
const {
  analyzeMessage,
  isBlankMessage,
  upcomingDaysNote,
  describeDate,
  detectSpecialty,
  detectEmergency,
  detectSlotQuery,
} = require('../lib/chatAnalysis');
const { logAudit } = require('../lib/audit');
const llm = require('../lib/llm');
const { intParam } = require('../middleware/params');
const { withRetry, aiErrorResponse } = llm;

// Công cụ tra cứu dữ liệu CỦA CHÍNH bệnh nhân — dùng ngay trong khung chat chính khi bệnh nhân
// đã đăng nhập (thay cho khung "Trợ lý AI của bạn" cũ trong không gian bệnh nhân).
const PATIENT_TOOL_NAMES = ['my_appointments', 'my_records', 'my_invoices', 'my_followups'];

const MAX_MESSAGE_LENGTH = 1000;
const HISTORY_TURNS_FOR_MODEL = 12;

// Lưu 1 lượt hỏi-đáp vào lịch sử của bệnh nhân đã đăng nhập (tạo cuộc trò chuyện mới nếu
// chưa có). Lỗi lưu không được làm hỏng câu trả lời đã có — chỉ mất phần lịch sử.
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

// Ngữ cảnh "RAG" lấy trực tiếp từ CSDL thật của phòng khám (giá khám, bác sĩ đang
// có theo từng chuyên khoa) — không bịa thêm kiến thức y khoa bên ngoài.
async function buildClinicContext() {
  const [prices, doctors] = await Promise.all([
    pool.query('SELECT specialty, price FROM service_prices'),
    pool.query("SELECT name, specialty FROM users WHERE role = 'doctor' ORDER BY specialty, name"),
  ]);
  const priceMap = Object.fromEntries(prices.rows.map((r) => [r.specialty, r.price]));
  // Bác sĩ specialty = NULL là "bác sĩ tổng quát", phụ trách được mọi chuyên khoa
  // nên được liệt kê ở tất cả các dòng, không dồn vào 1 nhóm riêng.
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

  const text = [
    'Thông tin phòng khám (chỉ dùng đúng dữ kiện dưới đây, không bịa thêm):',
    '- Tên: Phòng khám Đa khoa Đức Minh.',
    '- Địa chỉ: Phường Túc Duyên, TP. Thái Nguyên.',
    '- Hotline: 0974 755 333.',
    '- Giờ làm việc: 7:00–21:00, Thứ 2 – Thứ 7. Chủ nhật KHÔNG khám thường xuyên, chỉ có người trực cho trường hợp đột xuất: muốn khám Chủ nhật phải hẹn trước với 1 bác sĩ cụ thể, đặt chậm nhất Thứ 3 của tuần đó, và chỉ được khám khi chính bác sĩ đó đồng ý (lịch sẽ ở trạng thái chờ xác nhận cho tới khi bác sĩ đồng ý).',
    '- Cách đặt lịch: đăng nhập/đăng ký tại /tai-khoan.html rồi đặt lịch tại /dat-lich.html.',
    '',
    'Chuyên khoa, giá khám và bác sĩ hiện có:',
    specialtyLines,
  ].join('\n');
  return { text, describeSpecialty };
}

// Tool Gemini có thể tự gọi để tra cứu khung giờ còn trống THẬT trong CSDL —
// không để mô hình tự đoán/bịa ra lịch trống.
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
// Danh sách 28 mốc giờ làm model nhỏ chép lại dài dòng; dạng khoảng giờ vừa gọn vừa đủ ý.
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

// Tra sẵn lịch trống cho các ngày khách hỏi (detectSlotQuery) — model nhỏ hay chỉ hứa "mình sẽ
// kiểm tra rồi báo lại" mà không gọi check_available_slots, nên code tra trước rồi đưa kết quả vào prompt.
async function slotFacts(specialty, dates, todayVN) {
  // getAvailableSlots không bỏ các giờ đã trôi qua của hôm nay — lọc ở đây để không mời khách đặt giờ đã qua.
  const nowVN = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' });
  const results = await Promise.all(dates.map((date) => checkAvailableSlots({ specialty, date })));
  return results.map((r, i) => {
    const [y, m, d] = dates[i].split('-');
    const label = `${describeDate(dates[i]).match(/\((.+)\)/)[1]} ${d}/${m}/${y}`;
    if (r.error || !r.doctors) return `- ${label}: ${r.error || r.message}`;
    const docs = r.doctors.map((d) => {
      const free = dates[i] === todayVN ? d.freeSlots.filter((t) => t > nowVN) : d.freeSlots;
      return `${d.doctorName}: ${free.length ? slotRanges(free) : 'hết chỗ'}`;
    });
    return `- ${label}: ${docs.join('; ')}${r.sundayNote ? ' (Chủ nhật: chỉ khám theo hẹn trước, cần bác sĩ đồng ý)' : ''}`;
  });
}

// Chuyên khoa khách đang nói tới: ưu tiên tin nhắn mới, không có thì lần ngược lịch sử (tin của
// khách trước, rồi tới câu trả lời của trợ lý — vd trợ lý vừa gợi ý "Tai – Mũi – Họng").
function specialtyFromConversation(message, turns) {
  const fromMessage = detectSpecialty(message);
  if (fromMessage) return fromMessage.specialty;
  for (const role of ['user', 'assistant']) {
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role !== role) continue;
      const found = detectSpecialty(turns[i].content);
      if (found) return found.specialty;
    }
  }
  return null;
}

// Tool Gemini gọi để ĐẶT LỊCH THẬT cho khách — chỉ nên gọi sau khi đã thu thập
// đủ thông tin VÀ khách đã xác nhận rõ ràng bằng lời (xem quy tắc trong systemPrompt).
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

// ---------- RAG: Retrieval phase ----------
// Nhúng 1 câu truy vấn thành vector, tìm các đoạn tri thức gần nhất bằng cosine
// similarity (toán tử <=> của pgvector), kèm tên tài liệu nguồn để model trích dẫn.
async function retrieveKnowledge(query, k = 4, taskType = 'RETRIEVAL_QUERY') {
  // Nhúng câu hỏi cần Gemini — chạy Ollama mà không có GEMINI_API_KEY thì trả lời không kèm tài liệu.
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
    console.error('Retrieval error:', e);
    return []; // Retrieval lỗi không nên làm sập cả chatbot — chỉ mất phần ngữ cảnh bổ sung.
  }
}

// ---------- RAG nâng cao: Multi-Query + HyDE ----------
// Multi-Query: câu hỏi của người dùng thường ngắn, thiếu ngữ cảnh hoặc có thể mang
// nhiều nghĩa — vd "lỗi kết nối db" có thể là timeout, sai quyền truy cập, hay lỗi
// mạng. Sinh ra vài GIẢ THUYẾT/DIỄN GIẢI KHÁC NHAU cho cùng câu hỏi gốc (không phải
// chỉ đổi từ ngữ mà giữ nguyên đúng 1 ý), rồi tìm kiếm tất cả và gộp kết quả lại, để
// không bỏ sót tài liệu liên quan tới cách hiểu mà người dùng không nói rõ.
// HyDE (Hypothetical Document Embeddings): sinh 1 "câu trả lời giả định" rồi dùng
// vector của câu đó để tìm — vì tài liệu thật viết văn phong mô tả/khẳng định, khác
// văn phong câu hỏi, nên so 2 đoạn cùng văn phong mô tả thường cho vector gần nhau
// hơn là so câu hỏi với tài liệu. Để đúng tinh thần đó, câu trả lời giả định phải
// được NHÚNG NHƯ 1 TÀI LIỆU (taskType RETRIEVAL_DOCUMENT) — cùng không gian nhúng
// với các chunk tài liệu thật — chứ không nhúng như 1 câu hỏi (RETRIEVAL_QUERY),
// nếu không sẽ mất tác dụng thu hẹp khoảng cách ngữ nghĩa mà HyDE mang lại.
// Gộp chung 2 kỹ thuật vào ĐÚNG 1 lượt gọi generateContent (không tách riêng) để đỡ
// tốn thêm quota — vẫn tốn thêm đúng 1 lượt gọi AI mỗi câu hỏi so với bản gốc.
// Lượt gọi này chạy TRƯỚC câu trả lời chính (tuần tự, không song song được), nên với mô hình
// chạy trên máy (Ollama, chậm hơn Gemini nhiều) nó gần như nhân đôi thời gian chờ — vì vậy
// mặc định TẮT khi AI_PROVIDER=ollama; đặt AI_QUERY_EXPANSION=true/false để ép bật/tắt.
const QUERY_EXPANSION_ENABLED = process.env.AI_QUERY_EXPANSION
  ? process.env.AI_QUERY_EXPANSION === 'true'
  : llm.PROVIDER !== 'ollama';

// System prompt đầy đủ (~40 quy tắc, viết cho Gemini) quá dài với model nhỏ chạy trên máy: đo thật
// với qwen3:1.7b chỉ đạt 6/15 câu của scripts/eval-chatbot.js (lặp nguyên câu xin xác nhận, gợi ý
// sai khoa…). Bản rút gọn giữ đúng các quy tắc an toàn/đặt lịch, phần còn lại do chatAnalysis tính
// sẵn. Mặc định BẬT khi AI_PROVIDER=ollama; đặt AI_COMPACT_PROMPT=true/false để ép bật/tắt.
const COMPACT_PROMPT = process.env.AI_COMPACT_PROMPT
  ? process.env.AI_COMPACT_PROMPT === 'true'
  : llm.PROVIDER === 'ollama';

async function expandQuery(message) {
  if (!QUERY_EXPANSION_ENABLED || !llm.isConfigured()) return { queries: [], hypotheticalAnswer: null };
  // Tin nhắn không có nội dung để mở rộng (vd chỉ gửi số điện thoại giữa lúc đang đặt
  // lịch) thì bỏ qua — gói miễn phí chỉ có 20 lượt gọi/ngày/model, không nên tốn thêm 1
  // lượt cho câu chỉ có số hoặc 1 từ.
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
    // Lỗi (kể cả hết quota) thì rơi về tìm kiếm với đúng câu hỏi gốc — không chặn chatbot.
    return { queries: [], hypotheticalAnswer: null };
  }
}

// Chạy retrieval cho câu hỏi gốc + các biến thể Multi-Query + câu trả lời giả định
// HyDE, rồi gộp lại: 1 đoạn tri thức có thể được nhiều câu truy vấn cùng tìm thấy,
// chỉ giữ lại điểm tương đồng CAO NHẤT của nó, sau đó lấy top-k chung cuộc.
async function retrieveKnowledgeExpanded(message, k = 4) {
  const { queries, hypotheticalAnswer } = await expandQuery(message);
  const searchTexts = [message, ...queries];

  const resultsPerText = await Promise.all([
    ...searchTexts.map((text) => retrieveKnowledge(text, k, 'RETRIEVAL_QUERY')),
    // Câu trả lời giả định (HyDE) đóng vai "tài liệu", phải nhúng bằng RETRIEVAL_DOCUMENT
    // (cùng không gian nhúng với các chunk tài liệu thật) để so khớp đúng ý nghĩa của kỹ thuật.
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

// Chatbot công khai cho khách/bệnh nhân — không bắt buộc đăng nhập, nhưng nếu
// khách ĐANG đăng nhập (gửi kèm Bearer token) thì nhận diện được req.user, để
// bật tính năng đặt lịch trực tiếp qua chat (xem book_appointment bên dưới).
router.post('/chat', optionalAuthenticate, async (req, res) => {
  if (!llm.isConfigured()) {
    return res.status(503).json({ error: llm.NOT_CONFIGURED_ERROR });
  }
  try {
    const { message, history, conversationId } = req.body || {};
    const userText = typeof message === 'string' ? message.trim() : '';
    let convId = req.user && Number.isInteger(Number(conversationId)) ? Number(conversationId) : null;

    // Tin trống / chỉ dấu câu: trả lời hướng dẫn ngay, không tốn lượt gọi AI (gói miễn
    // phí chỉ có 20 lượt/ngày) và không lưu vào lịch sử.
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

    // Bệnh nhân đã đăng nhập: lấy ngữ cảnh từ lịch sử lưu ở CSDL (đáng tin hơn dữ liệu
    // client gửi lên, và chat tiếp được sau khi tải lại trang). Không đúng chủ sở hữu
    // hoặc không tồn tại thì coi như cuộc trò chuyện mới.
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

    const prepStart = Date.now();
    const [clinic, retrieved] = await Promise.all([
      buildClinicContext(),
      retrieveKnowledgeExpanded(userText),
    ]);
    if (process.env.AI_DEBUG === 'true') console.log(`[chat] lấy ngữ cảnh CSDL + tìm tài liệu RAG: ${((Date.now() - prepStart) / 1000).toFixed(1)}s`);
    const todayVN = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });

    // Dữ kiện tính TẤT ĐỊNH cho tin nhắn này (chatAnalysis.js) — model chỉ việc diễn đạt lại.
    const facts = analyzeMessage(userText, todayVN).map((n) => `- ${n}`);
    const emergency = detectEmergency(userText);
    if (emergency.length) {
      facts.unshift(`- CẤP CỨU: khách nói "${emergency.join(', ')}" → câu ĐẦU TIÊN phải khuyên gọi cấp cứu 115 hoặc đến ngay cơ sở y tế gần nhất.`);
    }
    const slotQuery = detectSlotQuery(userText, todayVN);
    const suggested = detectSpecialty(userText);
    if (slotQuery) {
      const specialty = specialtyFromConversation(userText, turns);
      const slotLines = specialty ? await slotFacts(specialty, slotQuery.dates, todayVN) : null;
      // Model nhỏ bỏ qua cả lịch trống đã tra sẵn trong prompt (vẫn hứa "mình sẽ kiểm tra"), mà câu trả
      // lời ở đây xác định hoàn toàn từ dữ liệu — nên với bản rút gọn, code trả lời luôn, không gọi model.
      // Tin có kèm số điện thoại/tuổi là đang đặt lịch dở — để model xử lý tiếp, không cắt ngang.
      const bookingDetails = facts.some((f) => /Số điện thoại|Tuổi/.test(f));
      if (COMPACT_PROMPT && !emergency.length && !bookingDetails) {
        const reply = slotLines
          ? [
              `Lịch còn trống khoa ${specialty}:`,
              ...slotLines,
              req.user
                ? 'Bạn muốn chọn giờ nào? Mình có thể đặt lịch giúp bạn luôn.'
                : 'Bạn muốn chọn giờ nào? Bạn đăng nhập tại /tai-khoan.html để mình đặt giúp, hoặc tự đặt tại /dat-lich.html.',
            ].join('\n')
          : `Bạn muốn xem lịch trống của chuyên khoa nào? Phòng khám có: ${SPECIALTIES.join(', ')}.`;
        if (req.user) convId = await persistTurn(req.user.id, convId, userText, reply);
        return res.json({ reply, conversationId: convId });
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
    if (!req.user && /đặt (?:lịch|hẹn)|book/i.test(userText)) {
      facts.push('- Khách muốn đặt lịch nhưng CHƯA ĐĂNG NHẬP → hướng dẫn khách đăng nhập/đăng ký tại /tai-khoan.html rồi quay lại chat, hoặc tự đặt tại /dat-lich.html.');
    }
    if (!slotQuery && suggested) {
      facts.push(`- CHUYÊN KHOA PHÙ HỢP: ${suggested.specialty} (vì khách nói "${suggested.keywords.join(', ')}") — ${clinic.describeSpecialty(suggested.specialty)}. Gợi ý ĐÚNG chuyên khoa này và chỉ nêu bác sĩ của chuyên khoa này.`);
    }
    const analysisBlock = facts.length
      ? ['KẾT QUẢ KIỂM TRA TỰ ĐỘNG tin nhắn MỚI NHẤT của khách (do hệ thống tính, ĐÚNG TUYỆT ĐỐI — tin theo đây, không tự đếm/tính lại):', ...facts].join('\n')
      : '';

    const knowledgeBlock = retrieved.length
      ? [
          'Tài liệu tham khảo tìm được (có thể liên quan hoặc không, tự đánh giá; nếu dùng thì ghi "(Nguồn: <tên tài liệu>)" cuối câu):',
          ...retrieved.map((r) => `--- ${r.title} ---\n${r.content}`),
        ].join('\n\n')
      : 'Không tìm thấy tài liệu tham khảo nào liên quan trong cơ sở tri thức.';

    // Nêu thẳng tên tài liệu khớp nhất bằng 1 câu cụ thể — thực tế cho thấy chỉ
    // đưa cả khối tài liệu và nói "ưu tiên dùng thông tin trên" là chưa đủ, model
    // vẫn có thể tự bịa ra 1 chuyên khoa không hề xuất hiện trong tài liệu tham
    // khảo (đã xảy ra thật: tài liệu chỉ có "Da liễu"/"Nhi khoa" nhưng model trả
    // lời "Tai – Mũi – Họng"). Nêu tên tài liệu rõ ràng, cụ thể giúp model bám sát
    // hơn là 1 quy tắc chung chung.
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

    // Bản rút gọn cho model nhỏ (xem COMPACT_PROMPT): ít quy tắc, đánh số, và để "KẾT QUẢ KIỂM TRA
    // TỰ ĐỘNG" ở CUỐI prompt — model nhỏ bám phần nằm gần câu hỏi hơn phần ở đầu.
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
      '3. Không bao giờ nói "mình sẽ kiểm tra rồi báo lại": cần dữ liệu thì gọi công cụ ngay, thiếu thông tin thì hỏi lại đúng 1 câu.',
      '4. Tin ngắn như "0912345678", "mai", "9 giờ", "nam", "ok" là câu trả lời cho câu bạn vừa hỏi — hiểu theo ngữ cảnh hội thoại.',
      // Không trích nguyên văn câu xin xác nhận: model nhỏ chép lại câu đó vào cả những câu trả lời
      // không liên quan. Giao diện nhận bản tóm tắt theo dấu hiệu chung (index.html, isSummary).
      '5. Đặt lịch qua chat (chỉ khi khách đang đăng nhập): hỏi dần cho đủ chuyên khoa, ngày, giờ, họ tên, số điện thoại, tuổi, giới tính (bác sĩ và lý do khám nếu có). CHỈ KHI ĐÃ ĐỦ các thông tin đó mới tóm tắt gạch đầu dòng (họ tên, ngày khám, giờ khám, ...) và mời khách trả lời xác nhận. Khách chỉ hỏi thông tin hay hỏi lịch trống thì trả lời câu hỏi đó, KHÔNG tóm tắt, KHÔNG xin xác nhận.',
      '6. CHỈ gọi book_appointment sau khi khách xác nhận ("xác nhận", "đúng rồi", "ok đặt giúp mình"). Khách huỷ thì không đặt; khách muốn sửa thì hỏi sửa mục nào rồi tóm tắt lại. Báo đúng kết quả công cụ (mã lịch, trạng thái chờ xác nhận, hoặc lý do lỗi). Không bao giờ nói đã đặt nếu chưa gọi công cụ.',
      '7. Chủ nhật không khám thường: chỉ khám theo hẹn trước với 1 bác sĩ cụ thể, đặt chậm nhất Thứ 3 tuần đó, cần bác sĩ đồng ý.',
      '8. Câu hỏi ngoài phạm vi phòng khám hoặc không chắc thông tin y khoa: khuyên gọi hotline 0974 755 333.',
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
      message: userText,
      declarations: [checkSlotsDeclaration, bookAppointmentDeclaration, ...patientTools.map((t) => t.declaration)],
      // Nhiệt độ thấp để AI bám sát tài liệu tham khảo thay vì tự suy luận
      // lệch (đã có trường hợp thật: tài liệu ghi rõ "Da liễu" nhưng AI vẫn
      // trả lời "Tai – Mũi – Họng" — lỗi ở bước sinh câu trả lời, không phải
      // do tìm sai tài liệu).
      temperature: 0.3,
      maxRounds: 3,
      handleCall: async (name, args) => {
        if (name === 'check_available_slots') return checkAvailableSlots(args);
        if (name === 'book_appointment') return bookAppointmentTool(args, req.user);
        if (isPatient && PATIENT_TOOL_NAMES.includes(name)) {
          // runTool tự giới hạn theo req.user.id — bệnh nhân chỉ tra cứu được dữ liệu của mình.
          const output = await runTool(name, args, req.user);
          // Giữ đúng dấu vết như khi bệnh nhân tự mở trang hồ sơ/hoá đơn.
          if (output.error) { /* tra cứu lỗi thì chưa xem được gì, không ghi nhật ký */ }
          else if (name === 'my_records') await logAudit(req.user, 'record.self_view', 'medical_record', null, { count: (output.records || []).length, via: 'ai_chat' });
          else if (name === 'my_invoices') await logAudit(req.user, 'invoice.self_view', 'invoice', null, { count: (output.invoices || []).length, via: 'ai_chat' });
          return output;
        }
        return { error: 'Công cụ không được hỗ trợ.' };
      },
    });
    let reply = text || 'Mình chưa hiểu rõ ý bạn. Bạn nói lại cụ thể hơn giúp mình nhé (ví dụ: hỏi giờ làm việc, chuyên khoa phù hợp hoặc đặt lịch khám).';
    // An toàn không phó mặc cho model: đo thật, model nhỏ lúc khuyên 115, lúc lại chỉ đưa hotline phòng khám.
    if (emergency.length && !/115/.test(reply)) {
      reply = `⚠️ ${emergency.join(', ')} có thể là dấu hiệu nguy hiểm — bạn hãy gọi cấp cứu 115 hoặc đến ngay cơ sở y tế gần nhất.\n\n${reply}`;
    }
    if (req.user) convId = await persistTurn(req.user.id, convId, userText, reply);
    res.json({ reply, conversationId: convId });
  } catch (e) {
    console.error(e);
    const { status, error } = aiErrorResponse(e);
    res.status(status).json({ error });
  }
});

// Laptop chạy Ollama báo địa chỉ đường hầm hiện tại lên đây (scripts/ollama-tunnel.js) để bản
// deploy gọi về được. Bắt buộc đúng OLLAMA_API_KEY — không thì ai cũng trỏ được chatbot sang máy
// của họ và đọc toàn bộ câu hỏi của bệnh nhân. Không đặt OLLAMA_API_KEY = tắt hẳn endpoint này.
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

// ---------- Quản lý cơ sở tri thức (Indexing phase) — chỉ admin ----------

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
  // Nhúng tài liệu luôn dùng Gemini (kể cả khi AI_PROVIDER=ollama) — xem lib/llm.js.
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

    // Nhúng từng chunk thành vector TRƯỚC khi ghi vào CSDL, để không lưu tài
    // liệu "dở dang" (có chunk nhưng thiếu embedding) nếu Gemini lỗi giữa chừng.
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

// ---------- Trợ lý AI cá nhân theo vai trò (trong không gian làm việc) ----------
// Khác với chatbot công khai ở trên: người dùng PHẢI đăng nhập, và trợ lý có
// các công cụ tra cứu dữ liệu thật của chính họ (xem lib/assistantTools.js) —
// bệnh nhân hỏi lịch hẹn/đơn thuốc/hoá đơn của mình, bác sĩ hỏi ca hôm nay và
// lịch tái khám, admin hỏi doanh thu, số ca theo chuyên khoa, nhật ký hoạt động.
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
    // Ngữ cảnh lấy từ lịch sử đã lưu (đáng tin hơn dữ liệu client gửi lên, và chat tiếp được sau khi tải lại trang).
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
