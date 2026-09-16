// Nạp các tài liệu PDF trong thư mục "Chuyên khoa" (Cẩm nang MSD) vào cơ sở tri
// thức RAG (kb_documents/kb_chunks) — cùng logic chunk + embed với route
// POST /api/ai/kb, chạy hàng loạt thay vì qua từng request HTTP.
//
// Chạy lại an toàn: bỏ qua các tài liệu đã có title trùng trong kb_documents,
// nên nếu bị dừng giữa chừng (vd hết hạn ngạch Gemini trong ngày) thì chạy lại
// đúng lệnh này vào lúc khác sẽ tự tiếp tục từ tài liệu còn thiếu.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');
const { pool } = require('../src/db');
const { chunkText } = require('../src/lib/chunk');
const { embedText, toVectorLiteral } = require('../src/lib/embeddings');

const ROOT_DIR = path.resolve(__dirname, '..', '..', 'Chuyên khoa');
const EMBED_DELAY_MS = 300; // giãn cách giữa các lần gọi embedContent để tránh vượt rate limit theo phút.

// Khớp với danh sách SPECIALTIES trong src/constants.js.
const CATEGORY_TO_SPECIALTY = [
  [/Rối loạn Nha Khoa/i, 'Răng – Hàm – Mặt'],
  [/Rối loạn về Tai Mũi Họng/i, 'Tai – Mũi – Họng'],
  [/Rối loạn Da liễu/i, 'Da liễu'],
  [/Khoa nhi/i, 'Nhi khoa'],
  [/Phụ khoa và Sản khoa/i, 'Sản phụ khoa'],
];
const FOLDER_TO_SPECIALTY = {
  'Da liễu': 'Da liễu',
  'Nhi khoa': 'Nhi khoa',
  'Sản phụ khoa': 'Sản phụ khoa',
  'Tai – Mũi – Họng': 'Tai – Mũi – Họng',
  'Răng – Hàm – Mặt': 'Răng – Hàm – Mặt',
};
const DROP_SEGMENTS = [/Cẩm nang MSD/i, /Phiên bản dành cho chuyên gia/i];

function findPdfs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findPdfs(full));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) {
      out.push({ file: full, folder: path.basename(dir) });
    }
  }
  return out;
}

function deriveTitle(fileBaseName, folder) {
  const segments = fileBaseName.split(' - ').map((s) => s.trim());
  const category = CATEGORY_TO_SPECIALTY.find(([re]) => segments.some((s) => re.test(s)));
  const specialty = category ? category[1] : FOLDER_TO_SPECIALTY[folder];
  const topicSegments = segments.filter(
    (s) => !DROP_SEGMENTS.some((re) => re.test(s)) && !CATEGORY_TO_SPECIALTY.some(([re]) => re.test(s))
  );
  const topic = topicSegments.join(' - ') || fileBaseName;
  return { title: specialty ? `${topic} - ${specialty}` : topic, specialty };
}

