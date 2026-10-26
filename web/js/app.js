/* ============================================================
   微坛 WeForum · 前台（零依赖）
   三端自适应：手机 Tab 导航 / 平板单列 / 桌面三栏
   公共工具与请求封装来自 /js/core.js（window.WFCore）
   ============================================================ */
(() => {
  'use strict';

  const {
    $, $$, esc, num, uid,
    toast, closeOverlays, openSheet, confirmDialog, viewer,
    ICONS, icon, iconFill, avatarHTML, fileToDataURL,
  } = window.WFCore;

  const state = {
    token: localStorage.getItem('wf_token') || '',
    me: null,
    config: { boards: [] },
    route: { name: 'home', params: {} },
    history: [],
    unread: 0,
    homeSort: 'new',     // new | hot | essence | following
    noticeFilter: 'all', // all | unread | comment | like | follow | system
    list: [],           // 桌面中栏列表
    listMode: 'latest', // latest | board | notice | mine | favs | search | user | hot
    listTitle: '最新',
    listParams: {},
    draft: { boardId: 0, title: '', content: '', images: [], audio: '' },
    editorMode: 'post',
  };

  // 首页排序 → 列表标题 / 分区标题
  const SORT_LABEL = { new: '最新', hot: '热门', essence: '精华', following: '关注' };

  // 访客可自由浏览站点；以下路由属于「内容详情 / 个人中心」，需要登录
  const GUEST_BLOCKED = new Set(['post', 'me', 'notice', 'mine', 'favs']);

  /* ---------------- 请求封装（绑定前台登录态） ---------------- */
  const api = WFCore.createApi({
    getToken: () => state.token,
    setToken: (t) => {
      state.token = t || '';
      if (t) localStorage.setItem('wf_token', t);
      else localStorage.removeItem('wf_token');
    },
    onAuthExpired: () => {
      state.me = null;
      toast('登录已过期，请重新登录');
      openLoginModal();
    },
    onNeedLogin: () => openLoginModal(),
  });

  /* ---------------- 轻量 Markdown 渲染 ---------------- */
  function renderMarkdown(src) {
    const codes = [];
    let text = String(src || '').replace(/\r\n/g, '\n');
    // 围栏代码块先抽出
    text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (m, lang, code) => {
      codes.push(code.replace(/\n$/, ''));
      return `\n\u0000CODE${codes.length - 1}\u0000\n`;
    });
    const inline = (s) => {
      s = esc(s);
      s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
      s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
      return s;
    };
    const lines = text.split('\n');
    const out = [];
    let para = [];
    let list = null;
    let quote = [];
    const flushPara = () => {
      if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; }
    };
    const flushList = () => {
      if (list) { out.push(`<${list.type}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.type}>`); list = null; }
    };
    const flushQuote = () => {
      if (quote.length) { out.push(`<blockquote>${quote.map(inline).join('<br>')}</blockquote>`); quote = []; }
    };
    for (const raw of lines) {
      const line = raw.trimEnd();
      const cm = line.match(/^\u0000CODE(\d+)\u0000$/);
      if (cm) {
        flushPara(); flushList(); flushQuote();
        out.push(`<pre><code>${esc(codes[Number(cm[1])])}</code></pre>`);
        continue;
      }
      if (/^\s*$/.test(line)) { flushPara(); flushList(); flushQuote(); continue; }
      if (/^#{1,3}\s+/.test(line)) {
        flushPara(); flushList(); flushQuote();
        out.push(`<h3>${inline(line.replace(/^#{1,3}\s+/, ''))}</h3>`);
        continue;
      }
      if (/^>\s?/.test(line)) {
        flushPara(); flushList();
        quote.push(line.replace(/^>\s?/, ''));
        continue;
      }
      const ul = line.match(/^[-*]\s+(.*)$/);
      const ol = line.match(/^\d+\.\s+(.*)$/);
      if (ul || ol) {
        flushPara(); flushQuote();
        const type = ul ? 'ul' : 'ol';
        if (!list || list.type !== type) { flushList(); list = { type, items: [] }; }
        list.items.push((ul || ol)[1]);
        continue;
      }
      if (/^---+$/.test(line)) { flushPara(); flushList(); flushQuote(); out.push('<hr>'); continue; }
      flushList(); flushQuote();
      para.push(line);
    }
    flushPara(); flushList(); flushQuote();
    return out.join('');
  }

  /* ---------------- 邮箱与富文本粘贴 ---------------- */
  const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

  // 把剪贴板里的 HTML 转成 Markdown，让粘贴进来的内容保留原格式
  function htmlToMarkdown(html) {
    const root = document.createElement('div');
    root.innerHTML = html;
    root.querySelectorAll('script,style,meta,link,title,noscript').forEach((n) => n.remove());

    const walk = (node) => {
      let out = '';
      node.childNodes.forEach((ch) => {
        if (ch.nodeType === 3) { out += ch.nodeValue.replace(/\s+/g, ' '); return; }
        if (ch.nodeType !== 1) return;
        const tag = ch.tagName.toLowerCase();
        const inner = walk(ch);
        switch (tag) {
          case 'br': out += '\n'; break;
          case 'p': case 'div': case 'section': case 'article': case 'header': case 'footer':
            out += `\n${inner.trim()}\n`; break;
          case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
            out += `\n\n${'#'.repeat(Number(tag[1]))} ${inner.trim()}\n\n`; break;
          case 'strong': case 'b':
            out += inner.trim() ? `**${inner.trim()}**` : inner; break;
          case 'em': case 'i':
            out += inner.trim() ? `*${inner.trim()}*` : inner; break;
          case 'del': case 's': case 'strike':
            out += inner.trim() ? `~~${inner.trim()}~~` : inner; break;
          case 'code':
            out += ch.closest('pre') ? inner : (inner.trim() ? `\`${inner.trim()}\`` : inner); break;
          case 'pre':
            out += `\n\n\`\`\`\n${inner.replace(/^\n+|\n+$/g, '')}\n\`\`\`\n\n`; break;
          case 'blockquote':
            out += '\n' + inner.trim().split('\n').map((l) => `> ${l}`).join('\n') + '\n\n'; break;
          case 'ul': case 'ol': {
            const items = Array.from(ch.children)
              .filter((li) => li.tagName && li.tagName.toLowerCase() === 'li')
              .map((li, i) => `${tag === 'ol' ? `${i + 1}.` : '-'} ${walk(li).trim().replace(/\n+/g, ' ')}`);
            out += `\n${items.join('\n')}\n\n`;
            break;
          }
          case 'a': {
            const href = ch.getAttribute('href') || '';
            const text = inner.trim();
            out += (/^https?:\/\//.test(href) && text) ? `[${text}](${href})` : (text || href);
            break;
          }
          case 'img': {
            const src = ch.getAttribute('src') || '';
            if (/^data:image\//.test(src)) out += ''; // 内联大图忽略，避免撑爆正文
            else if (src) out += `![${ch.getAttribute('alt') || ''}](${src})`;
            break;
          }
          case 'hr': out += '\n\n---\n\n'; break;
          case 'td': case 'th': out += `${inner.trim()} | `; break;
          case 'tr': out += `\n| ${inner.trim()}`; break;
          case 'table': out += `\n${inner.trim()}\n\n`; break;
          default: out += inner;
        }
      });
      return out;
    };

    return walk(root)
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // 在 textarea 光标处插入文本（保留原有内容与选区）
  function insertAtCursor(el, text) {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const before = el.value.slice(0, start);
    const after = el.value.slice(end);
    el.value = before + text + after;
    const pos = start + text.length;
    el.selectionStart = el.selectionEnd = pos;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /* ---------------- 路由 ---------------- */
  const isDesktop = () => window.matchMedia('(min-width: 1024px)').matches;

  function parseHash() {
    const h = location.hash.replace(/^#\/?/, '');
    const [path, qs] = h.split('?');
    const seg = path.split('/').filter(Boolean);
    const params = {};
    new URLSearchParams(qs || '').forEach((v, k) => (params[k] = v));
    return { seg, params };
  }

  function navigate(name, params = {}, replace) {
    const query = new URLSearchParams(params).toString();
    const hash = '#/' + name + (query ? '?' + query : '');
    // 同一个 hash 不会触发 hashchange，因此始终手动渲染一次
    history.pushState(null, '', hash);
    window.scrollTo(0, 0);
    render();
  }

  /* ---------------- 骨架渲染 ---------------- */
  function render() {
    let { seg, params } = parseHash();
    let name = seg[0] || 'home';
    // 访客可直接浏览站点首页/版块/发现/搜索等；仅「内容详情 / 个人中心」需要登录，
    // 此时回到首页并弹出玻璃登录框，而不是整页跳转登录页。
    let needLogin = false;
    if (name === 'login') { needLogin = true; name = 'home'; }
    else if (!state.me && GUEST_BLOCKED.has(name)) { needLogin = true; name = 'home'; }
    if (needLogin) {
      history.replaceState(null, '', '#/home');
      seg[0] = 'home';
      params = {};
    }
    state.route = { name, params, seg };

    // 管理后台已是独立页面（/admin），老链接 #/admin 直接整页跳过去
    if (name === 'admin') { location.replace('/admin'); return; }

    const app = $('#app');
    const desktop = isDesktop();
    if (!desktop) {
      app.innerHTML = `<div class="app"><div class="mobile-shell" id="mobile"></div></div>`;
      renderMobile(name, params);
    } else {
      const appName = state.config.appName || '微坛';
      app.innerHTML = `<div class="app desk-app" id="desk">
        <header class="desk-topbar" data-navbar>
          <button class="nav-brand" data-go="home">
            <span class="brand-ico">${esc(appName.charAt(0))}</span><span class="brand-name">${esc(appName)}</span>
          </button>
          <div style="flex:1"></div>
          <div class="nav-right">${notifyBtn()}${searchBtn()}${userMenuBtn()}</div>
        </header>
        <div class="desk-body">
          <aside class="sidebar" id="sidebar"></aside>
          <section class="pane-list" id="pane-list"></section>
          <section class="pane-main" id="pane-main"></section>
        </div>
      </div>`;
      renderSidebar();
      renderDeskList(name, params);
      renderDeskMain(name, params);
      // 绑定顶部导航
      const topbar = $('.desk-topbar', app);
      if (topbar) {
        bindCommon(topbar);
        bindUserMenu(topbar);
      }
    }
    // 渲染完毕后，提示需要登录（玻璃弹窗）
    if (needLogin && !state.me) openLoginModal();
  }

  /* ---------------- 登录 / 注册（玻璃弹窗） ----------------
     访客可自由浏览站点；当需要查看内容或进行互动时，弹出玻璃拟态登录框。
     requireLogin(after)：已登录直接执行 after；未登录先弹窗，登录成功后自动继续。
  */
  function requireLogin(after) {
    if (state.me) { if (after) after(); return true; }
    openLoginModal({ onSuccess: after });
    return false;
  }

  function openLoginModal({ onSuccess } = {}) {
    if (state.me) { if (onSuccess) onSuccess(); return; }
    if (openLoginModal._cleanup) { openLoginModal._cleanup(); }
    let mode = 'login';
    closeOverlays();
    const mask = document.createElement('div');
    mask.className = 'glass-mask';
    const card = document.createElement('div');
    card.className = 'glass-card';
    const close = () => {
      mask.remove(); card.remove();
      document.removeEventListener('keydown', onKey);
      openLoginModal._cleanup = null;
    };
    openLoginModal._cleanup = close;
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    mask.onclick = close;

    const draw = () => {
      const appName = state.config.appName || '微坛';
      const logoURL = state.config.logo || '';
      const logoChar = appName.charAt(0);
      const needVerify = state.config.emailVerify !== false;
      card.innerHTML = `
        <button class="glass-close" data-gclose title="关闭">${icon('close', 18)}</button>
        <div class="glass-logo">${logoURL ? `<img src="${esc(logoURL)}" alt="" />` : esc(logoChar)}</div>
        <h2>${mode === 'login' ? '欢迎回来' : '加入' + esc(appName)}</h2>
        <div class="glass-sub">${mode === 'login' ? '登录后即可查看内容、发帖、评论与收藏' : esc(state.config.appDesc || '登录后开启完整社区体验')}</div>
        <div class="auth-field"><input class="field" id="g-user" placeholder="账号（3-20 位字母/数字/下划线）" autocomplete="username" /></div>
        ${mode === 'register' ? `
        <div class="auth-field"><input class="field" id="g-nick" placeholder="昵称（最多 16 个字）" /></div>
        <div class="auth-field"><input class="field" id="g-email" type="email" placeholder="邮箱（必填，用于接收验证码）" autocomplete="email" /></div>
        ${needVerify ? `
        <div class="auth-field" style="display:flex;gap:8px">
          <input class="field" id="g-code" placeholder="邮箱验证码" inputmode="numeric" maxlength="6" style="flex:1" />
          <button class="btn ghost" id="g-send" style="white-space:nowrap;padding:0 14px">获取验证码</button>
        </div>
        <div class="tiny muted" id="g-tip" style="margin:-2px 0 10px"></div>` : ''}` : ''}
        <div class="auth-field"><input class="field" id="g-pass" type="password" placeholder="密码（至少 6 位）" autocomplete="current-password" /></div>
        <button class="btn primary block" id="g-submit">${mode === 'login' ? '登录' : '注册并登录'}</button>
        <div class="glass-switch">${mode === 'login' ? '还没有账号？<button data-gswitch>立即注册</button>' : '已有账号？<button data-gswitch>去登录</button>'}</div>
        ${mode === 'login' && demoAccountsHTML() ? `<div class="demo-accounts">${demoAccountsHTML()}</div>` : ''}`;
      const user = $('#g-user', card);
      const pass = $('#g-pass', card);
      $('[data-gclose]', card).onclick = close;
      $('[data-gswitch]', card).onclick = () => { mode = mode === 'login' ? 'register' : 'login'; draw(); };

      // 获取邮箱验证码（演示模式下后端会直接返回验证码）
      const sendBtn = $('#g-send', card);
      if (sendBtn) {
        let left = 0;
        let timer = null;
        const tick = () => {
          if (left <= 0) { clearInterval(timer); sendBtn.disabled = false; sendBtn.textContent = '获取验证码'; return; }
          sendBtn.textContent = left + 's';
          left -= 1;
        };
        sendBtn.onclick = async () => {
          const email = ($('#g-email', card).value || '').trim();
          if (!EMAIL_RE.test(email)) return toast('请输入正确的邮箱地址');
          sendBtn.disabled = true;
          sendBtn.textContent = '发送中…';
          try {
            const d = await api('/api/email/send-code', { method: 'POST', body: { email } });
            const tip = $('#g-tip', card);
            if (d.demo) {
              if (tip) tip.textContent = `演示模式：验证码 ${d.code}（后台配置 SMTP 后将自动发到邮箱）`;
              const ce = $('#g-code', card);
              if (ce) ce.value = d.code;
              toast('演示模式：已自动填入验证码');
            } else {
              if (tip) tip.textContent = '验证码已发送，请查收邮箱（含垃圾邮件箱），10 分钟内有效';
              toast('验证码已发送');
            }
            left = 60; tick();
            timer = setInterval(tick, 1000);
          } catch (e) {
            sendBtn.disabled = false;
            sendBtn.textContent = '获取验证码';
          }
        };
      }

      const submit = async () => {
        const username = user.value.trim();
        const password = pass.value;
        const nick = $('#g-nick', card);
        const emailEl = $('#g-email', card);
        const codeEl = $('#g-code', card);
        if (!username || !password) return toast('请填写账号和密码');
        if (mode === 'register') {
          if (!EMAIL_RE.test((emailEl && emailEl.value.trim()) || '')) return toast('请输入正确的邮箱地址');
          if (needVerify && !((codeEl && codeEl.value.trim()) || '')) return toast('请填写邮箱验证码');
        }
        const btn = $('#g-submit', card);
        btn.disabled = true;
        btn.textContent = '请稍候…';
        try {
          const path = mode === 'login' ? '/api/login' : '/api/register';
          const body = mode === 'login'
            ? { username, password }
            : {
                username, password,
                nickname: (nick && nick.value.trim()) || username,
                email: emailEl.value.trim(),
                code: codeEl ? codeEl.value.trim() : '',
              };
          const d = await api(path, { method: 'POST', body });
          state.token = d.token;
          state.me = d.user;
          state.unread = d.user.unread || 0;
          localStorage.setItem('wf_token', d.token);
          close();
          toast(mode === 'login' ? '登录成功' : '欢迎加入 🎉');
          if (onSuccess) onSuccess(); else render();
        } catch (e) {
          btn.disabled = false;
          btn.textContent = mode === 'login' ? '登录' : '注册并登录';
        }
      };
      $('#g-submit', card).onclick = submit;
      pass.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
      user.onkeydown = (e) => {
        if (e.key !== 'Enter') return;
        const nick = $('#g-nick', card);
        if (mode === 'register' && nick) nick.focus(); else pass.focus();
      };
      setTimeout(() => user.focus(), 80);
    };
    draw();
    document.body.append(mask, card);
    document.addEventListener('keydown', onKey);
    return { close };
  }

  /* ---------------- 导航栏 ---------------- */
  function navbar({ title, back = false, right = '', transparent, brand = false }) {
    const appName = state.config.appName || '微坛';
    const logoChar = appName.charAt(0);
    const leftHTML = brand
      ? `<button class="nav-brand" data-go="home">
          <span class="brand-ico">${logoChar}</span><span class="brand-name">${esc(appName)}</span>
        </button>`
      : (back ? `<button class="icon-btn" data-back>${icon('back')}</button>` : '');
    const centerHTML = brand ? '' : `<div class="nav-title ellipsis">${esc(title)}</div>`;
    return `<header class="navbar" data-navbar>
      <div class="nav-left">${leftHTML}</div>
      ${centerHTML}
      <div class="nav-right">${right}${userMenuBtn()}</div>
    </header>`;
  }

  // 右上角头像按钮 + 下拉菜单
  function userMenuBtn() {
    const u = state.me;
    if (!u) {
      return `<button class="btn sm primary" data-open-login style="height:32px;padding:0 14px;border-radius:16px">登录</button>`;
    }
    const vip = u.isVip ? 'vip' : '';
    const avatar = u.avatar && u.avatar.startsWith('avatar:')
      ? `<div class="avatar-fallback">${esc(u.avatar.split(':').pop().charAt(0) || u.nickname.charAt(0))}</div>`
      : (u.avatar ? `<img src="${esc(u.avatar)}" alt="" />` : `<div class="avatar-fallback">${esc((u.nickname || 'U').charAt(0))}</div>`);
    return `<div class="nav-avatar-wrap" style="position:relative">
      <button class="nav-avatar-btn ${vip}" data-user-menu aria-label="用户菜单">${avatar}</button>
    </div>`;
  }

  function userDropdownHTML() {
    const u = state.me;
    if (!u) return '';
    const isVip = !!u.isVip;
    const vipText = isVip
      ? `VIP 会员 · 到期 ${formatDate(u.vipExpire)}`
      : '开通 VIP 享特权';
    return `<div class="user-dropdown" id="user-dropdown">
      <div class="dd-head">
        <button class="nav-avatar-btn ${isVip ? 'vip' : ''}" style="width:42px;height:42px" data-go="me">
          ${u.avatar && u.avatar.startsWith('avatar:')
            ? `<div class="avatar-fallback" style="font-size:16px">${esc(u.avatar.split(':').pop().charAt(0) || u.nickname.charAt(0))}</div>`
            : (u.avatar ? `<img src="${esc(u.avatar)}" alt="" />` : `<div class="avatar-fallback" style="font-size:16px">${esc((u.nickname || 'U').charAt(0))}</div>`)}
        </button>
        <div class="dd-info">
          <div class="dd-name">${esc(u.nickname)}${isVip ? '<span class="dd-vip-badge">👑 VIP</span>' : ''}</div>
          <div class="dd-sub">${esc(u.username)} · ${num(u.points || 0)} ${pointsName()}</div>
        </div>
      </div>
      <div class="dd-list">
        <button class="dd-item" data-go="me"><span class="dd-ico">👤</span>个人中心</button>
        ${u.isAdmin ? `<button class="dd-item" data-goto-admin><span class="dd-ico">🛡️</span>管理中心</button>` : ''}
        <button class="dd-item" data-compose-dropdown><span class="dd-ico">✏️</span>发帖</button>
        ${isVip
          ? `<button class="dd-item" data-vip><span class="dd-ico">👑</span>VIP 会员<span class="dd-tag">${esc(formatDate(u.vipExpire))}</span></button>`
          : `<button class="dd-item" data-vip style="color:#FA9D3B"><span class="dd-ico">👑</span>开通 VIP<span class="dd-tag">${pointsName()}兑换</span></button>`}
        <button class="dd-item danger" data-logout-dropdown><span class="dd-ico">🚪</span>退出登录</button>
      </div>
    </div>`;
  }

  function formatDate(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  let _dropdownOpen = false;
  function toggleUserDropdown(show) {
    const wrap = document.querySelector('.nav-avatar-wrap');
    if (!wrap) return;
    const existing = document.getElementById('user-dropdown');
    if (show === false || (show === undefined && existing)) {
      if (existing) existing.remove();
      _dropdownOpen = false;
      return;
    }
    if (existing) existing.remove();
    wrap.insertAdjacentHTML('beforeend', userDropdownHTML());
    _dropdownOpen = true;
  }

  function bindUserMenu(root) {
    const btn = $('[data-user-menu]', root);
    if (btn) {
      btn.onclick = (e) => {
        e.stopPropagation();
        toggleUserDropdown();
      };
    }
    const loginBtn = $('[data-open-login]', root);
    if (loginBtn) loginBtn.onclick = () => openLoginModal();
  }

  // 下拉菜单内的操作绑定（每次打开下拉时重新绑定）
  function bindDropdownActions(root) {
    const dd = document.getElementById('user-dropdown');
    if (!dd) {
      // 下拉可能稍后才打开，用事件委托在 document 上兜底
      return;
    }
    bindDropdownInner(dd);
  }

  function bindDropdownInner(dd) {
    dd.onclick = (e) => e.stopPropagation();
    $$('[data-go]', dd).forEach((b) => (b.onclick = () => { toggleUserDropdown(false); navigate(b.dataset.go); }));
    $$('[data-goto-admin]', dd).forEach((b) => (b.onclick = () => { toggleUserDropdown(false); gotoAdmin(); }));
    $$('[data-compose-dropdown]', dd).forEach((b) => (b.onclick = () => { toggleUserDropdown(false); openEditor(); }));
    $$('[data-vip]', dd).forEach((b) => (b.onclick = () => { toggleUserDropdown(false); openVipSheet(); }));
    $$('[data-logout-dropdown]', dd).forEach((b) => (b.onclick = () => { toggleUserDropdown(false); doLogout(); }));
  }

  // 重写 toggle 以在打开时绑定内部操作
  const _origToggle = toggleUserDropdown;
  toggleUserDropdown = function(show) {
    _origToggle(show);
    const dd = document.getElementById('user-dropdown');
    if (dd) bindDropdownInner(dd);
  };

  async function doLogout() {
    if (!(await confirmDialog({ title: '退出登录？', text: '下次访问需要重新输入账号密码', okText: '退出', danger: true }))) return;
    await api('/api/logout', { method: 'POST', body: {} }).catch(() => {});
    state.token = ''; state.me = null;
    localStorage.removeItem('wf_token');
    toast('已退出登录');
    navigate('home', {}, true);
  }

  // 导航栏滚动透明度
  function bindNavbarScroll(root) {
    const nav = $('[data-navbar]', root);
    const page = $('.page', root);
    if (!nav || !page) return;
    const onScroll = () => {
      if (page.scrollTop > 8) nav.classList.add('scrolled');
      else nav.classList.remove('scrolled');
    };
    onScroll();
    page.addEventListener('scroll', onScroll, { passive: true });
  }

  // 全局点击关闭下拉
  document.addEventListener('click', () => toggleUserDropdown(false));

  function bindBack(root) {
    $$('[data-back]', root).forEach((b) => (b.onclick = () => {
      if (history.length > 1 && state.route.name !== 'home') history.back();
      else navigate('home');
    }));
  }

  /* ---------------- 帖子卡片 ---------------- */
  function postItem(p) {
    const thumb = (p.images && p.images[0]) ? imageBox(p.images[0], 'p-thumb') : '';
    const tags = [
      p.isTop ? '<span class="tag-top">置顶</span>' : '',
      p.isEssence ? '<span class="tag-best">精华</span>' : '',
    ].join('');
    return `<button class="post-item" data-post="${p.id}">
      <div class="p-main">
        <div class="p-title clamp2">${tags}${esc(p.title)}</div>
        ${p.summary ? `<div class="p-sum clamp2">${esc(p.summary)}</div>` : ''}
        <div class="p-meta">
          <span class="p-board">${esc(p.board.icon)} ${esc(p.board.name)}</span>
          <span class="ellipsis" style="max-width:100px" data-uid="${p.user.id}">${esc(p.user.nickname)}</span>
          <span>${esc(p.timeAgo)}</span>
          ${p.comments ? `<span class="meta-dot">${icon('comment', 13)}${num(p.comments)}</span>` : ''}
          ${p.likes ? `<span class="meta-dot">${icon('heart', 13)}${num(p.likes)}</span>` : ''}
        </div>
      </div>
      ${thumb}
    </button>`;
  }

  function imageBox(src, cls = 'ph') {
    if (/^(linear-gradient|#|rgb)/.test(src)) {
      return `<div class="${cls}"><div class="grad" style="background:${esc(src)}"></div></div>`;
    }
    return `<div class="${cls}"><img src="${esc(src)}" alt="" loading="lazy" data-img="${esc(src)}" /></div>`;
  }

  function postListHTML(items, emptyText = '这里还很安静，来发第一帖吧') {
    if (!items || !items.length) {
      return `<div class="empty"><div class="big">🍃</div>${esc(emptyText)}</div>`;
    }
    return items.map(postItem).join('');
  }

  /* ---------------- 图片流帖子卡片（小红书风格） ---------------- */
  function imagePostCard(p) {
    const cover = (p.images && p.images[0]) ? p.images[0] : '';
    const moreCount = (p.images && p.images.length > 1) ? p.images.length : 0;
    const coverHTML = cover
      ? imageBox(cover, 'img-card-cover')
      : `<div class="img-card-cover"><div class="grad" style="background:linear-gradient(135deg,#e0e7ff,#c7d2fe)"></div></div>`;
    const tags = [
      p.isTop ? '<span class="tag-top">置顶</span>' : '',
      p.isEssence ? '<span class="tag-best">精华</span>' : '',
    ].join('');
    return `<button class="img-card" data-post="${p.id}">
      <div class="img-card-media">
        ${coverHTML}
        ${moreCount ? `<span class="img-card-count">${icon('image', 12)}${moreCount}</span>` : ''}
        ${tags ? `<div class="img-card-tags">${tags}</div>` : ''}
      </div>
      <div class="img-card-body">
        <div class="img-card-title clamp2">${esc(p.title)}</div>
        <div class="img-card-foot">
          <span data-uid="${p.user.id}" style="display:inline-flex;align-items:center;gap:6px;min-width:0">
            ${avatarHTML(p.user, 'xs')}
            <span class="img-card-name ellipsis">${esc(p.user.nickname)}</span>
          </span>
          <span class="img-card-like">${icon('heart', 13)}${num(p.likes)}</span>
        </div>
      </div>
    </button>`;
  }

  function imageBoardHTML(items, emptyText = '还没有图文，快来发第一张吧') {
    if (!items || !items.length) {
      return `<div class="empty"><div class="big">🖼</div>${esc(emptyText)}</div>`;
    }
    // 瀑布流：两列交错，按图片有无分配高度感
    return `<div class="img-waterfall">${items.map(imagePostCard).join('')}</div>`;
  }

  // 一行二（两列卡片）版式
  function postGrid2HTML(items, emptyText = '这里还很安静，来发第一帖吧') {
    if (!items || !items.length) {
      return `<div class="empty"><div class="big">🍃</div>${esc(emptyText)}</div>`;
    }
    return `<div class="post-grid2">${items.map(imagePostCard).join('')}</div>`;
  }

  // 热门头条（首页网格）
  function hotPixHTML(items) {
    if (!items || !items.length) return `<div class="empty">还没有热门图片</div>`;
    return `<div class="hotpix-grid">${items.map((p) => {
      const imgs = (p.images || []).slice(0, 4);
      const n = Math.max(1, imgs.length);
      const more = (p.images.length > 4) ? `<span class="hotpix-more">+${p.images.length - 4}</span>` : '';
      return `<button class="hotpix" data-post="${p.id}">
        <div class="hotpix-media n${n}">${imgs.map((s) => imageBox(s, 'hotpix-img')).join('')}${more}</div>
        <div class="hotpix-title clamp2">${esc(p.title)}</div>
        <div class="hotpix-foot"><span data-uid="${p.user.id}" style="display:inline-flex;align-items:center;gap:5px;min-width:0">${avatarHTML(p.user, 'xs')}<span class="hotpix-name ellipsis">${esc(p.user.nickname)}</span></span><span class="hotpix-like">${icon('heart', 12)}${num(p.likes)}</span></div>
      </button>`;
    }).join('')}</div>`;
  }

  // 登录弹窗演示账号说明（可在后台「站点设置」修改）
  function demoAccountsHTML() {
    const t = String(state.config.demoAccounts || '').trim();
    return t ? esc(t).replace(/\n/g, '<br>') : '';
  }

  // 社区交友版块（「社交」页只展示它）
  function socialBoard() {
    const bs = state.config.boards || [];
    return bs.find((b) => b.slug === 'social') || bs.find((b) => /交友|社交/.test(b.name)) || null;
  }

  // 版主展示条
  function moderatorsBarHTML(b) {
    const mods = (b && b.moderators) || [];
    if (!mods.length) return '';
    return `<div class="board-mods">${icon('shield', 14)}<b>版主</b>${mods.map((m) =>
      `<button class="mod-chip" data-uid="${m.id}">${esc(m.nickname)}</button>`).join('')}</div>`;
  }

  // 版块无权限访问提示（VIP / 申请制）
  function boardAccessDeniedHTML(b) {
    const isVip = state.me && state.me.isVip;
    const mode = b.accessMode || 'apply';
    const pending = !!b.accessPending;
    const desc = mode === 'vip'
      ? '该版块仅限 VIP 会员访问，开通 VIP 即可畅览全部内容。'
      : '该版块需申请并经管理员或版主审批后方可访问，VIP 会员可直接进入。';
    return `
      <div class="access-denied">
        <div class="ad-ico">${esc(b.icon || '🔒')}</div>
        <h3>${esc(b.name || '该版块')}</h3>
        <p class="ad-desc">${desc}</p>
        ${pending ? `
          <div class="ad-pending">⏳ 你的申请已提交，等待管理员或版主审批中…</div>` : `
          ${isVip ? `<button class="btn primary" data-refresh-board>刷新访问状态</button>` :
            `<div class="ad-actions">
              <button class="btn primary" data-apply-board>${mode === 'vip' ? '开通 VIP' : '申请访问'}</button>
            </div>`}`}
      </div>`;
  }

  // 绑定版块申请/开通 VIP 操作
  function bindBoardAccess(root, b) {
    const applyBtn = $('[data-apply-board]', root);
    if (applyBtn) {
      applyBtn.onclick = () => {
        if ((b.accessMode || 'apply') === 'vip') {
          // 跳转开通 VIP
          openVipSheet();
          return;
        }
        openSheet({
          title: '申请访问「' + (b.name || '该版块') + '」',
          body: `<div class="adm-form">
            <label>申请理由（选填，最多 200 字）
              <textarea class="field" id="apply-reason" maxlength="200" style="min-height:90px" placeholder="简单说明你想加入的原因，有助于快速通过审核"></textarea>
            </label>
            <button class="btn primary block" id="apply-submit">提交申请</button>
          </div>`,
          onMount(sheet) {
            $('#apply-submit', sheet).onclick = async () => {
              const reason = $('#apply-reason', sheet).value.trim();
              const btn = $('#apply-submit', sheet);
              btn.disabled = true; btn.textContent = '提交中…';
              try {
                const r = await api('/api/boards/' + encodeURIComponent(b.slug) + '/apply', {
                  method: 'POST', body: { reason },
                });
                toast('申请已提交，等待审批');
                b.accessPending = true;
                closeOverlays();
                // 刷新当前页
                if (state.route.name === 'discover') loadDiscover($('#discover-root'));
                else render();
              } catch (e) {
                btn.disabled = false; btn.textContent = '提交申请';
              }
            };
          },
        });
      };
    }
    const refreshBtn = $('[data-refresh-board]', root);
    if (refreshBtn) {
      refreshBtn.onclick = async () => {
        try {
          // 重新拉取配置以更新 canAccess
          state.config = await api('/api/config');
          if (state.route.name === 'discover') loadDiscover($('#discover-root'));
          else render();
        } catch (e) { toast('刷新失败'); }
      };
    }
  }

  // 个人中心「版块访问」：列出受限版块并可申请
  function openBoardAccessSheet() {
    const boards = (state.config.boards || []).filter((b) => (b.accessMode || 'public') !== 'public');
    const isVip = state.me && state.me.isVip;
    openSheet({
      title: '版块访问',
      body: boards.length ? `
        <div class="tiny muted" style="margin-bottom:10px">以下版块为 VIP 专属或需申请访问，${isVip ? '你已是 VIP，可直接进入' : '开通 VIP 可直接进入全部受限版块'}</div>
        <div class="cell-group">
          ${boards.map((b) => {
            const canAccess = b.canAccess !== false;
            const pending = !!b.accessPending;
            const modeLabel = b.accessMode === 'vip' ? '👑 仅 VIP' : '📝 申请访问';
            return `<div class="cell" style="cursor:default">
              <div class="board-ico" style="width:36px;height:36px;background:${esc(b.color)}1A;color:${esc(b.color)};border-radius:8px;display:grid;place-items:center;font-size:17px;flex-shrink:0">${esc(b.icon)}</div>
              <div class="grow" style="min-width:0">
                <div class="cell-title">${esc(b.name)} <span class="access-tag ${b.accessMode}">${modeLabel}</span></div>
                <div class="cell-sub">${canAccess ? '✅ 已可访问' : (pending ? '⏳ 审核中' : '🔒 未开通')}</div>
              </div>
              ${canAccess ? '' : `<button class="btn sm ${b.accessMode === 'vip' ? '' : 'primary'}" data-apply-board2="${b.slug}">${b.accessMode === 'vip' ? '开通 VIP' : (pending ? '等待中' : '申请')}</button>`}
            </div>`;
          }).join('')}
        </div>` : `<div class="empty" style="padding:30px 0"><div class="big">🔓</div>所有版块均为公开访问</div>`,
      onMount(sheet) {
        $$('[data-apply-board2]', sheet).forEach((btn) => (btn.onclick = () => {
          const slug = btn.dataset.applyBoard2;
          const b = (state.config.boards || []).find((x) => x.slug === slug);
          if (!b) return;
          if (b.accessMode === 'vip') { closeOverlays(); openVipSheet(); return; }
          closeOverlays();
          setTimeout(() => {
            // 复用申请弹窗
            const fakeRoot = document.createElement('div');
            fakeRoot.innerHTML = boardAccessDeniedHTML(b);
            bindBoardAccess(fakeRoot, b);
            const applyBtn = fakeRoot.querySelector('[data-apply-board]');
            if (applyBtn) applyBtn.click();
          }, 100);
        }));
      },
    });
  }

  // 全局页脚
  function siteFooterHTML(cls) {
    return `<div class="site-foot ${cls || ''}">© 2026 Powered by <a href="https://520816.xyz" target="_blank" rel="noopener">CARSON</a></div>`;
  }

  function bindPosts(root) {
    // 点击帖子/图片属于「查看内容」，需要登录：未登录时弹出玻璃登录框
    $$('[data-post]', root).forEach((el) => (el.onclick = (e) => {
      // 若点击的是用户名/头像（data-uid），交给用户主页跳转，不打开帖子
      if (e.target.closest('[data-uid]')) return;
      requireLogin(() => navigate('post', { id: el.dataset.post }));
    }));
    $$('[data-img]', root).forEach((el) => (el.onclick = (e) => { e.stopPropagation(); requireLogin(() => viewer(el.dataset.img)); }));
    $$('[data-uid]', root).forEach((el) => (el.onclick = (e) => { e.stopPropagation(); navigate('user', { id: el.dataset.uid }); }));
  }

  /* ---------------- 手机端：页面 ---------------- */
  function renderMobile(name, params) {
    const box = $('#mobile');
    if (name === 'post') {
      box.innerHTML = `<div class="page" id="page"></div>`;
      renderPostPage($('#page'), params, false);
      return;
    }
    let title = '微坛';
    let body = '';
    let right = '';
    let active = 'home';
    let fab = '';
    const nn = (k, def) => ((state.config.navNames || {})[k] || def);
    switch (name) {
      case 'home':
        title = state.config.appName || '微坛'; right = `${notifyBtn()}${searchBtn()}`;
        body = homeHTML();
        break;
      case 'discover':
        title = nn('social', '社交'); active = 'discover';
        body = `<div id="discover-root"><div class="spin" style="margin-top:40px"></div></div>`;
        break;
      case 'boards':
        title = nn('boards', '社区'); active = 'boards'; right = searchBtn();
        body = boardsHTML();
        break;
      case 'notice':
        title = nn('notice', '消息'); active = 'notice'; right = `<button class="btn sm" data-readall>全部已读</button>`;
        body = `<div class="page" id="page"><div class="spin" style="margin-top:60px"></div></div>`;
        break;
      case 'me':
        title = nn('me', '我'); active = 'me'; right = `<button class="icon-btn" data-edit-profile>${icon('settings')}</button>`;
        body = meHTML();
        break;
      case 'mine':
        title = '我的帖子'; active = 'me';
        body = `<div class="page" id="page"><div class="spin" style="margin-top:60px"></div></div>`;
        break;
      case 'favs':
        title = '我的收藏'; active = 'me';
        body = `<div class="page" id="page"><div class="spin" style="margin-top:60px"></div></div>`;
        break;
      case 'search':
        title = '搜索'; active = 'home';
        body = searchPageHTML();
        break;
      case 'user':
        title = '个人主页'; active = 'home';
        body = `<div class="page" id="page"><div class="spin" style="margin-top:60px"></div></div>`;
        break;
    }
    if (name === 'home' || name === 'boards') fab = `<button class="fab" data-compose>${icon('plus', 26)}</button>`;

    const isHome = name === 'home';
    box.innerHTML = `${navbar({ title, back: false, right, brand: isHome })}
      <div class="page" id="page"><div class="page-inner">${body}${siteFooterHTML()}</div></div>
      ${name !== 'search' ? tabbarHTML(active) : ''}
      ${fab}`;

    bindBack(box);
    bindCommon(box);
    bindUserMenu(box);
    bindDropdownActions(box);
    bindNavbarScroll(box);

    if (name === 'home') initHome(box);
    if (name === 'discover') loadDiscover($('#discover-root', box));
    if (name === 'boards') initBoards(box);
    if (name === 'me') initMe(box);
    if (name === 'notice') loadNotices($('#page', box));
    if (name === 'mine') loadMyPosts($('#page', box));
    if (name === 'favs') loadFavs($('#page', box), true);
    if (name === 'search') initSearch($('#page', box));
    if (name === 'user') loadUserPage($('#page', box), params.id);
    if (name !== 'post') scrollRestore(box);
  }

  function tabbarHTML(active) {
    const nn = (k, def) => ((state.config.navNames || {})[k] || def);
    const items = [
      ['home', 'home', nn('home', '首页')],
      ['discover', 'group', nn('social', '社交')],
      ['boards', 'boards', nn('boards', '社区')],
      ['notice', 'bell', nn('notice', '消息')],
      ['me', 'user', nn('me', '我')],
    ];
    return `<nav class="tabbar">${items.map(([k, ic, label]) => `
      <button class="${active === k ? 'active' : ''}" data-tab="${k}">
        ${active === k ? iconFill(ic) : icon(ic)}<span>${label}</span>
        ${k === 'notice' && state.unread ? `<span class="badge">${state.unread > 99 ? '99+' : state.unread}</span>` : ''}
      </button>`).join('')}</nav>`;
  }

  function notifyBtn() {
    return `<button class="icon-btn" data-tab="notice" style="position:relative">${icon('bell')}
      ${state.unread ? `<span class="badge">${state.unread > 99 ? '99+' : state.unread}</span>` : ''}</button>`;
  }
  function searchBtn() {
    return `<button class="icon-btn" data-go="search">${icon('search')}</button>`;
  }

  function bindCommon(root) {
    $$('[data-tab]', root).forEach((b) => (b.onclick = () => navigate(b.dataset.tab)));
    $$('[data-go]', root).forEach((b) => (b.onclick = () => navigate(b.dataset.go)));
    $$('[data-compose]', root).forEach((b) => (b.onclick = () => openEditor()));
    $$('[data-edit-profile]', root).forEach((b) => (b.onclick = () => openEditProfile()));
    $$('[data-readall]', root).forEach((b) => (b.onclick = async () => {
      await api('/api/notifications/read', { method: 'POST', body: { all: true } });
      state.unread = 0;
      toast('已全部标记为已读');
      navigate(state.route.name, state.route.params, true);
    }));
  }

  /* ---------------- 首页公告 ---------------- */
  // 吸顶常驻 + 单条滚动展示：多条按间隔纵向切换，单条文本过长则横向跑马灯
  function announceBarHTML() {
    const anns = Array.isArray(state.config.announcements)
      ? state.config.announcements.map((a) => String(a || '').trim()).filter(Boolean)
      : [];
    const single = (state.config.announcement || '').trim();
    const list = anns.length ? anns : (single ? [single] : []);
    if (!list.length) return '';
    // 每条文本复制两份，供跑马灯无缝循环使用（换行转空格，保证单行滚动）
    const items = list.map((t) => {
      const text = esc(t).replace(/\s*\n+\s*/g, ' ');
      return `<div class="ann-item">
        <div class="ann-scroll"><span class="ann-text-dup">${text}</span><span class="ann-text-dup" aria-hidden="true">${text}</span></div>
      </div>`;
    }).join('');
    return `<div class="announce-wrap" data-announce-wrap>
      <div class="announce-bar" data-announce>
        <span class="ann-ico">📢</span>
        <div class="ann-viewport"><div class="ann-track">${items}</div></div>
        <button class="ann-close" title="隐藏公告" aria-label="隐藏公告">×</button>
      </div>
    </div>`;
  }

  function startAnnouncements(root) {
    const wrap = $('[data-announce-wrap]', root);
    if (!wrap) return;
    const bar = $('[data-announce]', wrap);
    const viewport = $('.ann-viewport', bar);
    const track = $('.ann-track', bar);
    const items = $$('.ann-item', bar);
    if (!viewport || !track || !items.length) return;

    if (bar._annTimer) { clearInterval(bar._annTimer); bar._annTimer = 0; }
    // 关闭整个公告栏（仅本次会话，刷新恢复）
    $('.ann-close', wrap).onclick = () => { wrap.style.display = 'none'; };

    // 等布局稳定后再测量：跑马灯判断 + 逐行位移量
    requestAnimationFrame(() => {
      // 单条文本超出可视宽度 → 开启跑马灯并按文本长度计算时长（约 30px/秒）
      const vw = viewport.clientWidth || 300;
      items.forEach((item) => {
        const scroll = $('.ann-scroll', item);
        if (!scroll) return;
        const textWidth = scroll.scrollWidth / 2;
        if (textWidth > vw - 4) {
          scroll.classList.add('marquee');
          scroll.style.animationDuration = Math.max(6, textWidth / 30) + 's';
        } else {
          scroll.classList.remove('marquee');
          scroll.style.animationDuration = '';
        }
      });

      if (items.length <= 1) return;   // 单条无需切换
      // 逐行位移：必须按实际行高计算像素值，用 -100% 会以整条 track 高度为基准而跳行
      const itemH = items[0].offsetHeight || viewport.clientHeight;
      let idx = 0;
      const go = (i) => {
        idx = (i + items.length) % items.length;
        track.style.transform = `translateY(${-idx * itemH}px)`;
      };
      go(0);
      // 多条：按设定间隔纵向滚动切换，每次只显示一条
      const interval = Math.max(1, Number(state.config.announceInterval) || 5) * 1000;
      bar._annTimer = setInterval(() => go(idx + 1), interval);
    });
  }

  function homeHTML() {
    const appName = state.config.appName || '微坛';
    const appDesc = state.config.appDesc || '像微信一样简单，和同好聊聊技术与生活';
    const annHTML = announceBarHTML();
    return `
      <div class="hero">
        <h1>${esc(appName)}</h1>
        <p>${esc(appDesc)}</p>
        <div class="searchbox" data-search-trigger>
          ${icon('search', 18)}<span>搜索帖子、用户</span>
        </div>
      </div>
      ${annHTML}
      <div class="divider"></div>
      <div class="section-title"><b>热门头条</b><span data-go="boards" style="color:var(--link)">全部版块</span></div>
      <div id="home-pix"><div class="spin" style="margin:24px auto"></div></div>
      <div class="section-title"><b id="home-feed-title">${esc(SORT_LABEL[state.homeSort || 'new'] || '最新')}动态</b><span id="home-sort"></span></div>
      <div id="home-feed"><div class="spin" style="margin:30px auto"></div></div>`;
  }

  function initHome(root) {
    $$('[data-board]', root).forEach((b) => (b.onclick = () => openBoard(b.dataset.board)));
    const st = $('[data-search-trigger]', root);
    if (st) st.onclick = () => navigate('search');
    startAnnouncements(root);
    loadHomeFeed(root, state.homeSort || 'new');
    loadHomePix(root);
    // 分段器
    const sortBox = $('#home-sort', root);
    if (sortBox) {
      sortBox.innerHTML = `<span style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn sm ${(state.homeSort || 'new') === 'new' ? 'primary' : ''}" data-sort="new">最新</button>
        <button class="btn sm ${state.homeSort === 'hot' ? 'primary' : ''}" data-sort="hot">热门</button>
        <button class="btn sm ${state.homeSort === 'essence' ? 'primary' : ''}" data-sort="essence">精华</button>
        <button class="btn sm ${state.homeSort === 'following' ? 'primary' : ''}" data-sort="following">关注</button></span>`;
      $$('[data-sort]', root).forEach((b) => (b.onclick = () => {
        state.homeSort = b.dataset.sort;
        render();
      }));
    }
  }

  async function loadHomeFeed(root, sort) {
    const box = $('#home-feed', root);
    if (!box) return;
    try {
      if (sort === 'hot') {
        const hot = await api('/api/hot');
        box.innerHTML = `<div style="padding:10px 16px 4px;font-size:12px;color:var(--text-2)">🔥 近 30 天热度榜</div>` + postListHTML(hot);
      } else if (sort === 'following') {
        const list = await api('/api/posts?feed=following&limit=30');
        box.innerHTML = `<div style="padding:10px 16px 4px;font-size:12px;color:var(--text-2)">👥 你关注的人的最新动态</div>` + postListHTML(list, '关注的用户还没有发帖，去发现页找找感兴趣的人吧');
      } else {
        const list = await api('/api/posts?sort=' + sort + '&limit=30');
        box.innerHTML = postListHTML(list);
      }
      bindPosts(box);
      bindCommon(box);
      $$('[data-board]', box).forEach(() => {});
    } catch (e) { box.innerHTML = `<div class="empty">加载失败</div>`; }
  }

  // 首页「热门头条」
  async function loadHomePix(root) {
    const box = $('#home-pix', root);
    if (!box) return;
    try {
      const list = await api('/api/hot-images?limit=12');
      box.innerHTML = hotPixHTML(list);
      bindPosts(box);
    } catch (e) { box.innerHTML = ''; }
  }

  /* ---------------- 版块 ---------------- */
  function boardsHTML() {
    const boards = state.config.boards || [];
    const adminCols = Math.max(1, Math.min(6, Number(state.config.boardCols) || 1));
    // 手机端最多 2 列，电脑端按后台设置（最多 6 列）
    const cols = isDesktop() ? adminCols : Math.min(adminCols, 2);
    const gridStyle = `grid-template-columns:repeat(${cols}, minmax(0, 1fr))`;
    const card = (b) => `
      <button class="cell board-card" data-board="${b.slug}">
        <div class="board-ico" style="width:40px;height:40px;background:${esc(b.color)}1A;color:${esc(b.color)};border-radius:9px;display:grid;place-items:center;font-size:19px;flex-shrink:0">${esc(b.icon)}</div>
        <div class="grow" style="min-width:0">
          <div class="cell-title">${esc(b.name)}${b.accessMode === 'vip' ? '<span class="access-tag vip">VIP</span>' : b.accessMode === 'apply' ? '<span class="access-tag apply">申请</span>' : ''}</div>
          <div class="cell-sub">${esc(b.description)}</div>
        </div>
      </button>`;
    const cardCompact = (b) => `
      <button class="cell board-card compact" data-board="${b.slug}">
        <div class="board-ico" style="width:36px;height:36px;background:${esc(b.color)}1A;color:${esc(b.color)};border-radius:9px;display:grid;place-items:center;font-size:17px">${esc(b.icon)}</div>
        <div class="cell-title" style="font-size:13px">${esc(b.name)}${b.accessMode === 'vip' ? '<span class="access-tag vip sm">VIP</span>' : b.accessMode === 'apply' ? '<span class="access-tag apply sm">申请</span>' : ''}</div>
      </button>`;
    // 单列时用经典列表样式，多列时用紧凑卡片
    const useCompact = cols > 1;
    return `<div class="section-title"><b>全部版块</b><span>${boards.length} 个</span></div>
      <div class="board-grid" style="${gridStyle}">
      ${boards.map(useCompact ? cardCompact : card).join('')}
      </div>`;
  }

  function initBoards(root) {
    $$('[data-board]', root).forEach((b) => (b.onclick = () => openBoard(b.dataset.board)));
  }

  function openBoard(slug) {
    const b = (state.config.boards || []).find((x) => x.slug === slug);
    // 访问权限控制
    if (b && b.canAccess === false) {
      if (isDesktop()) {
        // 桌面端：在中栏显示无权限提示
        state.listMode = 'board';
        state.listParams = { slug };
        state.listTitle = b.name || '版块';
        state.list = [];
        if (state.route.name === 'home' || state.route.name === 'post') render();
        else navigate('home');
        // render 后渲染中栏
        setTimeout(() => {
          const pane = $('#pane-list');
          if (pane) {
            pane.innerHTML = `<div class="page" id="desk-board"><div class="page-inner">${boardAccessDeniedHTML(b)}</div></div>`;
            bindBoardAccess(pane, b);
          }
        }, 30);
      } else {
        // 手机端：显示无权限页
        const app = $('#app');
        app.innerHTML = `<div class="app"><div class="mobile-shell">
          ${navbar({ title: (b ? b.name : '版块'), back: true, right: searchBtn() })}
          <div class="page" id="board-page"><div class="page-inner">${boardAccessDeniedHTML(b)}</div></div>
        </div></div>`;
        bindBack(app);
        bindCommon(app);
        bindUserMenu(app);
        bindDropdownActions(app);
        bindNavbarScroll(app);
        bindBoardAccess(app, b);
      }
      return;
    }
    if (isDesktop()) {
      state.listMode = 'board';
      state.listParams = { slug };
      state.listTitle = b ? b.name : '版块';
      state.list = [];
      // 首页/帖子详情的左栏本就是帖子信息流，直接刷新即可；发现、版块等页面则跳到首页，让左栏切到该版块
      if (state.route.name === 'home' || state.route.name === 'post') render();
      else navigate('home');
    } else {
      // 手机端：进入独立的版块列表页
      const isImage = b && b.layout === 'image';
      const isGrid2 = b && b.layout === 'grid2';
      const app = $('#app');
      app.innerHTML = `<div class="app"><div class="mobile-shell">
        ${navbar({ title: (b ? b.name : '版块'), back: true, right: searchBtn() })}
        <div class="page" id="board-page"><div class="page-inner"><div class="spin" style="margin-top:60px"></div></div></div>
        <button class="fab" data-compose>${icon('plus', 26)}</button>
      </div></div>`;
      bindBack(app);
      bindCommon(app);
      bindUserMenu(app);
      bindDropdownActions(app);
      bindNavbarScroll(app);
      $$('[data-compose]', app).forEach((b2) => (b2.onclick = () => openEditor(slug)));
      api('/api/posts?board=' + encodeURIComponent(slug) + '&limit=50').then((list) => {
        const html = isImage ? imageBoardHTML(list) : (isGrid2 ? postGrid2HTML(list) : postListHTML(list));
        $('#board-page', app).innerHTML = `<div class="page-inner">${moderatorsBarHTML(b)}${html}</div>`;
        bindPosts($('#board-page', app));
      });
    }
  }

  /* ---------------- 消息 ---------------- */
  const NOTICE_KIND = { like: '赞了你的帖子', like_comment: '赞了你的评论', comment: '评论了你的帖子', reply: '回复了你', mention: '在内容中提到了你', follow: '关注了你', system: '发来一条系统消息' };
  const NOTICE_TABS = [['all', '全部'], ['unread', '未读'], ['comment', '评论'], ['like', '赞'], ['follow', '关注'], ['system', '系统']];

  async function loadNotices(box) {
    const filter = state.noticeFilter || 'all';
    let d;
    try { d = await api('/api/notifications?type=' + encodeURIComponent(filter)); }
    catch (e) { box.innerHTML = `<div class="empty">加载失败</div>`; return; }
    state.unread = d.unread;
    const counts = d.counts || {};
    const tabsHTML = `<div class="notice-tabs">${NOTICE_TABS.map(([k, label]) => {
      const n = counts[k] || 0;
      return `<button class="notice-tab ${filter === k ? 'on' : ''}" data-nf="${k}">${label}${n ? `<b>${n > 99 ? '99+' : n}</b>` : ''}</button>`;
    }).join('')}</div>`;
    const list = d.list || [];
    const itemsHTML = list.length ? list.map((n) => `
        <button class="notice-item ${n.isRead ? '' : 'unread'}" data-nid="${n.id}" data-pid="${n.postId || ''}" data-uid="${n.user.id}">
          ${avatarHTML(n.user)}
          <div class="notice-body">
            <div class="t"><b>${esc(n.user.nickname)}</b> ${esc(NOTICE_KIND[n.type] || '有新动态')}</div>
            ${n.content ? `<div class="q clamp2">${esc(n.content)}</div>` : (n.postTitle ? `<div class="q clamp2">${esc(n.postTitle)}</div>` : '')}
            <div class="w">${esc(n.timeAgo)}</div>
          </div>
        </button>`).join('')
      : `<div class="empty"><div class="big">🔔</div>${filter === 'all' ? '还没有新消息' : '这里暂时没有消息'}<br><span class="tiny">有人点赞、评论或关注你时会出现在这里</span></div>`;
    box.innerHTML = `<div class="page-inner">${tabsHTML}<div class="notice-list">${itemsHTML}</div></div>`;
    $$('[data-nf]', box).forEach((b) => (b.onclick = () => { state.noticeFilter = b.dataset.nf; box.innerHTML = `<div class="spin" style="margin-top:40px"></div>`; loadNotices(box); }));
    $$('.notice-item', box).forEach((el) => (el.onclick = async () => {
      await api('/api/notifications/read', { method: 'POST', body: { ids: [Number(el.dataset.nid)] } }).catch(() => {});
      state.unread = Math.max(0, state.unread - 1);
      if (el.dataset.pid) navigate('post', { id: el.dataset.pid });
      else if (el.dataset.uid && el.dataset.uid !== '0') navigate('user', { id: el.dataset.uid });
    }));
  }

  /* ---------------- 社交（仅展示「社区交友」版块内容） ---------------- */
  async function loadDiscover(box) {
    if (!box) return;
    const b = socialBoard();
    if (!b) { box.innerHTML = `<div class="empty"><div class="big">👥</div>还没有「社区交友」版块</div>`; return; }
    // 访问权限控制：VIP / 申请制
    if (b && b.canAccess === false) {
      box.innerHTML = boardAccessDeniedHTML(b);
      bindBoardAccess(box, b);
      return;
    }
    let list = [];
    try { list = await api('/api/posts?board=' + encodeURIComponent(b.slug) + '&limit=50'); }
    catch (e) { box.innerHTML = `<div class="empty">加载失败</div>`; return; }
    const empty = '还没有交友帖，快来发第一条吧';
    const layoutHTML = b.layout === 'image' ? imageBoardHTML(list, empty)
      : (b.layout === 'grid2' ? postGrid2HTML(list, empty) : postListHTML(list, empty));
    box.innerHTML = `
      <div class="section-title"><b>${esc(b.icon)} ${esc(b.name)}</b><span class="tiny muted">${esc(b.description || '社区交友')}</span></div>
      ${moderatorsBarHTML(b)}
      ${layoutHTML}`;
    bindPosts(box);
  }

  /* ---------------- 等级 / 用户组 / 勋章 展示 ---------------- */
  // 等级徽章（Lv.N），颜色取自用户组
  function levelBadgeHTML(u) {
    const color = (u.group && u.group.color) || '#07C160';
    return `<span class="lv-badge" style="background:linear-gradient(135deg,${esc(color)},${esc(color)}CC)">Lv.${num(u.level || 1)}</span>`;
  }

  // 用户组胶囊标签
  function groupChipHTML(u) {
    const g = u.group;
    if (!g) return '';
    const c = esc(g.color || '#07C160');
    return `<span class="grp-chip" style="color:${c};background:${c}1A">
      <i class="grp-ico" style="background:${c}">${esc(g.icon || '')}</i>${esc(g.name)}</span>`;
  }

  // 经验进度条
  function expBarHTML(u) {
    const p = Math.max(0, Math.min(100, Number(u.progress) || 0));
    const exp = num(u.exp), next = u.nextExp || 0;
    const tip = u.isManualGroup ? `${exp} 经验` : (next ? `${exp} / ${num(next)}` : `${exp} 经验`);
    const rest = next ? `还差 <b>${num(Math.max(0, next - (Number(u.exp) || 0)))}</b> 经验升级到「${esc(u.nextGroupName || '')}」` : '';
    return `<div class="exp-wrap">
      <div class="exp-line"><span class="exp-label">${icon('level', 14)} 经验值</span><span class="exp-tip">${tip}</span></div>
      <div class="exp-bar"><i style="width:${p}%"></i></div>
      ${(!u.isManualGroup && next && rest) ? `<div class="exp-next">${rest}</div>` : ''}
    </div>`;
  }

  // 用户组 + 经验区块
  function profileSysHTML(u) {
    return `<div class="profile-sys">
      <div class="ps-group">${groupChipHTML(u)}<span class="ps-tag">${u.isManualGroup ? '管理员授予' : '经验自动匹配'}</span></div>
      ${expBarHTML(u)}
    </div>`;
  }

  // 勋章墙
  function badgesHTML(u, label) {
    const list = u.badges || [];
    if (!list.length) return '';
    return `<div class="badge-wall">
      <div class="bw-head">${icon('medal', 16)} ${esc(label || '勋章')}<span class="bw-count">${list.length}</span></div>
      <div class="bw-list">${list.map((b) => `<span class="bw-item" title="${esc(b.description || '')}" style="border-color:${esc(b.color || '#07C160')}40">
        <i class="bw-ico" style="background:${esc(b.color || '#07C160')}1A">${esc(b.icon || '🏅')}</i>${esc(b.name)}</span>`).join('')}</div>
    </div>`;
  }

  /* ---------------- 我的 ---------------- */
  // 积分名称（后台可改，默认「积分」）
  function pointsName() {
    return (state.config && state.config.pointsName) || '积分';
  }

  function pointsConf() {
    const c = (state.config && state.config.pointsConfig) || {};
    return {
      post: Number(c.post ?? 5),
      comment: Number(c.comment ?? 2),
      checkin: Number(c.checkin ?? 5),
      checkinBonusMax: Number(c.checkinBonusMax ?? 5),
    };
  }

  function checkinRangeText() {
    const c = pointsConf();
    return c.checkinBonusMax > 0 ? `+${c.checkin}~${c.checkin + c.checkinBonusMax}` : `+${c.checkin}`;
  }

  function checkinHTML(u) {
    const checked = !!u.checkedInToday;
    const streak = u.checkinStreak || 0;
    return `<div style="margin:0 0 12px;padding:12px 14px;border-radius:14px;background:var(--card);border:.5px solid var(--line);display:flex;align-items:center;gap:10px">
      <div style="font-size:24px">📅</div>
      <div class="grow">
        <div style="font-weight:600;font-size:14px">每日签到</div>
        <div class="tiny" style="color:var(--text-2);margin-top:2px">连续签到 <b style="color:var(--brand)">${num(streak)}</b> 天 · 每日 ${checkinRangeText()} ${pointsName()}</div>
      </div>
      <button class="btn sm ${checked ? 'ghost' : 'primary'}" data-checkin ${checked ? 'disabled' : ''} style="height:32px">${checked ? '已签到' : '签到'}</button>
    </div>`;
  }

  function meHTML() {
    const u = state.me || {};
    const badges = badgesHTML(u, '我的勋章');
    const isVip = !!u.isVip;
    const vipBanner = isVip
      ? `<div class="vip-banner" style="margin:0 0 12px;padding:12px 14px;border-radius:14px;background:linear-gradient(135deg,#FA9D3B,#F5A623);color:#fff;display:flex;align-items:center;gap:10px">
          <div style="font-size:28px">👑</div>
          <div class="grow">
            <div style="font-weight:700;font-size:15px">VIP 会员</div>
            <div style="font-size:12px;opacity:.9">有效期至 ${esc(formatDate(u.vipExpire))}</div>
          </div>
          <button class="btn sm" data-vip style="background:rgba(255,255,255,.25);color:#fff;border:0;height:30px;padding:0 12px;border-radius:15px">续费</button>
        </div>`
      : `<button class="vip-banner" data-vip style="margin:0 0 12px;width:100%;padding:12px 14px;border-radius:14px;background:linear-gradient(135deg,#FA9D3B,#F5A623);color:#fff;display:flex;align-items:center;gap:10px;text-align:left">
          <div style="font-size:28px">👑</div>
          <div class="grow">
            <div style="font-weight:700;font-size:15px">开通 VIP 会员</div>
            <div style="font-size:12px;opacity:.9">${pointsName()}兑换 · 尊享专属标识与特权</div>
          </div>
          <span style="font-size:20px">›</span>
        </button>`;
    return `
      <div class="profile-head">
        ${avatarHTML(u, 'xl')}
        <div class="grow">
          <div class="nm">${esc(u.nickname || '')}${levelBadgeHTML(u)}${isVip ? '<span class="dd-vip-badge" style="margin-left:4px">👑 VIP</span>' : ''}</div>
          <div class="bio">${esc(u.bio || '这个人很懒，什么都没写~')}</div>
        </div>
        <button class="btn sm ghost" data-edit-profile>编辑</button>
      </div>
      ${vipBanner}
      ${checkinHTML(u)}
      ${profileSysHTML(u)}
      <div class="stat-row">
        <div><b>${num(u.points || 0)}</b>${pointsName()}</div>
        <div><b>${num(u.postCount)}</b>帖子</div>
        <div><b>${num(u.followingCount)}</b>关注</div>
        <div><b>${num(u.followerCount)}</b>粉丝</div>
        <div><b>${num(u.favoriteCount)}</b>收藏</div>
      </div>
      <div class="divider"></div>
      ${badges ? badges + '<div class="divider"></div>' : ''}
      <div class="cell-group">
        <button class="cell" data-vip><span class="ico" style="color:#FA9D3B">👑</span><div class="grow cell-title">${isVip ? 'VIP 会员中心' : '开通 VIP'}</div><span class="cell-value" style="color:var(--text-2)">${isVip ? '有效期至 ' + formatDate(u.vipExpire) : pointsName() + '兑换'}</span><span class="arrow">${icon('back', 16)}</span></button>
        <button class="cell" data-points><span class="ico" style="color:#E6655C">💰</span><div class="grow cell-title">${pointsName()}明细</div><span class="cell-value" style="color:var(--text-2)">${num(u.points || 0)} ${pointsName()}</span><span class="arrow">${icon('back', 16)}</span></button>
        <button class="cell" data-board-access><span class="ico" style="color:#10AEFF">🔑</span><div class="grow cell-title">版块访问</div><span class="cell-value" style="color:var(--text-2)">申请进入受限版块</span><span class="arrow">${icon('back', 16)}</span></button>
        <button class="cell" data-go="mine"><span class="ico" style="color:var(--brand)">${icon('edit', 22)}</span><div class="grow cell-title">我的帖子</div><span class="arrow">${icon('back', 16)}</span></button>
        <button class="cell" data-go="favs"><span class="ico" style="color:var(--orange)">${icon('bookmark', 22)}</span><div class="grow cell-title">我的收藏</div><span class="arrow">${icon('back', 16)}</span></button>
        <button class="cell" data-tab="notice"><span class="ico" style="color:var(--link)">${icon('bell', 22)}</span><div class="grow cell-title">消息通知</div>${state.unread ? `<span class="badge">${state.unread}</span>` : ''}<span class="arrow">${icon('back', 16)}</span></button>
      </div>
      <div class="divider"></div>
      <div class="cell-group">
        ${state.me && state.me.isAdmin ? `<a class="cell" href="/admin"><span class="ico" style="color:#fff;background:var(--brand);width:26px;height:26px;border-radius:6px;display:grid;place-items:center">${icon('settings', 16)}</span><div class="grow cell-title">管理后台</div><span class="cell-value">管理员</span><span class="arrow">${icon('back', 16)}</span></a>` : ''}
        <button class="cell" data-about><span class="ico" style="color:var(--text-2)">${icon('board', 22)}</span><div class="grow cell-title">关于${esc(state.config.appName || '微坛')}</div><span class="arrow">${icon('back', 16)}</span></button>
        <button class="cell" data-logout><span class="ico" style="color:var(--danger)">${icon('logout', 22)}</span><div class="grow cell-title" style="color:var(--danger)">退出登录</div></button>
      </div>`;
  }

  function initMe(root) {
    $$('[data-vip]', root).forEach((b) => (b.onclick = () => openVipSheet()));
    $$('[data-points]', root).forEach((b) => (b.onclick = () => openPointsLog()));
    $$('[data-checkin]', root).forEach((b) => (b.onclick = async () => {
      if (b.disabled) return;
      b.disabled = true;
      try {
        const d = await api('/api/checkin', { method: 'POST', body: {} });
        toast(d.already ? '今天已经签到过了' : `签到成功，+${d.gained} ${pointsName()}`);
        await refreshMe();
        render();
      } catch (e) { b.disabled = false; }
    }));
    $$('[data-board-access]', root).forEach((b) => (b.onclick = () => openBoardAccessSheet()));
    $$('[data-logout]', root).forEach((b) => (b.onclick = async () => {
      if (!(await confirmDialog({ title: '退出登录？', text: '下次访问需要重新输入账号密码', okText: '退出', danger: true }))) return;
      await api('/api/logout', { method: 'POST', body: {} }).catch(() => {});
      state.token = ''; state.me = null;
      localStorage.removeItem('wf_token');
      toast('已退出登录');
      navigate('home', {}, true);
    }));
    $$('[data-about]', root).forEach((b) => (b.onclick = () => {
      const appName = state.config.appName || '微坛';
      const appDesc = state.config.appDesc || '一个像微信一样好用的社区';
      const aboutText = (state.config.about || '').trim();
      const aboutHTML = aboutText ? `<div class="content" style="font-size:14px;line-height:1.8;white-space:pre-wrap">${renderMarkdown(aboutText)}</div>` :
        `<div class="content" style="font-size:14px;color:var(--text-2)">
        <p>· 三端自适应：手机、平板、电脑都能舒适浏览</p>
        <p>· 微信风格：气泡式评论、沉浸阅读、轻量交互</p>
        <p>· 完整社区：发帖、楼中楼、点赞、收藏、关注、通知</p>
      </div>`;
      const logoURL = state.config.logo || '';
      const logoChar = (state.config.appName || '坛').charAt(0);
      openSheet({
        title: '关于' + appName,
        body: `<div style="text-align:center;padding:10px 0 20px">
        <div class="boot-logo" style="margin:0 auto 12px;width:62px;height:62px;border-radius:15px;font-size:22px;overflow:hidden">${logoURL ? `<img src="${esc(logoURL)}" style="width:100%;height:100%;object-fit:cover" />` : esc(logoChar)}</div>
        <div style="font-size:17px;font-weight:600">${esc(appName)} WeForum</div>
        <div class="muted" style="font-size:13px;margin-top:4px">v1.0 · ${esc(appDesc)}</div>
      </div>
      ${aboutHTML}`,
      });
    }));
  }

  async function loadMyPosts(box) {
    try {
      const list = await api('/api/users/' + state.me.id + '/posts');
      box.innerHTML = `<div class="page-inner" style="padding-bottom:20px">${postListHTML(list, '你还没有发过帖子哦')}</div>`;
      bindPosts(box);
    } catch (e) { box.innerHTML = `<div class="empty">加载失败</div>`; }
  }

  async function loadFavs(box, withHeader) {
    try {
      const list = await api('/api/favorites');
      const html = `<div class="page-inner" style="padding-bottom:20px">${postListHTML(list, '还没有收藏，遇到好帖记得点收藏')}</div>`;
      box.innerHTML = html;
      bindPosts(box);
    } catch (e) { box.innerHTML = `<div class="empty">加载失败</div>`; }
  }

  // 桌面端「我的」：把用户中心渲染进中栏（含等级 / 用户组 / 经验 / 勋章）
  function loadMePage(box) {
    if (!state.me) { box.innerHTML = `<div class="empty">请先登录</div>`; return; }
    box.innerHTML = meHTML();
    initMe(box);
    bindCommon(box);
  }

  /* ---------------- 搜索 ---------------- */
  function boardRowHTML(b) {
    return `<button class="user-row" data-board="${esc(b.slug)}">
      <div class="board-ico" style="width:32px;height:32px;background:${esc(b.color)}1A;color:${esc(b.color)};border-radius:8px;display:grid;place-items:center;font-size:16px">${esc(b.icon)}</div>
      <div class="grow"><div class="cell-title">${esc(b.name)}</div><div class="cell-sub">${esc(b.description || '')}</div></div>
      <span class="arrow">${icon('back', 16)}</span></button>`;
  }

  function searchPageHTML() {
    const kwStr = (state.config.keywords || '').trim();
    const kws = kwStr ? kwStr.split(',').map((s) => s.trim()).filter(Boolean) : ['SQLite', '移动端适配', '副业', '已读', '机械键盘'];
    return `<div style="padding:12px 16px;background:var(--panel)">
      <div class="searchbox">${icon('search', 18)}<input id="q-input" placeholder="搜索帖子、用户" autofocus /></div>
      <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">
        ${kws.map((k) => `<button class="btn sm" data-kw="${esc(k)}">${esc(k)}</button>`).join('')}
      </div>
    </div>
    <div id="search-result"></div>`;
  }

  function initSearch(box) {
    const input = $('#q-input', box);
    const result = $('#search-result', box);
    let t = null;
    const run = async () => {
      const q = input.value.trim();
      if (!q) { result.innerHTML = ''; return; }
      result.innerHTML = `<div class="spin" style="margin:30px auto"></div>`;
      try {
        const [posts, users, boards] = await Promise.all([
          api('/api/search?q=' + encodeURIComponent(q)),
          api('/api/users/search?q=' + encodeURIComponent(q)),
          api('/api/boards/search?q=' + encodeURIComponent(q)),
        ]);
        result.innerHTML = `
          ${boards.length ? `<div class="section-title"><b>版块</b></div><div class="cell-group">${boards.slice(0, 4).map(boardRowHTML).join('')}</div>` : ''}
          ${users.length ? `<div class="section-title"><b>用户</b></div><div class="cell-group">${users.slice(0, 5).map((u) => `
            <button class="user-row" data-uid="${u.id}">${avatarHTML(u, 'sm')}
              <div class="grow"><div class="cell-title">${esc(u.nickname)}</div>
              <div class="cell-sub">@${esc(u.username)} · ${num(u.postCount)} 帖</div></div>
              <span class="arrow">${icon('back', 16)}</span></button>`).join('')}</div>` : ''}
          <div class="section-title"><b>帖子</b><span>${posts.length} 条结果</span></div>
          ${postListHTML(posts, '没有找到相关帖子')}`;
        bindPosts(result);
        $$('[data-uid]', result).forEach((b) => (b.onclick = () => navigate('user', { id: b.dataset.uid })));
        $$('[data-board]', result).forEach((b) => (b.onclick = () => openBoard(b.dataset.board)));
      } catch (e) { result.innerHTML = `<div class="empty">搜索失败</div>`; }
    };
    input.oninput = () => { clearTimeout(t); t = setTimeout(run, 300); };
    input.onkeydown = (e) => { if (e.key === 'Enter') { clearTimeout(t); run(); } };
    $$('[data-kw]', box).forEach((b) => (b.onclick = () => { input.value = b.dataset.kw; run(); }));
    input.focus();
  }

  /* ---------------- 用户主页 ---------------- */
  async function loadUserPage(box, id) {
    try {
      const [u, posts] = await Promise.all([api('/api/users/' + id), api('/api/users/' + id + '/posts')]);
      const badges = badgesHTML(u, 'TA 的勋章');
      box.innerHTML = `<div class="page-inner">
        <div class="profile-head">
          ${avatarHTML(u, 'xl')}
          <div class="grow">
            <div class="nm">${esc(u.nickname)}${levelBadgeHTML(u)}</div>
            <div class="bio">${esc(u.bio || '这个人很懒，什么都没写~')}</div>
          </div>
        </div>
        ${profileSysHTML(u)}
        <div class="stat-row">
          <div><b>${num(u.postCount)}</b>帖子</div>
          <div><b>${num(u.followingCount)}</b>关注</div>
          <div><b>${num(u.followerCount)}</b>粉丝</div>
          <div style="margin-left:auto"><button class="btn sm ${u.isFollowing ? 'ghost' : 'primary'}" data-follow="${u.id}" ${u.isMe ? 'disabled style="opacity:.4"' : ''}>${u.isMe ? '这是你自己' : (u.isFollowing ? '已关注' : '+ 关注')}</button></div>
        </div>
        <div class="divider"></div>
        ${badges ? badges + '<div class="divider"></div>' : ''}
        <div class="section-title"><b>TA 的帖子</b></div>
        ${postListHTML(posts, 'TA 还没有发过帖子')}
      </div>`;
      bindPosts(box);
      const fb = $('[data-follow]', box);
      if (fb) fb.onclick = () => requireLogin(async () => {
        const d = await api('/api/users/' + u.id + '/follow', { method: 'POST', body: {} });
        toast(d.following ? '已关注' : '已取消关注');
        loadUserPage(box, id);
      });
    } catch (e) { box.innerHTML = `<div class="empty">用户不存在</div>`; }
  }

  /* ---------------- 帖子详情 ---------------- */
  async function renderPostPage(page, params, desktop) {
    page.innerHTML = `<div class="spin" style="margin-top:80px"></div>`;
    let p;
    try { p = await api('/api/posts/' + params.id); }
    catch (e) { page.innerHTML = `<div class="empty"><div class="big">😶</div>帖子不存在或已被删除</div>`; return; }

    const imgs = p.images || [];
    const imgHTML = imgs.length ? `<div class="img-grid n${Math.min(imgs.length, 6)}">${imgs.map((s) => imageBox(s)).join('')}</div>` : '';
    const audioHTML = p.audio ? `<div class="audio-bubble" data-audio="${esc(p.audio)}"><div class="bars"><i></i><i></i><i></i><i></i></div><span class="tiny">语音留言 · 点击播放</span></div>` : '';
    const favOn = p.favorited;
    const quickReplies = defaultQuickReplies((state.config && state.config.quickReplies) || []);

    const html = `
      <article class="article">
        <h1>${esc(p.title)}</h1>
        <div class="author-row">
          ${avatarHTML(p.author, 'sm')}
          <div class="grow">
            <div class="name">${esc(p.author.nickname)}</div>
            <div class="when">${esc(p.createdAgo)} · ${num(p.views)} 阅读</div>
          </div>
          ${p.author.isMe ? '' : `<button class="btn sm ${p.author.isFollowing ? 'ghost' : 'primary'} follow-btn" data-follow="${p.author.id}">${p.author.isFollowing ? '已关注' : '+ 关注'}</button>`}
        </div>
        <div class="content">${renderMarkdown(p.content)}</div>
        ${imgHTML}${audioHTML}
        <div class="article-foot">
          <button class="act ${p.liked ? 'on' : ''}" data-like="${p.id}">
            ${p.liked ? iconFill('heart', 19) : icon('heart', 19)}<span>${p.likes || '赞'}</span></button>
          <button class="act fav ${favOn ? 'on' : ''}" data-fav="${p.id}">
            ${favOn ? iconFill('star', 19) : icon('star', 19)}<span>${favOn ? '已收藏' : '收藏'}</span></button>
          <button class="act" data-share>${icon('share', 19)}<span>分享</span></button>
          <button class="act more" data-more>${icon('more', 19)}</button>
        </div>
      </article>
      <div class="comments">
        <div class="c-head">全部评论 <span id="c-total"></span></div>
        <div id="comment-list"><div class="spin" style="margin:24px auto"></div></div>
      </div>
      <div class="comment-bar" id="qr-bar">
        <div class="qr-collapsed">
          <div class="fake-input" data-qr-open>写评论…</div>
          ${icon('image', 22)}
          ${icon('mic', 22)}
        </div>
        <div class="qr-expanded" id="qr-expanded" hidden>
          ${quickReplies.length ? `<div class="qr-chips">${quickReplies.map((q) => `<button type="button" class="qr-chip" data-qr-chip="${esc(q)}">${esc(q)}</button>`).join('')}</div>` : ''}
          <div class="qr-input-row">
            <textarea id="qr-text" class="qr-text" placeholder="友善交流…可用 @昵称 提及他人"></textarea>
            <button class="btn primary sm" id="qr-send">发送</button>
          </div>
          <div class="qr-actions"><span class="tiny muted">点击短语可快速填入</span><button type="button" class="qr-close" data-qr-close>收起</button></div>
        </div>
      </div>`;

    if (desktop) {
      page.innerHTML = navbar({ title: '帖子详情', back: true, right: `<button class="icon-btn" data-share>${icon('share')}</button>` }) +
        `<div class="page" id="post-page" style="border-left:.5px solid var(--line)"><div class="page-inner">${html}</div></div>`;
      bindBack(page);
    } else {
      page.innerHTML = navbar({ title: '帖子详情', back: true, right: `<button class="icon-btn" data-more>${icon('more')}</button>` }) +
        `<div class="page-inner" style="background:var(--bg)">${html}</div>`;
      bindBack(page);
    }

    const root = page;
    bindUserMenu(root);
    bindDropdownActions(root);
    bindNavbarScroll(root);
    bindPosts(root);
    $$('[data-audio]', root).forEach((el) => (el.onclick = () => {
      const a = new Audio(el.dataset.audio);
      a.play().catch(() => toast('语音播放失败'));
    }));

    // 关注
    const fb = $('[data-follow]', root);
    if (fb) fb.onclick = async () => {
      const d = await api('/api/users/' + fb.dataset.follow + '/follow', { method: 'POST', body: {} });
      toast(d.following ? '已关注' : '已取消关注');
      fb.textContent = d.following ? '已关注' : '+ 关注';
      fb.className = 'btn sm follow-btn ' + (d.following ? 'ghost' : 'primary');
    };

    // 点赞
    const lk = $('[data-like]', root);
    if (lk) lk.onclick = async () => {
      if (!state.me) return openLoginModal();
      const d = await api('/api/posts/' + p.id + '/like', { method: 'POST', body: {} });
      p.liked = d.liked; p.likes = d.likes;
      lk.className = 'act' + (d.liked ? ' on' : '');
      lk.innerHTML = `${d.liked ? iconFill('heart', 19) : icon('heart', 19)}<span>${d.likes || '赞'}</span>`;
    };

    // 收藏
    const fv = $('[data-fav]', root);
    if (fv) fv.onclick = async () => {
      const d = await api('/api/posts/' + p.id + '/favorite', { method: 'POST', body: {} });
      fv.className = 'act fav' + (d.favorited ? ' on' : '');
      fv.innerHTML = `${d.favorited ? iconFill('star', 19) : icon('star', 19)}<span>${d.favorited ? '已收藏' : '收藏'}</span>`;
      toast(d.favorited ? '已收藏' : '已取消收藏');
    };

    // 分享
    $$('[data-share]', root).forEach((b) => (b.onclick = async () => {
      const url = location.origin + '/#/post?id=' + p.id;
      const text = `【${p.title}】 ${url}`;
      if (navigator.share) { navigator.share({ title: p.title, text: p.content.slice(0, 60), url }).catch(() => {}); return; }
      try { await navigator.clipboard.writeText(text); toast('链接已复制，去分享给朋友吧'); }
      catch (e) { openSheet({ title: '分享', body: `<div class="content" style="word-break:break-all">${esc(text)}</div>` }); }
    }));

    // 更多
    $$('[data-more]', root).forEach((b) => (b.onclick = () => {
      openSheet({
        title: '更多操作',
        body: `<div class="cell-group" style="margin:-14px -18px">
          ${p.canEdit ? `<button class="cell" data-edit>${icon('edit', 20)}<div class="grow cell-title">编辑帖子</div></button>` : ''}
          ${p.canDelete ? `<button class="cell" data-del>${icon('trash', 20)}<div class="grow cell-title" style="color:var(--danger)">删除帖子</div></button>` : ''}
          <button class="cell" data-report>${icon('flag', 20)}<div class="grow cell-title">举报</div></button>
          <button class="cell" data-copy>${icon('share', 20)}<div class="grow cell-title">复制链接</div></button>
        </div>`,
        onMount: (sheet) => {
          $('[data-report]', sheet).onclick = () => { closeOverlays(); openReport('post', p.id); };
          $('[data-copy]', sheet).onclick = () => {
            navigator.clipboard?.writeText(location.origin + '/#/post?id=' + p.id);
            closeOverlays(); toast('链接已复制');
          };
          const ed = $('[data-edit]', sheet);
          if (ed) ed.onclick = () => {
            closeOverlays();
            openEditor(null, {
              editingId: p.id,
              boardId: (p.board && p.board.id) || 0,
              title: p.title,
              content: p.content,
              images: p.images || [],
              audio: p.audio || '',
            });
          };
          const del = $('[data-del]', sheet);
          if (del) del.onclick = async () => {
            closeOverlays();
            if (!(await confirmDialog({ title: '确认删除这篇帖子？', text: '删除后不可恢复', okText: '删除', danger: true }))) return;
            await api('/api/posts/' + p.id, { method: 'DELETE' });
            toast('已删除');
            navigate('home');
          };
        },
      });
    }));

    // 快捷回复：底部内联展开，快捷短语一键填入
    const qrBar = $('#qr-bar', root);
    const qrExpanded = $('#qr-expanded', root);
    const qrText = $('#qr-text', root);
    const refreshComments = () => renderComments($('#comment-list', root), p.id);
    const expandQR = () => {
      if (!state.me) { openLoginModal({ onSuccess: expandQR }); return; }
      qrBar.classList.add('qr-open');
      qrExpanded.hidden = false;
      qrText.focus();
    };
    const collapseQR = () => {
      qrBar.classList.remove('qr-open');
      qrExpanded.hidden = true;
      qrText.value = '';
    };
    $$('[data-qr-open]', root).forEach((el) => (el.onclick = expandQR));
    const qrClose = $('[data-qr-close]', root);
    if (qrClose) qrClose.onclick = collapseQR;
    $$('[data-qr-chip]', root).forEach((b) => (b.onclick = () => {
      const phrase = b.dataset.qrChip || '';
      qrText.value = qrText.value.trim() ? qrText.value.trim() + ' ' + phrase : phrase;
      qrText.focus();
    }));
    const qrSend = $('#qr-send', root);
    if (qrSend) qrSend.onclick = async () => {
      const content = qrText.value.trim();
      if (!content) { toast('说点什么再发送吧'); return; }
      qrSend.disabled = true;
      try {
        await api('/api/posts/' + p.id + '/comments', { method: 'POST', body: { content, parentId: 0 } });
        toast('评论成功');
        collapseQR();
        p.comments = (p.comments || 0) + 1;
        refreshComments();
      } catch (e) { /* 错误已统一提示 */ }
      qrSend.disabled = false;
    };

    renderComments($('#comment-list', root), p.id);
  }

  function defaultQuickReplies(list) {
    const arr = (list || []).map((s) => String(s).trim()).filter(Boolean);
    return arr.length ? arr.slice(0, 20) : ['感谢分享', '很有用的信息', '学到了，支持一下', '占楼，稍后细看'];
  }

  async function renderComments(box, pid) {
    if (!box) return;
    let d;
    try { d = await api('/api/posts/' + pid + '/comments'); }
    catch (e) { box.innerHTML = `<div class="empty tiny">评论加载失败</div>`; return; }
    const total = $('#c-total');
    if (total) total.textContent = d.total ? `${d.total} 条` : '';
    if (!d.list.length) {
      box.innerHTML = `<div class="empty tiny" style="padding:30px 20px">还没有评论，来说两句吧</div>`;
      return;
    }
    const SHOW = 3;
    box.innerHTML = d.list.map((c) => {
      const replies = c.replies || [];
      const visible = replies.slice(0, SHOW);
      return `<div class="c-item">
        ${avatarHTML(c.user)}
        <div class="c-body">
          <div class="c-name">${esc(c.user.nickname)}</div>
          <div class="c-text">${esc(c.content)}</div>
          <div class="c-foot">
            <span>${esc(c.timeAgo)}</span>
            <button data-reply="${c.id}" data-uid="${c.user.id}">回复</button>
            <button class="${c.liked ? 'on' : ''}" data-clike="${c.id}">${icon(c.liked ? 'heart' : 'heart', 13)} ${c.likes || '赞'}</button>
            ${c.canDelete ? `<button data-cdel="${c.id}">删除</button>` : ''}
          </div>
          ${replies.length ? `<div class="reply-list">
            ${visible.map((r) => `<div class="reply-item"><span class="rn">${esc(r.user.nickname)}</span>${r.replyTo ? ` 回复 <span class="rn">${esc(r.replyTo.nickname)}</span>` : ''}：<span class="rt">${esc(r.content)}</span></div>`).join('')}
            ${replies.length > SHOW ? `<div class="reply-more" data-expand="${c.id}">展开 ${replies.length - SHOW} 条回复</div>` : ''}
          </div>` : ''}
        </div>
      </div>`;
    }).join('');

    $$('[data-reply]', box).forEach((b) => (b.onclick = () => {
      const c = d.list.find((x) => x.id === Number(b.dataset.reply));
      openCommentInput(pid, c.id, c.user, () => renderComments(box, pid));
    }));
    $$('[data-expand]', box).forEach((b) => (b.onclick = () => {
      const c = d.list.find((x) => x.id === Number(b.dataset.expand));
      const parent = b.closest('.reply-list');
      parent.innerHTML = c.replies.map((r) => `<div class="reply-item"><span class="rn">${esc(r.user.nickname)}</span>${r.replyTo ? ` 回复 <span class="rn">${esc(r.replyTo.nickname)}</span>` : ''}：<span class="rt">${esc(r.content)}</span></div>`).join('');
    }));
    $$('[data-clike]', box).forEach((b) => (b.onclick = async () => {
      const r = await api('/api/comments/' + b.dataset.clike + '/like', { method: 'POST', body: {} });
      b.className = r.liked ? 'on' : '';
      b.innerHTML = `${icon('heart', 13)} ${r.likes || '赞'}`;
    }));
    $$('[data-cdel]', box).forEach((b) => (b.onclick = async () => {
      if (!(await confirmDialog({ title: '删除这条评论？', okText: '删除', danger: true }))) return;
      await api('/api/comments/' + b.dataset.cdel, { method: 'DELETE' });
      toast('已删除');
      renderComments(box, pid);
    }));
  }

  function openCommentInput(pid, parentId, replyUser, onDone) {
    openSheet({
      title: parentId ? `回复 ${replyUser ? replyUser.nickname : ''}` : '发表评论',
      body: `<div class="searchbox" style="height:auto;padding:10px 12px;align-items:flex-start">
          <textarea id="ci" class="field" style="background:transparent;padding:0;min-height:80px;border:0" placeholder="${parentId ? '回复 @' + esc(replyUser ? replyUser.nickname : '') + '：' : '说点什么…'}" autofocus></textarea>
        </div>
        <div class="between" style="margin-top:12px">
          <span class="tiny muted">友善交流 · 可用 @昵称 提及他人</span>
          <button class="btn primary sm" id="ci-send">发送</button>
        </div>`,
      onMount: (sheet) => {
        const ta = $('#ci', sheet);
        setTimeout(() => ta.focus(), 120);
        const send = async () => {
          const content = ta.value.trim();
          if (!content) return toast('评论内容不能为空');
          const btn = $('#ci-send', sheet);
          btn.disabled = true;
          try {
            await api('/api/posts/' + pid + '/comments', { method: 'POST', body: { content, parentId: parentId || 0 } });
            closeOverlays();
            toast('评论成功');
            onDone && onDone();
          } catch (e) { btn.disabled = false; }
        };
        $('#ci-send', sheet).onclick = send;
        ta.onkeydown = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); };
      },
    });
  }

  /* ---------------- 举报 ---------------- */
  function openReport(type, id) {
    const reasons = ['垃圾广告', '色情低俗', '人身攻击', '违法违规', '侵犯隐私', '其他'];
    openSheet({
      title: '举报',
      body: `<div class="cell-group" style="margin:-14px -18px">
        ${reasons.map((r) => `<button class="cell" data-reason="${esc(r)}"><div class="grow cell-title">${esc(r)}</div><span class="arrow">${icon('back', 16)}</span></button>`).join('')}
      </div>`,
      onMount: (sheet) => {
        $$('[data-reason]', sheet).forEach((b) => (b.onclick = async () => {
          await api('/api/report', { method: 'POST', body: { type, id, reason: b.dataset.reason } });
          closeOverlays();
          toast('举报已提交，感谢你的反馈');
        }));
      },
    });
  }

  /* ---------------- 编辑器 ---------------- */
  function openEditor(boardSlug, init) {
    // 发帖需要登录：访客先弹玻璃登录框，登录成功后自动回到发帖编辑器
    if (!state.me) { openLoginModal({ onSuccess: () => openEditor(boardSlug, init) }); return; }
    const boards = state.config.boards || [];
    const editing = !!(init && init.editingId);
    if (init) {
      state.draft = {
        boardId: init.boardId || 0,
        title: init.title || '',
        content: init.content || '',
        images: (init.images || []).slice(),
        audio: init.audio || '',
        editingId: init.editingId || 0,
      };
    } else {
      const startBoard = boardSlug ? (boards.find((b) => b.slug === boardSlug) || {}).id : 0;
      state.draft = { boardId: startBoard || 0, title: '', content: '', images: [], audio: '', editingId: 0 };
    }

    const sheet = openSheet({
      title: editing ? '编辑帖子' : '发帖',
      wide: true,
      body: `<div class="editor-sheet">
        <div class="board-picker" id="bp">
          ${boards.map((b) => `<button data-bid="${b.id}">${esc(b.icon)} ${esc(b.name)}</button>`).join('')}
        </div>
        <input class="editor-title" id="e-title" placeholder="标题（2-60 字）" maxlength="60" />
        <textarea class="editor-body" id="e-body" placeholder="分享你的想法…&#10;&#10;支持 Markdown：**加粗**、\`代码\`、\`\`\`代码块\`\`\`、- 列表、> 引用&#10;可用 @昵称 提及他人，对方会收到提醒"></textarea>
        <div class="editor-attach" id="e-attach"></div>
        <div class="editor-tools">
          <button class="tool" id="t-img">${icon('image', 22)}图片</button>
          <button class="tool" id="t-audio">${icon('mic', 22)}语音</button>
          <div class="grow"></div>
          <button class="btn primary" id="e-submit" style="height:34px">${editing ? '保存' : '发布'}</button>
        </div>
        <input type="file" id="f-img" accept="image/*" multiple class="hidden" />
      </div>`,
      onMount: (sh) => {
        const d = state.draft;
        const bp = $('#bp', sh);
        const markBoard = () => $$('[data-bid]', bp).forEach((b) => b.classList.toggle('on', Number(b.dataset.bid) === d.boardId));
        $$('[data-bid]', bp).forEach((b) => (b.onclick = () => { d.boardId = Number(b.dataset.bid); markBoard(); }));
        markBoard();
        $('#e-title', sh).value = d.title;
        $('#e-body', sh).value = d.content;

        // 粘贴富文本时转成 Markdown，保留标题 / 加粗 / 列表 / 链接等原文格式
        const bodyEl = $('#e-body', sh);
        bodyEl.addEventListener('paste', (e) => {
          const cd = e.clipboardData;
          const html = cd && cd.getData('text/html');
          if (!html) return; // 纯文本粘贴走浏览器默认行为
          const md = htmlToMarkdown(html);
          if (!md) return;
          e.preventDefault();
          insertAtCursor(bodyEl, md);
          toast('已按原文格式粘贴');
        });

        const attach = $('#e-attach', sh);
        const renderAttach = () => {
          attach.innerHTML = d.images.map((src, i) => `<div class="thumb-attach"><img src="${esc(src)}" /><button class="x" data-rm="${i}">✕</button></div>`).join('')
            + (d.images.length < 9 ? `<button class="attach-btn" id="add-img">${icon('image', 20)}添加图片</button>` : '')
            + (d.audio ? `<div class="audio-mini">${icon('play', 14)} 语音已录制 <button data-rmaudio style="color:var(--danger)">删除</button></div>` : '');
          $$('[data-rm]', attach).forEach((b) => (b.onclick = () => { d.images.splice(Number(b.dataset.rm), 1); renderAttach(); }));
          const addBtn = $('#add-img', attach);
          if (addBtn) addBtn.onclick = () => $('#f-img', sh).click();
          const rmA = $('[data-rmaudio]', attach);
          if (rmA) rmA.onclick = () => { d.audio = ''; renderAttach(); };
        };
        renderAttach();

        $('#f-img', sh).onchange = async (e) => {
          const files = Array.from(e.target.files || []).slice(0, 9 - d.images.length);
          for (const f of files) {
            if (f.size > 6 * 1024 * 1024) { toast('单张图片不能超过 6MB'); continue; }
            const dataUrl = await fileToDataURL(f, 1600);
            d.images.push(dataUrl);
          }
          renderAttach();
          e.target.value = '';
        };

        $('#t-img', sh).onclick = () => $('#f-img', sh).click();

        $('#t-audio', sh).onclick = () => {
          closeOverlays();
          openRecorder((dataUrl) => { d.audio = dataUrl; openEditorKeep(d); });
        };

        $('#e-submit', sh).onclick = async () => {
          d.title = $('#e-title', sh).value.trim();
          d.content = $('#e-body', sh).value.trim();
          if (!d.boardId) return toast('请选择版块');
          if (d.title.length < 2) return toast('标题至少 2 个字');
          if (d.content.length < 2) return toast('正文至少 2 个字');
          const btn = $('#e-submit', sh);
          btn.disabled = true; btn.textContent = editing ? '保存中…' : '发布中…';
          try {
            const payload = { boardId: d.boardId, title: d.title, content: d.content, images: d.images, audio: d.audio };
            const r = editing
              ? await api('/api/posts/' + d.editingId, { method: 'PUT', body: payload })
              : await api('/api/posts', { method: 'POST', body: payload });
            closeOverlays();
            toast(editing ? '已保存' : '发布成功');
            state.draft = { boardId: 0, title: '', content: '', images: [], audio: '', editingId: 0 };
            navigate('post', { id: r.id });
          } catch (e) { btn.disabled = false; btn.textContent = editing ? '保存' : '发布'; }
        };
      },
    });
    return sheet;
  }

  function openEditorKeep(d) {
    // 录音后恢复编辑器（不丢失草稿，含编辑模式的 editingId）
    openEditor(null, d);
  }

  /* ---------------- 录音 ---------------- */
  function openRecorder(onDone) {
    let recorder = null, chunks = [], stream = null, timer = null, seconds = 0;
    const sheet = openSheet({
      title: '语音留言',
      body: `<div style="text-align:center;padding:20px 0 10px">
        <div id="rec-time" style="font-size:34px;font-weight:300;font-variant-numeric:tabular-nums">00:00</div>
        <div class="tiny muted" style="margin-top:6px" id="rec-tip">点击开始录音（最长 60 秒）</div>
        <div class="audio-bubble" style="margin:22px auto;max-width:240px;min-width:180px"><div class="bars"><i></i><i></i><i></i><i></i><i></i></div><span class="tiny">语音</span></div>
      </div>
      <div style="display:flex;gap:10px;padding:0 0 6px">
        <button class="btn block ghost" id="rec-btn">开始录音</button>
        <button class="btn block primary" id="rec-ok" disabled>使用这段语音</button>
      </div>`,
      onMount: (sh) => {
        const btn = $('#rec-btn', sh);
        const okBtn = $('#rec-ok', sh);
        const timeEl = $('#rec-time', sh);
        const tip = $('#rec-tip', sh);
        const fmt = (s) => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');

        btn.onclick = async () => {
          if (recorder && recorder.state === 'recording') {
            recorder.stop();
            return;
          }
          if (!navigator.mediaDevices || !window.MediaRecorder) {
            tip.textContent = '当前浏览器不支持录音，请改用文字';
            return;
          }
          try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          } catch (e) {
            tip.textContent = '未获得麦克风权限';
            return;
          }
          chunks = [];
          recorder = new MediaRecorder(stream);
          recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
          recorder.onstop = () => {
            clearInterval(timer);
            stream.getTracks().forEach((t) => t.stop());
            const blob = new Blob(chunks, { type: chunks[0] ? chunks[0].type : 'audio/webm' });
            const reader = new FileReader();
            reader.onload = () => {
              window.__lastAudio = reader.result;
              okBtn.disabled = false;
              btn.textContent = '重新录音';
              tip.textContent = `已录制 ${fmt(seconds)}，点击「使用这段语音」`;
            };
            reader.readAsDataURL(blob);
          };
          recorder.start();
          seconds = 0;
          timeEl.textContent = '00:00';
          btn.textContent = '停止录音';
          tip.textContent = '录音中…';
          timer = setInterval(() => {
            seconds++;
            timeEl.textContent = fmt(seconds);
            if (seconds >= 60) recorder.stop();
          }, 1000);
        };
        okBtn.onclick = () => {
          if (window.__lastAudio) {
            const a = window.__lastAudio;
            window.__lastAudio = null;
            closeOverlays();
            onDone(a);
          }
        };
      },
    });
    // 关闭时释放麦克风
    const mo = new MutationObserver(() => {
      if (!document.body.contains(sheet)) {
        if (stream) stream.getTracks().forEach((t) => t.stop());
        clearInterval(timer);
        mo.disconnect();
      }
    });
    mo.observe(document.body, { childList: true });
  }

  /* ---------------- 编辑资料 ---------------- */
  function openEditProfile() {
    const u = state.me || {};
    openSheet({
      title: '编辑资料',
      body: `<div style="display:flex;align-items:center;gap:14px;margin-bottom:16px">
          <div id="pf-avatar">${avatarHTML(u, 'lg')}</div>
          <div>
            <button class="btn sm ghost" id="pf-pick">更换头像</button>
            <div class="tiny muted" style="margin-top:6px">支持 JPG / PNG，自动压缩</div>
          </div>
        </div>
        <div class="tiny muted" style="margin-bottom:6px">昵称</div>
        <input class="field" id="pf-nick" maxlength="16" value="${esc(u.nickname || '')}" style="background:var(--panel-2)" />
        <div class="tiny muted" style="margin:14px 0 6px">个性签名</div>
        <textarea class="field" id="pf-bio" maxlength="100" style="background:var(--panel-2);min-height:80px" placeholder="介绍一下自己…">${esc(u.bio || '')}</textarea>
        <button class="btn primary block" id="pf-save" style="margin-top:18px">保存</button>
        <input type="file" id="pf-file" accept="image/*" class="hidden" />`,
      onMount: (sh) => {
        let avatarData = '';
        $('#pf-pick', sh).onclick = () => $('#pf-file', sh).click();
        $('#pf-file', sh).onchange = async (e) => {
          const f = e.target.files[0];
          if (!f) return;
          avatarData = await fileToDataURL(f, 400);
          $('#pf-avatar', sh).innerHTML = `<div class="avatar lg"><img src="${avatarData}" /></div>`;
        };
        $('#pf-save', sh).onclick = async () => {
          const nickname = $('#pf-nick', sh).value.trim();
          const bio = $('#pf-bio', sh).value.trim();
          if (!nickname) return toast('昵称不能为空');
          const body = { nickname, bio };
          if (avatarData) body.avatar = avatarData;
          try {
            const d = await api('/api/me', { method: 'PUT', body });
            state.me = d.user;
            closeOverlays();
            toast('已保存');
            render();
          } catch (e) {}
        };
      },
    });
  }

  /* ---------------- VIP 会员开通 ---------------- */
  function openVipSheet() {
    if (!state.me) { openLoginModal({ onSuccess: openVipSheet }); return; }
    const plans = (state.config.vipPlans || []);
    const u = state.me;
    const isVip = !!u.isVip;
    openSheet({
      title: isVip ? 'VIP 会员中心' : '开通 VIP 会员',
      body: `<div style="text-align:center;padding:6px 0 16px">
        <div style="font-size:40px">👑</div>
        <div style="font-size:18px;font-weight:700;margin-top:4px;background:linear-gradient(135deg,#FA9D3B,#F5A623);-webkit-background-clip:text;color:transparent">${isVip ? '您已是 VIP 会员' : '升级 VIP 尊享特权'}</div>
        <div class="tiny muted" style="margin-top:6px">
          ${isVip ? `有效期至 ${esc(formatDate(u.vipExpire))}` : pointsName() + '兑换，解锁会员专属标识与特权'}
        </div>
        <div class="tiny" style="margin-top:10px;color:var(--text-2)">当前${pointsName()}：<b style="color:var(--brand)">${num(u.points || 0)}</b></div>
      </div>
      <div class="adm-tiles" style="grid-template-columns:repeat(3,1fr);gap:10px">
        ${plans.map((p) => `
          <button class="adm-tile vip-plan" data-plan="${esc(p.id)}" style="text-align:center;padding:14px 8px;border:2px solid ${esc(p.color || '#07C160')};border-radius:14px;background:var(--panel-2)">
            <div style="font-size:24px">${esc(p.icon || '👑')}</div>
            <div style="font-size:14px;font-weight:600;margin-top:4px">${esc(p.name)}</div>
            <div style="font-size:11px;color:var(--text-2);margin-top:2px">${num(p.days)} 天</div>
            <div style="margin-top:8px;font-size:16px;font-weight:700;color:${esc(p.color || '#07C160')}">${num(p.points)}<span class="tiny" style="font-weight:400"> ${pointsName()}</span></div>
            ${p.hot ? '<div style="position:absolute;top:-8px;right:-6px;background:#FA9D3B;color:#fff;font-size:10px;padding:1px 6px;border-radius:8px">热门</div>' : ''}
          </button>`).join('')}
      </div>
      <div class="tiny muted" style="margin-top:14px;text-align:center;line-height:1.7">
        · VIP 会员享受金色头像光环与专属标识<br>
        · ${pointsName()}可通过签到（${checkinRangeText()}）、发帖（+${pointsConf().post}）、评论（+${pointsConf().comment}）获得<br>
        · 管理员也可在后台直接为您开通
      </div>`,
      onMount: (sheet) => {
        $$('[data-plan]', sheet).forEach((b) => (b.onclick = async () => {
          const plan = plans.find((x) => x.id === b.dataset.plan);
          if (!plan) return;
          if ((u.points || 0) < plan.points) {
            toast(`${pointsName()}不足，还差 ${plan.points - (u.points || 0)} ${pointsName()}`);
            return;
          }
          if (!(await confirmDialog({ title: `确认开通 ${plan.name}？`, text: `将扣除 ${plan.points} ${pointsName()}，有效期 ${plan.days} 天`, okText: '确认开通' }))) return;
          const btn = b;
          btn.disabled = true;
          try {
            const r = await api('/api/vip/buy', { method: 'POST', body: { planId: plan.id } });
            state.me = r.user;
            closeOverlays();
            toast(`🎉 开通成功，有效期至 ${formatDate(r.vipExpire)}`);
            render();
          } catch (e) { btn.disabled = false; }
        }));
      },
    });
  }

  async function openPointsLog() {
    let d;
    try { d = await api('/api/points/log?limit=50'); }
    catch (e) { toast(pointsName() + '明细加载失败'); return; }
    const rows = d.list || [];
    const body = rows.length
      ? `<div style="margin:-12px 0 0">${rows.map((r) => `<div class="cell" style="cursor:default;width:100%">
          <div class="grow" style="min-width:0">
            <div class="cell-title">${esc(r.reason || pointsName() + '变动')}</div>
            <div class="tiny" style="color:var(--text-2);margin-top:2px">${esc(r.timeAgo)}</div>
          </div>
          <span class="cell-value" style="font-weight:700;color:${r.delta >= 0 ? 'var(--brand)' : 'var(--danger)'}">${r.delta >= 0 ? '+' : ''}${num(r.delta)}</span>
        </div>`).join('')}</div>`
      : `<div class="empty tiny" style="padding:36px 0">还没有${pointsName()}记录，去签到或发帖赚${pointsName()}吧</div>`;
    openSheet({
      title: `${pointsName()}明细 · 当前 ${num(d.points)} ${pointsName()}`,
      wide: true,
      body,
    });
  }

  /* ---------------- 桌面端 ---------------- */
  function renderSidebar() {
    const sb = $('#sidebar');
    const u = state.me || {};
    const guest = !state.me;
    const boards = state.config.boards || [];
    const nn = (k, def) => ((state.config.navNames || {})[k] || def);
    const navItem = (k, ic, label, badge) => `<button class="nav-item ${state.route.name === k ? 'active' : ''}" data-nav="${k}">
      ${icon(ic, 18)}<span>${label}</span>${badge ? `<span class="badge">${badge > 99 ? '99+' : badge}</span>` : ''}</button>`;
    sb.innerHTML = `
      <button class="me" data-nav="${guest ? 'login' : 'me'}" style="width:100%;text-align:left">
        ${avatarHTML(guest ? null : u)}
        <div class="grow" style="min-width:0">
          <div class="name ellipsis">${esc(guest ? '点击登录' : (u.nickname || ''))}</div>
          <div class="sub ellipsis">${guest ? '登录后可查看内容、发帖互动' : '@' + esc(u.username || '')}</div>
        </div>
      </button>
      <div class="nav-group">
        ${navItem('home', 'home', nn('home', '首页'))}
        ${navItem('discover', 'group', nn('social', '社交'))}
        ${navItem('boards', 'boards', nn('boards', '社区'))}
        ${navItem('notice', 'bell', nn('notice', '消息'), state.unread)}
      </div>
      <div class="nav-group">
        <div class="nav-label">${nn('boards', '社区')}</div>
        ${boards.map((b) => `<button class="nav-item board-item ${state.listMode === 'board' && state.listParams.slug === b.slug ? 'active' : ''}" data-board="${b.slug}">
          <span class="ico">${esc(b.icon)}</span><span class="ellipsis">${esc(b.name)}</span></button>`).join('')}
      </div>
      <div class="nav-group">
        <div class="nav-label">我的</div>
        ${navItem('mine', 'edit', '我的帖子')}
        ${navItem('favs', 'bookmark', '我的收藏')}
        ${u.isAdmin ? `<a class="nav-item" href="/admin">${icon('settings', 18)}<span>管理后台</span></a>` : ''}
      </div>
      <div class="foot">${esc(state.config.appName || '微坛')} v1.0</div>
      ${siteFooterHTML('side')}`;

    $$('[data-nav]', sb).forEach((b) => (b.onclick = () => {
      const k = b.dataset.nav;
      if (k === 'me') { state.listMode = 'mine'; state.listTitle = '我的帖子'; state.list = []; }
      else if (k === 'home') { state.listMode = 'home'; state.listParams = {}; }
      navigate(k);
    }));
    $$('[data-board]', sb).forEach((b) => (b.onclick = () => openBoard(b.dataset.board)));
  }

  function renderDeskList(name, params) {
    const pane = $('#pane-list');
    let head = '';
    let bodyHTML = '';
    let actions = '';
    const nn = (k, def) => ((state.config.navNames || {})[k] || def);

    if (name === 'notice') {
      head = `<div class="list-head"><h2>消息</h2><button class="btn sm" data-readall>全部已读</button></div>`;
      bodyHTML = `<div class="page" id="desk-notice"><div class="spin" style="margin-top:60px"></div></div>`;
    } else if (name === 'mine') {
      head = `<div class="list-head"><h2>我的帖子</h2></div>`;
      bodyHTML = `<div class="page" id="desk-mine"><div class="spin" style="margin-top:60px"></div></div>`;
    } else if (name === 'favs') {
      head = `<div class="list-head"><h2>我的收藏</h2></div>`;
      bodyHTML = `<div class="page" id="desk-favs"><div class="spin" style="margin-top:60px"></div></div>`;
    } else if (name === 'search') {
      head = `<div class="list-head"><h2>搜索</h2></div>`;
      bodyHTML = `<div class="page" id="desk-search" style="padding:0 14px 14px"><div class="searchbox">${icon('search', 18)}<input id="q-input" placeholder="搜索帖子、用户…" /></div><div id="desk-search-result"></div></div>`;
    } else if (name === 'user') {
      head = `<div class="list-head"><h2>个人主页</h2></div>`;
      bodyHTML = `<div class="page" id="desk-user"><div class="spin" style="margin-top:60px"></div></div>`;
    } else if (name === 'me') {
      head = `<div class="list-head"><h2>我的</h2><button class="icon-btn" data-edit-profile>${icon('settings')}</button></div>`;
      bodyHTML = `<div class="page" id="desk-me"><div class="spin" style="margin-top:60px"></div></div>`;
    } else if (name === 'boards') {
      head = `<div class="list-head"><h2>${esc(nn('boards', '社区'))}</h2></div>`;
      bodyHTML = `<div class="page" id="desk-boards">${boardsHTML()}</div>`;
    } else if (name === 'discover') {
      head = `<div class="list-head"><h2>${esc(nn('social', '社交'))}</h2><button class="icon-btn" data-go="search">${icon('search')}</button></div>`;
      bodyHTML = `<div class="page" id="desk-discover"><div class="spin" style="margin-top:60px"></div></div>`;
    } else {
      // 首页 / 版块 / 帖子详情下的中栏帖子列表
      if (state.listMode === 'board' && name !== 'post') {
        // 桌面端从版块进入：中栏展示该版块帖子，标题随版块联动，不再显示首页排序器
        head = `<div class="list-head">
          <h2>${esc(state.listTitle || '版块')}</h2>
          <button class="icon-btn" data-go="search">${icon('search')}</button>
        </div>`;
      } else if (name === 'post' && state.listMode === 'board') {
        head = `<div class="list-head"><h2>${esc(state.listTitle)}</h2></div>`;
      } else {
        head = `<div class="list-head">
          <h2>${esc(SORT_LABEL[state.homeSort || 'new'] || '最新')}</h2>
          <button class="icon-btn" data-go="search">${icon('search')}</button>
        </div>
        <div class="segment" id="desk-seg" style="padding:0 12px 10px;border-bottom:1px solid var(--line-2)">
          <button data-sort="new" class="${(state.homeSort || 'new') === 'new' ? 'active' : ''}">最新</button>
          <button data-sort="hot" class="${state.homeSort === 'hot' ? 'active' : ''}">热门</button>
          <button data-sort="essence" class="${state.homeSort === 'essence' ? 'active' : ''}">精华</button>
          <button data-sort="following" class="${state.homeSort === 'following' ? 'active' : ''}">关注</button>
        </div>`;
      }
      bodyHTML = `<div class="page" id="desk-feed"><div class="spin" style="margin-top:60px"></div></div>`;
    }

    pane.innerHTML = `${head}${bodyHTML}
      <div style="padding:10px 12px calc(10px + env(safe-area-inset-bottom));border-top:.5px solid var(--line-2)">
        <button class="btn primary block" data-compose style="height:40px">${icon('plus', 18)} 发帖</button>
      </div>`;

    bindCommon(pane);
    $$('[data-go]', pane).forEach((b) => (b.onclick = () => navigate(b.dataset.go)));
    $$('[data-compose]', pane).forEach((b) => (b.onclick = () => openEditor(state.listMode === 'board' ? state.listParams.slug : undefined)));
    $$('[data-readall]', pane).forEach((b) => (b.onclick = async () => {
      await api('/api/notifications/read', { method: 'POST', body: { all: true } });
      state.unread = 0; render();
    }));
    $$('[data-sort]', pane).forEach((b) => (b.onclick = () => { state.homeSort = b.dataset.sort; render(); }));

    if (name === 'notice') loadNotices($('#desk-notice'));
    if (name === 'mine') loadMyPosts($('#desk-mine'));
    if (name === 'favs') loadFavs($('#desk-favs'));
    if (name === 'boards') initBoards(pane);
    if (name === 'discover') loadDiscover($('#desk-discover'));
    if (name === 'search') initDeskSearch(pane);
    if (name === 'user') loadUserPage($('#desk-user'), params.id);
    if (name === 'me') loadMePage($('#desk-me'));
    if (name === 'home' || name === 'post' || name === 'boards') loadDeskFeed();
  }

  async function loadDeskFeed() {
    const box = $('#desk-feed');
    if (!box) return;
    try {
      let list;
      let board = null;
      if (state.listMode === 'board') {
        board = (state.config.boards || []).find((x) => x.slug === state.listParams.slug) || null;
        // 访问权限控制
        if (board && board.canAccess === false) {
          box.innerHTML = boardAccessDeniedHTML(board);
          bindBoardAccess(box, board);
          return;
        }
        list = await api('/api/posts?board=' + encodeURIComponent(state.listParams.slug) + '&limit=50');
      } else if (state.homeSort === 'hot') {
        list = await api('/api/hot');
      } else if (state.homeSort === 'following') {
        list = await api('/api/posts?feed=following&limit=40');
      } else {
        list = await api('/api/posts?sort=' + (state.homeSort || 'new') + '&limit=40');
      }
      const isImageBoard = !!(board && board.layout === 'image');
      const isGrid2 = !!(board && board.layout === 'grid2');
      const emptyText = board ? '这里还很安静，来发第一帖吧'
        : (state.homeSort === 'following' ? '关注的用户还没有发帖' : '这里还很安静，来发第一帖吧');
      const html = isImageBoard ? imageBoardHTML(list, emptyText)
        : (isGrid2 ? postGrid2HTML(list, emptyText) : postListHTML(list, emptyText));
      box.innerHTML = (board ? moderatorsBarHTML(board) : '') + html;
      if (isImageBoard) box.classList.add('is-image-board'); else box.classList.remove('is-image-board');
      bindPosts(box);
      const cur = state.route.name === 'post' ? Number(state.route.params.id) : 0;
      if (cur) $$('[data-post]', box).forEach((el) => el.classList.toggle('active', Number(el.dataset.post) === cur));
      const active = $('.post-item.active', box);
      if (active) active.style.background = 'var(--brand-weak)';
    } catch (e) { box.innerHTML = `<div class="empty">加载失败</div>`; }
  }

  function initDeskSearch(pane) {
    const input = $('#q-input', pane);
    const result = $('#desk-search-result', pane);
    let t = null;
    const run = async () => {
      const q = input.value.trim();
      if (!q) { result.innerHTML = ''; return; }
      result.innerHTML = `<div class="spin" style="margin:24px auto"></div>`;
      try {
        const [posts, users, boards] = await Promise.all([
          api('/api/search?q=' + encodeURIComponent(q)),
          api('/api/users/search?q=' + encodeURIComponent(q)),
          api('/api/boards/search?q=' + encodeURIComponent(q)),
        ]);
        result.innerHTML = `${boards.length ? `<div class="section-title" style="padding:14px 0 8px"><b>版块</b></div>` +
          boards.slice(0, 4).map(boardRowHTML).join('') : ''}
          ${users.length ? `<div class="section-title" style="padding:14px 0 8px"><b>用户</b></div>` +
          users.slice(0, 4).map((u) => `<button class="user-row" style="padding:10px 0" data-uid="${u.id}">${avatarHTML(u, 'sm')}<div class="grow"><div class="cell-title">${esc(u.nickname)}</div><div class="cell-sub">@${esc(u.username)}</div></div></button>`).join('') : ''}
          <div class="section-title" style="padding:14px 0 8px"><b>帖子</b><span>${posts.length}</span></div>
          ${postListHTML(posts, '没有找到相关帖子')}`;
        bindPosts(result);
        $$('[data-uid]', result).forEach((b) => (b.onclick = () => navigate('user', { id: b.dataset.uid })));
        $$('[data-board]', result).forEach((b) => (b.onclick = () => openBoard(b.dataset.board)));
      } catch (e) { result.innerHTML = `<div class="empty">搜索失败</div>`; }
    };
    input.oninput = () => { clearTimeout(t); t = setTimeout(run, 300); };
    setTimeout(() => input.focus(), 60);
  }

  function renderDeskMain(name, params) {
    const main = $('#pane-main');
    if (name === 'post') {
      main.innerHTML = `<div id="desk-post" style="width:100%;display:flex;flex-direction:column"></div>`;
      renderPostPage($('#desk-post'), params, true);
      return;
    }
    if (name === 'home') {
      const boards = state.config.boards || [];
      const appName = state.config.appName || '微坛';
      const appDesc = state.config.appDesc || '一个像微信一样好用的社区';
      const annHTML = announceBarHTML();
      main.innerHTML = `<div style="width:100%;overflow-y:auto" class="page">
        <div class="hero" style="padding:40px 34px 24px">
          <h1 style="font-size:27px">你好，${esc((state.me && state.me.nickname) || '朋友')} 👋</h1>
          <p>${esc(appDesc)}</p>
          <div class="searchbox" style="max-width:420px;margin-top:18px" data-search-trigger-desktop>${icon('search', 18)}<span>搜索帖子、用户</span></div>
        </div>
        ${annHTML}
        <div class="divider"></div>
        <div class="section-title" style="padding:20px 24px 12px"><b>热门头条</b></div>
        <div id="home-pix-desktop" style="padding:0 24px 24px"><div class="spin" style="margin:24px auto"></div></div>
        <div class="section-title" style="padding:4px 24px 10px"><b>社区数据</b></div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;padding:0 24px 30px">
          ${[['版块', boards.length, '📍'], ['帖子', boards.reduce((s, b) => s + b.postCount, 0), '📝'], ['在线', Math.max(1, Math.round((state.unread || 0) + 7)), '🟢']]
            .map(([k, v, e]) => `<div style="background:var(--panel-2);border-radius:10px;padding:16px">
              <div style="font-size:22px;font-weight:600">${num(v)}</div>
              <div class="tiny muted" style="margin-top:2px">${e} ${k}</div></div>`).join('')}
        </div>
      </div>`;
      $$('[data-board]', main).forEach((b) => (b.onclick = () => openBoard(b.dataset.board)));
      const st = $('[data-search-trigger-desktop]', main);
      if (st) st.onclick = () => navigate('search');
      startAnnouncements(main);
      const pix = $('#home-pix-desktop', main);
      if (pix) api('/api/hot-images?limit=12').then((list) => { pix.innerHTML = hotPixHTML(list); bindPosts(pix); }).catch(() => { pix.innerHTML = ''; });
      return;
    }
    // 其他情况：右侧显示欢迎/说明
    const info = {
      boards: ['版块', '点击左侧版块，浏览该版块的帖子；点击板块卡片进入列表。', 'boards'],
      discover: ['社交', '这里只展示「社区交友」版块的最新内容。', 'group'],
      notice: ['消息中心', '点赞、评论、关注都会在这里提醒你。', 'bell'],
      mine: ['我的帖子', '这里汇总了你发布过的所有帖子。', 'edit'],
      favs: ['我的收藏', '你收藏的好帖都在这里，方便随时回看。', 'bookmark'],
      search: ['搜索', '在左侧输入关键词，可以同时搜索帖子与用户。', 'search'],
      user: ['个人主页', '左侧展示了该用户的资料与帖子列表。', 'user'],
      me: ['我的主页', '你的等级、用户组、经验值与勋章都展示在左侧中栏。', 'user'],
    }[name] || ['微坛', '', 'home'];
    main.innerHTML = `<div style="width:100%;display:flex;flex-direction:column;height:100%">
      <div class="navbar" style="background:var(--panel)"><div class="nav-title">${esc(info[0])}</div></div>
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;color:var(--text-2);padding:30px;text-align:center">
        <div style="width:92px;height:92px;border-radius:24px;background:var(--brand-weak);display:grid;place-items:center;color:var(--brand)">${icon(info[2], 44)}</div>
        <div style="font-size:16px;color:var(--text);font-weight:500">${esc(info[0])}</div>
        <div style="font-size:13px;max-width:320px;line-height:1.7">${esc(info[1])}</div>
      </div>
    </div>`;
  }


  async function refreshMe() {
    try {
      const r = await api('/api/me');
      state.me = r.user;
    } catch (e) { /* ignore */ }
  }

  async function refreshConfig() {
    try { state.config = await api('/api/config', { silent: true }); } catch (e) { /* ignore */ }
  }

  /* ---------------- 管理后台入口 ---------------- */
  // 后台是独立页面，前台只负责带上 token 跳转（同一个站点，localStorage 共享）
  function gotoAdmin() {
    if (!state.me) { openLoginModal({ onSuccess: gotoAdmin }); return; }
    if (!state.me.isAdmin) { toast('需要管理员权限'); return; }
    location.href = '/admin';
  }

  /* ---------------- 滚动位置记忆（手机） ---------------- */
  function scrollRestore(root) {
    const key = 'wf_scroll_' + state.route.name;
    const page = $('.page', root);
    if (!page) return;
    const saved = Number(sessionStorage.getItem(key) || 0);
    if (saved) requestAnimationFrame(() => (page.scrollTop = saved));
    page.addEventListener('scroll', () => {
      sessionStorage.setItem(key, String(page.scrollTop));
    }, { passive: true });
  }

  /* ---------------- 引导 ---------------- */
  async function boot() {
    try {
      const cfg = await api('/api/config');
      state.config = cfg;
      // 同步站点信息到浏览器标题与启动屏
      const appName = (cfg && cfg.appName) || '微坛';
      const appDesc = (cfg && cfg.appDesc) || '像微信一样简单，和同好聊聊技术与生活';
      document.title = appName + ' · ' + appDesc;
      const metaDesc = document.querySelector('meta[name="description"]');
      if (metaDesc) metaDesc.setAttribute('content', appName + ' —— ' + appDesc);
      const bl = document.querySelector('.boot-logo');
      if (bl) bl.textContent = (cfg && cfg.logo) ? '' : appName.charAt(0);
    } catch (e) {}
    if (state.token) {
      try {
        const d = await api('/api/me', { silent: true });
        state.me = d.user;
        if (state.me) state.unread = state.me.unread || 0;
        else state.token = '';
      } catch (e) { state.token = ''; }
    }
    if (!location.hash) history.replaceState(null, '', '#/home');
    render();
  }

  // 浏览器前进/后退：popstate 负责渲染，补一次 history 同步
  window.addEventListener('popstate', () => {
    window.scrollTo(0, 0);
    render();
  });
  // 手动改 hash 的情况
  window.addEventListener('hashchange', () => {
    window.scrollTo(0, 0);
    render();
  });
  let rt = null;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      const wasDesktop = $('#desk') !== null;
      if (wasDesktop !== isDesktop()) render();
    }, 120);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeOverlays();
  });

  boot();
})();
