// Recursive chunking đơn giản: ưu tiên cắt theo đoạn văn (\n\n), rồi tới câu,
// giữ overlap giữa các chunk liền kề để không mất ngữ cảnh ở điểm cắt —
// theo đúng kỹ thuật "Recursive Chunking" mô tả trong tài liệu RAG.
function chunkText(text, chunkSize = 500, overlap = 100) {
  const clean = String(text).replace(/\r\n/g, '\n').trim();
  if (!clean) return [];

  const paragraphs = clean.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const rawChunks = [];
  let buffer = '';

  const flush = () => {
    if (buffer.trim()) rawChunks.push(buffer.trim());
    buffer = '';
  };

  for (const para of paragraphs) {
    const candidate = buffer ? buffer + '\n\n' + para : para;
    if (candidate.length <= chunkSize) {
      buffer = candidate;
      continue;
    }
    flush();
    if (para.length <= chunkSize) {
      buffer = para;
      continue;
    }
    // Đoạn quá dài -> cắt tiếp theo câu.
    const sentences = para.split(/(?<=[.!?])\s+/);
    let sBuf = '';
    for (const s of sentences) {
      const sCandidate = sBuf ? sBuf + ' ' + s : s;
      if (sCandidate.length <= chunkSize) {
        sBuf = sCandidate;
      } else {
        if (sBuf) rawChunks.push(sBuf.trim());
        sBuf = s;
      }
    }
    buffer = sBuf;
  }
  flush();

  if (overlap <= 0 || rawChunks.length <= 1) return rawChunks;
  return rawChunks.map((chunk, i) => {
    if (i === 0) return chunk;
    const tail = rawChunks[i - 1].slice(-overlap);
    return tail + ' ' + chunk;
  });
}

module.exports = { chunkText };
