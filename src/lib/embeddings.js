// Bọc lại API embedding của Gemini — dùng chung cho cả bước Indexing (nhúng
// tài liệu, taskType RETRIEVAL_DOCUMENT) và Retrieval (nhúng câu hỏi, taskType
// RETRIEVAL_QUERY). Model text-embedding-004 sinh vector 768 chiều.
const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001';

let genAI;
function getClient() {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!genAI) {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return genAI;
}

async function embedText(text, taskType) {
  const client = getClient();
  if (!client) throw Object.assign(new Error('Thiếu GEMINI_API_KEY'), { code: 'no_client' });
  const model = client.getGenerativeModel({ model: EMBEDDING_MODEL });
  const result = await model.embedContent({
    content: { role: 'user', parts: [{ text }] },
    taskType,
  });
  return result.embedding.values;
}

// pgvector nhận vector qua SQL dưới dạng chuỗi '[0.1,0.2,...]'.
function toVectorLiteral(values) {
  return '[' + values.join(',') + ']';
}

module.exports = { embedText, toVectorLiteral, EMBEDDING_MODEL };
