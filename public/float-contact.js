// Cụm nút liên hệ nổi ở góc phải: "Chat" mở khung chat AI chính (toàn màn hình) ở trang chủ (cho bệnh nhân chỉ
// muốn dùng khung chat), "Zalo" mở cuộc trò chuyện Zalo với phòng khám; mũi tên thu gọn/mở rộng cụm nút.
// Gắn vào trang bằng: <script src="/float-contact.js" data-zalo="0974755333"></script>
(function () {
  const script = document.currentScript;
  const zaloPhone = ((script && script.dataset.zalo) || '0974755333').replace(/\D/g, '');
  const KEY = 'dm_fc_collapsed';
  const STAFF_ROLES = ['doctor', 'staff', 'admin']; // trợ lý riêng đã có trong không gian làm việc, không cần cụm nút này

  const css = document.createElement('style');
  css.textContent = `
    .fc{position:fixed; right:14px; bottom:88px; z-index:90; display:flex; flex-direction:column; align-items:center; gap:12px;}
    .fc[hidden]{display:none;}
    .fc-toggle{width:38px; height:38px; border-radius:50%; border:0; cursor:pointer; background:#fff; color:#f08a00; font:700 22px/1 system-ui,sans-serif; box-shadow:0 4px 14px rgba(0,0,0,.28); display:grid; place-items:center; padding:0 0 3px;}
    .fc-toggle:hover{transform:scale(1.06);}
    .fc-list{display:flex; flex-direction:column; align-items:center; gap:12px;}
    .fc.collapsed .fc-list{display:none;}
    .fc-btn{position:relative; width:54px; height:54px; border-radius:50%; display:grid; place-items:center; color:#fff; text-decoration:none; border:0; cursor:pointer; font:800 15px/1 system-ui,sans-serif; box-shadow:0 6px 16px rgba(0,0,0,.3);}
    .fc-btn:hover{transform:scale(1.07);}
    .fc-btn:focus-visible,.fc-toggle:focus-visible{outline:3px solid #fff; outline-offset:2px; box-shadow:0 0 0 5px #0b6f62;}
    .fc-chat{background:var(--accent-deep,#0b6f62);}
    .fc-zalo{background:#0068ff; letter-spacing:-.2px;}
    .fc-btn::before{content:''; position:absolute; inset:-6px; border-radius:50%; border:2px solid currentColor; opacity:0; animation:fcPulse 2.6s ease-out infinite;}
    .fc-chat::before{border-color:var(--accent,#0e8e7d);}
    .fc-zalo::before{border-color:#0068ff;}
    @keyframes fcPulse{0%{transform:scale(.85); opacity:.65;} 70%,100%{transform:scale(1.25); opacity:0;}}
    @media (prefers-reduced-motion: reduce){.fc-btn::before{animation:none;} .fc-btn,.fc-toggle{transition:none;}}
    .fc-btn::after{content:attr(data-tip); position:absolute; right:calc(100% + 10px); top:50%; transform:translateY(-50%); white-space:nowrap; background:#142e29; color:#fff; font:600 .78rem/1 system-ui,sans-serif; padding:7px 10px; border-radius:3px; opacity:0; pointer-events:none;}
    .fc-btn:hover::after,.fc-btn:focus-visible::after{opacity:1;}
    @media (max-width:560px){.fc{right:10px; bottom:76px;} .fc-btn{width:48px; height:48px;} .fc-btn::after{display:none;}}
    @media print{.fc{display:none;}}
  `;
  document.head.appendChild(css);

  const wrap = document.createElement('div');
  wrap.className = 'fc';
  wrap.innerHTML = `
    <button type="button" class="fc-toggle" aria-expanded="true" aria-label="Thu gọn / mở rộng nút liên hệ" title="Thu gọn / mở rộng">›</button>
    <div class="fc-list">
      <button type="button" class="fc-btn fc-chat" data-tip="Chat với trợ lý AI" aria-label="Chat với trợ lý AI">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/><path d="M9 11h6M9 14h4"/></svg>
      </button>
      <a class="fc-btn fc-zalo" data-tip="Nhắn Zalo cho phòng khám" aria-label="Nhắn Zalo cho phòng khám" href="https://zalo.me/${zaloPhone}" target="_blank" rel="noopener noreferrer">Zalo</a>
    </div>`;
  document.body.appendChild(wrap);

  const toggle = wrap.querySelector('.fc-toggle');
  function setCollapsed(c) {
    wrap.classList.toggle('collapsed', c);
    toggle.textContent = c ? '‹' : '›';
    toggle.setAttribute('aria-expanded', String(!c));
    try { localStorage.setItem(KEY, c ? '1' : '0'); } catch (e) {}
  }
  let saved = false;
  try { saved = localStorage.getItem(KEY) === '1'; } catch (e) {}
  setCollapsed(saved);
  toggle.addEventListener('click', () => setCollapsed(!wrap.classList.contains('collapsed')));

  // Mở khung chat toàn màn hình (trang chủ cung cấp window.dmChat). Trang khác: về trang chủ và mở ở đó.
  function openChat() {
    if (window.dmChat) { window.dmChat.openFull(); return; }
    location.href = '/#chat-full';
  }
  wrap.querySelector('.fc-chat').addEventListener('click', openChat);
  if (location.hash === '#chat' && window.dmChat) window.dmChat.openFull();

  document.addEventListener('dm:user', (e) => {
    if (e.detail && STAFF_ROLES.includes(e.detail.role)) wrap.hidden = true;
  });
})();
