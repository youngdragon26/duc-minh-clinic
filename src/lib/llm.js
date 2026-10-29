// Lớp gọi mô hình ngôn ngữ dùng chung cho mọi tính năng AI. AI_PROVIDER:
//   - "gemini" (mặc định): SDK @google/genai, cần GEMINI_API_KEY.
//   - "ollama": model chạy trên máy (hoặc laptop qua đường hầm, xem setRemoteOllama); lỗi thì chuyển sang Gemini nếu có khoá.
// Embedding cho RAG (lib/embeddings.js) luôn dùng Gemini — kb_chunks đã nhúng bằng gemini-embedding-001.
const PROVIDER = (process.env.AI_PROVIDER || 'gemini').trim().toLowerCase() === 'ollama' ? 'ollama' : 'gemini';

const GEMINI_CHAT_MODEL = process.env.GEMINI_CHAT_MODEL || 'gemini-3.6-flash';
const GEMINI_SUMMARY_MODEL = process.env.GEMINI_SUMMARY_MODEL || 'gemini-3.6-flash';

const OLLAMA_HOST = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3:4b-instruct';
// System prompt dài vài nghìn token — mặc định 4096 của Ollama cắt mất phần đầu.
const OLLAMA_NUM_CTX = Number(process.env.OLLAMA_NUM_CTX) || 8192;
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '30m';
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 120000;
// Tắt chế độ suy nghĩ của Qwen3 (chậm gấp nhiều lần) trừ khi OLLAMA_THINK=true.
const OLLAMA_THINK = process.env.OLLAMA_THINK === 'true';
// Khoá chung server ↔ laptop (đường hầm Ollama). Để trống = tắt. trim(): ô Environment của Render hay dính xuống dòng.
const OLLAMA_API_KEY = (process.env.OLLAMA_API_KEY || '').trim();

// Địa chỉ đường hầm laptop báo gần nhất; quá 5 phút không báo lại thì quay về OLLAMA_HOST.
const REMOTE_OLLAMA_TTL_MS = 5 * 60 * 1000;
let remoteOllama = null;

function setRemoteOllama(url) {
  remoteOllama = { url: url.replace(/\/+$/, ''), seenAt: Date.now() };
}

function ollamaHost() {
  if (remoteOllama && Date.now() - remoteOllama.seenAt < REMOTE_OLLAMA_TTL_MS) return remoteOllama.url;
  return OLLAMA_HOST;
}

// So khoá theo thời gian hằng (băm SHA-256) để không lộ khoá qua thời gian phản hồi.
function checkOllamaKey(token) {
  if (!OLLAMA_API_KEY || !token) return false;
  const crypto = require('crypto');
  const hash = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(hash(String(token).trim()), hash(OLLAMA_API_KEY));
}

const PROVIDER_LABEL = PROVIDER === 'ollama' ? `Ollama (${OLLAMA_MODEL})` : `Gemini (${GEMINI_CHAT_MODEL})`;

let genAI;
function getGeminiClient() {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!genAI) {
    const { GoogleGenAI } = require('@google/genai');
    genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return genAI;
}

function isConfigured() {
  return PROVIDER === 'ollama' || !!getGeminiClient();
}

const NOT_CONFIGURED_ERROR = 'Trợ lý AI chưa được cấu hình (thiếu GEMINI_API_KEY).';

