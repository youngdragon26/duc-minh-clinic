// Cho bản deploy trên Render dùng Ollama đang chạy trên laptop này. Chạy: npm run tunnel
//
// 1. Mở proxy 127.0.0.1:11435 đứng trước Ollama — Ollama không có mật khẩu, nên proxy chỉ cho đi
//    qua đúng POST /api/chat kèm "Authorization: Bearer <OLLAMA_API_KEY>", còn lại chặn hết.
// 2. Mở đường hầm Cloudflare (cloudflared, không cần tài khoản) ra Internet tới proxy đó.
//    Địa chỉ *.trycloudflare.com đổi sau mỗi lần chạy, nên…
// 3. …cứ 2 phút báo địa chỉ hiện tại lên REMOTE_SERVER_URL (/api/ai/ollama-endpoint), đồng thời
//    giữ model nằm sẵn trong VRAM và giữ bản Render miễn phí không "ngủ".
// Tắt script (Ctrl+C) hoặc tắt laptop: sau tối đa 5 phút server tự quay về Gemini.
require('dotenv').config();
const http = require('http');
const { spawn } = require('child_process');
const llm = require('../src/lib/llm');

const OLLAMA_LOCAL = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3:4b-instruct';
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '30m';
// Phải trùng num_ctx server dùng (lib/llm.js) — khác nhau thì Ollama nạp lại model mỗi lần đổi qua lại: đo thật,
// lệnh giữ model không có num_ctx làm model về 4096 và lượt chat sau phải chờ nạp lại 7–9 giây.
const OLLAMA_NUM_CTX = Number(process.env.OLLAMA_NUM_CTX) || 8192;
const REMOTE_SERVER_URL = (process.env.REMOTE_SERVER_URL || 'https://duc-minh-clinic.onrender.com').replace(/\/+$/, '');
const PROXY_PORT = Number(process.env.OLLAMA_PROXY_PORT) || 11435;
// Tìm cả ở thư mục cài mặc định của winget: terminal trong VS Code mở từ trước khi cài vẫn giữ PATH cũ.
const CLOUDFLARED =
  process.env.CLOUDFLARED_PATH ||
  [
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
  ].find((p) => require('fs').existsSync(p)) ||
  'cloudflared';
const HEARTBEAT_MS = 2 * 60 * 1000;
const OLLAMA_API_KEY = (process.env.OLLAMA_API_KEY || '').trim();

const now = () => new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

if (!OLLAMA_API_KEY) {
  console.error('Thiếu OLLAMA_API_KEY trong .env — đặt 1 chuỗi bí mật dài, và đặt ĐÚNG chuỗi đó trên Render.');
  process.exit(1);
}

const proxy = http.createServer((req, res) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (req.method !== 'POST' || req.url !== '/api/chat' || !llm.checkOllamaKey(token)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'unauthorized' }));
  }
  const started = Date.now();
  const upstream = http.request(OLLAMA_LOCAL + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (up) => {
    res.writeHead(up.statusCode, { 'Content-Type': up.headers['content-type'] || 'application/json' });
    up.pipe(res);
    up.on('end', () => console.log(`[${now()}] Web gọi Ollama → ${up.statusCode} (${((Date.now() - started) / 1000).toFixed(1)}s)`));
  });
  upstream.on('error', (e) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Ollama trên laptop chưa chạy: ' + e.message }));
  });
  req.pipe(upstream);
});

// Gọi Ollama với danh sách tin nhắn rỗng = chỉ nạp model (hoặc gia hạn keep_alive), không sinh chữ.
async function warmModel() {
  try {
    await fetch(OLLAMA_LOCAL + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, messages: [], keep_alive: OLLAMA_KEEP_ALIVE, options: { num_ctx: OLLAMA_NUM_CTX } }),
      signal: AbortSignal.timeout(120000),
    });
  } catch (e) {
    console.error(`[${now()}] Chưa nạp được ${OLLAMA_MODEL} — Ollama đã mở chưa?`, e.message);
  }
}

async function register(tunnelUrl) {
  try {
    // Bản Render miễn phí đang "ngủ" có thể mất ~1 phút mới thức dậy trả lời.
    const res = await fetch(REMOTE_SERVER_URL + '/api/ai/ollama-endpoint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + OLLAMA_API_KEY },
      body: JSON.stringify({ url: tunnelUrl }),
      signal: AbortSignal.timeout(90000),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) console.log(`[${now()}] Đã báo đường hầm lên ${REMOTE_SERVER_URL} (server dùng ${data.model}).`);
    else console.error(`[${now()}] Server từ chối (${res.status}): ${data.error || res.statusText}`);
  } catch (e) {
    console.error(`[${now()}] Không gọi được ${REMOTE_SERVER_URL}:`, e.message);
  }
}

proxy.listen(PROXY_PORT, '127.0.0.1', () => {
  console.log(`Proxy có khoá: http://127.0.0.1:${PROXY_PORT} → ${OLLAMA_LOCAL} (model ${OLLAMA_MODEL})`);
  warmModel();

  const tunnel = spawn(CLOUDFLARED, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PROXY_PORT}`]);
  let tunnelUrl = null;
  tunnel.on('error', (e) => {
    console.error(`Không chạy được "${CLOUDFLARED}" (${e.code}). Cài bằng: winget install --id Cloudflare.cloudflared`);
    console.error('rồi mở lại VS Code/terminal, hoặc đặt CLOUDFLARED_PATH trỏ tới cloudflared.exe.');
    process.exit(1);
  });
  tunnel.on('exit', (code) => {
    console.error(`cloudflared đã dừng (mã ${code}).`);
    process.exit(1);
  });
  // cloudflared in địa chỉ đường hầm ra stderr, lẫn trong log của nó.
  tunnel.stderr.on('data', (chunk) => {
    const m = !tunnelUrl && String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (!m) return;
    tunnelUrl = m[0];
    console.log(`Đường hầm: ${tunnelUrl}`);
    // Tên miền mới cần vài giây để DNS nhận, báo lên sau một chút.
    setTimeout(() => register(tunnelUrl), 5000);
    setInterval(() => {
      register(tunnelUrl);
      warmModel();
    }, HEARTBEAT_MS);
  });

  const stop = () => {
    tunnel.kill();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
});
