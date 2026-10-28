// Kho câu trả lời mẫu của chatbot (bảng chat_examples) — "dạy" chatbot bằng ví dụ (few-shot) thay
// vì huấn luyện lại model: mỗi lượt chat tìm vài câu hỏi mẫu gần nghĩa nhất với câu của khách rồi đưa
// cặp hỏi–đáp vào prompt cho model bắt chước. Câu gần như trùng khớp thì trả nguyên câu mẫu.
//
// Hai cách so câu hỏi:
// - Vector Gemini (cùng không gian RETRIEVAL_QUERY với câu hỏi nên dùng chung 1 lượt nhúng với RAG):
//   hiểu được câu hỏi khác chữ cùng ý. Gói miễn phí chỉ 1000 lượt nhúng/ngày — đã hết thật khi kiểm thử.
// - Trigram ký tự trên chữ đã bỏ dấu: không tốn hạn ngạch, luôn chạy được, nhưng chỉ bắt được câu gần
//   giống về chữ. Dùng khi không nhúng được (thiếu key, hết hạn ngạch) và cho câu mẫu chưa có vector.
const { pool } = require('../db');
const { embedText, toVectorLiteral } = require('./embeddings');

// Ngưỡng đo trên bộ mẫu thật (23 câu thử). Vector: câu cùng ý khác chữ đạt 0.70–0.97, câu KHÔNG nên khớp
// (vd "giờ làm việc" ↔ câu mẫu BHYT) cao nhất 0.764 → lấy từ 0.77. Trigram (20 câu thử) phân tách kém hơn:
// câu khớp đúng 0.50–0.89 nhưng khớp nhầm lên tới 0.667 ("đặt lịch khám răng" ↔ "đổi lịch khám đã đặt")
// → chỉ lấy từ 0.70, trả nguyên văn từ 0.82; bỏ sót câu khác chữ là cái giá chấp nhận được khi chạy dự phòng.
const MIN_SIMILARITY = Number(process.env.AI_EXAMPLE_MIN_SIMILARITY) || 0.77;
const DIRECT_SIMILARITY = Number(process.env.AI_EXAMPLE_DIRECT_SIMILARITY) || 0.93;
const LEXICAL_MIN_SIMILARITY = 0.7;
const LEXICAL_DIRECT_SIMILARITY = 0.82;

async function embedQuestion(question) {
  return toVectorLiteral(await embedText(question, 'RETRIEVAL_QUERY'));
}

// Nhúng câu hỏi nếu được; hết hạn ngạch / thiếu key thì trả null — câu mẫu vẫn lưu và dùng được qua trigram.
async function tryEmbedQuestion(question) {
  if (!process.env.GEMINI_API_KEY) return null;
  try {
    return await embedQuestion(question);
  } catch (e) {
    console.error('Chưa nhúng được câu mẫu (sẽ dùng so khớp chữ):', e.message.slice(0, 120));
    return null;
  }
}

const plain = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function trigrams(s) {
  const t = ` ${plain(s)} `;
  const grams = new Set();
  for (let i = 0; i + 3 <= t.length; i++) grams.add(t.slice(i, i + 3));
  return grams;
}
function lexicalSimilarity(a, b) {
  const ga = trigrams(a);
  const gb = trigrams(b);
  let common = 0;
  for (const g of ga) if (gb.has(g)) common++;
  return ga.size + gb.size ? (2 * common) / (ga.size + gb.size) : 0;
}

// Trả về tối đa k câu mẫu [{ id, question, answer, similarity, direct }] đủ gần, giống nhất trước;
// direct = đủ giống để trả nguyên văn. Lỗi thì trả [] — thiếu ví dụ không được làm hỏng lượt chat.
async function findExamples(text, k = 3) {
  if (!String(text || '').trim()) return [];
  try {
    let vector = null;
    if (process.env.GEMINI_API_KEY) {
      try {
        vector = await embedQuestion(text);
      } catch (e) {
        vector = null; // hết hạn ngạch nhúng → so khớp chữ
      }
    }
    const rows = (await pool.query(
      vector
        ? 'SELECT id, question, answer, 1 - (embedding <=> $1::vector) AS vsim FROM chat_examples'
        : 'SELECT id, question, answer, NULL AS vsim FROM chat_examples',
      vector ? [vector] : []
    )).rows;
    return rows
      .map((r) => {
        const lex = lexicalSimilarity(text, r.question);
        const vsim = r.vsim == null ? null : Number(r.vsim);
        // Có vector thì theo vector; câu chưa có vector (hoặc không nhúng được) thì theo trigram.
        return vsim != null
          ? { id: r.id, question: r.question, answer: r.answer, similarity: vsim, direct: vsim >= DIRECT_SIMILARITY, ok: vsim >= MIN_SIMILARITY }
          : { id: r.id, question: r.question, answer: r.answer, similarity: lex, direct: lex >= LEXICAL_DIRECT_SIMILARITY, ok: lex >= LEXICAL_MIN_SIMILARITY, lexical: true };
      })
      .filter((r) => r.ok)
      .sort((a, b) => Number(b.direct) - Number(a.direct) || b.similarity - a.similarity)
      .slice(0, k)
      .map(({ ok, ...r }) => r);
  } catch (e) {
    console.error('Tìm câu trả lời mẫu lỗi:', e.message);
    return [];
  }
}

module.exports = { tryEmbedQuestion, findExamples };
