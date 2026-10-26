/* ============================================================
   微坛 WeForum · 管理后台（独立页面 /admin，零依赖）
   - 真实路径路由：/admin/overview、/admin/posts …
   - 后台内直接登录，不必回前台
   - 三端适配：宽屏左侧深色导航，窄屏收成顶部横向导航
   公共工具与请求封装来自 /js/core.js（window.WFCore）
   ============================================================ */
(() => {
  'use strict';

  const {
    $, $$, esc, num,
    toast, closeOverlays, openSheet, confirmDialog, viewer,
    icon, avatarHTML, fileToDataURL,
  } = window.WFCore;

  /* ---------------- 全局状态 ---------------- */
  const S = {
    me: null,
    tab: 'overview',
    boards: [],
    posts: { items: [], total: 0, page: 1, pages: 1, q: '', board: '', status: '', sort: 'latest', sel: new Set() },
    comments: { items: [], total: 0, page: 1, pages: 1, q: '', sel: new Set() },
    users: { items: [], total: 0, page: 1, pages: 1, q: '' },
    groups: null,
    badges: null,
    reports: [],
    loading: true,     // 首次鉴权中
    loginMode: 'login',
    authError: '',
  };

  const TABS = [
    // key, 名称, 图标, 所属分组
    ['overview', '概览', 'dashboard', '内容'],
    ['site', '站点设置', 'settings', '内容'],
    ['boards', '版块', 'boards', '内容'],
    ['posts', '帖子', 'article', '内容'],
    ['comments', '评论', 'comment', '内容'],
    ['ops', '运营管理', 'chart', '运营'],
    ['board-apps', '版块申请', 'shield', '运营'],
    ['email', '邮件群发', 'send', '运营'],
    ['users', '用户', 'users', '用户与运营'],
    ['groups', '用户组', 'group', '用户与运营'],
    ['badges', '勋章', 'medal', '用户与运营'],
    ['reports', '举报', 'flag', '用户与运营'],
  ];
  const TAB_MAP = Object.fromEntries(TABS.map((t) => [t[0], t]));
  // 侧栏导航按分组渲染（导航始终竖向排布，不横排）
  const NAV_SECTIONS = [...new Set(TABS.map((t) => t[3]))]
    .map((sec) => ({ sec, items: TABS.filter((t) => t[3] === sec) }));

  /* ---------------- 登录态（与前台共用 localStorage） ---------------- */
  // 演示账号说明默认文案（未在后台设置过时用于预填）
  const DEMO_DEFAULT = '演示账号：admin / admin123（管理员）\nlinda / 123456 · kevin / 123456 · mia / 123456';
  const TOKEN_KEY = 'wf_token';
  const getToken = () => localStorage.getItem(TOKEN_KEY) || '';
  const setToken = (t) => {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  };

  const api = WFCore.createApi({
    getToken,
    setToken,
    onAuthExpired: () => {
      S.me = null;
      toast('登录已过期，请重新登录');
      renderLogin('登录已过期，请重新登录');
    },
    onNeedLogin: () => renderLogin(),
  });

  /* ---------------- 路由 ---------------- */
  // /admin、/admin/ → overview；其余取第一段作 tab
  function currentTab() {
    const seg = location.pathname.replace(/^\/admin\/?/, '').split('/').filter(Boolean);
    const t = seg[0] || 'overview';
    return TAB_MAP[t] ? t : 'overview';
  }

  function goTab(tab, replace) {
    if (!TAB_MAP[tab]) tab = 'overview';
    const url = '/admin/' + tab;
    if (location.pathname === url) {
      S.tab = tab;
      renderTab();
      return;
    }
    if (replace) history.replaceState({ tab }, '', url);
    else history.pushState({ tab }, '', url);
    S.tab = tab;
    renderTab();
  }

  /* ---------------- 后台外壳 ---------------- */
  function shellHTML() {
    const u = S.me;
    return `
    <div class="adm">
      <aside class="adm-side" id="adm-side">
        <div class="adm-brand">
          <div class="adm-logo">坛</div>
          <div class="adm-brand-txt"><div class="adm-bn">微坛管理后台</div><div class="adm-bs">WeForum Admin</div></div>
        </div>
        <nav class="adm-nav" id="adm-nav">
          ${NAV_SECTIONS.map(({ sec, items }) => `
            <div class="adm-nav-label">${sec}</div>
            ${items.map(([k, label, ic]) => `<a class="adm-nav-item" href="/admin/${k}" data-atab="${k}">${icon(ic, 18)}<span>${label}</span></a>`).join('')}`).join('')}
        </nav>
        <div class="adm-side-foot">
          <a class="adm-nav-item" href="/">${icon('external', 18)}<span>返回社区</span></a>
          <div class="adm-side-copy">© 2026 Powered by <a href="https://520816.xyz" target="_blank" rel="noopener">CARSON</a></div>
        </div>
      </aside>
      <div class="adm-side-mask" id="adm-side-mask" hidden></div>
      <main class="adm-main">
        <header class="adm-top">
          <div class="adm-top-l">
            <button class="adm-menu-btn" id="adm-menu-btn" title="导航菜单" aria-label="导航菜单" aria-expanded="false">${icon('menu', 20)}</button>
            <div class="adm-crumb"><i>/</i><b id="adm-crumb">概览</b></div>
          </div>
          <div class="adm-top-r">
            <button class="icon-btn adm-refresh" data-refresh title="刷新数据">${icon('refresh', 18)}</button>
            <div class="adm-user" id="adm-user">
              ${avatarHTML(u, 'xs')}
              <span class="ellipsis adm-uname">${esc(u.nickname || '')}</span>
              <span class="adm-role">管理员</span>
              <button class="icon-btn" data-logout title="退出登录">${icon('logout', 17)}</button>
            </div>
          </div>
        </header>
        <div class="adm-body" id="adm-body"></div>
      </main>
    </div>`;
  }

  // 宽屏常驻侧栏；窄屏（<900px）收成抽屉，点按钮滑出
  function toggleSide(open) {
    const side = $('#adm-side');
    const mask = $('#adm-side-mask');
    const btn = $('#adm-menu-btn');
    if (!side) return;
    const willOpen = open === undefined ? !side.classList.contains('open') : open;
    side.classList.toggle('open', willOpen);
    if (mask) mask.hidden = !willOpen;
    if (btn) btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  }

  function mountShell() {
    $('#app').innerHTML = shellHTML();
    const menuBtn = $('#adm-menu-btn');
    if (menuBtn) menuBtn.onclick = () => toggleSide();
    const mask = $('#adm-side-mask');
    if (mask) mask.onclick = () => toggleSide(false);
    $$('[data-atab]').forEach((a) => {
      a.onclick = (e) => { e.preventDefault(); toggleSide(false); goTab(a.dataset.atab); };
    });
    // Esc 关闭抽屉：只绑一次，避免重新挂载时重复
    if (!mountShell._escBound) {
      mountShell._escBound = true;
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleSide(false); });
    }
    $('[data-logout]').onclick = async () => {
      if (!(await confirmDialog({ title: '退出登录？', text: '退出后需要重新输入账号密码', okText: '退出', danger: true }))) return;
      await api('/api/logout', { method: 'POST', body: {} }).catch(() => {});
      setToken('');
      S.me = null;
      renderLogin();
    };
    $('[data-refresh]').onclick = () => {
      const b = $('[data-refresh]');
      b.classList.add('spin-once');
      setTimeout(() => b.classList.remove('spin-once'), 600);
      renderTab(true);
    };
    syncNav();
  }

  function syncNav() {
    $$('#adm-nav [data-atab]').forEach((a) => a.classList.toggle('active', a.dataset.atab === S.tab));
    const crumb = $('#adm-crumb');
    if (crumb) crumb.textContent = (TAB_MAP[S.tab] || TAB_MAP.overview)[1];
  }

  /* ---------------- 渲染入口 ---------------- */
  function render() {
    if (S.loading) {
      $('#app').innerHTML = `<div class="adm-boot"><div class="boot-logo">坛</div><div class="boot-tip">正在校验管理员身份…</div></div>`;
      return;
    }
    if (!S.me) { renderLogin(); return; }
    if (!S.me.isAdmin) { renderForbidden(); return; }
    // 裸 /admin 与 /admin/ 统一成 /admin/overview，刷新后地址栏能看出当前模块
    if (!/^\/admin\/[a-z]+/.test(location.pathname)) {
      history.replaceState({ tab: currentTab() }, '', '/admin/' + currentTab());
    }
    S.tab = currentTab();
    mountShell();
    renderTab();
  }

  function renderTab(force) {
    if (!S.me || !S.me.isAdmin) return;
    S.tab = currentTab();
    syncNav();
    document.title = (TAB_MAP[S.tab] || TAB_MAP.overview)[1] + ' · 微坛管理后台';
    const body = $('#adm-body');
    if (!body) { mountShell(); return; }
    body.scrollTop = 0;
    if (S.tab === 'overview') admOverview(body);
    else if (S.tab === 'site') admSite(body);
    else if (S.tab === 'boards') admBoards(body);
    else if (S.tab === 'posts') admPosts(body);
    else if (S.tab === 'comments') admComments(body);
    else if (S.tab === 'ops') admOps(body);
    else if (S.tab === 'board-apps') admBoardApps(body);
    else if (S.tab === 'email') admEmail(body);
    else if (S.tab === 'users') admUsers(body);
    else if (S.tab === 'groups') admGroups(body);
    else if (S.tab === 'badges') admBadges(body);
    else if (S.tab === 'reports') admReports(body);
    else admOverview(body);
  }

  /* ---------------- 错误处理 ---------------- */
  function admReq(path, opt) {
    return api(path, opt).catch((e) => {
      if (e && e.status === 403) {
        toast('需要管理员权限');
        renderForbidden();
      }
      throw e;
    });
  }

  /* ---------------- 登录页 ---------------- */
  function renderLogin(msg) {
    document.title = '登录 · 微坛管理后台';
    const demo = '';
    $('#app').innerHTML = `
      <div class="adm-login">
        <div class="adm-login-card">
          <div class="adm-login-brand">
            <div class="adm-logo lg">坛</div>
            <div>
              <h1>微坛管理后台</h1>
              <p>WeForum Admin Console</p>
            </div>
          </div>
          <form id="login-form" autocomplete="on">
            <div class="adm-login-field">
              <label for="lg-user">账号</label>
              <input class="field" id="lg-user" name="username" autocomplete="username" placeholder="请输入管理员账号" />
            </div>
            <div class="adm-login-field">
              <label for="lg-pass">密码</label>
              <input class="field" id="lg-pass" name="password" type="password" autocomplete="current-password" placeholder="请输入密码" />
            </div>
            <div class="adm-login-err ${msg ? 'show' : ''}" id="lg-err">${esc(msg || S.authError || '')}</div>
            <button class="btn primary block" id="lg-submit" type="submit">登录后台</button>
          </form>
          ${demo}
          <div class="adm-login-foot"><a href="/">← 返回社区首页</a></div>
        </div>
      </div>`;

    const form = $('#login-form');
    const errBox = $('#lg-err');
    const btn = $('#lg-submit');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const username = $('#lg-user').value.trim();
      const password = $('#lg-pass').value;
      if (!username || !password) { errBox.textContent = '请填写账号和密码'; errBox.classList.add('show'); return; }
      btn.disabled = true; btn.textContent = '登录中…';
      errBox.classList.remove('show');
      try {
        const r = await api('/api/login', { method: 'POST', body: { username, password }, silent: true });
        setToken(r.token);
        S.me = r.user;
        if (!S.me || !S.me.isAdmin) {
          setToken('');
          S.me = null;
          errBox.textContent = '该账号不是管理员，无法进入后台';
          errBox.classList.add('show');
          return;
        }
        toast('欢迎回来，' + (S.me.nickname || '管理员'));
        S.tab = currentTab();
        render();
      } catch (err) {
        errBox.textContent = (err && err.message) || '登录失败';
        errBox.classList.add('show');
      } finally {
        btn.disabled = false; btn.textContent = '登录后台';
      }
    };
  }

  function renderForbidden() {
    document.title = '无权访问 · 微坛管理后台';
    const name = S.me ? (S.me.nickname || S.me.username || '') : '';
    $('#app').innerHTML = `
      <div class="adm-login">
        <div class="adm-login-card adm-forbid">
          <div class="adm-login-brand">
            <div class="adm-logo lg" style="background:var(--text-3)">${icon('lock', 26)}</div>
            <div><h1>无权访问</h1><p>当前账号没有管理员权限</p></div>
          </div>
          <p class="adm-forbid-tip">${name ? '你正以「' + esc(name) + '」的身份登录。' : ''}如需管理社区内容，请使用管理员账号登录。</p>
          <button class="btn primary block" id="fb-relogin">换一个账号登录</button>
          <div class="adm-login-foot"><a href="/">← 返回社区首页</a></div>
        </div>
      </div>`;
    $('#fb-relogin').onclick = async () => {
      await api('/api/logout', { method: 'POST', body: {} }).catch(() => {});
      setToken(''); S.me = null; renderLogin();
    };
  }

  /* ---------------- 概览 ---------------- */
  async function admOverview(box) {
    let s;
    try { s = await admReq('/api/admin/overview'); } catch (e) {
      if (!box.isConnected) return;
      box.innerHTML = `<div class="empty">加载失败</div>`; return;
    }
    const cards = [
      ['用户总数', s.users, s.newUsers7d + ' 位近 7 天新增', 'var(--link)', 'users'],
      ['帖子总数', s.posts, s.newPosts1d + ' 篇今日新增', 'var(--brand)', 'posts'],
      ['评论总数', s.comments, s.newComments1d + ' 条今日新增', 'var(--orange)', 'comments'],
      ['版块数', s.boards, '可自由增删改', '#8B7BD8', 'boards'],
    ];
    const max = Math.max(1, ...s.trend.map((t) => Math.max(t.posts, t.comments)));
    box.innerHTML = `
      <div class="adm-cards">${cards.map(([k, v, sub, c, tab]) => `
        <a class="adm-card" href="/admin/${tab}" data-goto="${tab}">
          <div class="adm-card-k">${k}</div>
          <div class="adm-card-v" style="color:${c}">${num(v)}</div>
          <div class="adm-card-s">${sub}</div>
        </a>`).join('')}
      </div>
      <div class="adm-panel">
        <div class="adm-panel-h"><b>近 14 天活跃趋势</b>
          <div class="adm-legend"><span><i style="background:var(--brand)"></i>帖子</span><span><i style="background:var(--link)"></i>评论</span></div>
        </div>
        <div class="adm-chart">
          ${s.trend.map((t) => `<div class="adm-bar-wrap" title="${t.date} 帖子 ${t.posts} / 评论 ${t.comments}">
            <div class="adm-bar-col">
              <div class="adm-bar" style="height:${Math.max(2, Math.round((t.posts / max) * 100))}%;background:var(--brand)"></div>
              <div class="adm-bar" style="height:${Math.max(2, Math.round((t.comments / max) * 100))}%;background:var(--link)"></div>
            </div>
            <div class="adm-bar-x">${t.date}</div>
          </div>`).join('')}
        </div>
      </div>
      <div class="adm-panel">
        <div class="adm-panel-h"><b>待处理</b><span class="adm-hint">点击右侧按钮直达对应模块</span></div>
        <div class="adm-rows">
          <div class="adm-row"><span>举报记录</span><b class="adm-num danger">${s.pendingReports}</b><a class="btn sm ghost" href="/admin/reports" data-goto="reports">查看</a></div>
          <div class="adm-row"><span>已封禁用户</span><b class="adm-num">${s.banned}</b><a class="btn sm ghost" href="/admin/users" data-goto="users">管理</a></div>
          <div class="adm-row"><span>已隐藏帖子</span><b class="adm-num">${s.deletedPosts}</b><a class="btn sm ghost" href="/admin/posts" data-goto="posts">管理</a></div>
        </div>
      </div>
      <div class="adm-panel">
        <div class="adm-panel-h"><b>用户体系</b><span class="adm-hint">用户组、勋章与已授予数量</span></div>
        <div class="adm-sysgrid">
          <a class="adm-sys" href="/admin/groups" data-goto="groups">
            <div class="adm-sys-k">用户组</div>
            <div class="adm-sys-v">${num(s.groups)}</div>
            <div class="adm-sys-s">按经验值自动升级</div>
          </a>
          <a class="adm-sys" href="/admin/badges" data-goto="badges">
            <div class="adm-sys-k">勋章</div>
            <div class="adm-sys-v">${num(s.badges)}</div>
            <div class="adm-sys-s">可在用户中授予</div>
          </a>
          <a class="adm-sys" href="/admin/users" data-goto="users">
            <div class="adm-sys-k">已授予勋章</div>
            <div class="adm-sys-v">${num(s.grantedBadges)}</div>
            <div class="adm-sys-s">枚勋章已发放</div>
          </a>
        </div>
      </div>
      <div class="adm-panel">
        <div class="adm-panel-h"><b>数据导出</b><span class="adm-hint">导出为 CSV 文件，可直接用 Excel 打开</span></div>
        <div class="adm-rows">
          <div class="adm-row"><span>用户数据（账号、积分、VIP 到期）</span><button class="btn sm ghost" data-export="users">导出 CSV</button></div>
          <div class="adm-row"><span>帖子数据（版块、作者、浏览/点赞/评论）</span><button class="btn sm ghost" data-export="posts">导出 CSV</button></div>
          <div class="adm-row"><span>评论数据（所属帖子、评论者、内容）</span><button class="btn sm ghost" data-export="comments">导出 CSV</button></div>
        </div>
      </div>`;
    $$('[data-goto]', box).forEach((el) => (el.onclick = (e) => { e.preventDefault(); goTab(el.dataset.goto); }));
    $$('[data-export]', box).forEach((b) => (b.onclick = async () => {
      const typ = b.dataset.export;
      const old = b.textContent;
      b.disabled = true; b.textContent = '导出中…';
      try {
        const d = await admReq('/api/admin/export?type=' + typ);
        const blob = new Blob([d.csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = d.filename || (typ + '.csv');
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        toast(`已导出 ${num(d.count)} 条数据`);
      } catch (e) { /* 错误已由 admReq 统一提示 */ }
      b.disabled = false; b.textContent = old;
    }));
  }

  /* ---------------- 站点设置 ---------------- */
  // 快捷回复短语默认值（与后端 DEFAULT_QUICK_REPLIES 保持一致）
  const DEFAULT_QUICK = ['感谢分享', '很有帮助，谢谢', '学到了，支持一下', '占楼，稍后细看'];

  function clampInt(v, min, max, dft) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return dft;
    return Math.max(min, Math.min(max, n));
  }

  function quickRepliesText(raw) {
    if (!raw) return DEFAULT_QUICK.join('\n');
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) return arr.map((x) => String(x)).join('\n');
    } catch (e) { /* 非 JSON，按纯文本处理 */ }
    return String(raw);
  }

  async function admSite(box) {
    let s;
    try { s = await admReq('/api/admin/site'); } catch (e) {
      if (!box.isConnected) return;
      box.innerHTML = `<div class="empty">加载失败</div>`; return;
    }
    const cur = s || {};
    box.innerHTML = `
      <div class="adm-panel">
        <div class="adm-panel-h"><b>站点信息</b><span class="adm-hint">修改后前台首页标题、描述、关于页会同步更新</span></div>
        <div class="adm-form">
          <div style="display:flex;align-items:center;gap:14px;margin-bottom:6px">
            <div id="s-logo" style="width:56px;height:56px;border-radius:14px;background:var(--brand);color:#fff;display:grid;place-items:center;font-size:24px;font-weight:600;overflow:hidden">${cur.site_logo ? `<img src="${esc(cur.site_logo)}" style="width:100%;height:100%;object-fit:cover" />` : '坛'}</div>
            <div>
              <button class="btn sm ghost" id="s-logo-up">更换 Logo</button>
              <div class="tiny muted" style="margin-top:6px">建议正方形，自动压缩</div>
            </div>
          </div>
          <label>站点名称<input class="field" id="s-name" maxlength="30" value="${esc(cur.site_name || '')}" placeholder="微坛" /></label>
          <label>站点描述<input class="field" id="s-desc" maxlength="120" value="${esc(cur.site_desc || '')}" placeholder="一个像微信一样好用的技术社区" /></label>
          <label>首页公告（可选，单条旧版；多条公告请到「运营管理」配置）<textarea class="field" id="s-ann" maxlength="300" style="min-height:70px" placeholder="展示在首页顶部，支持换行">${esc(cur.site_announcement || '')}</textarea></label>
          <div class="adm-form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
            <label>公告滚动间隔（秒）<input class="field" id="s-ann-interval" type="number" min="1" max="60" value="${esc(cur.site_announce_interval || '5')}" placeholder="5" /><span class="tiny muted">首页公告自动切换的间隔秒数</span></label>
            <label>板块每行数量<input class="field" id="s-board-cols" type="number" min="1" max="6" value="${esc(cur.site_board_cols || '1')}" placeholder="1" /><span class="tiny muted">电脑端最多 6，手机端最多 2</span></label>
          </div>
          <div class="adm-form-row">
            <div class="tiny muted" style="margin-bottom:6px">导航名称（留空使用默认值：首页 / 社交 / 社区 / 消息 / 我）</div>
            <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px">
              <label class="tiny">首页<input class="field" id="s-nav-home" maxlength="6" value="${esc(cur.site_nav_home || '')}" placeholder="首页" /></label>
              <label class="tiny">社交<input class="field" id="s-nav-social" maxlength="6" value="${esc(cur.site_nav_social || '')}" placeholder="社交" /></label>
              <label class="tiny">板块<input class="field" id="s-nav-boards" maxlength="6" value="${esc(cur.site_nav_boards || '')}" placeholder="社区" /></label>
              <label class="tiny">消息<input class="field" id="s-nav-notice" maxlength="6" value="${esc(cur.site_nav_notice || '')}" placeholder="消息" /></label>
              <label class="tiny">我<input class="field" id="s-nav-me" maxlength="6" value="${esc(cur.site_nav_me || '')}" placeholder="我" /></label>
            </div>
          </div>
          <label>搜索热词（用英文逗号分隔，可选）<input class="field" id="s-kw" value="${esc(cur.site_keywords || '')}" placeholder="SQLite,移动端适配,副业" /></label>
          <label>登录弹窗演示账号说明（可选，支持换行；留空则不显示）<textarea class="field" id="s-demo" maxlength="300" style="min-height:62px" placeholder="演示账号：admin / admin123（管理员）">${esc(cur.site_demo_accounts === undefined ? DEMO_DEFAULT : (cur.site_demo_accounts || ''))}</textarea></label>
          <label>关于本站（支持 Markdown）<textarea class="field" id="s-about" maxlength="2000" style="min-height:180px;line-height:1.7" placeholder="介绍社区的定位、规则、联系方式等">${esc(cur.site_about || '')}</textarea></label>
          <button class="btn primary block" id="s-save" style="margin-top:8px">保存设置</button>
          <input type="file" id="s-logo-file" accept="image/*" hidden />
        </div>
      </div>
      <div class="adm-panel">
        <div class="adm-panel-h"><b>积分设置</b><span class="adm-hint">控制前台发帖 / 评论 / 签到获得的积分，0 表示不奖励；积分名称会同步显示在前台各处</span></div>
        <div class="adm-form">
          <label>积分名称<input class="field" id="p-name" maxlength="10" value="${esc(cur.points_name || '积分')}" placeholder="例如：金币、能量、元宝" /><span class="tiny muted">前台所有「积分」字样将替换为此名称，最多 10 字</span></label>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
            <label>发帖获得积分<input class="field" id="p-post" type="number" min="0" max="1000" value="${esc(cur.points_post ?? 5)}" /><span class="tiny muted">每次发帖奖励</span></label>
            <label>评论获得积分<input class="field" id="p-comment" type="number" min="0" max="1000" value="${esc(cur.points_comment ?? 2)}" /><span class="tiny muted">每次评论奖励</span></label>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
            <label>签到基础积分<input class="field" id="p-checkin" type="number" min="0" max="1000" value="${esc(cur.points_checkin ?? 5)}" /><span class="tiny muted">每日签到基础奖励</span></label>
            <label>连续签到加成上限<input class="field" id="p-checkin-bonus" type="number" min="0" max="1000" value="${esc(cur.points_checkin_bonus_max ?? 5)}" /><span class="tiny muted">连续签到每天递增 1 分，最多加到这里</span></label>
          </div>
        </div>
      </div>
      <div class="adm-panel">
        <div class="adm-panel-h"><b>快捷回复短语</b><span class="adm-hint">帖子详情底部可一键填入，每行一条，最多 20 条</span></div>
        <div class="adm-form">
          <label>短语列表<textarea class="field" id="s-quick" style="min-height:110px;line-height:1.7" placeholder="感谢分享&#10;很有帮助，谢谢">${esc(quickRepliesText(cur.quick_replies))}</textarea></label>
        </div>
      </div>
      <div class="adm-panel">
        <div class="adm-panel-h"><b>邮件设置（SMTP）</b><span class="adm-hint">用于注册邮箱验证码与欢迎邮件；未配置服务器时自动进入演示模式（验证码直接显示在注册页）</span></div>
        <div class="adm-form">
          <label>邮箱验证码
            <select class="field" id="s-email-verify">
              <option value="1"${(cur.site_email_verify || '1') !== '0' ? ' selected' : ''}>开启（注册需验证邮箱）</option>
              <option value="0"${(cur.site_email_verify || '1') === '0' ? ' selected' : ''}>关闭（仅发送欢迎邮件）</option>
            </select>
          </label>
          <div style="display:grid;grid-template-columns:2fr 1fr;gap:14px">
            <label>SMTP 服务器<input class="field" id="s-smtp-host" value="${esc(cur.smtp_host || '')}" placeholder="smtp.qq.com" /></label>
            <label>端口<input class="field" id="s-smtp-port" type="number" min="1" max="65535" value="${esc(cur.smtp_port || '465')}" placeholder="465" /></label>
          </div>
          <label>加密方式
            <select class="field" id="s-smtp-ssl">
              <option value="1"${(cur.smtp_ssl || '1') !== '0' ? ' selected' : ''}>SSL（常见端口 465）</option>
              <option value="0"${(cur.smtp_ssl || '1') === '0' ? ' selected' : ''}>STARTTLS（常见端口 587）</option>
            </select>
          </label>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
            <label>SMTP 账号<input class="field" id="s-smtp-user" value="${esc(cur.smtp_user || '')}" placeholder="noreply@yourdomain.com" autocomplete="off" /></label>
            <label>SMTP 密码 / 授权码<input class="field" id="s-smtp-pass" type="password" value="${esc(cur.smtp_pass || '')}" placeholder="留空则不修改" autocomplete="new-password" /></label>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
            <label>发件人地址<input class="field" id="s-smtp-from" value="${esc(cur.smtp_from || '')}" placeholder="留空则用 SMTP 账号" /></label>
            <label>发件人名称<input class="field" id="s-smtp-name" value="${esc(cur.smtp_name || '')}" placeholder="留空则用站点名称" /></label>
          </div>
          <div class="tiny muted" style="line-height:1.7">QQ 邮箱 / 163 邮箱需先在邮箱设置里开启 SMTP 并获取「授权码」作为密码。配置保存后即可真实发信。</div>
        </div>
      </div>
      <div class="adm-panel">
        <div class="adm-panel-h"><b>上传存储</b><span class="adm-hint">上传图片 / 附件可以直接推送到网盘：WebDAV（坚果云/InfiniCloud/Yandex/Nextcloud 等）或百度网盘原生 API。光鸭网盘可通过 WebDAV 桥接工具接入。外部上传失败时自动回退本地存储，不丢文件</span></div>
        <div class="adm-form">
          <label>存储模式
            <select class="field" id="s-storage-mode">
              <option value="local"${(cur.storage_mode || 'local') === 'local' ? ' selected' : ''}>本地文件（data/uploads 目录）</option>
              <option value="webdav"${(cur.storage_mode || 'local') === 'webdav' ? ' selected' : ''}>WebDAV 网盘（坚果云 / InfiniCloud / Yandex / 自建等）</option>
              <option value="baidu"${(cur.storage_mode || 'local') === 'baidu' ? ' selected' : ''}>百度网盘（开放平台原生 API）</option>
            </select>
          </label>
          <div class="tiny muted" style="margin-bottom:10px">启用外部存储后，<b>新上传</b>的图片将直接推送到网盘并返回网盘直链；旧帖子的历史图片地址不变。外部存储一旦不可用，会自动回退本地存储。</div>
          <div id="webdav-fields" style="display:${(cur.storage_mode || 'local') === 'webdav' ? 'block' : 'none'}">
            <label>WebDAV 服务器地址<input class="field" id="s-webdav-url" value="${esc(cur.webdav_url || '')}" placeholder="https://dav.jianguoyun.com/dav/" /><span class="tiny muted">坚果云：https://dav.jianguoyun.com/dav/ &nbsp; InfiniCloud：https://dav.infini.cloud/&nbsp; Yandex：https://webdav.yandex.ru&nbsp; Nextcloud：https://你的域名/remote.php/dav/files/</span></label>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
              <label>用户名<input class="field" id="s-webdav-user" value="${esc(cur.webdav_user || '')}" placeholder="邮箱或账号" autocomplete="off" /></label>
              <label>密码 / 授权码<input class="field" id="s-webdav-pass" type="password" value="" placeholder="留空则不修改已保存的密码" autocomplete="new-password" /></label>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
              <label>存储子目录（可选）<input class="field" id="s-webdav-path" value="${esc(cur.webdav_path || '')}" placeholder="weforum/uploads" /><span class="tiny muted">自动创建；留空则存在网盘根目录</span></label>
              <label>公开地址前缀（可选）<input class="field" id="s-webdav-public" value="${esc(cur.webdav_public_url || '')}" placeholder="https://pan.example.com/dav/share" /><span class="tiny muted">不填则用服务器地址作为公开链接。如果网盘走反向代理或 CDN，这里填对外地址</span></label>
            </div>
            <div style="display:flex;align-items:center;gap:10px;margin-top:8px">
              <button class="btn sm ghost" id="s-webdav-test" type="button">测试连接</button>
              <span id="s-webdav-test-msg" class="tiny muted"></span>
            </div>
          </div>
          <div id="baidu-fields" style="display:${(cur.storage_mode || 'local') === 'baidu' ? 'block' : 'none'}">
            <div class="tiny muted" style="line-height:1.8;margin-bottom:8px">
              <b>如何获取百度网盘 access_token：</b><br/>
              1. 访问 <a href="https://pan.baidu.com/union/home" target="_blank" rel="noopener">百度网盘开放平台</a> 注册开发者账号并实名认证<br/>
              2. 创建应用（建议类型选「移动应用」或「网页应用」），获取 <b>AppKey</b><br/>
              3. 打开这个授权链接（把 APPKEY 替换成你的 AppKey）：<br/>
              &nbsp;&nbsp;&nbsp;<code style="font-size:12px">http://openapi.baidu.com/oauth/2.0/authorize?response_type=token&amp;client_id=APPKEY&amp;redirect_uri=oob&amp;scope=basic,netdisk</code><br/>
              4. 用百度账号登录并同意授权后，浏览器会跳到「登录成功」页面，地址栏 <b>#access_token=xxxxxxx</b> 后面那串就是 token<br/>
              5. 复制到下方「access_token」字段即可。Token 有效期 30 天，过期后重新授权一次
            </div>
            <label>百度网盘 access_token<input class="field" id="s-baidu-token" value="" placeholder="粘贴 OAuth 授权后获得的 access_token" autocomplete="off" /><span class="tiny muted">当前已保存状态：${(cur.baidu_token || '').startsWith('***') ? '已配置' : (cur.baidu_token ? '已配置' : '未配置')}</span></label>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
              <label>存储目录<input class="field" id="s-baidu-dir" value="${esc(cur.baidu_dir || 'weforum/uploads')}" placeholder="weforum/uploads" /><span class="tiny muted">自动创建；实际路径 = /apps/应用名/你填的目录</span></label>
              <label>公开地址前缀（推荐填写）<input class="field" id="s-baidu-public" value="${esc(cur.baidu_public_url || '')}" placeholder="https://你的CDN或Cloudreve/path" /><span class="tiny muted">百度网盘直链需额外签名，推荐在服务器侧用 Cloudreve / dav2pan / Alist 等代理出一个可公开访问的 URL 前缀</span></label>
            </div>
            <div style="display:flex;align-items:center;gap:10px;margin-top:8px">
              <button class="btn sm ghost" id="s-baidu-test" type="button">测试 access_token</button>
              <span id="s-baidu-test-msg" class="tiny muted"></span>
            </div>
          </div>
        </div>
      </div>`;
    let logoData = cur.site_logo || '';
    $('#s-logo-up', box).onclick = () => $('#s-logo-file', box).click();
    $('#s-logo-file', box).onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      logoData = await fileToDataURL(f, 256);
      $('#s-logo', box).innerHTML = `<img src="${esc(logoData)}" style="width:100%;height:100%;object-fit:cover" />`;
    };
    // 存储模式切换：local/webdav/baidu 显隐对应字段
    const webdavFields = $('#webdav-fields', box);
    const baiduFields = $('#baidu-fields', box);
    $('#s-storage-mode', box).onchange = () => {
      const v = $('#s-storage-mode', box).value;
      webdavFields.style.display = v === 'webdav' ? 'block' : 'none';
      baiduFields.style.display = v === 'baidu' ? 'block' : 'none';
      $('#s-webdav-test-msg', box).textContent = '';
      $('#s-baidu-test-msg', box).textContent = '';
    };
    // 测试 WebDAV 连接
    $('#s-webdav-test', box).onclick = async () => {
      const btn = $('#s-webdav-test', box);
      const msg = $('#s-webdav-test-msg', box);
      btn.disabled = true; btn.textContent = '测试中…'; msg.textContent = '';
      try {
        const r = await admReq('/api/admin/storage/test', {
          method: 'POST',
          body: { kind: 'webdav',
            url: $('#s-webdav-url', box).value.trim(),
            user: $('#s-webdav-user', box).value.trim(),
            pass: $('#s-webdav-pass', box).value || cur.webdav_pass || '',
            path: $('#s-webdav-path', box).value.trim(),
            public_url: $('#s-webdav-public', box).value.trim(),
          },
        });
        msg.textContent = r?.ok ? `✅ ${r.msg}` : `❌ ${r.msg}`;
        msg.style.color = r?.ok ? 'var(--brand)' : '#E6655C';
      } catch (e) {
        msg.textContent = `❌ ${e.message || '测试失败'}`;
        msg.style.color = '#E6655C';
      } finally { btn.disabled = false; btn.textContent = '测试连接'; }
    };
    // 测试百度网盘 access_token
    $('#s-baidu-test', box).onclick = async () => {
      const btn = $('#s-baidu-test', box);
      const msg = $('#s-baidu-test-msg', box);
      btn.disabled = true; btn.textContent = '测试中…'; msg.textContent = '';
      try {
        const r = await admReq('/api/admin/storage/test', {
          method: 'POST',
          body: { kind: 'baidu',
            token: $('#s-baidu-token', box).value || cur.baidu_token || '',
          },
        });
        msg.textContent = r?.ok ? `✅ ${r.msg}` : `❌ ${r.msg}`;
        msg.style.color = r?.ok ? 'var(--brand)' : '#E6655C';
      } catch (e) {
        msg.textContent = `❌ ${e.message || '测试失败'}`;
        msg.style.color = '#E6655C';
      } finally { btn.disabled = false; btn.textContent = '测试 access_token'; }
    };
    $('#s-save', box).onclick = async () => {
      const payload = {
        site_name: $('#s-name', box).value.trim(),
        site_desc: $('#s-desc', box).value.trim(),
        site_announcement: $('#s-ann', box).value,
        site_announce_interval: String(Math.max(1, Math.min(60, Number($('#s-ann-interval', box).value) || 5))),
        site_board_cols: String(Math.max(1, Math.min(6, Number($('#s-board-cols', box).value) || 1))),
        site_nav_home: $('#s-nav-home', box).value.trim(),
        site_nav_social: $('#s-nav-social', box).value.trim(),
        site_nav_boards: $('#s-nav-boards', box).value.trim(),
        site_nav_notice: $('#s-nav-notice', box).value.trim(),
        site_nav_me: $('#s-nav-me', box).value.trim(),
        site_keywords: $('#s-kw', box).value.trim(),
        site_demo_accounts: $('#s-demo', box).value,
        site_about: $('#s-about', box).value,
        points_post: String(clampInt($('#p-post', box).value, 0, 1000, 5)),
        points_comment: String(clampInt($('#p-comment', box).value, 0, 1000, 2)),
        points_checkin: String(clampInt($('#p-checkin', box).value, 0, 1000, 5)),
        points_checkin_bonus_max: String(clampInt($('#p-checkin-bonus', box).value, 0, 1000, 5)),
        points_name: ($('#p-name', box).value || '').trim() || '积分',
        quick_replies: $('#s-quick', box).value.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 20),
        site_email_verify: $('#s-email-verify', box).value,
        smtp_host: $('#s-smtp-host', box).value.trim(),
        smtp_port: String(clampInt($('#s-smtp-port', box).value, 1, 65535, 465)),
        smtp_ssl: $('#s-smtp-ssl', box).value,
        smtp_user: $('#s-smtp-user', box).value.trim(),
        smtp_from: $('#s-smtp-from', box).value.trim(),
        smtp_name: $('#s-smtp-name', box).value.trim(),
        storage_mode: $('#s-storage-mode', box).value,
        webdav_url: $('#s-webdav-url', box).value.trim(),
        webdav_user: $('#s-webdav-user', box).value.trim(),
        webdav_path: $('#s-webdav-path', box).value.trim(),
        webdav_public_url: $('#s-webdav-public', box).value.trim(),
        baidu_dir: $('#s-baidu-dir', box).value.trim(),
        baidu_public_url: $('#s-baidu-public', box).value.trim(),
      };
      // 密码留空表示不修改，避免误清空已保存的 SMTP 授权码
      const smtpPass = $('#s-smtp-pass', box).value;
      if (smtpPass) payload.smtp_pass = smtpPass;
      // WebDAV 密码留空也表示不修改
      const webdavPass = $('#s-webdav-pass', box).value;
      if (webdavPass) payload.webdav_pass = webdavPass;
      // 百度网盘 access_token 留空也不修改
      const baiduToken = $('#s-baidu-token', box).value;
      if (baiduToken) payload.baidu_token = baiduToken;
      if (logoData) payload.site_logo = logoData;
      const btn = $('#s-save', box);
      btn.disabled = true; btn.textContent = '保存中…';
      try {
        await admReq('/api/admin/site', { method: 'PUT', body: payload });
        toast('站点设置已保存');
      } catch (e) { /* 已提示 */ }
      finally { btn.disabled = false; btn.textContent = '保存设置'; }
    };
  }

  /* ---------------- 运营管理 ---------------- */
  // 默认 VIP 套餐（与后端 DEFAULT_VIP_PLANS 保持一致，用于空值预填）
  const DEFAULT_VIP_PLANS = [
    { id: 'month', name: '月度会员', icon: '🟢', days: 30, points: 300, color: '#07C160' },
    { id: 'quarter', name: '季度会员', icon: '🔵', days: 90, points: 800, color: '#10AEFF' },
    { id: 'year', name: '年度会员', icon: '🟡', days: 365, points: 2800, color: '#FA9D3B', hot: true },
  ];
  const ANN_MAX = 10;
  // 公告有效期：时间戳（秒，0=不限）与 datetime-local 值互转
  const tsToLocal = (ts) => {
    const n = Number(ts) || 0;
    if (!n) return '';
    const d = new Date(n * 1000);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const localToTs = (v) => {
    if (!v) return 0;
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
  };
  // 公告当前状态：长期有效 / 未开始 / 生效中 / 已结束
  const annState = (a) => {
    const now = Date.now() / 1000;
    if (a.end && now > a.end) return { cls: 'off', label: '已结束' };
    if (a.start && now < a.start) return { cls: 'wait', label: '未开始' };
    if (!a.start && !a.end) return { cls: 'always', label: '长期有效' };
    return { cls: 'on', label: '生效中' };
  };
  // VIP 套餐可选图标（与后端 VIP_ICONS 保持一致：皇冠 / 金币 / 钻石 / 珠宝 / 奖杯 / 尊贵身份等 VIP 主题，共 85 个）
  const VIP_ICONS = [
    "👑", "🤴", "👸", "🏰", "💰", "🪙", "💵", "💴", "💶", "💷",
    "💸", "💎", "💍", "💠", "🔮", "🏆", "🥇", "🥈", "🥉", "🏅",
    "🎖", "⭐", "🌟", "✨", "💫", "⚡", "🔥", "💥", "💯", "🎯",
    "🎁", "🎀", "🎉", "🎊", "🛍", "🏵", "🎗", "🍾", "🥂", "🍷",
    "🥃", "🎂", "🎈", "🎇", "🎆", "🛡", "🧭", "🚀", "🎲", "🎰",
    "🎪", "🎭", "🎨", "🎬", "🔔", "📯", "🎺", "🎸", "🎹", "🎻",
    "🔷", "🔶", "🔹", "🔸", "💒", "👝", "👛", "💄", "🪞", "💝",
    "💚", "💙", "💜", "🩷", "🖤", "🩶", "💗", "💖", "💘", "🌹",
    "💐", "🌺", "🪻", "🦋", "🦚", "🐉", "🦁", "🐆", "🎩", "💳",
    "🗡", "⚔", "🔱", "🌙", "🌠",
  ];

  // 用户组可选图标（在 VIP 图标库基础上追加等级 / 成长主题图标，共 105 个）
  const GROUP_ICONS = VIP_ICONS.concat([
    "🌱", "🌿", "🌳", "🪴", "🐣", "🦅", "🛡", "🧭", "🧠", "💡",
    "🎯", "🏅", "🎖", "⚡", "🔮", "📚", "🧩", "🌙", "🌊", "🦉",
  ]);

  // VIP 图标选择器弹窗（85 个图标网格，嵌套弹窗不关闭父级）
  function openVipIconPicker(current, onPick) {
    const mask = document.createElement('div');
    mask.className = 'mask';
    const sheet = document.createElement('div');
    sheet.className = 'sheet';
    sheet.innerHTML = `
      <div class="handle"></div>
      <div class="sheet-head"><b>选择套餐图标</b><button class="icon-btn" data-close>${icon('close')}</button></div>
      <div class="sheet-body">
        <div class="vip-icon-picker">
          <div class="vip-icon-grid">
            ${VIP_ICONS.map((ic) => `<button data-ic="${esc(ic)}" class="${ic === current ? 'on' : ''}">${ic}</button>`).join('')}
          </div>
        </div>
      </div>`;
    const close = () => { mask.remove(); sheet.remove(); };
    mask.onclick = close;
    $('[data-close]', sheet).onclick = close;
    $$('[data-ic]', sheet).forEach((b) => (b.onclick = () => {
      onPick(b.dataset.ic);
      close();
    }));
    document.body.append(mask, sheet);
  }

  // VIP 套餐添加 / 编辑弹窗（填写资料）
  function openPlanEditor(plan, onSave) {
    const isNew = !plan;
    const cur = plan || { name: '', icon: '🎁', days: 30, points: 0, color: '#07C160', hot: false };
    let icon = cur.icon || '🎁';
    openSheet({
      title: isNew ? '添加 VIP 套餐' : '编辑 VIP 套餐',
      body: `
        <div class="adm-form">
          <label>套餐名称
            <input class="field" id="p-name" maxlength="12" value="${esc(cur.name || '')}" placeholder="例如：月度会员" />
          </label>
          <label>套餐图标
            <button class="adm-ed-iconbtn" id="p-icon" type="button" title="点击选择图标">${esc(icon)}</button>
            <span class="tiny muted" style="margin-top:4px">点击图标可从 85 个图标中选择</span>
          </label>
          <label>有效期（天）
            <input class="field" id="p-days" type="number" min="1" value="${cur.days || 30}" placeholder="会员有效天数" />
          </label>
          <label>所需积分
            <input class="field" id="p-points" type="number" min="0" value="${cur.points || 0}" placeholder="购买所需积分" />
          </label>
          <label>主题色
            <input class="adm-ed-color" id="p-color" type="color" value="${esc(cur.color || '#07C160')}" />
          </label>
          <label style="flex-direction:row;align-items:center;gap:8px">
            <input type="checkbox" id="p-hot" ${cur.hot ? 'checked' : ''} />
            <span>设为推荐套餐（前台展示「推荐」标识）</span>
          </label>
          <button class="btn primary block" id="p-save" style="margin-top:8px">${isNew ? '添加套餐' : '保存修改'}</button>
        </div>`,
      onMount(sheet) {
        $('#p-icon', sheet).onclick = () => {
          openVipIconPicker(icon, (ic) => {
            icon = ic;
            $('#p-icon', sheet).textContent = ic;
          });
        };
        $('#p-save', sheet).onclick = () => {
          const name = $('#p-name', sheet).value.trim();
          const days = Math.max(1, Number($('#p-days', sheet).value) || 0);
          const points = Math.max(0, Number($('#p-points', sheet).value) || 0);
          const color = $('#p-color', sheet).value || '#07C160';
          const hot = $('#p-hot', sheet).checked;
          if (!name) { toast('请填写套餐名称'); return; }
          onSave({
            id: cur.id || ('plan' + Date.now()),
            name, icon, days, points, color,
            ...(hot ? { hot: true } : {}),
          });
          closeOverlays();
        };
      },
    });
  }

  async function admOps(box) {
    let s;
    try { s = await admReq('/api/admin/site'); } catch (e) {
      if (!box.isConnected) return;
      box.innerHTML = `<div class="empty">加载失败</div>`; return;
    }
    const cur = s || {};

    // 解析已有公告（兼容旧的纯字符串写法，统一归一为带有效期的对象）
    let anns = [];
    try {
      if (cur.site_announcements) {
        const p = JSON.parse(cur.site_announcements);
        if (Array.isArray(p)) {
          anns = p.map((x) => (x && typeof x === 'object')
            ? { text: String(x.text || ''), start: Number(x.start) || 0, end: Number(x.end) || 0 }
            : { text: String(x || ''), start: 0, end: 0 });
        }
      }
    } catch (e) {}
    if (!anns.length && cur.site_announcement) anns = [{ text: String(cur.site_announcement), start: 0, end: 0 }];
    // 保证至少一行方便填写
    while (anns.length < 1) anns.push({ text: '', start: 0, end: 0 });

    // 解析已有 VIP 套餐
    let plans = [];
    try { if (cur.site_vip_plans) { const p = JSON.parse(cur.site_vip_plans); if (Array.isArray(p) && p.length) plans = p; } } catch (e) {}
    if (!plans.length) plans = JSON.parse(JSON.stringify(DEFAULT_VIP_PLANS));

    const renderAnns = () => anns.map((a, i) => {
      const st = annState(a);
      return `
      <div class="adm-ed-row ann-row">
        <span class="adm-ed-idx">${i + 1}</span>
        <span><input class="field adm-ed-input" data-ann="${i}" maxlength="200" value="${esc(a.text)}" placeholder="公告内容，最多 200 字" /></span>
        <span><input class="field adm-ed-time" type="datetime-local" data-ann-start="${i}" value="${esc(tsToLocal(a.start))}" title="开始时间（留空 = 立即生效）" /></span>
        <span><input class="field adm-ed-time" type="datetime-local" data-ann-end="${i}" value="${esc(tsToLocal(a.end))}" title="结束时间（留空 = 长期有效）" /></span>
        <span class="adm-ed-ops">
          <span class="ann-status ${st.cls}">${st.label}</span>
          <button class="btn sm ghost danger" data-del-ann="${i}">删除</button>
        </span>
      </div>`;
    }).join('');

    const renderPlans = () => plans.map((p, i) => `
      <div class="adm-ed-row vip-row">
        <span class="vip-card">
          <span class="vip-card-icon" style="background:${esc(p.color || '#07C160')}22">${esc(p.icon || '🎁')}</span>
          <span class="vip-card-info">
            <b>${esc(p.name || '未命名套餐')}${p.hot ? '<span class="vip-hot-tag">推荐</span>' : ''}</b>
            <small>${p.days || 0} 天 · ${p.points || 0} 积分</small>
          </span>
          <span class="vip-card-dot" style="background:${esc(p.color || '#07C160')}"></span>
        </span>
        <span class="adm-ed-ops">
          <button class="btn sm ghost" data-edit-plan="${i}">编辑</button>
          <button class="btn sm ghost danger" data-del-plan="${i}">删除</button>
        </span>
      </div>`).join('');

    box.innerHTML = `
      <div class="adm-panel">
        <div class="adm-panel-h"><b>首页公告</b><span class="adm-hint">最多 ${ANN_MAX} 条，平铺展示在首页顶部；可设置起止时间，到期自动隐藏（留空 = 不限）</span></div>
        <div class="adm-ed-table" id="ann-table">
          <div class="adm-ed-row adm-ed-th ann-row">
            <span class="adm-ed-idx">#</span><span>公告内容</span><span>开始时间</span><span>结束时间</span><span class="adm-ed-ops">操作</span>
          </div>
          <div id="ann-body">${renderAnns()}</div>
        </div>
        <div class="adm-ed-toolbar">
          <button class="btn sm ghost" id="ann-add" ${anns.length >= ANN_MAX ? 'disabled' : ''}>${icon('plus', 14)} 添加公告</button>
          <span class="tiny muted">${anns.length} / ${ANN_MAX} 条</span>
        </div>
      </div>

      <div class="adm-panel" style="margin-top:16px">
        <div class="adm-panel-h"><b>VIP 会员套餐</b><span class="adm-hint">配置套餐名称、时长（天）与所需积分，前台购买弹窗同步更新</span></div>
        <div class="adm-ed-table" id="vip-table">
          <div class="adm-ed-row adm-ed-th vip-row">
            <span>套餐信息</span><span class="adm-ed-ops">操作</span>
          </div>
          <div id="vip-body">${renderPlans()}</div>
        </div>
        <div class="adm-ed-toolbar">
          <button class="btn sm ghost" id="vip-add">${icon('plus', 14)} 添加套餐</button>
        </div>
      </div>

      <div style="margin-top:16px">
        <button class="btn primary block" id="ops-save">保存运营配置</button>
      </div>`;

    const annBody = $('#ann-body', box);
    const vipBody = $('#vip-body', box);

    // 公告：增删
    $('#ann-add', box).onclick = () => {
      if (anns.length >= ANN_MAX) return;
      anns.push({ text: '', start: 0, end: 0 });
      annBody.innerHTML = renderAnns();
      bindAnn();
      $('#ann-add', box).disabled = anns.length >= ANN_MAX;
      $('.adm-ed-toolbar .tiny.muted', box.closest('.adm-panel') || box).textContent = `${anns.length} / ${ANN_MAX} 条`;
    };
    // 时间改动后即时刷新该行的状态徽章
    function refreshAnnStatus(i) {
      const row = $$('.ann-row', annBody)[i];
      const badge = row && $('.ann-status', row);
      if (!badge) return;
      const st = annState(anns[i]);
      badge.className = `ann-status ${st.cls}`;
      badge.textContent = st.label;
    }
    function bindAnn() {
      $$('[data-ann]', annBody).forEach((inp) => (inp.oninput = () => { anns[Number(inp.dataset.ann)].text = inp.value; }));
      $$('[data-ann-start]', annBody).forEach((inp) => (inp.onchange = () => {
        const i = Number(inp.dataset.annStart);
        anns[i].start = localToTs(inp.value);
        refreshAnnStatus(i);
      }));
      $$('[data-ann-end]', annBody).forEach((inp) => (inp.onchange = () => {
        const i = Number(inp.dataset.annEnd);
        anns[i].end = localToTs(inp.value);
        refreshAnnStatus(i);
      }));
      $$('[data-del-ann]', annBody).forEach((b) => (b.onclick = () => {
        anns.splice(Number(b.dataset.delAnn), 1);
        if (!anns.length) anns.push({ text: '', start: 0, end: 0 });
        annBody.innerHTML = renderAnns();
        bindAnn();
        $('#ann-add', box).disabled = anns.length >= ANN_MAX;
        const tb = box.querySelector('#ann-table').closest('.adm-panel').querySelector('.adm-ed-toolbar .tiny.muted');
        if (tb) tb.textContent = `${anns.length} / ${ANN_MAX} 条`;
      }));
    }
    bindAnn();

    // VIP：添加 / 编辑 / 删除（弹窗填写资料）
    $('#vip-add', box).onclick = () => {
      openPlanEditor(null, (p) => {
        plans.push(p);
        vipBody.innerHTML = renderPlans();
        bindVip();
      });
    };
    function bindVip() {
      $$('[data-edit-plan]', vipBody).forEach((b) => (b.onclick = () => {
        const idx = Number(b.dataset.editPlan);
        openPlanEditor(plans[idx], (p) => {
          plans[idx] = p;
          vipBody.innerHTML = renderPlans();
          bindVip();
        });
      }));
      $$('[data-del-plan]', vipBody).forEach((b) => (b.onclick = () => {
        plans.splice(Number(b.dataset.delPlan), 1);
        vipBody.innerHTML = renderPlans();
        bindVip();
      }));
    }
    bindVip();

    // 保存
    $('#ops-save', box).onclick = async () => {
      // 公告：过滤空值，最多 ANN_MAX 条；保留各自的起止时间
      const cleanAnns = anns
        .map((a) => ({ text: String(a.text || '').trim(), start: Number(a.start) || 0, end: Number(a.end) || 0 }))
        .filter((a) => a.text)
        .slice(0, ANN_MAX);
      // 有效期校验：开始时间必须早于结束时间
      if (cleanAnns.some((a) => a.start && a.end && a.start >= a.end)) {
        toast('公告的开始时间需早于结束时间');
        return;
      }
      // VIP：补全 id，过滤无效行
      const cleanPlans = plans
        .map((p, i) => ({
          id: p.id || ('plan' + (i + 1)),
          name: String(p.name || '').trim(),
          icon: String(p.icon || '🎁').trim(),
          days: Math.max(1, Number(p.days) || 0),
          points: Math.max(0, Number(p.points) || 0),
          color: String(p.color || '#07C160'),
          ...(p.hot ? { hot: true } : {}),
        }))
        .filter((p) => p.name && p.days > 0);

      if (cleanPlans.length === 0) { toast('请至少保留一个有效的 VIP 套餐'); return; }

      const btn = $('#ops-save', box);
      btn.disabled = true; btn.textContent = '保存中…';
      try {
        await admReq('/api/admin/site', {
          method: 'PUT',
          body: { site_announcements: JSON.stringify(cleanAnns), site_vip_plans: JSON.stringify(cleanPlans) },
        });
        toast('运营配置已保存');
      } catch (e) { /* 已提示 */ }
      finally { btn.disabled = false; btn.textContent = '保存运营配置'; }
    };
  }

  /* ---------------- 版块访问申请审核 ---------------- */
  async function admBoardApps(box) {
    let list = [];
    let filter = 'pending';
    const load = async () => {
      try { list = await admReq('/api/admin/board-applications' + (filter ? '?status=' + filter : '')); }
      catch (e) { if (box.isConnected) box.innerHTML = `<div class="empty">加载失败</div>`; return; }
      render();
    };
    const statusBadge = (s) => s === 'pending' ? '<span class="lv-badge" style="background:#FA9D3B">待审核</span>'
      : s === 'approved' ? '<span class="lv-badge" style="background:#07C160">已通过</span>'
      : '<span class="lv-badge" style="background:#E6655C">已拒绝</span>';
    const render = () => {
      if (!box.isConnected) return;
      box.innerHTML = `
        <div class="adm-toolbar">
          <div class="adm-hint">共 <b>${list.length}</b> 条申请</div>
          <div class="grow"></div>
          <div class="adm-tabbar">
            <button class="btn sm ${filter === 'pending' ? 'primary' : 'ghost'}" data-st="pending">待审核</button>
            <button class="btn sm ${filter === 'approved' ? 'primary' : 'ghost'}" data-st="approved">已通过</button>
            <button class="btn sm ${filter === 'rejected' ? 'primary' : 'ghost'}" data-st="rejected">已拒绝</button>
            <button class="btn sm ${filter === '' ? 'primary' : 'ghost'}" data-st="">全部</button>
          </div>
        </div>
        <div class="adm-panel">
          <div class="adm-table">
            <div class="adm-tr adm-th"><span>用户</span><span>版块</span><span>申请理由</span><span>状态</span><span>时间</span><span class="adm-op-h">操作</span></div>
            ${list.length ? list.map((a, i) => `
              <div class="adm-tr ${i % 2 ? 'stripe' : ''}">
                <span><b>${esc(a.nickname)}</b><span class="muted tiny"> @${esc(a.username)}</span></span>
                <span>${esc(a.boardName)} <span class="muted tiny">(${esc(a.boardSlug)})</span></span>
                <span class="adm-cell-desc">${esc(a.reason || '—')}</span>
                <span>${statusBadge(a.status)}</span>
                <span class="muted tiny">${esc(a.createdAgo)}</span>
                <span class="adm-ops">
                  ${a.status === 'pending' ? `
                    <button class="btn sm primary" data-approve="${a.id}">通过</button>
                    <button class="btn sm ghost danger" data-reject="${a.id}">拒绝</button>` : ''}
                </span>
              </div>`).join('') : `<div class="empty" style="padding:40px 0">暂无申请记录</div>`}
          </div>
        </div>`;
      $$('[data-st]', box).forEach((b) => (b.onclick = () => { filter = b.dataset.st; load(); }));
      $$('[data-approve]', box).forEach((b) => (b.onclick = async () => {
        if (!(await confirmDialog({ title: '通过该申请？', text: '通过后用户即可访问该版块', okText: '通过' }))) return;
        try { await admReq('/api/admin/board-applications/' + b.dataset.approve + '/approve', { method: 'PUT' }); toast('已通过'); load(); } catch (e) { /* toast 已提示 */ }
      }));
      $$('[data-reject]', box).forEach((b) => (b.onclick = async () => {
        if (!(await confirmDialog({ title: '拒绝该申请？', text: '用户将无法访问该版块', okText: '拒绝', danger: true }))) return;
        try { await admReq('/api/admin/board-applications/' + b.dataset.reject + '/reject', { method: 'PUT' }); toast('已拒绝'); load(); } catch (e) { /* toast 已提示 */ }
      }));
    };
    box.innerHTML = `<div class="spin" style="margin:40px auto"></div>`;
    load();
  }

  /* ---------------- 版块 ---------------- */
  // 拉取全部用户（分页汇总），供版主多选使用
  async function loadAllUsers() {
    const out = [];
    let page = 1, pages = 1;
    while (page <= pages && page <= 20) {
      const res = await admReq('/api/admin/users?page=' + page);
      out.push(...(res.items || []));
      pages = res.pages || 1;
      page += 1;
    }
    return out;
  }

  async function admBoards(box) {
    let list;
    try { list = await admReq('/api/admin/boards'); } catch (e) {
      if (!box.isConnected) return;
      box.innerHTML = `<div class="empty">加载失败</div>`; return;
    }
    S.boards = list;
    box.innerHTML = `
      <div class="adm-toolbar">
        <div class="adm-hint">共 <b>${list.length}</b> 个版块，排序值越小越靠前</div>
        <div class="grow"></div>
        <button class="btn sm primary" data-new-board>${icon('plus', 15)} 新建版块</button>
      </div>
      <div class="adm-panel">
        <div class="adm-table adm-table-boards">
          <div class="adm-tr adm-th"><span>版块</span><span>标识</span><span>简介</span><span>布局</span><span>访问</span><span>帖子</span><span>排序</span><span class="adm-op-h">操作</span></div>
          ${list.map((b, i) => `
            <div class="adm-tr ${i % 2 ? 'stripe' : ''}">
              <span class="adm-cell-main"><i class="adm-dot" style="background:${esc(b.color)}">${esc(b.icon)}</i><b>${esc(b.name)}</b></span>
              <span class="muted tiny">${esc(b.slug)}</span>
              <span class="adm-cell-desc">${esc(b.description || '—')}</span>
              <span>${b.layout === 'image' ? '🖼 图片流' : (b.layout === 'grid2' ? '🔲 一行二' : '📝 一行一')}</span>
              <span>${b.accessMode === 'vip' ? '👑 仅VIP' : (b.accessMode === 'apply' ? '📝 申请' : '🌐 公开')}</span>
              <span>${num(b.postCount)}</span>
              <span>${b.sort}</span>
              <span class="adm-ops">
                <button class="btn sm ghost" data-eb="${b.id}">编辑</button>
                <button class="btn sm ghost danger" data-db="${b.id}">删除</button>
              </span>
            </div>`).join('')}
        </div>
      </div>
      ${list.some((b) => (b.moderators || []).length) ? `<div class="adm-panel" style="margin-top:16px">
        <div class="adm-panel-h"><b>版主一览</b><span class="adm-hint">每个版块可设置任意数量的版主</span></div>
        <div class="adm-list">${list.map((b) => (b.moderators || []).length ? `
          <div class="adm-item"><div class="adm-item-main" style="gap:10px;flex-wrap:wrap;align-items:center">
            <span class="adm-cell-main" style="min-width:120px"><i class="adm-dot" style="background:${esc(b.color)}">${esc(b.icon)}</i><b>${esc(b.name)}</b></span>
            ${b.moderators.map((m) => `<span class="adm-lvchip" style="color:var(--brand)">${esc(m.nickname)}</span>`).join('')}
          </div></div>` : '').join('')}</div>
      </div>` : ''}`;
    $('[data-new-board]', box).onclick = () => admBoardForm(null);
    $$('[data-eb]', box).forEach((b) => (b.onclick = () => admBoardForm(S.boards.find((x) => x.id === Number(b.dataset.eb)))));
    $$('[data-db]', box).forEach((b) => (b.onclick = async () => {
      const item = S.boards.find((x) => x.id === Number(b.dataset.db));
      if (!item) return;
      if (!(await confirmDialog({ title: '删除版块「' + item.name + '」？', text: '仅当版块下没有帖子时才能删除，删除后不可恢复', okText: '删除', danger: true }))) return;
      try { await admReq('/api/admin/boards/' + item.id, { method: 'DELETE' }); toast('已删除'); admBoards($('#adm-body')); } catch (e) { /* toast 已提示 */ }
    }));
  }

  function admBoardForm(item) {
    const isNew = !item;
    const cur = item || { name: '', icon: '💬', color: '#07C160', description: '', layout: 'list', accessMode: 'public', sort: (S.boards.length || 0) + 1 };
    const colors = ['#07C160', '#576B95', '#FA9D3B', '#E6655C', '#10AEFF', '#8B7BD8', '#00C2C7', '#F76260'];
    const icons = ['💬', '💻', '🎨', '💼', '🍵', '📦', '📢', '📷', '🎮', '📚', '🎵', '🏃', '🌱', '🧠', '🤝'];
    openSheet({
      title: isNew ? '新建版块' : '编辑版块',
      body: `
        <div class="adm-form">
          <label>版块名称<input class="field" id="b-name" maxlength="10" value="${esc(cur.name)}" placeholder="不超过 10 个字" /></label>
          <label>图标
            <div class="adm-picker" id="b-icons">${icons.map((i) => `<button data-ic="${i}" class="${i === cur.icon ? 'on' : ''}">${i}</button>`).join('')}</div>
          </label>
          <label>主题色
            <div class="adm-picker" id="b-colors">${colors.map((c) => `<button data-cl="${c}" class="${c === cur.color ? 'on' : ''}" style="background:${c}"></button>`).join('')}</div>
          </label>
          <label>一句话简介<input class="field" id="b-desc" maxlength="60" value="${esc(cur.description || '')}" placeholder="例如：代码、架构、踩坑与心得" /></label>
          <label>展示布局
            <div class="adm-picker" id="b-layout">
              <button data-lay="list" class="${cur.layout !== 'image' && cur.layout !== 'grid2' ? 'on' : ''}">📝 一行一</button>
              <button data-lay="grid2" class="${cur.layout === 'grid2' ? 'on' : ''}">🔲 一行二</button>
              <button data-lay="image" class="${cur.layout === 'image' ? 'on' : ''}">🖼 图片流</button>
            </div>
            <div class="tiny muted" style="margin-top:6px">一行一：整行标题列表；一行二：每行两张图文卡片；图片流：封面卡片瀑布流（适合晒图/交友类版块）</div>
          </label>
          <label>访问模式
            <div class="adm-picker" id="b-access">
              <button data-acc="public" class="${cur.accessMode !== 'vip' && cur.accessMode !== 'apply' ? 'on' : ''}">🌐 公开</button>
              <button data-acc="vip" class="${cur.accessMode === 'vip' ? 'on' : ''}">👑 仅 VIP</button>
              <button data-acc="apply" class="${cur.accessMode === 'apply' ? 'on' : ''}">📝 申请访问</button>
            </div>
            <div class="tiny muted" style="margin-top:6px">公开：所有人可访问；仅 VIP：只有 VIP 会员可访问；申请访问：VIP 可直接进入，普通用户需申请并由管理员/版主审批</div>
          </label>
          <label>排序<input class="field" id="b-sort" type="number" value="${cur.sort || 0}" /></label>
          <label>版主（可多选，名额不限）
            <input class="field" id="b-mod-q" placeholder="搜索昵称或账号…" />
            <div class="adm-mods" id="b-mods"><div class="tiny muted" style="padding:8px 2px">加载中…</div></div>
          </label>
          <button class="btn primary block" id="b-save" style="margin-top:8px">${isNew ? '创建版块' : '保存修改'}</button>
        </div>`,
      onMount(sheet) {
        let icon = cur.icon, color = cur.color;
        let layout = cur.layout === 'image' ? 'image' : (cur.layout === 'grid2' ? 'grid2' : 'list');
        let accessMode = (cur.accessMode === 'vip' || cur.accessMode === 'apply') ? cur.accessMode : 'public';
        $$('[data-ic]', sheet).forEach((b) => (b.onclick = () => { $$('[data-ic]', sheet).forEach((x) => x.classList.remove('on')); b.classList.add('on'); icon = b.dataset.ic; }));
        $$('[data-cl]', sheet).forEach((b) => (b.onclick = () => { $$('[data-cl]', sheet).forEach((x) => x.classList.remove('on')); b.classList.add('on'); color = b.dataset.cl; }));
        $$('[data-lay]', sheet).forEach((b) => (b.onclick = () => { $$('[data-lay]', sheet).forEach((x) => x.classList.remove('on')); b.classList.add('on'); layout = b.dataset.lay; }));
        $$('[data-acc]', sheet).forEach((b) => (b.onclick = () => { $$('[data-acc]', sheet).forEach((x) => x.classList.remove('on')); b.classList.add('on'); accessMode = b.dataset.acc; }));

        // 版主多选（名额不限）
        const modIds = new Set((cur.moderators || []).map((m) => m.id));
        let allUsers = [];
        const modBox = $('#b-mods', sheet);
        const renderMods = (kw) => {
          const k = (kw || '').trim().toLowerCase();
          const list = allUsers.filter((u) => !k || u.nickname.toLowerCase().includes(k) || u.username.toLowerCase().includes(k));
          modBox.innerHTML = list.length ? list.map((u) => `
            <label class="adm-mod-row ${modIds.has(u.id) ? 'on' : ''}">
              <input type="checkbox" data-mid="${u.id}" ${modIds.has(u.id) ? 'checked' : ''} />
              <span class="grow">${esc(u.nickname)} <span class="muted tiny">@${esc(u.username)}</span></span>
            </label>`).join('') : `<div class="tiny muted" style="padding:8px 2px">没有匹配的用户</div>`;
          $$('[data-mid]', modBox).forEach((c) => (c.onchange = () => {
            const id = Number(c.dataset.mid);
            if (c.checked) modIds.add(id); else modIds.delete(id);
            c.closest('.adm-mod-row').classList.toggle('on', c.checked);
          }));
        };
        loadAllUsers().then((us) => { allUsers = us; renderMods(''); })
          .catch(() => { modBox.innerHTML = `<div class="tiny muted" style="padding:8px 2px">用户加载失败</div>`; });
        $('#b-mod-q', sheet).oninput = (e) => renderMods(e.target.value);

        $('#b-save', sheet).onclick = async () => {
          const payload = {
            name: $('#b-name', sheet).value.trim(), icon, color, layout, access_mode: accessMode,
            description: $('#b-desc', sheet).value.trim(),
            sort: Number($('#b-sort', sheet).value) || 0,
          };
          if (!payload.name) { toast('请填写版块名称'); return; }
          const btn = $('#b-save', sheet); btn.disabled = true;
          try {
            let id = item && item.id;
            if (isNew) {
              const r = await admReq('/api/admin/boards', { method: 'POST', body: payload });
              id = r && r.id;
            } else {
              await admReq('/api/admin/boards/' + item.id, { method: 'PUT', body: payload });
            }
            if (id) await admReq('/api/admin/boards/' + id + '/moderators', { method: 'PUT', body: { userIds: [...modIds] } });
            toast(isNew ? '版块已创建' : '已保存');
            closeOverlays();
            admBoards($('#adm-body'));
          } catch (e) { btn.disabled = false; }
        };
      },
    });
  }

  /* ---------------- 帖子 ---------------- */
  async function admPosts(box) {
    const st = S.posts;
    if (!S.boards.length) { try { S.boards = await admReq('/api/admin/boards'); } catch (e) { /* ignore */ } }
    box.innerHTML = `
      <div class="adm-toolbar">
        <input class="field adm-search" id="p-q" placeholder="搜索标题或正文…" value="${esc(st.q)}" />
        <select class="field adm-select" id="p-board">
          <option value="">全部版块</option>
          ${S.boards.map((b) => `<option value="${b.id}" ${String(b.id) === String(st.board) ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}
        </select>
        <select class="field adm-select" id="p-status">
          <option value="" ${st.status === '' ? 'selected' : ''}>全部状态</option>
          <option value="normal" ${st.status === 'normal' ? 'selected' : ''}>正常</option>
          <option value="deleted" ${st.status === 'deleted' ? 'selected' : ''}>已隐藏</option>
        </select>
        <select class="field adm-select" id="p-sort">
          <option value="latest" ${st.sort === 'latest' ? 'selected' : ''}>最新活跃</option>
          <option value="oldest" ${st.sort === 'oldest' ? 'selected' : ''}>最早发布</option>
          <option value="hot" ${st.sort === 'hot' ? 'selected' : ''}>最热</option>
          <option value="comments" ${st.sort === 'comments' ? 'selected' : ''}>评论最多</option>
        </select>
        <button class="btn sm primary" id="p-go">筛选</button>
        <div class="grow"></div>
        <div class="adm-hint" id="p-hint">共 ${st.total} 条</div>
      </div>
      <div class="adm-batchbar" id="p-batchbar">
        <label class="adm-check-all"><input type="checkbox" id="p-all" /><span>全选本页</span></label>
        <span class="adm-batch-count" id="p-picked">已选 0 项</span>
        <div class="grow"></div>
        <span class="adm-batch-tip">批量：</span>
        <button class="btn sm ghost" data-batch="top">置顶</button>
        <button class="btn sm ghost" data-batch="untop">取消置顶</button>
        <button class="btn sm ghost" data-batch="essence">加精</button>
        <button class="btn sm ghost" data-batch="unessence">取消精华</button>
        <button class="btn sm ghost" data-batch="restore">恢复显示</button>
        <button class="btn sm ghost" data-batch="hide">隐藏</button>
        <button class="btn sm ghost danger" data-batch="delete">删除</button>
      </div>
      <div class="adm-panel"><div class="adm-list" id="p-list">${skeletonRows(4)}</div></div>
      <div class="adm-pager" id="p-pager"></div>`;

    st.sel = new Set();
    const apply = () => {
      st.q = $('#p-q', box).value.trim();
      st.board = $('#p-board', box).value;
      st.status = $('#p-status', box).value;
      st.sort = $('#p-sort', box).value;
      st.page = 1;
      st.sel.clear();
      admLoadPosts();
    };
    $('#p-go', box).onclick = apply;
    $('#p-q', box).onkeydown = (e) => { if (e.key === 'Enter') apply(); };
    $('#p-board', box).onchange = apply;
    $('#p-status', box).onchange = apply;
    $('#p-sort', box).onchange = apply;
    $('#p-all', box).onchange = (e) => {
      const on = e.target.checked;
      st.items.forEach((p) => (on ? st.sel.add(p.id) : st.sel.delete(p.id)));
      $$('[data-pick]', $('#p-list')).forEach((c) => {
        c.checked = on;
        const it = c.closest('.adm-item'); if (it) it.classList.toggle('picked', on);
      });
      syncBatchBar('#p-batchbar', '#p-picked', st);
    };
    $$('[data-batch]', box).forEach((b) => (b.onclick = () => admPostBatch(b.dataset.batch)));
    syncBatchBar('#p-batchbar', '#p-picked', st);
    await admLoadPosts();
  }

  // 批量栏：按钮可用性 + 已选计数
  function syncBatchBar(barSel, countSel, st, btnSel = '[data-batch]') {
    const n = st.sel ? st.sel.size : 0;
    const cnt = $(countSel);
    if (cnt) cnt.textContent = `已选 ${n} 项`;
    const bar = $(barSel);
    if (bar) $$(btnSel, bar).forEach((b) => { b.disabled = n === 0; });
  }

  async function admPostBatch(action) {
    const st = S.posts;
    const ids = Array.from(st.sel || []);
    if (!ids.length) { toast('请先勾选帖子'); return; }
    if (action === 'delete' &&
      !(await confirmDialog({ title: `彻底删除选中的 ${ids.length} 篇帖子？`, text: '这些帖子及其评论、收藏都会被永久删除，且不可恢复', okText: '删除', danger: true }))) return;
    try {
      const r = await admReq('/api/admin/posts/batch', { method: 'POST', body: { ids, action } });
      toast(`已处理 ${r.count} 篇帖子`);
      st.sel.clear();
      admLoadPosts();
    } catch (e) { /* 已提示 */ }
  }

  async function admLoadPosts() {
    const st = S.posts;
    const list = $('#p-list');
    if (!list) return;
    if (!st.sel) st.sel = new Set();
    // reqId 防止快速筛选时旧响应覆盖新结果
    const rid = (admLoadPosts._rid = (admLoadPosts._rid || 0) + 1);
    let res;
    try {
      res = await admReq('/api/admin/posts?' + new URLSearchParams({ q: st.q, board: st.board, status: st.status, sort: st.sort, page: st.page }).toString());
    } catch (e) {
      if (rid === admLoadPosts._rid && list.isConnected) list.innerHTML = `<div class="empty">加载失败</div>`;
      return;
    }
    if (rid !== admLoadPosts._rid) return;   // 已有更新的请求
    if (!list.isConnected) return;
    st.items = res.items; st.total = res.total; st.pages = res.pages; st.page = res.page;
    const hint = $('#p-hint');
    if (hint) hint.textContent = `共 ${st.total} 条`;
    list.innerHTML = res.items.length ? res.items.map((p, i) => `
      <div class="adm-item ${p.status === 0 ? 'is-off' : ''} ${i % 2 ? 'stripe' : ''} ${st.sel.has(p.id) ? 'picked' : ''}">
        <label class="adm-check"><input type="checkbox" data-pick="${p.id}" ${st.sel.has(p.id) ? 'checked' : ''} /></label>
        <div class="adm-item-main">
          <div class="adm-item-title">
            ${p.isTop ? '<span class="adm-tag-pin">置顶</span>' : ''}${p.isEssence ? '<span class="adm-tag-best">精华</span>' : ''}
            <span class="adm-item-t">${esc(p.title)}</span>
            ${p.status === 0 ? '<span class="adm-flag-off">已隐藏</span>' : ''}
          </div>
          <div class="adm-item-sub">
            <span>${esc(p.boardName)}</span><i>·</i><span>${esc(p.author)}</span><i>·</i>
            <span>${p.createdAgo}</span><i>·</i><span>${num(p.views)} 浏览</span><i>·</i><span>${num(p.likes)} 赞</span><i>·</i><span>${num(p.comments)} 评论</span>
          </div>
          <div class="adm-item-sum">${esc(p.summary)}</div>
        </div>
        <div class="adm-item-ops">
          <button class="btn sm ghost" data-eo="${p.id}">${icon('edit', 14)} 编辑</button>
          <button class="btn sm ghost" data-to="${p.id}">${p.isTop ? '取消置顶' : '置顶'}</button>
          <button class="btn sm ghost" data-es="${p.id}">${p.isEssence ? '取消精华' : '加精'}</button>
          <button class="btn sm ghost ${p.status === 0 ? '' : 'danger'}" data-sv="${p.id}">${p.status === 0 ? '恢复' : '隐藏'}</button>
          <button class="btn sm ghost danger" data-dp="${p.id}">彻底删除</button>
        </div>
      </div>`).join('') : `<div class="empty">没有符合条件的帖子</div>`;

    renderPager('#p-pager', st, admLoadPosts);
    // 勾选联动
    $$('[data-pick]', list).forEach((c) => (c.onchange = () => {
      const id = Number(c.dataset.pick);
      if (c.checked) st.sel.add(id); else st.sel.delete(id);
      const it = c.closest('.adm-item'); if (it) it.classList.toggle('picked', c.checked);
      const all = $('#p-all');
      if (all) all.checked = st.items.length > 0 && st.items.every((p) => st.sel.has(p.id));
      syncBatchBar('#p-batchbar', '#p-picked', st);
    }));
    const allBox = $('#p-all');
    if (allBox) allBox.checked = st.items.length > 0 && st.items.every((p) => st.sel.has(p.id));
    syncBatchBar('#p-batchbar', '#p-picked', st);

    $$('[data-eo]', list).forEach((b) => (b.onclick = () => admPostForm(st.items.find((x) => x.id === Number(b.dataset.eo)))));
    $$('[data-to]', list).forEach((b) => (b.onclick = async () => {
      const p = st.items.find((x) => x.id === Number(b.dataset.to));
      try { await admReq('/api/admin/posts/' + p.id, { method: 'PUT', body: { isTop: !p.isTop } }); toast(p.isTop ? '已取消置顶' : '已置顶'); admLoadPosts(); } catch (e) { /* */ }
    }));
    $$('[data-es]', list).forEach((b) => (b.onclick = async () => {
      const p = st.items.find((x) => x.id === Number(b.dataset.es));
      try { await admReq('/api/admin/posts/' + p.id, { method: 'PUT', body: { isEssence: !p.isEssence } }); toast(p.isEssence ? '已取消精华' : '已设为精华'); admLoadPosts(); } catch (e) { /* */ }
    }));
    $$('[data-sv]', list).forEach((b) => (b.onclick = async () => {
      const p = st.items.find((x) => x.id === Number(b.dataset.sv));
      try { await admReq('/api/admin/posts/' + p.id, { method: 'PUT', body: { status: p.status === 0 ? 1 : 0 } }); toast(p.status === 0 ? '已恢复' : '已隐藏'); admLoadPosts(); } catch (e) { /* */ }
    }));
    $$('[data-dp]', list).forEach((b) => (b.onclick = async () => {
      const p = st.items.find((x) => x.id === Number(b.dataset.dp));
      if (!(await confirmDialog({ title: '彻底删除这篇帖子？', text: '「' + p.title + '」及其所有评论都会被永久删除', okText: '删除', danger: true }))) return;
      try { await admReq('/api/admin/posts/' + p.id, { method: 'DELETE' }); toast('已删除'); admLoadPosts(); } catch (e) { /* */ }
    }));
  }

  async function admPostForm(p) {
    if (!p) return;
    let full;
    try { full = await admReq('/api/admin/posts/' + p.id); } catch (e) { return; }
    openSheet({
      title: '编辑帖子 #' + full.id,
      wide: true,
      body: `
        <div class="adm-form">
          <label>标题<input class="field" id="e-title" maxlength="80" value="${esc(full.title)}" /></label>
          <label>所属版块
            <select class="field" id="e-board">${S.boards.map((b) => `<option value="${b.id}" ${b.id === full.boardId ? 'selected' : ''}>${esc(b.icon)} ${esc(b.name)}</option>`).join('')}</select>
          </label>
          <label>正文（支持 Markdown）<textarea class="field" id="e-content" rows="12" style="height:auto;padding:10px 12px;line-height:1.7">${esc(full.content)}</textarea></label>
          <label>管理员备注（仅后台可见）<input class="field" id="e-note" maxlength="200" value="${esc(full.adminNote || '')}" placeholder="例如：已核实、待作者补充信息" /></label>
          <div class="adm-switches">
            <label class="adm-switch"><input type="checkbox" id="e-top" ${full.isTop ? 'checked' : ''} /><span>置顶</span></label>
            <label class="adm-switch"><input type="checkbox" id="e-ess" ${full.isEssence ? 'checked' : ''} /><span>精华</span></label>
            <label class="adm-switch"><input type="checkbox" id="e-show" ${full.status === 1 ? 'checked' : ''} /><span>前台可见</span></label>
          </div>
          <button class="btn primary block" id="e-save">保存修改</button>
        </div>`,
      onMount(sheet) {
        $('#e-save', sheet).onclick = async () => {
          const payload = {
            title: $('#e-title', sheet).value.trim(),
            content: $('#e-content', sheet).value,
            boardId: Number($('#e-board', sheet).value),
            isTop: $('#e-top', sheet).checked,
            isEssence: $('#e-ess', sheet).checked,
            status: $('#e-show', sheet).checked ? 1 : 0,
            adminNote: $('#e-note', sheet).value.trim(),
          };
          if (payload.title.length < 2) { toast('标题至少 2 个字'); return; }
          if (payload.content.trim().length < 2) { toast('正文至少 2 个字'); return; }
          try {
            await admReq('/api/admin/posts/' + full.id, { method: 'PUT', body: payload });
            toast('已保存'); closeOverlays(); admLoadPosts();
          } catch (e) { /* 已提示 */ }
        };
      },
    });
  }

  /* ---------------- 评论 ---------------- */
  async function admComments(box) {
    const st = S.comments;
    box.innerHTML = `
      <div class="adm-toolbar">
        <input class="field adm-search" id="c-q" placeholder="搜索评论内容…" value="${esc(st.q)}" />
        <button class="btn sm primary" id="c-go">搜索</button>
        <div class="grow"></div><div class="adm-hint" id="c-hint">共 ${st.total} 条</div>
      </div>
      <div class="adm-batchbar" id="c-batchbar">
        <label class="adm-check-all"><input type="checkbox" id="c-all" /><span>全选本页</span></label>
        <span class="adm-batch-count" id="c-picked">已选 0 项</span>
        <div class="grow"></div>
        <button class="btn sm ghost danger" data-cbatch>删除选中</button>
      </div>
      <div class="adm-panel"><div class="adm-list" id="c-list">${skeletonRows(4)}</div></div>
      <div class="adm-pager" id="c-pager"></div>`;
    st.sel = new Set();
    const apply = () => { st.q = $('#c-q', box).value.trim(); st.page = 1; st.sel.clear(); admLoadComments(); };
    $('#c-go', box).onclick = apply;
    $('#c-q', box).onkeydown = (e) => { if (e.key === 'Enter') apply(); };
    $('#c-all', box).onchange = (e) => {
      const on = e.target.checked;
      st.items.forEach((c) => (on ? st.sel.add(c.id) : st.sel.delete(c.id)));
      $$('[data-pick]', $('#c-list')).forEach((c) => {
        c.checked = on;
        const it = c.closest('.adm-item'); if (it) it.classList.toggle('picked', on);
      });
      syncBatchBar('#c-batchbar', '#c-picked', st, '[data-cbatch]');
    };
    $('[data-cbatch]', box).onclick = () => admCommentBatch();
    syncBatchBar('#c-batchbar', '#c-picked', st, '[data-cbatch]');
    await admLoadComments();
  }

  async function admCommentBatch() {
    const st = S.comments;
    const ids = Array.from(st.sel || []);
    if (!ids.length) { toast('请先勾选评论'); return; }
    if (!(await confirmDialog({ title: `删除选中的 ${ids.length} 条评论？`, text: '这些评论及其楼中楼回复都会一并删除', okText: '删除', danger: true }))) return;
    try {
      const r = await admReq('/api/admin/comments/batch', { method: 'POST', body: { ids } });
      toast(`已删除 ${r.count} 条评论`);
      st.sel.clear();
      admLoadComments();
    } catch (e) { /* 已提示 */ }
  }

  async function admLoadComments() {
    const st = S.comments;
    const list = $('#c-list');
    if (!list) return;
    if (!st.sel) st.sel = new Set();
    const rid = (admLoadComments._rid = (admLoadComments._rid || 0) + 1);
    let res;
    try { res = await admReq('/api/admin/comments?' + new URLSearchParams({ q: st.q, page: st.page }).toString()); }
    catch (e) { if (rid === admLoadComments._rid && list.isConnected) list.innerHTML = `<div class="empty">加载失败</div>`; return; }
    if (rid !== admLoadComments._rid || !list.isConnected) return;
    st.items = res.items; st.total = res.total; st.pages = res.pages; st.page = res.page;
    const hint = $('#c-hint');
    if (hint) hint.textContent = `共 ${st.total} 条`;
    list.innerHTML = res.items.length ? res.items.map((c, i) => `
      <div class="adm-item ${i % 2 ? 'stripe' : ''} ${st.sel.has(c.id) ? 'picked' : ''}">
        <label class="adm-check"><input type="checkbox" data-pick="${c.id}" ${st.sel.has(c.id) ? 'checked' : ''} /></label>
        <div class="adm-item-main">
          <div class="adm-item-sub" style="margin-top:0">
            ${avatarHTML({ avatar: c.avatar, nickname: c.author }, 'xs')}
            <b class="adm-who">${esc(c.author)}</b>
            ${c.isReply ? '<span class="adm-tag">回复</span>' : '<span class="adm-tag on">主楼</span>'}
            <i>·</i><span>${c.createdAgo}</span><i>·</i>
            <span class="ellipsis" style="max-width:300px">在《${esc(c.postTitle)}》</span>
          </div>
          <div class="adm-item-body">${esc(c.content)}</div>
        </div>
        <div class="adm-item-ops">
          <a class="btn sm ghost" href="/#/post?id=${c.postId}" target="_blank" rel="noopener">查看原帖</a>
          <button class="btn sm ghost danger" data-dc="${c.id}">删除</button>
        </div>
      </div>`).join('') : `<div class="empty">暂无评论</div>`;
    renderPager('#c-pager', st, admLoadComments);
    $$('[data-pick]', list).forEach((c) => (c.onchange = () => {
      const id = Number(c.dataset.pick);
      if (c.checked) st.sel.add(id); else st.sel.delete(id);
      const it = c.closest('.adm-item'); if (it) it.classList.toggle('picked', c.checked);
      const all = $('#c-all');
      if (all) all.checked = st.items.length > 0 && st.items.every((x) => st.sel.has(x.id));
      syncBatchBar('#c-batchbar', '#c-picked', st, '[data-cbatch]');
    }));
    const allBox = $('#c-all');
    if (allBox) allBox.checked = st.items.length > 0 && st.items.every((x) => st.sel.has(x.id));
    syncBatchBar('#c-batchbar', '#c-picked', st, '[data-cbatch]');
    $$('[data-dc]', list).forEach((b) => (b.onclick = async () => {
      if (!(await confirmDialog({ title: '删除这条评论？', text: '该评论下的所有回复也会一并删除', okText: '删除', danger: true }))) return;
      try { await admReq('/api/admin/comments/' + b.dataset.dc, { method: 'DELETE' }); toast('已删除'); admLoadComments(); } catch (e) { /* */ }
    }));
  }

  /* ---------------- 邮件群发 ---------------- */
  async function admEmail(box) {
    let stats = { all: 0, vip: 0, active: 0 };
    try { stats = await admReq('/api/admin/email/recipients'); } catch (e) { stats = { all: 0, vip: 0, active: 0 }; }
    const targetOpts = [
      { v: 'all', label: '全部有邮箱的用户', n: stats.all },
      { v: 'vip', label: 'VIP 会员', n: stats.vip },
      { v: 'active', label: '活跃用户（未封禁）', n: stats.active },
    ];
    box.innerHTML = `
      <div class="adm-panel">
        <div class="adm-panel-h"><b>邮件群发</b><span class="adm-hint">通过已配置的 SMTP 给选中用户批量发送邮件；正文含 HTML 标签时按 HTML 发送，否则自动换行</span></div>
        <div class="adm-form">
          <label>发送对象
            <select class="field" id="e-target">
              ${targetOpts.map((o) => `<option value="${o.v}">${o.label}（${o.n} 人）</option>`).join('')}
            </select>
          </label>
          <label>邮件主题<input class="field" id="e-subject" maxlength="120" placeholder="例如：微坛社区通知" /></label>
          <label>邮件正文<span class="tiny muted" style="margin-left:8px">支持纯文本（自动换行）或直接写 HTML</span>
            <textarea class="field" id="e-content" style="min-height:220px;line-height:1.7" placeholder="请输入邮件正文…"></textarea>
          </label>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <button class="btn ghost" id="e-preview">预览收件人</button>
            <button class="btn primary" id="e-send">立即发送</button>
            <span class="tiny muted" id="e-status" style="align-self:center"></span>
          </div>
        </div>
      </div>
      <div class="adm-panel" id="e-result" style="display:none">
        <div class="adm-panel-h"><b>发送结果</b></div>
        <div class="adm-form" id="e-result-body"></div>
      </div>`;

    const targetSel = $('#e-target', box);
    const subjectEl = $('#e-subject', box);
    const contentEl = $('#e-content', box);
    const statusEl = $('#e-status', box);
    const resultPanel = $('#e-result', box);
    const resultBody = $('#e-result-body', box);

    const showResult = (data) => {
      resultPanel.style.display = '';
      const failed = data.failed || [];
      resultBody.innerHTML = `
        <div style="display:flex;gap:24px;flex-wrap:wrap;margin-bottom:10px">
          <div>收件总数：<b>${data.total || 0}</b></div>
          <div style="color:var(--brand)">发送成功：<b>${data.sent || 0}</b></div>
          <div style="color:var(--danger)">发送失败：<b>${failed.length}</b></div>
        </div>
        ${failed.length ? `
          <div class="tiny muted" style="margin-bottom:6px">失败详情：</div>
          <div style="max-height:260px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:8px">
            ${failed.map((f) => `<div style="padding:4px 0;border-bottom:1px solid var(--border)"><b>${esc(f.nickname || '')}</b> ${esc(f.email)} <span class="tiny muted">— ${esc(f.error)}</span></div>`).join('')}
          </div>` : '<div class="tiny muted">全部发送成功 🎉</div>'}`;
    };

    const send = async (dryRun) => {
      const subject = subjectEl.value.trim();
      const content = contentEl.value;
      if (!subject) return toast('请填写邮件主题');
      if (!content.trim()) return toast('请填写邮件正文');
      const payload = { target: targetSel.value, subject, content, dryRun };
      const btn = dryRun ? $('#e-preview', box) : $('#e-send', box);
      btn.disabled = true; btn.textContent = dryRun ? '预览中…' : '发送中…';
      statusEl.style.color = '';
      statusEl.textContent = dryRun ? '' : '正在发送，请稍候（人数较多时可能需要一段时间）…';
      try {
        const d = await admReq('/api/admin/email/bulk', { method: 'POST', body: payload });
        if (dryRun) {
          resultPanel.style.display = '';
          resultBody.innerHTML = `
            <div style="margin-bottom:8px">将发送给 <b>${d.total}</b> 位用户：</div>
            <div style="max-height:260px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:8px">
              ${(d.recipients || []).map((r) => `<div style="padding:3px 0">${esc(r.nickname || '')} <span class="tiny muted">${esc(r.email)}</span></div>`).join('') || '<div class="tiny muted">无匹配收件人</div>'}
            </div>`;
          toast(`共 ${d.total} 位收件人`);
        } else {
          showResult(d);
          toast(d.sent ? `已发送 ${d.sent} 封${d.failed.length ? `，失败 ${d.failed.length} 封` : ''}` : '发送失败');
        }
      } catch (e) {
        const msg = (e && e.message) ? e.message : '操作失败，请稍后重试';
        statusEl.textContent = msg;
        statusEl.style.color = 'var(--danger)';
        resultPanel.style.display = '';
        resultBody.innerHTML = `<div style="color:var(--danger);padding:8px 0">发送失败：${esc(msg)}</div>`;
      } finally {
        btn.disabled = false; btn.textContent = dryRun ? '预览收件人' : '立即发送';
      }
    };

    $('#e-preview', box).onclick = () => send(true);
    $('#e-send', box).onclick = () => send(false);
  }

  /* ---------------- 用户 ---------------- */
  async function admUsers(box) {
    const st = S.users;
    box.innerHTML = `
      <div class="adm-toolbar">
        <input class="field adm-search" id="u-q" placeholder="搜索昵称或账号…" value="${esc(st.q)}" />
        <button class="btn sm primary" id="u-go">搜索</button>
        <div class="grow"></div><div class="adm-hint" id="u-hint">共 ${st.total} 位用户</div>
      </div>
      <div class="adm-panel"><div class="adm-list" id="u-list">${skeletonRows(4)}</div></div>
      <div class="adm-pager" id="u-pager"></div>`;
    const apply = () => { st.q = $('#u-q', box).value.trim(); st.page = 1; admLoadUsers(); };
    $('#u-go', box).onclick = apply;
    $('#u-q', box).onkeydown = (e) => { if (e.key === 'Enter') apply(); };
    await admLoadUsers();
  }

  async function admLoadUsers() {
    const st = S.users;
    const list = $('#u-list');
    if (!list) return;
    const rid = (admLoadUsers._rid = (admLoadUsers._rid || 0) + 1);
    let res;
    try { res = await admReq('/api/admin/users?' + new URLSearchParams({ q: st.q, page: st.page }).toString()); }
    catch (e) { if (rid === admLoadUsers._rid && list.isConnected) list.innerHTML = `<div class="empty">加载失败</div>`; return; }
    if (rid !== admLoadUsers._rid || !list.isConnected) return;
    st.items = res.items; st.total = res.total; st.pages = res.pages; st.page = res.page;
    const hint = $('#u-hint');
    if (hint) hint.textContent = `共 ${st.total} 位用户`;
    list.innerHTML = res.items.length ? res.items.map((u, i) => `
      <div class="adm-item ${u.status === 0 ? 'is-off' : ''} ${i % 2 ? 'stripe' : ''}">
        <div class="adm-item-main">
          <div class="adm-item-title" style="gap:10px">
            ${avatarHTML({ avatar: u.avatar, nickname: u.nickname }, 'sm')}
            <span class="adm-item-t">${esc(u.nickname)}</span>
            <span class="muted tiny">@${esc(u.username)}</span>
            ${u.role === 'admin' ? '<span class="adm-tag-admin">管理员</span>' : ''}
            ${u.isVip ? '<span class="adm-tag-vip" title="VIP 会员">👑 VIP</span>' : ''}
            ${u.group ? `<span class="adm-lvchip" style="color:${esc(u.group.color)}" title="用户组"><i>${esc(u.group.icon)}</i>${esc(u.group.name)}</span>` : ''}
            <span class="adm-lvchip" style="color:var(--text-2)">Lv.${u.level}</span>
            ${u.status === 0 ? '<span class="adm-flag-off">已封禁</span>' : ''}
            ${(u.badges && u.badges.length) ? `<span class="adm-medal-mini" title="${esc(u.badges.map((b) => b.name).join('、'))}">${u.badges.slice(0, 4).map((b) => esc(b.icon)).join('')}</span>` : ''}
          </div>
          <div class="adm-item-sub"><span>${num(u.postCount)} 篇帖子</span><i>·</i><span>${num(u.exp)} 经验</span><i>·</i><span style="color:var(--brand)">${num(u.points || 0)} 积分</span><i>·</i><span>${u.joinedAgo}加入</span></div>
        </div>
        <div class="adm-item-ops">
          <button class="btn sm ghost" data-eu="${u.id}">编辑资料</button>
          <button class="btn sm ghost" data-pw="${u.id}">改密码</button>
          <button class="btn sm ghost" data-rl="${u.id}">${u.role === 'admin' ? '取消管理员' : '设为管理员'}</button>
          <button class="btn sm ghost ${u.status === 1 ? 'danger' : ''}" data-bn="${u.id}">${u.status === 1 ? '封禁' : '解封'}</button>
        </div>
      </div>`).join('') : `<div class="empty">没有匹配的用户</div>`;
    renderPager('#u-pager', st, admLoadUsers);
    $$('[data-eu]', list).forEach((b) => (b.onclick = () => admUserForm(st.items.find((x) => x.id === Number(b.dataset.eu)))));
    $$('[data-pw]', list).forEach((b) => (b.onclick = () => {
      const u = st.items.find((x) => x.id === Number(b.dataset.pw));
      openSheet({
        title: '重置「' + u.nickname + '」的密码',
        body: `<div class="adm-form">
          <label>新密码<input class="field" id="n-pw" type="text" placeholder="至少 6 位" /></label>
          <button class="btn primary block" id="n-save">确认重置</button></div>`,
        onMount(sheet) {
          $('#n-save', sheet).onclick = async () => {
            const pwd = $('#n-pw', sheet).value;
            if (pwd.length < 6) { toast('密码至少 6 位'); return; }
            try { await admReq('/api/admin/users/' + u.id, { method: 'PUT', body: { password: pwd } }); toast('密码已重置'); closeOverlays(); } catch (e) { /* */ }
          };
        },
      });
    }));
    $$('[data-rl]', list).forEach((b) => (b.onclick = async () => {
      const u = st.items.find((x) => x.id === Number(b.dataset.rl));
      const demote = u.role === 'admin';
      if (demote && !(await confirmDialog({ title: '取消「' + u.nickname + '」的管理员权限？', text: '取消后该账号将无法进入管理后台', okText: '取消权限', danger: true }))) return;
      try {
        await admReq('/api/admin/users/' + u.id, { method: 'PUT', body: { role: demote ? 'user' : 'admin' } });
        toast(demote ? '已取消管理员' : '已设为管理员');
        if (u.id === S.me.id) {
          // 改的是自己的角色：重新拉一次身份，必要时退到无权页
          await refreshMe();
          if (!S.me || !S.me.isAdmin) { renderForbidden(); return; }
        }
        admLoadUsers();
      } catch (e) { /* */ }
    }));
    $$('[data-bn]', list).forEach((b) => (b.onclick = async () => {
      const u = st.items.find((x) => x.id === Number(b.dataset.bn));
      const ban = u.status === 1;
      if (u.id === S.me.id) { toast('不能封禁自己'); return; }
      if (ban && !(await confirmDialog({ title: '封禁「' + u.nickname + '」？', text: '封禁后该用户无法登录，已登录的会话也将失效', okText: '封禁', danger: true }))) return;
      try { await admReq('/api/admin/users/' + u.id, { method: 'PUT', body: { status: ban ? 0 : 1 } }); toast(ban ? '已封禁' : '已解封'); admLoadUsers(); } catch (e) { /* */ }
    }));
  }

  async function admUserForm(u) {
    if (!u) return;
    // 用户组 / 勋章只在需要时拉一次并缓存
    if (!S.groups) { try { S.groups = await admReq('/api/admin/groups'); } catch (e) { /* */ } }
    if (!S.badges) { try { S.badges = await admReq('/api/admin/badges'); } catch (e) { /* */ } }
    const groups = S.groups || [];
    const badges = S.badges || [];
    const owned = new Set((u.badges || []).map((b) => b.id));
    const lv = u.group ? `Lv.${u.level} · ${u.group.icon} ${u.group.name}` : `Lv.${u.level} · 未分组`;
    const isVip = !!u.isVip;
    const vipExpireDate = u.vipExpire ? new Date(u.vipExpire * 1000) : null;
    const vipExpireStr = vipExpireDate ? `${vipExpireDate.getFullYear()}-${String(vipExpireDate.getMonth()+1).padStart(2,'0')}-${String(vipExpireDate.getDate()).padStart(2,'0')}` : '';
    openSheet({
      title: '编辑用户「' + u.nickname + '」',
      body: `<div class="adm-form">
        <div style="display:flex;justify-content:center;padding:4px 0 6px" id="u-avatar">${avatarHTML({ avatar: u.avatar, nickname: u.nickname }, 'xl')}</div>
        <button class="btn sm ghost" id="u-up" style="align-self:center">更换头像</button>
        <label>昵称<input class="field" id="u-nick" maxlength="16" value="${esc(u.nickname)}" /></label>
        <label>账号（不可修改）<input class="field" value="${esc(u.username)}" disabled /></label>
        <label>积分<input class="field" id="u-points" type="number" min="0" value="${num(u.points || 0)}" /></label>
        <div class="tiny muted" style="margin-top:-4px">发帖 +5，评论 +2，可用于兑换 VIP</div>
        <label>VIP 会员
          <select class="field" id="u-vip">
            <option value="0" ${!isVip ? 'selected' : ''}>未开通</option>
            <option value="30" ${isVip ? '' : ''}>开通 30 天</option>
            <option value="90" ${isVip ? '' : ''}>开通 90 天</option>
            <option value="365" ${isVip ? '' : ''}>开通 365 天</option>
            <option value="-1" ${isVip ? '' : ''}>永久 VIP</option>
          </select>
        </label>
        <div class="tiny muted" style="margin-top:-4px">${isVip ? `当前 VIP 到期：${esc(vipExpireStr)}` : '选择时长后将从现在起计算；不修改请保持「未开通」'}</div>
        <label>用户组
          <select class="field" id="u-group">
            <option value="0" ${!u.groupId ? 'selected' : ''}>自动匹配（按经验值 ${num(u.exp)}）</option>
            ${groups.map((g) => `<option value="${g.id}" ${u.groupId === g.id ? 'selected' : ''}>${esc(g.icon)} ${esc(g.name)}（Lv.${g.level}）</option>`).join('')}
          </select>
        </label>
        <div class="tiny muted" style="margin-top:-4px">当前：${esc(lv)}${u.isManualGroup ? ' · 已手动指定' : ''}</div>
        <label>授予勋章（可多选）</label>
        <div class="adm-badge-grid" id="u-badges">
          ${badges.length ? badges.map((b) => `
            <label class="adm-badge-pick ${owned.has(b.id) ? 'on' : ''}" data-bid="${b.id}">
              <input type="checkbox" ${owned.has(b.id) ? 'checked' : ''} />
              <span class="ic">${esc(b.icon)}</span>
              <span class="dt"><b>${esc(b.name)}</b><small>${esc(b.description || '')}</small></span>
            </label>`).join('') : '<div class="tiny muted">还没有勋章，先去「勋章」里创建</div>'}
        </div>
        <button class="btn primary block" id="u-save" style="margin-top:8px">保存</button>
        <input type="file" id="u-file" accept="image/*" hidden />
      </div>`,
      onMount(sheet) {
        let avatar = null;
        $('#u-up', sheet).onclick = () => $('#u-file', sheet).click();
        $('#u-file', sheet).onchange = async (e) => {
          const f = e.target.files[0]; if (!f) return;
          avatar = await fileToDataURL(f, 400);
          $('#u-avatar', sheet).innerHTML = avatarHTML({ avatar, nickname: $('#u-nick', sheet).value }, 'xl');
        };
        $$('.adm-badge-pick', sheet).forEach((el) => {
          const cb = el.querySelector('input');
          cb.onchange = () => el.classList.toggle('on', cb.checked);
        });
        $('#u-save', sheet).onclick = async () => {
          const body = { nickname: $('#u-nick', sheet).value.trim(), groupId: Number($('#u-group', sheet).value) };
          if (!body.nickname) { toast('昵称不能为空'); return; }
          if (avatar) body.avatar = avatar;
          // 积分
          const pts = parseInt($('#u-points', sheet).value, 10);
          if (!isNaN(pts) && pts >= 0) body.points = pts;
          // VIP
          const vipSel = Number($('#u-vip', sheet).value);
          if (vipSel === 0) {
            body.vipExpire = 0; // 取消 VIP
          } else if (vipSel > 0) {
            body.vipExpire = Math.floor(Date.now() / 1000) + vipSel * 86400;
          } else if (vipSel === -1) {
            body.vipExpire = Math.floor(Date.now() / 1000) + 100 * 365 * 86400; // 永久（100 年）
          }
          const ids = $$('.adm-badge-pick', sheet).filter((el) => el.querySelector('input').checked).map((el) => Number(el.dataset.bid));
          try {
            await admReq('/api/admin/users/' + u.id, { method: 'PUT', body });
            await admReq('/api/admin/users/' + u.id + '/badges', { method: 'PUT', body: { ids } });
            toast('已保存'); closeOverlays(); admLoadUsers();
          } catch (e) { /* */ }
        };
      },
    });
  }

  /* ---------------- 用户组 ---------------- */
  async function admGroups(box) {
    let list;
    try { list = await admReq('/api/admin/groups'); } catch (e) {
      if (!box.isConnected) return;
      box.innerHTML = `<div class="empty">加载失败</div>`; return;
    }
    S.groups = list;
    box.innerHTML = `
      <div class="adm-toolbar">
        <div class="adm-hint">共 <b>${list.length}</b> 个用户组 · 经验值达到「所需经验」自动升级</div>
        <div class="grow"></div>
        <button class="btn sm primary" data-new-group>${icon('plus', 15)} 新建用户组</button>
      </div>
      <div class="adm-tiles">
        ${list.map((g) => `
          <div class="adm-tile">
            <div class="adm-tile-h">
              <div class="adm-tile-ico" style="background:${esc(g.color)}">${esc(g.icon)}</div>
              <div class="grow" style="min-width:0">
                <div class="adm-tile-name">${esc(g.name)}</div>
                <div class="adm-tile-lv">Lv.${g.level} · 所需经验 ${num(g.minExp)}</div>
              </div>
            </div>
            <div class="adm-tile-meta">
              <span>成员 <b>${num(g.memberCount)}</b></span>
              <span>排序 <b>${g.sort}</b></span>
            </div>
            <div class="adm-tile-ops">
              <button class="btn sm ghost" data-eg="${g.id}">编辑</button>
              <button class="btn sm ghost danger" data-dg="${g.id}">删除</button>
            </div>
          </div>`).join('')}
      </div>`;
    $('[data-new-group]', box).onclick = () => admGroupForm(null);
    $$('[data-eg]', box).forEach((b) => (b.onclick = () => admGroupForm(S.groups.find((x) => x.id === Number(b.dataset.eg)))));
    $$('[data-dg]', box).forEach((b) => (b.onclick = async () => {
      const g = S.groups.find((x) => x.id === Number(b.dataset.dg));
      if (!g) return;
      if (!(await confirmDialog({ title: '删除用户组「' + g.name + '」？', text: '手动指定该组的成员会回退到按经验值自动匹配的组，删除后不可恢复', okText: '删除', danger: true }))) return;
      try { await admReq('/api/admin/groups/' + g.id, { method: 'DELETE' }); toast('已删除'); S.groups = null; admGroups($('#adm-body')); } catch (e) { /* 已提示 */ }
    }));
  }

  function admGroupForm(item) {
    const isNew = !item;
    const cur = item || { name: '', icon: '🌱', color: '#07C160', level: (S.groups ? S.groups.length + 1 : 1), minExp: 0, sort: 0 };
    const colors = ['#07C160', '#576B95', '#FA9D3B', '#E6655C', '#10AEFF', '#8B7BD8', '#00C2C7', '#9AA0A6'];
    const icons = GROUP_ICONS;
    const customIcon = icons.indexOf(cur.icon) >= 0 ? '' : (cur.icon || '');
    openSheet({
      title: isNew ? '新建用户组' : '编辑用户组',
      body: `
        <div class="adm-form">
          <label>用户组名称<input class="field" id="g-name" maxlength="12" value="${esc(cur.name)}" placeholder="例如：活跃会员" /></label>
          <label>图标（共 ${icons.length} 个可选）
            <div class="adm-picker scroll" id="g-icons">${icons.map((i) => `<button type="button" data-ic="${i}" class="${i === cur.icon ? 'on' : ''}">${i}</button>`).join('')}</div>
            <input class="field" id="g-icon-custom" maxlength="4" value="${esc(customIcon)}" placeholder="也可直接粘贴自定义 emoji，如 🍄" style="margin-top:8px" />
          </label>
          <label>主题色
            <div class="adm-picker" id="g-colors">${colors.map((c) => `<button type="button" data-cl="${c}" class="${c === cur.color ? 'on' : ''}" style="background:${c}"></button>`).join('')}</div>
          </label>
          <label>等级（数字，越大越高）<input class="field" id="g-level" type="number" min="1" value="${cur.level}" /></label>
          <label>所需经验（达到即自动升级到此组）<input class="field" id="g-exp" type="number" min="0" value="${cur.minExp}" /></label>
          <label>排序（越小越靠前）<input class="field" id="g-sort" type="number" value="${cur.sort || 0}" /></label>
          <button class="btn primary block" id="g-save" style="margin-top:8px">${isNew ? '创建用户组' : '保存修改'}</button>
        </div>`,
      onMount(sheet) {
        let icon = cur.icon, color = cur.color;
        const customInput = $('#g-icon-custom', sheet);
        $$('[data-ic]', sheet).forEach((b) => (b.onclick = () => {
          $$('[data-ic]', sheet).forEach((x) => x.classList.remove('on'));
          b.classList.add('on'); icon = b.dataset.ic;
          if (customInput) customInput.value = '';
        }));
        if (customInput) customInput.oninput = () => {
          const v = customInput.value.trim();
          if (!v) return;
          icon = v;
          $$('[data-ic]', sheet).forEach((x) => x.classList.remove('on'));
        };
        $$('[data-cl]', sheet).forEach((b) => (b.onclick = () => { $$('[data-cl]', sheet).forEach((x) => x.classList.remove('on')); b.classList.add('on'); color = b.dataset.cl; }));
        $('#g-save', sheet).onclick = async () => {
          const payload = {
            name: $('#g-name', sheet).value.trim(),
            icon: (customInput && customInput.value.trim()) || icon,
            color,
            level: Number($('#g-level', sheet).value) || 1,
            minExp: Number($('#g-exp', sheet).value) || 0,
            sort: Number($('#g-sort', sheet).value) || 0,
          };
          if (!payload.name) { toast('请填写用户组名称'); return; }
          try {
            if (isNew) await admReq('/api/admin/groups', { method: 'POST', body: payload });
            else await admReq('/api/admin/groups/' + item.id, { method: 'PUT', body: payload });
            toast(isNew ? '用户组已创建' : '已保存');
            S.groups = null;
            closeOverlays();
            admGroups($('#adm-body'));
          } catch (e) { /* 已提示 */ }
        };
      },
    });
  }

  /* ---------------- 勋章 ---------------- */
  async function admBadges(box) {
    let list;
    try { list = await admReq('/api/admin/badges'); } catch (e) {
      if (!box.isConnected) return;
      box.innerHTML = `<div class="empty">加载失败</div>`; return;
    }
    S.badges = list;
    box.innerHTML = `
      <div class="adm-toolbar">
        <div class="adm-hint">共 <b>${list.length}</b> 枚勋章 · 在「用户」中可给成员授予</div>
        <div class="grow"></div>
        <button class="btn sm primary" data-new-badge>${icon('plus', 15)} 新建勋章</button>
      </div>
      <div class="adm-tiles">
        ${list.map((b) => `
          <div class="adm-tile">
            <div class="adm-tile-h">
              <div class="adm-tile-ico" style="background:${esc(b.color)}">${esc(b.icon)}</div>
              <div class="grow" style="min-width:0">
                <div class="adm-tile-name">${esc(b.name)}</div>
                <div class="adm-tile-lv">已授予 ${num(b.grantCount)} 人 · 排序 ${b.sort}</div>
              </div>
            </div>
            <div class="adm-tile-desc">${esc(b.description || '暂无说明')}</div>
            <div class="adm-tile-ops">
              <button class="btn sm ghost" data-ebg="${b.id}">编辑</button>
              <button class="btn sm ghost danger" data-dbg="${b.id}">删除</button>
            </div>
          </div>`).join('')}
      </div>`;
    $('[data-new-badge]', box).onclick = () => admBadgeForm(null);
    $$('[data-ebg]', box).forEach((b) => (b.onclick = () => admBadgeForm(S.badges.find((x) => x.id === Number(b.dataset.ebg)))));
    $$('[data-dbg]', box).forEach((b) => (b.onclick = async () => {
      const bd = S.badges.find((x) => x.id === Number(b.dataset.dbg));
      if (!bd) return;
      if (!(await confirmDialog({ title: '删除勋章「' + bd.name + '」？', text: '所有用户持有的该勋章也会被收回，删除后不可恢复', okText: '删除', danger: true }))) return;
      try { await admReq('/api/admin/badges/' + bd.id, { method: 'DELETE' }); toast('已删除'); S.badges = null; admBadges($('#adm-body')); } catch (e) { /* 已提示 */ }
    }));
  }

  function admBadgeForm(item) {
    const isNew = !item;
    const cur = item || { name: '', icon: '🏅', color: '#07C160', description: '', sort: 0 };
    const colors = ['#07C160', '#576B95', '#FA9D3B', '#E6655C', '#10AEFF', '#8B7BD8', '#00C2C7', '#9AA0A6'];
    const icons = ['🏅', '🎉', '✍️', '🔥', '🎓', '🛡', '👑', '🎖', '💎', '⭐', '✨', '🚀'];
    openSheet({
      title: isNew ? '新建勋章' : '编辑勋章',
      body: `
        <div class="adm-form">
          <label>勋章名称<input class="field" id="d-name" maxlength="12" value="${esc(cur.name)}" placeholder="例如：妙笔生花" /></label>
          <label>图标
            <div class="adm-picker" id="d-icons">${icons.map((i) => `<button type="button" data-ic="${i}" class="${i === cur.icon ? 'on' : ''}">${i}</button>`).join('')}</div>
          </label>
          <label>主题色
            <div class="adm-picker" id="d-colors">${colors.map((c) => `<button type="button" data-cl="${c}" class="${c === cur.color ? 'on' : ''}" style="background:${c}"></button>`).join('')}</div>
          </label>
          <label>获得条件说明<input class="field" id="d-desc" maxlength="60" value="${esc(cur.description || '')}" placeholder="例如：累计发布 10 篇优质帖子" /></label>
          <label>排序（越小越靠前）<input class="field" id="d-sort" type="number" value="${cur.sort || 0}" /></label>
          <button class="btn primary block" id="d-save" style="margin-top:8px">${isNew ? '创建勋章' : '保存修改'}</button>
        </div>`,
      onMount(sheet) {
        let icon = cur.icon, color = cur.color;
        $$('[data-ic]', sheet).forEach((b) => (b.onclick = () => { $$('[data-ic]', sheet).forEach((x) => x.classList.remove('on')); b.classList.add('on'); icon = b.dataset.ic; }));
        $$('[data-cl]', sheet).forEach((b) => (b.onclick = () => { $$('[data-cl]', sheet).forEach((x) => x.classList.remove('on')); b.classList.add('on'); color = b.dataset.cl; }));
        $('#d-save', sheet).onclick = async () => {
          const payload = {
            name: $('#d-name', sheet).value.trim(), icon, color,
            description: $('#d-desc', sheet).value.trim(),
            sort: Number($('#d-sort', sheet).value) || 0,
          };
          if (!payload.name) { toast('请填写勋章名称'); return; }
          try {
            if (isNew) await admReq('/api/admin/badges', { method: 'POST', body: payload });
            else await admReq('/api/admin/badges/' + item.id, { method: 'PUT', body: payload });
            toast(isNew ? '勋章已创建' : '已保存');
            S.badges = null;
            closeOverlays();
            admBadges($('#adm-body'));
          } catch (e) { /* 已提示 */ }
        };
      },
    });
  }

  /* ---------------- 举报 ---------------- */
  async function admReports(box) {
    let list;
    try { list = await admReq('/api/admin/reports'); } catch (e) {
      if (!box.isConnected) return;
      box.innerHTML = `<div class="empty">加载失败</div>`; return;
    }
    S.reports = list;
    box.innerHTML = `<div class="adm-panel">
      <div class="adm-panel-h"><b>举报记录</b><span class="adm-hint">最近 50 条</span></div>
      ${list.length ? `<div class="adm-list">${list.map((r, i) => `
        <div class="adm-item ${i % 2 ? 'stripe' : ''}">
          <div class="adm-item-main">
            <div class="adm-item-title">
              <span class="adm-tag on">${r.type === 'post' ? '帖子' : r.type === 'comment' ? '评论' : '用户'} #${r.targetId}</span>
              <span class="adm-item-t">${esc(r.reason)}</span>
            </div>
            <div class="adm-item-sub"><span>举报人 ${esc(r.author)}</span><i>·</i><span>${r.createdAgo}</span></div>
          </div>
          <div class="adm-item-ops">
            ${r.type === 'post' ? `<a class="btn sm ghost" href="/#/post?id=${r.targetId}" target="_blank" rel="noopener">查看</a>` : ''}
            <button class="btn sm ghost" data-rm="${r.id}">标记已处理</button>
          </div>
        </div>`).join('')}</div>` : `<div class="empty">暂无举报，社区很干净</div>`}
    </div>`;
    $$('[data-rm]', box).forEach((b) => (b.onclick = async () => {
      try { await admReq('/api/admin/reports/' + b.dataset.rm, { method: 'DELETE' }); toast('已处理'); admReports(box); } catch (e) { /* */ }
    }));
  }

  /* ---------------- 小工具 ---------------- */
  function renderPager(sel, st, reload) {
    const pager = $(sel);
    if (!pager) return;
    if (st.pages <= 1) { pager.innerHTML = ''; return; }
    pager.innerHTML = `<button class="btn sm ghost" data-pg="prev" ${st.page <= 1 ? 'disabled' : ''}>上一页</button>
      <span class="adm-hint">${st.page} / ${st.pages}</span>
      <button class="btn sm ghost" data-pg="next" ${st.page >= st.pages ? 'disabled' : ''}>下一页</button>`;
    $$('[data-pg]', pager).forEach((b) => (b.onclick = () => {
      st.page += b.dataset.pg === 'next' ? 1 : -1;
      reload();
    }));
  }

  function skeletonRows(n) {
    return Array.from({ length: n }).map(() => `
      <div class="adm-skel">
        <div class="sk-line w40"></div>
        <div class="sk-line w80"></div>
        <div class="sk-line w60"></div>
      </div>`).join('');
  }

  async function refreshMe() {
    try {
      const r = await api('/api/me');
      S.me = r.user;
    } catch (e) { S.me = null; }
  }

  /* ---------------- 启动 ---------------- */
  async function boot() {
    // token 来自前台共享的 localStorage
    const token = getToken();
    if (!token) { S.loading = false; render(); return; }
    try {
      const r = await api('/api/me', { silent: true });
      S.me = r.user;
    } catch (e) {
      if (e && e.status === 440) S.me = null;
    }
    S.loading = false;
    render();

    // 浏览器前进/后退
    window.addEventListener('popstate', () => {
      if (!S.me || !S.me.isAdmin) return;
      renderTab();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
