// Menu tài khoản dùng chung: hiện tên + vai trò người đang đăng nhập và cho
// chuyển qua lại giữa "Giao diện chung" (trang chủ) và "Không gian làm việc"
// riêng của từng vai trò. Trang nào cần thì gắn <script src="/account-menu.js"
// data-mount="#idPhanTuChua" data-current="home|workspace"></script>.
(function () {
  const script = document.currentScript;
  const mountSel = script.dataset.mount;
  const current = script.dataset.current || '';
  const mount = mountSel && document.querySelector(mountSel);
  if (!mount) return;

  const ROLE_LABELS = { admin: 'Quản trị viên', doctor: 'Bác sĩ', staff: 'Nhân viên tư vấn', patient: 'Bệnh nhân' };
  const WORKSPACE_LABELS = {
    admin: 'Không gian quản trị',
    doctor: 'Không gian bác sĩ',
    staff: 'Không gian nhân viên',
    patient: 'Không gian bệnh nhân',
  };

  const css = document.createElement('style');
  css.textContent = `
    .acm{position:relative; display:inline-block;}
    .acm-btn{font:inherit; font-weight:600; font-size:.92rem; color:var(--ink); background:transparent; border:0; cursor:pointer; padding:8px 4px; display:flex; align-items:center; gap:8px; white-space:nowrap; flex-shrink:0;}
    .acm-btn:hover{color:var(--accent-deep);}
    .acm-role{font-size:.68rem; font-weight:700; letter-spacing:.03em; padding:2px 8px; border-radius:20px; background:var(--surface-2); color:var(--accent-deep); border:1px solid var(--line); white-space:nowrap;}
    .acm-caret{font-size:.65rem; opacity:.6;}
    .acm-pop{position:absolute; right:0; top:calc(100% + 8px); min-width:260px; background:var(--surface); border:1px solid var(--line); border-radius:12px; box-shadow:var(--shadow); padding:8px; z-index:200;}
    .acm-pop[hidden]{display:none;}
    .acm-who{padding:10px 12px 12px; border-bottom:1px solid var(--line); margin-bottom:6px;}
    .acm-who b{display:block; font-size:.95rem; color:var(--ink);}
    .acm-who span{font-size:.78rem; color:var(--ink-muted);}
    .acm-label{padding:6px 12px 2px; font-size:.68rem; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--ink-muted);}
    .acm-item{display:flex; align-items:center; justify-content:space-between; gap:10px; width:100%; text-align:left; font:inherit; font-size:.88rem; color:var(--ink); text-decoration:none; background:transparent; border:0; border-radius:8px; padding:9px 12px; cursor:pointer;}
    .acm-item:hover{background:var(--surface-2);}
    .acm-item.on{background:var(--surface-2); font-weight:700;}
    .acm-item small{color:var(--accent-deep); font-weight:700; font-size:.68rem;}
    .acm-sep{height:1px; background:var(--line); margin:6px 0;}
  `;
  document.head.appendChild(css);

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function render(user) {
    const wrap = document.createElement('div');
    wrap.className = 'acm';
    wrap.innerHTML = `
      <button class="acm-btn" type="button" aria-haspopup="true" aria-expanded="false">
        <span>Xin chào, ${esc(user.name)}</span>
        <span class="acm-role">${esc(ROLE_LABELS[user.role] || user.role)}</span>
        <span class="acm-caret">▾</span>
      </button>
      <div class="acm-pop" hidden>
        <div class="acm-who"><b>${esc(user.name)}</b><span>${esc(user.email)}</span></div>
        <div class="acm-label">Chuyển giao diện</div>
        <a class="acm-item ${current === 'home' ? 'on' : ''}" href="/">Giao diện chung ${current === 'home' ? '<small>Đang xem</small>' : ''}</a>
        <a class="acm-item ${current === 'workspace' ? 'on' : ''}" href="/khong-gian.html">${esc(WORKSPACE_LABELS[user.role] || 'Không gian của tôi')} ${current === 'workspace' ? '<small>Đang xem</small>' : ''}</a>
        <div class="acm-sep"></div>
        <a class="acm-item" href="/tai-khoan.html">Thông tin tài khoản</a>
        <button class="acm-item" type="button" data-logout>Đăng xuất</button>
      </div>`;
    const btn = wrap.querySelector('.acm-btn');
    const pop = wrap.querySelector('.acm-pop');
    function setOpen(open) {
      pop.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
    }
    btn.addEventListener('click', (e) => { e.stopPropagation(); setOpen(pop.hidden); });
    document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) setOpen(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
    wrap.querySelector('[data-logout]').addEventListener('click', () => {
      localStorage.removeItem('dm_token');
      location.href = '/';
    });
    mount.replaceChildren(wrap);
  }

  const token = localStorage.getItem('dm_token');
  if (!token) return; // chưa đăng nhập: giữ nguyên nút "Đăng nhập" có sẵn trong trang
  fetch('/api/auth/me', { headers: { Authorization: 'Bearer ' + token } })
    .then((r) => { if (!r.ok) throw new Error('unauthorized'); return r.json(); })
    .then(({ user }) => {
      render(user);
      document.dispatchEvent(new CustomEvent('dm:user', { detail: user }));
    })
    .catch(() => { localStorage.removeItem('dm_token'); });
})();
