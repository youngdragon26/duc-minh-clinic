// Phiếu thu / hoá đơn đầy đủ thông tin — dùng chung cho cửa sổ "Xem chi tiết" (trang Hoá đơn, Hồ sơ khám)
// và trang in (/in.html?type=hd). Bố cục theo mẫu Phiếu thu: người nộp tiền, người khám, lí do nộp, số tiền,
// giảm giá (%), thành tiền, thanh toán đợt 1/2, số tiền còn lại, số tiền viết bằng chữ, các ô ký tên.
(function (root) {
  const GENDER = { nam: 'Nam', nu: 'Nữ', khac: 'Khác' };
  const METHOD = { tien_mat: 'Tiền mặt', chuyen_khoan: 'Chuyển khoản' };
  const DISCOUNT = { bhyt: 'Bảo hiểm y tế (BHYT)', sinh_vien: 'Thẻ sinh viên' };

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const money = (n) => Number(n).toLocaleString('vi-VN') + 'đ';
  const pad2 = (n) => String(n).padStart(2, '0');
  const fmtDate = (d) => { const s = String(d).slice(0, 10).split('-'); return s[2] + '/' + s[1] + '/' + s[0]; };

  // Đọc số tiền bằng chữ: 140000 -> "Một trăm bốn mươi nghìn đồng chẵn."
  function numberToWords(value) {
    const n = Math.round(Math.abs(Number(value) || 0));
    if (n === 0) return 'Không đồng.';
    const digit = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];
    function triple(num, readHundreds) {
      const h = Math.floor(num / 100), t = Math.floor((num % 100) / 10), u = num % 10;
      const out = [];
      if (h > 0 || readHundreds) out.push(digit[h], 'trăm');
      if (t > 1) {
        out.push(digit[t], 'mươi');
        if (u === 1) out.push('mốt'); else if (u === 5) out.push('lăm'); else if (u > 0) out.push(digit[u]);
      } else if (t === 1) {
        out.push('mười');
        if (u === 5) out.push('lăm'); else if (u > 0) out.push(digit[u]);
      } else if (u > 0) {
        if (h > 0 || readHundreds) out.push('lẻ');
        out.push(digit[u]);
      }
      return out.join(' ');
    }
    const units = ['', 'nghìn', 'triệu', 'tỷ'];
    const groups = [];
    let rest = n;
    while (rest > 0) { groups.push(rest % 1000); rest = Math.floor(rest / 1000); }
    const parts = [];
    for (let i = groups.length - 1; i >= 0; i--) {
      if (groups[i] === 0) continue;
      const isLeading = i === groups.length - 1;
      parts.push((triple(groups[i], !isLeading) + ' ' + units[i]).trim());
    }
    const text = parts.join(' ');
    return text.charAt(0).toUpperCase() + text.slice(1) + ' đồng chẵn.';
  }

  const CSS = `
    .ivs{font-family:"Be Vietnam Pro",system-ui,sans-serif; color:#142e29; font-size:14px; line-height:1.55;}
    .ivs *{box-sizing:border-box;}
    .ivs-clinic{display:flex; justify-content:space-between; gap:16px; border-bottom:2px solid #0b6f62; padding-bottom:10px; margin-bottom:12px;}
    .ivs-clinic .name{font-family:"Lora",serif; font-weight:600; font-size:1.3rem;}
    .ivs-clinic .name em{color:#0b6f62; font-style:normal;}
    .ivs-clinic .info{font-size:.78rem; color:#52685f; text-align:right;}
    .ivs-title{text-align:center; margin:4px 0 12px; position:relative;}
    .ivs-title h1{font-family:"Lora",serif; font-size:1.6rem; margin:0; letter-spacing:.06em;}
    .ivs-title .code{font-weight:700; color:#0b6f62;}
    .ivs-title .date{color:#52685f; font-size:.9rem;}
    .ivs-stamp{display:inline-block; border:2px solid; border-radius:3px; padding:2px 12px; font-weight:700; font-size:.85rem; transform:rotate(-3deg); margin-top:6px;}
    .ivs-stamp.paid{color:#0b7a4a;} .ivs-stamp.unpaid{color:#b45309;}
    .ivs-form{margin:0 0 10px;}
    .ivs-row{display:flex; gap:8px; padding:3px 0; align-items:baseline;}
    .ivs-row .k{flex:0 0 190px; color:#52685f;}
    .ivs-row .v{flex:1; border-bottom:1px dotted #9aa9a4; min-height:1.4em; word-break:break-word;}
    .ivs-row .v.blank{color:transparent;}
    .ivs table{width:100%; border-collapse:collapse; margin:10px 0;}
    .ivs th,.ivs td{border:1px solid #c9d3cf; padding:6px 9px; text-align:left; vertical-align:top;}
    .ivs th{background:#f0f5f3; font-size:.76rem; text-transform:uppercase; letter-spacing:.03em;}
    .ivs .num{text-align:right; white-space:nowrap;}
    .ivs td.neg{color:#b3261e;}
    .ivs-sum{display:grid; grid-template-columns:1fr 1fr; gap:0 24px; margin:8px 0;}
    .ivs-sum .ivs-row .k{flex-basis:130px;}
    .ivs-sum .ivs-row .v{text-align:right; font-weight:600; font-variant-numeric:tabular-nums;}
    .ivs-sum .strong .v{font-size:1.1rem; color:#0b6f62;}
    .ivs-words{font-style:italic; margin:2px 0 8px;}
    .ivs-sign{display:flex; justify-content:space-between; gap:8px; text-align:center; margin:18px 0 8px; flex-wrap:wrap;}
    .ivs-sign > div{flex:1 1 110px; min-width:100px;}
    .ivs-sign b{display:block;} .ivs-sign small{color:#52685f;}
    .ivs-sign .who{margin-top:44px; font-weight:600; min-height:1.4em;}
    .ivs-foot{margin-top:12px; font-size:.75rem; color:#52685f; text-align:center; border-top:1px dashed #c9d3cf; padding-top:8px;}
    .ivs-tablewrap{overflow-x:auto;}
    @media (max-width:560px){
      .ivs-sum{grid-template-columns:1fr;}
      .ivs-row{flex-direction:column; gap:0;}
      .ivs-row .k, .ivs-sum .ivs-row .k{flex:0 0 auto;}
      .ivs-sum .ivs-row{flex-direction:row; justify-content:space-between; align-items:baseline; gap:12px;}
      .ivs-sum .ivs-row .v{flex:0 0 auto;}
      .ivs th,.ivs td{padding:5px 6px; font-size:.8rem;}
    }

    .ivs-overlay{position:fixed; inset:0; z-index:2000; background:rgba(10,20,18,.6); overflow-y:auto; padding:24px 12px;}
    .ivs-overlay[hidden]{display:none;}
    .ivs-modal{max-width:920px; margin:0 auto; background:#fff; border-radius:3px; box-shadow:0 20px 60px rgba(0,0,0,.4);}
    .ivs-bar{display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 16px; background:#142e29; color:#fff; border-radius:3px 3px 0 0; position:sticky; top:0;}
    .ivs-bar b{font-family:"Lora",serif;}
    .ivs-bar .btns{display:flex; gap:8px;}
    .ivs-bar a,.ivs-bar button{font:inherit; font-size:.82rem; font-weight:600; color:#fff; background:#0e8e7d; border:0; border-radius:3px; padding:8px 14px; cursor:pointer; text-decoration:none;}
    .ivs-bar button.close{background:transparent; border:1px solid rgba(255,255,255,.4);}
    .ivs-paper{padding:22px 26px 26px;}
    @media (max-width:560px){ .ivs-paper{padding:16px 14px 20px;} }
  `;
  function ensureCss() {
    if (typeof document === 'undefined' || document.getElementById('ivs-css')) return;
    const st = document.createElement('style');
    st.id = 'ivs-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function row(k, v, opts) {
    const val = v == null || v === '' ? '&nbsp;' : v;
    return `<div class="ivs-row${opts && opts.cls ? ' ' + opts.cls : ''}"><span class="k">${k}</span><span class="v${v == null || v === '' ? ' blank' : ''}">${val}</span></div>`;
  }

  function html(inv) {
    const paid = inv.status === 'da_thanh_toan';
    const when = new Date(paid && inv.paidAt ? inv.paidAt : inv.createdAt);
    const dateLine = `Ngày ${pad2(when.getDate())} tháng ${pad2(when.getMonth() + 1)} năm ${when.getFullYear()}`;
    const rows = inv.items.map((it, i) =>
      `<tr><td>${i + 1}</td><td>${esc(it.description)}</td><td class="num">${esc(it.quantity)}</td><td class="num">${money(it.unitPrice)}</td><td class="num${it.subtotal < 0 ? ' neg' : ''}">${it.subtotal < 0 ? '−' + money(-it.subtotal) : money(it.subtotal)}</td></tr>`).join('');
    const visit = `${fmtDate(inv.date)}${inv.time ? ' lúc ' + esc(inv.time) : ''}`;
    const isProxy = inv.contactName && inv.contactName !== inv.patientName;
    const examinee = inv.contactName
      ? `${esc(inv.contactName)}${inv.contactAge != null ? ' · ' + esc(inv.contactAge) + ' tuổi' : ''}${inv.contactGender ? ' · ' + esc(GENDER[inv.contactGender] || '') : ''}${inv.contactPhone ? ' · ĐT ' + esc(inv.contactPhone) : ''}${isProxy ? ' (khám hộ)' : ''}`
      : '';
    const reason = `Thanh toán phí khám ${esc(inv.specialty)} ngày ${visit}${inv.doctorName ? ' (BS. ' + esc(inv.doctorName.replace(/^BS\.\s*/i, '')) + ')' : ''}${inv.medicinesTotal > 0 ? ' và tiền thuốc theo đơn' : ''}`;
    const remaining = paid ? 0 : inv.totalAmount;
    const payLine = paid
      ? `${money(inv.totalAmount)} · ${esc(METHOD[inv.paymentMethod] || '')}${inv.paidAt ? ' · ' + new Date(inv.paidAt).toLocaleString('vi-VN') : ''}`
      : (inv.onlinePaymentClaimedAt ? `Chưa thu — bệnh nhân báo đã chuyển khoản lúc ${new Date(inv.onlinePaymentClaimedAt).toLocaleString('vi-VN')}, chờ đối chiếu` : 'Chưa thanh toán');

    return `<div class="ivs">
      <div class="ivs-clinic">
        <div class="name">Đa Khoa <em>Đức Minh</em></div>
        <div class="info">Phường Túc Duyên, TP. Thái Nguyên<br>Hotline: 0974 755 333<br>Thứ 2 – Thứ 7 · 7:00 – 21:00</div>
      </div>
      <div class="ivs-title">
        <h1>PHIẾU THU</h1>
        <div class="code">Hoá đơn số: ${esc(inv.code)}</div>
        <div class="date">${dateLine}</div>
        <span class="ivs-stamp ${paid ? 'paid' : 'unpaid'}">${paid ? 'ĐÃ THANH TOÁN' : 'CHƯA THANH TOÁN'}</span>
      </div>
      <div class="ivs-form">
        ${row('Họ và tên người nộp tiền:', `<b>${esc(inv.patientName)}</b>`)}
        ${row('Điện thoại:', inv.patientPhone ? esc(inv.patientPhone) : '')}
        ${row('Người khám bệnh:', examinee)}
        ${row('Địa chỉ:', '')}
        ${row('Lí do nộp:', reason)}
        ${inv.diagnosis ? row('Chẩn đoán:', esc(inv.diagnosis) + (inv.recordCode ? ' · Đơn thuốc ' + esc(inv.recordCode) : '')) : ''}
        ${row('Đối tượng ưu tiên:', esc(DISCOUNT[inv.discountCategory] || 'Không'))}
      </div>
      <div class="ivs-tablewrap"><table>
        <thead><tr><th style="width:36px">#</th><th>Nội dung</th><th class="num">SL</th><th class="num">Đơn giá</th><th class="num">Thành tiền</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div class="ivs-sum">
        ${row('Số tiền:', money(inv.grossAmount))}
        ${row('Số tiền giảm:', inv.discountAmount > 0 ? '−' + money(inv.discountAmount) : money(0))}
        ${row('Giảm (%):', (inv.discountPercent || 0) + '%')}
        ${row('Thành tiền:', money(inv.totalAmount), { cls: 'strong' })}
      </div>
      <div class="ivs-words"><b>Viết bằng chữ:</b> ${esc(numberToWords(inv.totalAmount))}</div>
      <div class="ivs-form">
        ${row('Thanh toán đợt 1:', esc(payLine))}
        ${row('Thanh toán đợt 2:', '')}
        ${row('Số tiền còn lại:', money(remaining))}
      </div>
      <div class="ivs-sign">
        <div><b>Người lập phiếu</b><small>(Ký, họ tên)</small><div class="who">${esc(inv.createdByName || '')}</div></div>
        <div><b>Người nộp tiền</b><small>(Ký, họ tên)</small><div class="who">${esc(inv.patientName)}</div></div>
        <div><b>Thủ quỹ</b><small>(Ký, họ tên)</small><div class="who"></div></div>
        <div><b>Kế toán trưởng</b><small>(Ký, họ tên)</small><div class="who"></div></div>
        <div><b>Giám đốc</b><small>(Ký, họ tên, đóng dấu)</small><div class="who"></div></div>
      </div>
      ${row('Đã nhận đủ số tiền (viết bằng chữ):', paid ? esc(numberToWords(inv.totalAmount)) : '')}
      <div class="ivs-foot">Cảm ơn quý khách đã tin tưởng Phòng khám Đa khoa Đức Minh.</div>
    </div>`;
  }

  // Cửa sổ xem chi tiết (dùng ở trang Hoá đơn của nhân viên và Hồ sơ khám của bệnh nhân).
  function open(inv) {
    ensureCss();
    const prevFocus = document.activeElement;
    const ov = document.createElement('div');
    ov.className = 'ivs-overlay';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-label', 'Chi tiết hoá đơn ' + inv.code);
    ov.innerHTML = `<div class="ivs-modal">
      <div class="ivs-bar"><b>Chi tiết hoá đơn ${esc(inv.code)}</b>
        <span class="btns"><a href="/in.html?type=hd&id=${encodeURIComponent(inv.id)}" target="_blank" rel="noopener">🖨 In / Lưu PDF</a><button type="button" class="close">✕ Đóng</button></span></div>
      <div class="ivs-paper">${html(inv)}</div></div>`;
    document.body.appendChild(ov);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    function close() {
      ov.remove();
      document.body.style.overflow = prevOverflow;
      document.removeEventListener('keydown', onKey);
      if (prevFocus && prevFocus.focus) prevFocus.focus();
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    const closeBtn = ov.querySelector('button.close');
    closeBtn.addEventListener('click', close);
    closeBtn.focus();
    return { close };
  }

  const api = { html, open, numberToWords, ensureCss };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.InvoiceSheet = api;
})(typeof window !== 'undefined' ? window : globalThis);
