const express = require('express');
const { pool } = require('../db');
const { authenticate, requireAdmin, requireRole } = require('../middleware/auth');
const { SPECIALTIES } = require('../constants');
const { chunkText } = require('../lib/chunk');
const { embedText, toVectorLiteral } = require('../lib/embeddings');

const router = express.Router();

// SDK @google/generative-ai (cũ) hardcode role "function" cho function response,
// không tương thích với model 3.x (chỉ nhận SYSTEM/USER/MODEL/...) — đây là lý do
// trước đây phải ép dùng model 2.5 cho phần chat (có tool). Google cũng đã khai tử
// hẳn @google/generative-ai. Đã chuyển sang SDK @google/genai (mới, còn bảo trì),
// SDK này tự gộp function response vào role "user" nên dùng được model 3.x cho cả
// phần có tool calling.
const CHAT_MODEL = process.env.GEMINI_CHAT_MODEL || 'gemini-3.6-flash';
const SUMMARY_MODEL = process.env.GEMINI_SUMMARY_MODEL || 'gemini-3.6-flash';

let genAI;
function getClient() {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!genAI) {
    const { GoogleGenAI } = require('@google/genai');
    genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return genAI;
}

// Gemini bản miễn phí đôi khi báo 503 "quá tải" hoặc 429 "quá nhiều yêu cầu" —
// đây là lỗi tạm thời phía Google, nên thử lại vài lần trước khi báo lỗi cho người dùng.
// Riêng lỗi hết hạn ngạch NGÀY (RESOURCE_EXHAUSTED/PerDay) thì thử lại vô ích
// (phải đợi qua ngày mới hết), nên báo lỗi ngay thay vì làm người dùng chờ.
async function withRetry(fn, retries = 2, delayMs = 900) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const msg = String((e && e.message) || '');
      const isDailyQuota = e && e.status === 429 && (msg.includes('PerDay') || msg.includes('RESOURCE_EXHAUSTED'));
      const retryable = !isDailyQuota && e && (e.status === 503 || e.status === 429);
      if (!retryable || attempt >= retries) throw e;
      await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
    }
  }
}

function aiErrorResponse(e) {
  const msg = String((e && e.message) || '');
  // Gói Gemini miễn phí giới hạn 20 request/ngày/model — hết hạn ngạch NGÀY,
  // không phải quá tải tạm thời, nên phải báo khác với lỗi 503 thông thường
  // (không nên khuyên "thử lại sau ít phút" vì thực tế phải đợi qua ngày mới).
  if (e && e.status === 429 && (msg.includes('PerDay') || msg.includes('RESOURCE_EXHAUSTED'))) {
    return {
      status: 503,
      error: 'Trợ lý AI đã đạt giới hạn miễn phí hôm nay, vui lòng thử lại vào ngày mai hoặc gọi hotline 0975 755 333 để được hỗ trợ.',
    };
  }
  if (e && (e.status === 503 || e.status === 429)) {
    return { status: 503, error: 'Dịch vụ AI đang quá tải, vui lòng thử lại sau ít phút.' };
  }
  return { status: 502, error: 'Không kết nối được tới dịch vụ AI, thử lại sau.' };
}

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
  const specialtyLines = SPECIALTIES.map((s) => {
    const price = priceMap[s] != null ? priceMap[s].toLocaleString('vi-VN') + 'đ' : 'chưa niêm yết';
    const docNames = [...(bySpecialty[s] || []), ...generalDoctors];
    const docs = docNames.length ? docNames.join(', ') : 'chưa có bác sĩ phụ trách';
    return `- ${s}: giá khám ${price}; bác sĩ: ${docs}`;
  }).join('\n');

  return [
    'Thông tin phòng khám (chỉ dùng đúng dữ kiện dưới đây, không bịa thêm):',
    '- Tên: Phòng khám Đa khoa Đức Minh.',
    '- Địa chỉ: Phường Túc Duyên, TP. Thái Nguyên.',
    '- Hotline: 0975 755 333.',
    '- Giờ làm việc: 7:00–21:00, Thứ 2 – Thứ 7 (không khám Chủ nhật).',
    '- Cách đặt lịch: đăng nhập/đăng ký tại /tai-khoan.html rồi đặt lịch tại /dat-lich.html.',
    '',
    'Chuyên khoa, giá khám và bác sĩ hiện có:',
    specialtyLines,
  ].join('\n');
}

