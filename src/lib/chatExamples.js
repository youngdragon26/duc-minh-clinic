// Kho câu trả lời mẫu của chatbot (bảng chat_examples) — "dạy" chatbot bằng ví dụ (few-shot) thay
// vì huấn luyện lại model: mỗi lượt chat tìm vài câu hỏi mẫu gần nghĩa nhất với câu của khách rồi đưa
// cặp hỏi–đáp vào prompt cho model bắt chước. Câu gần như trùng khớp thì trả nguyên câu mẫu.
//
// Hai cách so câu hỏi:
// - Vector của model embedding chạy trên Ollama (llm.ollamaEmbed, qwen3-embedding:0.6b): hiểu câu khác chữ cùng
//   ý, không tốn hạn ngạch. Bản đầu dùng vector Gemini nhưng gói miễn phí chỉ 1000 lượt/ngày — đã hết thật khi kiểm thử.
// - Trigram ký tự trên chữ đã bỏ dấu: luôn chạy được (khi không gọi được Ollama — vd Render lúc laptop tắt, hoặc câu
//   mẫu chưa có vector), nhưng chỉ bắt được câu gần giống về chữ.
const { pool } = require('../db');
const { ollamaEmbed } = require('./llm');
const { toVectorLiteral } = require('./embeddings');

// Ngưỡng đo trên 33 câu thử thật. qwen3-embedding:0.6b phân tách kém hơn Gemini: câu cùng ý đạt 0.55–0.91, câu
// KHÔNG nên khớp lên tới 0.693 ("giờ làm việc" ↔ "mấy giờ đóng cửa") — lấy từ 0.70 (câu đúng bị bỏ sót như "bạn
// tên gì", "làm thơ" đã có trả lời cố định trong ai.js lo). Trả nguyên văn từ 0.85: "đau đầu quá" ↔ "đau quá" đạt 0.818.
// Thêm lời dẫn "Instruct: …" của Qwen3-Embedding đã thử: không tách tốt hơn. Trigram (LEXICAL_*) dùng song song —
// bắt tốt câu gõ không dấu gần trùng chữ; ngưỡng chặt vì khớp nhầm lên tới 0.667.
const VECTOR_MIN_SIMILARITY = Number(process.env.AI_EXAMPLE_MIN_SIMILARITY) || 0.7;
const VECTOR_DIRECT_SIMILARITY = Number(process.env.AI_EXAMPLE_DIRECT_SIMILARITY) || 0.85;
const LEXICAL_MIN_SIMILARITY = 0.7;
const LEXICAL_DIRECT_SIMILARITY = 0.82;

// Mỗi lượt chat nhúng câu hỏi 1 lần; nhớ vài trăm câu gần nhất (khách hay hỏi lại / bấm câu gợi ý giống nhau).
const CACHE_SIZE = 300;
const cache = new Map();

// Vector (dạng chuỗi pgvector) của 1 câu hỏi, hoặc null nếu không gọi được Ollama.
async function tryEmbedQuestion(question) {
  if (cache.has(question)) return cache.get(question);
  const values = await ollamaEmbed(question);
  const literal = values ? toVectorLiteral(values) : null;
  if (literal) {
    cache.set(question, literal);
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
  }
  return literal;
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

// Trả về tối đa k câu mẫu [{ id, question, answer, similarity, direct, lexical? }] đủ gần, giống nhất trước;
// direct = đủ giống để trả nguyên văn. Lỗi thì trả [] — thiếu ví dụ không được làm hỏng lượt chat.
async function findExamples(text, k = 3) {
  if (!String(text || '').trim()) return [];
  try {
    const vector = await tryEmbedQuestion(text);
    const rows = (await pool.query(
      vector
        ? 'SELECT id, question, answer, 1 - (local_embedding <=> $1::vector) AS vsim FROM chat_examples'
        : 'SELECT id, question, answer, NULL AS vsim FROM chat_examples',
      vector ? [vector] : []
    )).rows;
    return rows
      .map((r) => {
        // Đạt ngưỡng ở vector HOẶC trigram là đủ; điểm hiển thị lấy theo cách đạt cao hơn so với ngưỡng của nó.
        const vsim = r.vsim == null ? null : Number(r.vsim);
        const lex = lexicalSimilarity(text, r.question);
        const vectorWins = vsim != null && vsim - VECTOR_MIN_SIMILARITY >= lex - LEXICAL_MIN_SIMILARITY;
        return {
          id: r.id,
          question: r.question,
          answer: r.answer,
          similarity: vectorWins ? vsim : lex,
          direct: (vsim != null && vsim >= VECTOR_DIRECT_SIMILARITY) || lex >= LEXICAL_DIRECT_SIMILARITY,
          ok: (vsim != null && vsim >= VECTOR_MIN_SIMILARITY) || lex >= LEXICAL_MIN_SIMILARITY,
          ...(vectorWins ? {} : { lexical: true }),
        };
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
