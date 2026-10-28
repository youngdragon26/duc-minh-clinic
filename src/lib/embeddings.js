// Bọc lại API embedding của Gemini — dùng chung cho cả bước Indexing (nhúng
// tài liệu, taskType RETRIEVAL_DOCUMENT) và Retrieval (nhúng câu hỏi, taskType
// RETRIEVAL_QUERY). Model gemini-embedding-001 sinh vector 3072 chiều.
//
// Dùng SDK @google/genai (thay cho @google/generative-ai đã bị Google khai tử
// hoàn toàn — "All support for the google.generativeai package has ended").
const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001';

let client;
function getClient() {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!client) {
    const { GoogleGenAI } = require('@google/genai');
    client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return client;
}

// Mỗi lượt chat nhúng cùng 1 câu hỏi cho cả tìm tài liệu (RAG) lẫn tìm câu trả lời mẫu — nhớ
// vài trăm kết quả gần nhất để không tốn 2 lượt gọi Gemini (có hạn ngạch) cho cùng 1 câu.
const CACHE_SIZE = 300;
const cache = new Map();

async function embedText(text, taskType) {
  const key = taskType + '\u0000' + text;
  if (cache.has(key)) return cache.get(key);
  const c = getClient();
  if (!c) throw Object.assign(new Error('Thiếu GEMINI_API_KEY'), { code: 'no_client' });
  const result = await c.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: text,
    config: { taskType },
  });
  const values = result.embeddings[0].values;
  cache.set(key, values);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
  return values;
}

// pgvector nhận vector qua SQL dưới dạng chuỗi '[0.1,0.2,...]'.
function toVectorLiteral(values) {
  return '[' + values.join(',') + ']';
}

module.exports = { embedText, toVectorLiteral, EMBEDDING_MODEL };
