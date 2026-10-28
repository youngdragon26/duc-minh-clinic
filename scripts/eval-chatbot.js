// Bộ câu hỏi mẫu để đo chất lượng chatbot công khai (POST /api/ai/chat) trước/sau mỗi lần sửa
// prompt, đổi model, sửa chatAnalysis... Chạy: npm run eval-chat  (server phải đang chạy)
//   EVAL_URL=https://duc-minh-clinic.onrender.com npm run eval-chat   — đo bản deploy
// Mỗi câu chấm tự động bằng biểu thức chính quy: phải có (must) / không được có (mustNot).
require('dotenv').config();

const BASE = (process.env.EVAL_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/+$/, '');
const TMH = /Tai\s*[–-]\s*Mũi\s*[–-]\s*Họng/i;
const SLOT_TIME = /\b(0[7-9]|1\d|20):[03]0\b/;
const PROMISE_LATER = /sẽ (kiểm tra|xem|check)|(mình|tôi) (sẽ )?báo lại/i;

const CASES = [
  { q: 'Tôi bị đau họng mấy ngày nay, nên khám khoa nào?', must: [TMH], mustNot: [/Nhi khoa/i] },
  { q: 'Tai tôi bị ù và hơi đau mấy hôm nay', must: [TMH] },
  { q: 'Con tôi 5 tuổi bị tiêu chảy 3 lần từ sáng, nên khám khoa nào?', must: [/Nhi/i] },
  { q: 'Tôi bị đau răng hàm dưới, sưng lợi', must: [/Răng\s*[–-]\s*Hàm\s*[–-]\s*Mặt/i] },
  { q: 'Da tôi nổi mẩn đỏ và ngứa khắp người', must: [/Da liễu/i] },
  { q: 'Tôi đang mang thai 3 tháng, muốn đi khám', must: [/Sản/i] },
  { q: 'Tôi bị ho và sốt 38 độ từ hôm qua', must: [/Nội|Tai\s*[–-]\s*Mũi/i] },
  { q: 'Tôi bị đau ngực dữ dội và khó thở', must: [/115/] },
  { q: 'Giờ làm việc của phòng khám?', must: [/0?7:00/, /21:00/] },
  { q: 'Chủ nhật này phòng khám có khám không?', must: [/hẹn trước/i] },
  { q: 'Ngày mai khoa Tai Mũi Họng còn giờ nào trống?', must: [SLOT_TIME], mustNot: [PROMISE_LATER] },
  { q: 'Thứ 7 tuần này khoa Nhi còn lịch trống không?', must: [SLOT_TIME], mustNot: [PROMISE_LATER] },
  {
    q: 'mình muốn đặt lịch khám bạn hãy check lịch khám xem trong tuần này còn trống không',
    history: [
      { role: 'user', content: 'Tôi bị đau họng mấy ngày nay, nên khám khoa nào?' },
      { role: 'assistant', content: 'Bạn nên khám chuyên khoa Tai – Mũi – Họng.' },
    ],
    must: [SLOT_TIME],
    mustNot: [PROMISE_LATER],
  },
  { q: 'Còn lịch trống ngày mai không?', must: [/chuyên khoa/i], mustNot: [PROMISE_LATER] },
  { q: 'Đặt lịch khám giúp mình với', must: [/đăng nhập|tai-khoan/i] },
];

async function ask({ q, history = [] }) {
  const started = Date.now();
  const res = await fetch(BASE + '/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: q, history }),
    signal: AbortSignal.timeout(180000),
  });
  const data = await res.json().catch(() => ({}));
  return { seconds: (Date.now() - started) / 1000, status: res.status, text: data.reply || data.error || '' };
}

(async () => {
  console.log(`Đo chatbot tại ${BASE} — ${CASES.length} câu\n`);
  let passed = 0;
  const times = [];
  for (const c of CASES) {
    const r = await ask(c);
    times.push(r.seconds);
    const missing = (c.must || []).filter((re) => !re.test(r.text));
    const forbidden = (c.mustNot || []).filter((re) => re.test(r.text));
    const ok = r.status === 200 && missing.length === 0 && forbidden.length === 0;
    if (ok) passed++;
    console.log(`${ok ? 'ĐẠT ' : 'TRƯỢT'} ${r.seconds.toFixed(1).padStart(5)}s  ${c.q}`);
    if (!ok) {
      if (r.status !== 200) console.log(`        HTTP ${r.status}`);
      for (const re of missing) console.log(`        thiếu ${re}`);
      for (const re of forbidden) console.log(`        không được có ${re}`);
      console.log(`        → ${r.text.replace(/\s+/g, ' ').slice(0, 220)}`);
    }
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(`\nKết quả: ${passed}/${CASES.length} đạt — trung bình ${avg.toFixed(1)}s, chậm nhất ${Math.max(...times).toFixed(1)}s`);
})();
