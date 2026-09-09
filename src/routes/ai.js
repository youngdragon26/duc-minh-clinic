const express = require('express');
const { pool } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { SPECIALTIES } = require('../constants');

const router = express.Router();

const CHAT_MODEL = process.env.GEMINI_CHAT_MODEL || 'gemini-2.0-flash';
const SUMMARY_MODEL = process.env.GEMINI_SUMMARY_MODEL || 'gemini-2.0-flash';

let genAI;
function getClient() {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!genAI) {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return genAI;
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
    const systemPrompt = [
      'Bạn là trợ lý ảo trên website của Phòng khám Đa khoa Đức Minh. Trả lời NGẮN GỌN (tối đa 2-4 câu), thân thiện, bằng tiếng Việt.',
      '',
      context,
      '',
      'Quy tắc:',
      '- Chỉ gợi ý chuyên khoa nên khám dựa trên triệu chứng khách mô tả, KHÔNG chẩn đoán bệnh, KHÔNG kê đơn hay tên thuốc cụ thể.',
      '- Nếu triệu chứng nghe nghiêm trọng/cấp cứu (khó thở, đau ngực dữ dội, chảy máu nhiều, bất tỉnh...), khuyên gọi cấp cứu 115 hoặc đến ngay cơ sở y tế gần nhất.',
      '- Nếu câu hỏi ngoài phạm vi phòng khám hoặc bạn không chắc, khuyên gọi hotline 0975 755 333.',
    ].join('\n');

    // Gemini dùng vai "model" thay vì "assistant", và lịch sử phải bắt đầu bằng "user".
    const turns = Array.isArray(history)
      ? history
          .filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string')
          .slice(-10)
          .map((h) => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content }] }))
      : [];
    while (turns.length && turns[0].role !== 'user') turns.shift();

    const model = client.getGenerativeModel({ model: CHAT_MODEL, systemInstruction: systemPrompt });
    const chat = model.startChat({ history: turns });
    const result = await chat.sendMessage(message.trim());
    const text = result.response.text().trim();

    res.json({ reply: text || 'Mình chưa có câu trả lời phù hợp. Bạn gọi hotline 0975 755 333 để được hỗ trợ nhé.' });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: 'Không kết nối được tới dịch vụ AI, thử lại sau.' });
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
    const result = await model.generateContent('Lịch sử khám bệnh:\n\n' + historyText);
    res.json({ summary: result.response.text().trim() });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: 'Không kết nối được tới dịch vụ AI, thử lại sau.' });
  }
});

module.exports = router;