// Loại bỏ header/footer lặp lại do PDF được in từ trang web MSD Manuals ra
// (dòng ngày giờ in + URL + số trang ở mỗi trang, huy hiệu "MSD MANUAL").
function cleanPdfText(text) {
  const lines = text.split('\n');
  const kept = lines.filter((line) => {
    const t = line.trim();
    if (!t) return true;
    if (/^\d{1,2}:\d{2}\s+\d{1,2}\/\d{1,2}\/\d{2}\s*\t/.test(t)) return false;
    if (/^https:\/\/www\.msdmanuals\.com\//.test(t)) return false;
    if (/^Bản quyền © \d{4} Merck/.test(t)) return false;
    if (/^-- \d+ of \d+ --$/.test(t)) return false;
    if (t === 'MSD MANUAL') return false;
    if (t === 'Phiên bản dành cho chuyên gia') return false;
    return true;
  });
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Cùng cách phân loại lỗi hạn ngạch NGÀY với src/routes/ai.js — lỗi này thử lại
// vô ích (phải đợi qua ngày), nên dừng hẳn kịch bản thay vì tiếp tục thử.
function isDailyQuotaError(e) {
  const msg = String((e && e.message) || '');
  return e && e.status === 429 && (msg.includes('PerDay') || msg.includes('RESOURCE_EXHAUSTED'));
}

async function embedWithRetry(text, retries = 2, delayMs = 900) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await embedText(text, 'RETRIEVAL_DOCUMENT');
    } catch (e) {
      if (isDailyQuotaError(e)) throw e;
      const retryable = e && (e.status === 503 || e.status === 429);
      if (!retryable || attempt >= retries) throw e;
      await sleep(delayMs * (attempt + 1));
    }
  }
}

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error('Thiếu GEMINI_API_KEY trong .env — cần để nhúng (embed) tài liệu.');
    process.exit(1);
  }

  const adminRes = await pool.query("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  if (adminRes.rows.length === 0) {
    console.error('Chưa có tài khoản admin nào trong CSDL — cần 1 admin để gán created_by cho tài liệu.');
    process.exit(1);
  }
  const adminId = adminRes.rows[0].id;

  const pdfs = findPdfs(ROOT_DIR).sort((a, b) => a.file.localeCompare(b.file));
  console.log(`Tìm thấy ${pdfs.length} file PDF trong "${ROOT_DIR}".`);

  const existingRes = await pool.query('SELECT title FROM kb_documents');
  const existingTitles = new Set(existingRes.rows.map((r) => r.title));

  let added = 0, skipped = 0, failed = 0;

  for (let i = 0; i < pdfs.length; i++) {
    const { file, folder } = pdfs[i];
    const baseName = path.basename(file, '.pdf');
    const { title, specialty } = deriveTitle(baseName, folder);
    const tag = `[${i + 1}/${pdfs.length}]`;

    if (existingTitles.has(title)) {
      console.log(`${tag} Bỏ qua (đã có): ${title}`);
      skipped++;
      continue;
    }
    if (!specialty) {
      console.warn(`${tag} Bỏ qua (không xác định được chuyên khoa): ${baseName}`);
      failed++;
      continue;
    }

    try {
      const buf = fs.readFileSync(file);
      const parser = new PDFParse({ data: buf });
      const result = await parser.getText();
      await parser.destroy();
      const content = cleanPdfText(result.text);

      if (content.length < 200) {
        console.warn(`${tag} Bỏ qua (nội dung trích xuất quá ngắn, ${content.length} ký tự): ${title}`);
        failed++;
        continue;
      }

      const chunks = chunkText(content, 500, 100);
      const embeddings = [];
      for (const chunk of chunks) {
        embeddings.push(await embedWithRetry(chunk));
        await sleep(EMBED_DELAY_MS);
      }

      const dbClient = await pool.connect();
      try {
        await dbClient.query('BEGIN');
        const docRes = await dbClient.query(
          'INSERT INTO kb_documents (title, content, created_by) VALUES ($1,$2,$3) RETURNING id',
          [title, content, adminId]
        );
        const docId = docRes.rows[0].id;
        for (let c = 0; c < chunks.length; c++) {
          await dbClient.query(
            'INSERT INTO kb_chunks (document_id, chunk_index, content, embedding) VALUES ($1,$2,$3,$4::vector)',
            [docId, c, chunks[c], toVectorLiteral(embeddings[c])]
          );
        }
        await dbClient.query('COMMIT');
      } catch (e) {
        await dbClient.query('ROLLBACK');
        throw e;
      } finally {
        dbClient.release();
      }

      console.log(`${tag} Đã thêm: ${title} (${chunks.length} đoạn)`);
      existingTitles.add(title);
      added++;
    } catch (e) {
      if (isDailyQuotaError(e)) {
        console.error(`${tag} Đã hết hạn ngạch Gemini trong ngày — dừng lại. Chạy lại kịch bản này vào lúc khác để tiếp tục (${pdfs.length - i} file còn lại).`);
        break;
      }
      console.error(`${tag} Lỗi khi xử lý "${title}": ${e.message}`);
      failed++;
    }
  }

  console.log(`\nHoàn tất: ${added} đã thêm, ${skipped} đã có từ trước, ${failed} lỗi/bỏ qua.`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