// Thử lại lỗi tạm thời 503/429 của Gemini; hết hạn ngạch NGÀY (RESOURCE_EXHAUSTED/PerDay) thì báo ngay.
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
  if (e && e.provider === 'ollama') {
    if (e.code === 'ollama_unreachable') {
      return { status: 503, error: 'Không kết nối được tới Ollama trên máy chủ — hãy mở ứng dụng Ollama rồi thử lại.' };
    }
    if (e.status === 404) {
      return { status: 503, error: `Ollama chưa có mô hình "${OLLAMA_MODEL}" — chạy lệnh: ollama pull ${OLLAMA_MODEL}` };
    }
    if (e.code === 'ollama_timeout') {
      return { status: 504, error: 'Mô hình AI trên máy trả lời quá lâu, vui lòng thử lại.' };
    }
    return { status: 502, error: 'Mô hình AI trên máy (Ollama) gặp lỗi, thử lại sau.' };
  }
  if (e && e.status === 429 && (msg.includes('PerDay') || msg.includes('RESOURCE_EXHAUSTED'))) {
    return {
      status: 503,
      error: 'Trợ lý AI đã đạt giới hạn miễn phí hôm nay, vui lòng thử lại vào ngày mai hoặc gọi hotline 0974 755 333 để được hỗ trợ.',
    };
  }
  if (e && (e.status === 503 || e.status === 429)) {
    return { status: 503, error: 'Dịch vụ AI đang quá tải, vui lòng thử lại sau ít phút.' };
  }
  return { status: 502, error: 'Không kết nối được tới dịch vụ AI, thử lại sau.' };
}

// ---------- Ollama ----------

async function ollamaChat(body) {
  let res;
  try {
    res = await fetch(ollamaHost() + '/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(OLLAMA_API_KEY ? { Authorization: 'Bearer ' + OLLAMA_API_KEY } : {}),
      },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        think: OLLAMA_THINK,
        keep_alive: OLLAMA_KEEP_ALIVE,
        ...body,
        options: { num_ctx: OLLAMA_NUM_CTX, ...(body.options || {}) },
      }),
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw Object.assign(new Error(timedOut ? 'Ollama timeout' : 'Ollama unreachable: ' + e.message), {
      provider: 'ollama',
      code: timedOut ? 'ollama_timeout' : 'ollama_unreachable',
    });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw Object.assign(new Error('Ollama: ' + (data.error || res.statusText)), { provider: 'ollama', status: res.status });
  }
  // AI_DEBUG=true: in số token và thời gian đọc prompt / sinh câu trả lời.
  if (process.env.AI_DEBUG === 'true' && data.total_duration) {
    const s = (ns) => ((ns || 0) / 1e9).toFixed(1) + 's';
    console.log(`[ollama] prompt ${data.prompt_eval_count || 0} token/${s(data.prompt_eval_duration)}, trả lời ${data.eval_count || 0} token/${s(data.eval_duration)}, tổng ${s(data.total_duration)}`);
  }
  return data.message || {};
}

// Vector của 1 đoạn văn bằng model embedding trên Ollama (câu trả lời mẫu). Lỗi trả null, không ném lỗi.
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'qwen3-embedding:0.6b';
async function ollamaEmbed(text) {
  try {
    const res = await fetch(ollamaHost() + '/api/embed', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(OLLAMA_API_KEY ? { Authorization: 'Bearer ' + OLLAMA_API_KEY } : {}),
      },
      body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, input: text, keep_alive: OLLAMA_KEEP_ALIVE }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({}));
    return res.ok && data.embeddings && data.embeddings[0] ? data.embeddings[0] : null;
  } catch (e) {
    return null;
  }
}

// Nạp sẵn model lúc khởi động để câu hỏi đầu tiên không phải chờ. Lỗi chỉ ghi log.
async function warmUp() {
  if (PROVIDER !== 'ollama') return;
  try {
    await ollamaChat({ messages: [] });
    await ollamaEmbed('xin chào');
    console.log(`Đã nạp sẵn mô hình ${PROVIDER_LABEL}.`);
  } catch (e) {
    console.error(`Chưa nạp được mô hình ${PROVIDER_LABEL}:`, e.message);
  }
}

// ---------- API chung ----------

// AI_PROVIDER=ollama: lỗi thì chuyển sang Gemini nếu có khoá — trừ khi công cụ đã chạy (e.toolsRan),
// vì Gemini sẽ chạy lại công cụ (vd đặt lịch trùng).
async function withFallback(ollamaFn, geminiFn) {
  if (PROVIDER !== 'ollama') return geminiFn();
  try {
    return await ollamaFn();
  } catch (e) {
    if (!e || e.provider !== 'ollama' || e.toolsRan || !getGeminiClient()) throw e;
    console.error('Ollama lỗi, chuyển sang Gemini:', e.message);
    return geminiFn();
  }
}