const FIXED_SLOTS = Array.from({ length: 14 }, (_, i) => String(7 + i).padStart(2, '0') + ':00'); // 07:00 - 20:00

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

  // specialty = NULL nghĩa là "bác sĩ tổng quát" phụ trách được mọi chuyên khoa.
  const doctorsRes = await pool.query(
    "SELECT id, name FROM users WHERE role = 'doctor' AND (specialty = $1 OR specialty IS NULL) ORDER BY name",
    [specialty]
  );
  if (doctorsRes.rows.length === 0) {
    return { specialty, date, available: false, message: `Chuyên khoa ${specialty} hiện chưa có bác sĩ phụ trách.` };
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
    return { doctorName: d.name, freeSlots: FIXED_SLOTS.filter((s) => !booked.has(s)) };
  });

  return { specialty, date, available: doctors.some((d) => d.freeSlots.length > 0), doctors };
}

// ---------- RAG: Retrieval phase ----------
// Nhúng câu hỏi thành vector, tìm các đoạn tri thức gần nhất bằng cosine similarity
// (toán tử <=> của pgvector), kèm tên tài liệu nguồn để model có thể trích dẫn.
async function retrieveKnowledge(query, k = 4) {
  try {
    const queryVector = await embedText(query, 'RETRIEVAL_QUERY');
    const literal = toVectorLiteral(queryVector);
    const result = await pool.query(
      `SELECT c.content, d.title, 1 - (c.embedding <=> $1::vector) AS similarity
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

// TẠM THỜI: xem kết quả retrieval thô (không gọi generateContent, không tốn quota chat) — xoá sau khi chẩn đoán xong.
router.get('/_debug-retrieve', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.json({ error: 'thiếu ?q=' });
    const hits = await retrieveKnowledge(String(q), 6);
    res.json({ query: q, hits });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// Chatbot công khai cho khách/bệnh nhân — không bắt buộc đăng nhập.
router.post('/chat', async (req, res) => {
  const client = getClient();
  if (!client) {
    return res.status(503).json({ error: 'Trợ lý AI chưa được cấu hình (thiếu GEMINI_API_KEY).' });
  }
  try {
    const { message, history } = req.body || {};
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Thiếu nội dung câu hỏi.' });
    }

    const [context, retrieved] = await Promise.all([
      buildClinicContext(),
      retrieveKnowledge(message.trim()),
    ]);
    const todayVN = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });

    const knowledgeBlock = retrieved.length
      ? [
          'Tài liệu tham khảo tìm được (có thể liên quan hoặc không, tự đánh giá; nếu dùng thì ghi "(Nguồn: <tên tài liệu>)" cuối câu):',
          ...retrieved.map((r) => `--- ${r.title} ---\n${r.content}`),
        ].join('\n\n')
      : 'Không tìm thấy tài liệu tham khảo nào liên quan trong cơ sở tri thức.';

    const systemPrompt = [
      'Bạn là trợ lý ảo trên website của Phòng khám Đa khoa Đức Minh. Trả lời NGẮN GỌN (tối đa 2-4 câu, có thể liệt kê khung giờ dạng gạch đầu dòng khi cần), thân thiện, bằng tiếng Việt.',
      `Hôm nay là ngày ${todayVN} (giờ Việt Nam).`,
      '',
      context,
      '',
      knowledgeBlock,
      '',
      'Bạn có công cụ check_available_slots để tra cứu khung giờ khám còn trống THẬT trong hệ thống — luôn dùng công cụ này khi khách hỏi về lịch trống, đừng tự đoán.',
      '',
      'Quy tắc:',
      '- Ưu tiên dùng thông tin trong "Tài liệu tham khảo" ở trên nếu liên quan tới câu hỏi; nếu tài liệu không liên quan thì bỏ qua, không nhắc tới nó.',
      '- Gợi ý chuyên khoa nên khám dựa trên triệu chứng khách mô tả, KHÔNG tự chẩn đoán bệnh thay bác sĩ.',
      '- Chỉ được nêu tên thuốc/liều dùng/cách xử lý khi thông tin đó có sẵn trong "Tài liệu tham khảo" ở trên — TUYỆT ĐỐI KHÔNG tự bịa thêm tên thuốc hay liều dùng ngoài tài liệu. Khi nêu, luôn trích dẫn (Nguồn: ...) và kèm câu nhắc đây chỉ là thông tin tham khảo, cần đến khám bác sĩ nếu triệu chứng không đỡ hoặc nặng hơn.',
      '- Với trẻ em: luôn hỏi rõ tuổi/cân nặng trước khi nêu bất kỳ thông tin liều dùng nào từ tài liệu tham khảo, và luôn khuyên nên để bác sĩ khám trực tiếp thay vì tự dùng thuốc tại nhà.',
      '- Nếu triệu chứng nghe nghiêm trọng/cấp cứu (khó thở, đau ngực dữ dội, chảy máu nhiều, bất tỉnh...), khuyên gọi cấp cứu 115 hoặc đến ngay cơ sở y tế gần nhất.',
      '- Nếu câu hỏi ngoài phạm vi phòng khám hoặc bạn không chắc, khuyên gọi hotline 0975 755 333.',
      '- Sau khi báo lịch trống, nhắc khách đặt lịch tại /dat-lich.html (cần đăng nhập/đăng ký ở /tai-khoan.html trước).',
    ].join('\n');

    // Gemini dùng vai "model" thay vì "assistant", và lịch sử phải bắt đầu bằng "user".
    const turns = Array.isArray(history)
      ? history
          .filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string')
          .slice(-10)
          .map((h) => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content }] }))
      : [];
    while (turns.length && turns[0].role !== 'user') turns.shift();

    const chat = client.chats.create({
      model: CHAT_MODEL,
      config: {
        systemInstruction: systemPrompt,
        tools: [{ functionDeclarations: [checkSlotsDeclaration] }],
      },
      history: turns,
    });

    let result = await withRetry(() => chat.sendMessage({ message: message.trim() }));
    let calls = result.functionCalls;
    let rounds = 0;
    while (calls && calls.length > 0 && rounds < 3) {
      const responseParts = [];
      for (const call of calls) {
        let output;
        if (call.name === 'check_available_slots') {
          output = await checkAvailableSlots(call.args || {});
        } else {
          output = { error: 'Công cụ không được hỗ trợ.' };
        }
        responseParts.push({ functionResponse: { name: call.name, response: output } });
      }
      result = await withRetry(() => chat.sendMessage({ message: responseParts }));
      calls = result.functionCalls;
      rounds++;
    }

    const text = (result.text || '').trim();
    res.json({ reply: text || 'Mình chưa có câu trả lời phù hợp. Bạn gọi hotline 0975 755 333 để được hỗ trợ nhé.' });
  } catch (e) {
    console.error(e);
    const { status, error } = aiErrorResponse(e);
    res.status(status).json({ error });
  }
});

router.use(authenticate);

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
  const client = getClient();
  if (!client) return res.status(503).json({ error: 'Trợ lý AI chưa được cấu hình (thiếu GEMINI_API_KEY).' });
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
  const client = getClient();
  if (!client) {
    return res.status(503).json({ error: 'Trợ lý AI chưa được cấu hình (thiếu GEMINI_API_KEY).' });
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

    const result = await withRetry(() => client.models.generateContent({
      model: SUMMARY_MODEL,
      contents: 'Lịch sử khám bệnh:\n\n' + historyText,
      config: { systemInstruction: systemPrompt },
    }));
    res.json({ summary: (result.text || '').trim() });
  } catch (e) {
    console.error(e);
    const { status, error } = aiErrorResponse(e);
    res.status(status).json({ error });
  }
});

module.exports = router;
