// Lớp gọi mô hình ngôn ngữ dùng chung cho mọi tính năng AI (chatbot công khai, trợ lý theo
// vai trò, mở rộng câu hỏi RAG, tóm tắt bệnh sử) — chọn nhà cung cấp bằng biến AI_PROVIDER:
//   - "gemini" (mặc định): gọi Gemini qua SDK @google/genai, cần GEMINI_API_KEY.
//   - "ollama": gọi mô hình chạy NGAY TRÊN MÁY qua Ollama (http://127.0.0.1:11434) — không
//     tốn hạn ngạch 20 lượt/ngày của Gemini, không phụ thuộc mạng tới Google. Chỉ dùng được
//     khi server Node gọi tới được Ollama: cùng máy, hoặc bản deploy trên Render gọi về laptop
//     qua đường hầm do scripts/ollama-tunnel.js mở (laptop tự báo địa chỉ lên, xem
//     setRemoteOllama). Gọi Ollama lỗi (laptop tắt, đường hầm đứt) thì tự chuyển sang Gemini
//     nếu có GEMINI_API_KEY — chatbot trên web không chết theo laptop.
// Embedding (vector cho RAG, lib/embeddings.js) KHÔNG đi qua đây — vẫn luôn dùng Gemini, vì
// toàn bộ kb_chunks đã được nhúng bằng gemini-embedding-001 (3072 chiều); đổi mô hình nhúng
// thì phải nhúng lại cả cơ sở tri thức.
const PROVIDER = (process.env.AI_PROVIDER || 'gemini').trim().toLowerCase() === 'ollama' ? 'ollama' : 'gemini';

const GEMINI_CHAT_MODEL = process.env.GEMINI_CHAT_MODEL || 'gemini-3.6-flash';
const GEMINI_SUMMARY_MODEL = process.env.GEMINI_SUMMARY_MODEL || 'gemini-3.6-flash';

const OLLAMA_HOST = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3:4b-instruct';
// System prompt của chatbot công khai (quy tắc + giá khám + tài liệu RAG) dài vài nghìn token —
// để mặc định 4096 của Ollama thì phần đầu prompt bị cắt mất âm thầm, nên đặt 8192.
const OLLAMA_NUM_CTX = Number(process.env.OLLAMA_NUM_CTX) || 8192;
// Giữ model nằm sẵn trong RAM/VRAM giữa các câu hỏi — nạp lại model mất vài giây mỗi lần.
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '30m';
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 120000;
// Qwen3 mặc định "suy nghĩ" (sinh cả đoạn lập luận ẩn trước khi trả lời) — chậm gấp nhiều lần
// mà với câu trả lời 2-4 câu của chatbot thì không cần, nên tắt trừ khi đặt OLLAMA_THINK=true.
const OLLAMA_THINK = process.env.OLLAMA_THINK === 'true';
// Khoá chung giữa server và laptop: server gửi kèm khi gọi Ollama qua đường hầm (proxy trên laptop
// kiểm tra), laptop gửi kèm khi báo địa chỉ đường hầm lên server. Để trống = tắt cả 2 chiều.
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || '';

// Địa chỉ đường hầm laptop báo lên gần nhất. Script báo lại mỗi 2 phút, nên quá 5 phút không
// nghe báo là coi như laptop đã tắt và quay về OLLAMA_HOST (trên Render: không gọi được → Gemini).
const REMOTE_OLLAMA_TTL_MS = 5 * 60 * 1000;
let remoteOllama = null;

function setRemoteOllama(url) {
  remoteOllama = { url: url.replace(/\/+$/, ''), seenAt: Date.now() };
}

function ollamaHost() {
  if (remoteOllama && Date.now() - remoteOllama.seenAt < REMOTE_OLLAMA_TTL_MS) return remoteOllama.url;
  return OLLAMA_HOST;
}

// So khoá theo thời gian hằng (so băm SHA-256 cùng độ dài) để không lộ khoá qua thời gian phản hồi.
function checkOllamaKey(token) {
  if (!OLLAMA_API_KEY || !token) return false;
  const crypto = require('crypto');
  const hash = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(hash(token), hash(OLLAMA_API_KEY));
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
  // Gói Gemini miễn phí giới hạn 20 request/ngày/model — hết hạn ngạch NGÀY,
  // không phải quá tải tạm thời, nên phải báo khác với lỗi 503 thông thường
  // (không nên khuyên "thử lại sau ít phút" vì thực tế phải đợi qua ngày mới).
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
  // AI_DEBUG=true: in ra số token và thời gian đọc prompt / sinh câu trả lời của từng lượt gọi,
  // để biết chậm vì prompt dài hay vì sinh chữ.
  if (process.env.AI_DEBUG === 'true' && data.total_duration) {
    const s = (ns) => ((ns || 0) / 1e9).toFixed(1) + 's';
    console.log(`[ollama] prompt ${data.prompt_eval_count || 0} token/${s(data.prompt_eval_duration)}, trả lời ${data.eval_count || 0} token/${s(data.eval_duration)}, tổng ${s(data.total_duration)}`);
  }
  return data.message || {};
}

// Nạp sẵn model vào bộ nhớ lúc khởi động server, để câu hỏi ĐẦU TIÊN của khách không phải chờ
// thêm vài giây nạp model. Lỗi ở đây chỉ ghi log — không chặn server khởi động.
async function warmUp() {
  if (PROVIDER !== 'ollama') return;
  try {
    await ollamaChat({ messages: [] });
    console.log(`Đã nạp sẵn mô hình ${PROVIDER_LABEL}.`);
  } catch (e) {
    console.error(`Chưa nạp được mô hình ${PROVIDER_LABEL}:`, e.message);
  }
}

// ---------- API chung ----------

// AI_PROVIDER=ollama: thử Ollama trước, lỗi (không kết nối được, đường hầm đứt, chưa có model…)
// thì chuyển sang Gemini nếu có GEMINI_API_KEY. Riêng lỗi xảy ra SAU KHI đã chạy công cụ (e.toolsRan)
// thì không chuyển — Gemini sẽ chạy lại công cụ, vd đặt lịch lần 2 thành lịch trùng.
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

// Sinh 1 đối tượng JSON theo đúng schema (dùng cho bước mở rộng câu hỏi RAG).
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

// Sinh 1 đoạn văn bản, không có công cụ (dùng cho tóm tắt bệnh sử).
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

// Hội thoại có công cụ: gửi tin nhắn mới kèm lịch sử, mỗi khi model yêu cầu gọi công cụ thì chạy
// handleCall(name, args) và gửi kết quả lại, tối đa maxRounds vòng. Trả về câu trả lời cuối
// (chuỗi rỗng nếu model không trả lời bằng chữ). history: [{ role: 'user'|'assistant', content }].
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
  checkOllamaKey,
};