// Sinh 1 đối tượng JSON theo schema (mở rộng câu hỏi RAG).
async function generateJSON({ system, prompt, schema }) {
  return withFallback(
    async () => {
      const msg = await ollamaChat({
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
        format: schema,
        options: { temperature: 0.4 },
      });
      return JSON.parse(msg.content || '{}');
    },
    async () => {
      const result = await withRetry(() =>
        getGeminiClient().models.generateContent({
          model: GEMINI_CHAT_MODEL,
          contents: prompt,
          config: { systemInstruction: system, responseMimeType: 'application/json', responseSchema: schema },
        })
      );
      return JSON.parse(result.text || '{}');
    }
  );
}

// Sinh 1 đoạn văn bản, không có công cụ (tóm tắt bệnh sử).
async function generateText({ system, prompt }) {
  return withFallback(
    async () => {
      const msg = await ollamaChat({ messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] });
      return (msg.content || '').trim();
    },
    async () => {
      const result = await withRetry(() =>
        getGeminiClient().models.generateContent({
          model: GEMINI_SUMMARY_MODEL,
          contents: prompt,
          config: { systemInstruction: system },
        })
      );
      return (result.text || '').trim();
    }
  );
}

// Hội thoại có công cụ: chạy handleCall(name, args) mỗi khi model gọi, tối đa maxRounds vòng.
// history: [{ role: 'user'|'assistant', content }]. Trả về chuỗi rỗng nếu model không trả lời bằng chữ.
async function chatWithTools(params) {
  return withFallback(() => ollamaChatWithTools(params), () => geminiChatWithTools(params));
}

async function ollamaChatWithTools({ system, history, message, declarations, temperature, maxRounds, handleCall }) {
  const messages = [
    { role: 'system', content: system },
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: message },
  ];
  const tools = declarations.map((d) => ({ type: 'function', function: d }));
  let toolsRan = false;
  try {
    let reply = await ollamaChat({ messages, tools, options: { temperature } });
    let rounds = 0;
    while (reply.tool_calls && reply.tool_calls.length > 0 && rounds < maxRounds) {
      messages.push(reply);
      for (const call of reply.tool_calls) {
        const name = call.function && call.function.name;
        toolsRan = true;
        const output = await handleCall(name, (call.function && call.function.arguments) || {});
        messages.push({ role: 'tool', tool_name: name, content: JSON.stringify(output) });
      }
      reply = await ollamaChat({ messages, tools, options: { temperature } });
      rounds++;
    }
    return (reply.content || '').trim();
  } catch (e) {
    if (e) e.toolsRan = toolsRan;
    throw e;
  }
}

async function geminiChatWithTools({ system, history, message, declarations, temperature, maxRounds, handleCall }) {
  // Gemini dùng vai "model" thay vì "assistant", và lịch sử phải bắt đầu bằng "user".
  const turns = history.map((h) => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content }] }));
  while (turns.length && turns[0].role !== 'user') turns.shift();

  const chat = getGeminiClient().chats.create({
    model: GEMINI_CHAT_MODEL,
    config: { systemInstruction: system, tools: [{ functionDeclarations: declarations }], temperature },
    history: turns,
  });
  let result = await withRetry(() => chat.sendMessage({ message }));
  let calls = result.functionCalls;
  let rounds = 0;
  while (calls && calls.length > 0 && rounds < maxRounds) {
    const responseParts = [];
    for (const call of calls) {
      const output = await handleCall(call.name, call.args || {});
      responseParts.push({ functionResponse: { name: call.name, response: output } });
    }
    result = await withRetry(() => chat.sendMessage({ message: responseParts }));
    calls = result.functionCalls;
    rounds++;
  }
  return (result.text || '').trim();
}

module.exports = {
  PROVIDER,
  PROVIDER_LABEL,
  NOT_CONFIGURED_ERROR,
  isConfigured,
  withRetry,
  aiErrorResponse,
  generateJSON,
  generateText,
  chatWithTools,
  warmUp,
  setRemoteOllama,
  ollamaEmbed,
  OLLAMA_EMBED_MODEL,
  checkOllamaKey,
};
