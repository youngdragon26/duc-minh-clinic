const express = require('express');
const { pool } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { SPECIALTIES } = require('../constants');

const router = express.Router();

// Chatbot dùng function calling (tra lịch trống) — model 3.6 mới đổi vai trò
// "function response" khiến bản SDK hiện tại (@google/generative-ai) bị lỗi 400
// "Role 'function' is not supported", nên tạm dùng bản 2.5 ổn định hơn cho phần này.
const CHAT_MODEL = process.env.GEMINI_CHAT_MODEL || 'gemini-2.5-flash';
// Tóm tắt bệnh sử không dùng tool, gemini-3.6-flash chạy tốt (đã test) và mạnh hơn.
const SUMMARY_MODEL = process.env.GEMINI_SUMMARY_MODEL || 'gemini-3.6-flash';

let genAI;
function getClient() {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!genAI) {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return genAI;
}

// Gemini bản miễn phí đôi khi báo 503 "quá tải" hoặc 429 "quá nhiều yêu cầu" —
// đây là lỗi tạm thời phía Google, nên thử lại vài lần trước khi báo lỗi cho người dùng.
async function withRetry(fn, retries = 2, delayMs = 900) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const retryable = e && (e.status === 503 || e.status === 429);
      if (!retryable || attempt >= retries) throw e;
      await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
    }
  }
}

function aiErrorResponse(e) {
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
  const bySpecialty = {};
  for (const d of doctors.rows) {
    const key = d.specialty || 'Chưa xếp chuyên khoa';
    if (!bySpecialty[key]) bySpecialty[key] = [];
    bySpecialty[key].push(d.name);
  }
  const specialtyLines = SPECIALTIES.map((s) => {
    const price = priceMap[s] != null ? priceMap[s].toLocaleString('vi-VN') + 'đ' : 'chưa niêm yết';
    const docs = bySpecialty[s] && bySpecialty[s].length ? bySpecialty[s].join(', ') : 'chưa có bác sĩ phụ trách';
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

  const doctorsRes = await pool.query("SELECT id, name FROM users WHERE role = 'doctor' AND specialty = $1 ORDER BY name", [specialty]);
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

    const context = await buildClinicContext();
    const todayVN = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
    const systemPrompt = [
      'Bạn là trợ lý ảo trên website của Phòng khám Đa khoa Đức Minh. Trả lời NGẮN GỌN (tối đa 2-4 câu, có thể liệt kê khung giờ dạng gạch đầu dòng khi cần), thân thiện, bằng tiếng Việt.',
      `Hôm nay là ngày ${todayVN} (giờ Việt Nam).`,
      '',
      context,
      '',
      'Bạn có công cụ check_available_slots để tra cứu khung giờ khám còn trống THẬT trong hệ thống — luôn dùng công cụ này khi khách hỏi về lịch trống, đừng tự đoán.',
      '',
      'Quy tắc:',
      '- Chỉ gợi ý chuyên khoa nên khám dựa trên triệu chứng khách mô tả, KHÔNG chẩn đoán bệnh, KHÔNG kê đơn hay tên thuốc cụ thể.',
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

    const model = client.getGenerativeModel({
      model: CHAT_MODEL,
      systemInstruction: systemPrompt,
      tools: [{ functionDeclarations: [checkSlotsDeclaration] }],
    });
    const chat = model.startChat({ history: turns });

    let result = await withRetry(() => chat.sendMessage(message.trim()));
    let calls = result.response.functionCalls();
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
      result = await withRetry(() => chat.sendMessage(responseParts));
      calls = result.response.functionCalls();
      rounds++;
    }

    const text = result.response.text().trim();
    res.json({ reply: text || 'Mình chưa có câu trả lời phù hợp. Bạn gọi hotline 0975 755 333 để được hỗ trợ nhé.' });
  } catch (e) {
    console.error(e);
    const { status, error } = aiErrorResponse(e);
    res.status(status).json({ error });
  }
});

router.use(authenticate);

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

    const model = client.getGenerativeModel({ model: SUMMARY_MODEL, systemInstruction: systemPrompt });
    const result = await withRetry(() => model.generateContent('Lịch sử khám bệnh:\n\n' + historyText));
    res.json({ summary: result.response.text().trim() });
  } catch (e) {
    console.error(e);
    const { status, error } = aiErrorResponse(e);
    res.status(status).json({ error });
  }
});

module.exports = router;
