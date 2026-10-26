/* ============================================================
   微坛 WeForum · 公共核心库（零依赖）
   前台 app.js 与后台 admin.js 共用：DOM 工具 / 图标 / 头像 /
   Toast / 弹层 / 请求封装。挂载到 window.WFCore。
   ============================================================ */
(() => {
  'use strict';

  /* ---------------- 基础工具 ---------------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => {
    n = Number(n) || 0;
    if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '万';
    return String(n);
  };
  const uid = () => Math.random().toString(36).slice(2, 9);

  /* ---------------- Toast / 弹层 ---------------- */
  function toast(msg, ms = 1800) {
    const root = $('#toast-root') || document.body;
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    root.innerHTML = '';
    root.appendChild(el);
    clearTimeout(el._t);
    el._t = setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, ms);
  }

  function closeOverlays() {
    $$('.mask, .sheet, .dialog, .viewer, .glass-mask, .glass-card').forEach((n) => n.remove());
  }

  function openSheet({ title, body, onMount, wide }) {
    closeOverlays();
    const mask = document.createElement('div');
    mask.className = 'mask';
    mask.onclick = closeOverlays;
    const sheet = document.createElement('div');
    sheet.className = 'sheet' + (wide ? ' wide' : '');
    sheet.innerHTML = `
      <div class="handle"></div>
      <div class="sheet-head"><b>${esc(title || '')}</b><button class="icon-btn" data-close>${icon('close')}</button></div>
      <div class="sheet-body"></div>`;
    $('.sheet-body', sheet).innerHTML = body || '';
    document.body.append(mask, sheet);
    $('[data-close]', sheet).onclick = closeOverlays;
    if (onMount) onMount(sheet);
    return sheet;
  }

  function confirmDialog({ title, text, okText = '确定', danger }) {
    return new Promise((resolve) => {
      closeOverlays();
      const mask = document.createElement('div');
      mask.className = 'mask';
      const dlg = document.createElement('div');
      dlg.className = 'dialog';
      dlg.innerHTML = `
        <div class="dialog-body"><h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}</div>
        <div class="dialog-foot"><button data-cancel>取消</button><button data-ok class="${danger ? 'danger' : ''}">${esc(okText)}</button></div>`;
      document.body.append(mask, dlg);
      const done = (v) => { mask.remove(); dlg.remove(); resolve(v); };
      mask.onclick = () => done(false);
      $('[data-cancel]', dlg).onclick = () => done(false);
      $('[data-ok]', dlg).onclick = () => done(true);
    });
  }

  function viewer(src) {
    const v = document.createElement('div');
    v.className = 'viewer';
    v.innerHTML = `<img src="${esc(src)}" alt="" /><button class="icon-btn close">${icon('close')}</button>`;
    v.onclick = () => v.remove();
    document.body.appendChild(v);
  }

  /* ---------------- 图标 ---------------- */
  const ICONS = {
    home: '<path d="M3 10.5 12 3l9 7.5V21H3z"/>',
    boards: '<rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/>',
    bell: '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6.5 8-6.5S20 17 20 21"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    back: '<path d="M15 18l-6-6 6-6"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    heart: '<path d="M20.8 5.6a5.2 5.2 0 0 0-7.4 0L12 7l-1.4-1.4a5.2 5.2 0 1 0-7.4 7.4L12 21l8.8-8a5.2 5.2 0 0 0 0-7.4z"/>',
    star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
    comment: '<path d="M21 12a8 8 0 0 1-8 8H7l-4 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z"/>',
    eye: '<path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/>',
    more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m4 17 5-5 4 4 3-3 4 4"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    send: '<path d="m3 3 18 9-18 9 4-9z"/>',
    share: '<circle cx="18" cy="5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/><path d="m8.3 10.8 7.4-4.3M8.3 13.2l7.4 4.3"/>',
    flag: '<path d="M5 21V4h9l-1 4h6l-2 5 2 5h-6l-1-4H5"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14"/>',
    logout: '<path d="M15 17l5-5-5-5M20 12H9M12 3H5v18h7"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/>',
    settings: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 13.7H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10.3 3V3a2 2 0 1 1 4 0v.1A1.7 1.7 0 0 0 17 4.6l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 10.3h.1a2 2 0 1 1 0 4H21a1.7 1.7 0 0 0-1.6 1.2z"/>',
    bookmark: '<path d="M6 3h12v18l-6-4-6 4z"/>',
    fire: '<path d="M12 3s5 4 5 9a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3s-1-3 1-8z"/>',
    board: '<path d="M4 5h16M4 12h16M4 19h10"/>',
    play: '<path d="M6 4l14 8-14 8z"/>',
    check: '<path d="m5 13 4 4L19 7"/>',
    // 后台专用
    dashboard: '<rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="4.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="10.5" width="7.5" height="10.5" rx="2"/>',
    article: '<path d="M4 4h16v16H4z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    users: '<circle cx="9" cy="8" r="3.4"/><path d="M2.5 20c0-3.4 3-5.6 6.5-5.6s6.5 2.2 6.5 5.6"/><path d="M17 5.2a3.4 3.4 0 0 1 0 6.4M18.5 20c0-2.4-.7-3.9-2-5"/>',
    shield: '<path d="M12 3l7 3v6c0 4-3 7.4-7 9-4-1.6-7-5-7-9V6z"/><path d="m9 12 2 2 4-4"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v4h-4"/>',
    lock: '<rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    unlock: '<rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.5-2"/>',
    pin: '<path d="M12 3v9M8 12h8l-1.5 4h-5z"/><path d="M12 16v5"/>',
    external: '<path d="M14 4h6v6M20 4l-8 8"/><path d="M18 14v5H5V6h5"/>',
    menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
    up: '<path d="m6 14 6-6 6 6"/>',
    down: '<path d="m6 10 6 6 6-6"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    group: '<circle cx="7" cy="9" r="3"/><circle cx="17" cy="9" r="3"/><path d="M2 19c0-2.6 2.2-4.5 5-4.5s5 1.9 5 4.5M12.6 15.2c.7-.5 1.5-.7 2.4-.7 2.8 0 5 1.9 5 4.5"/>',
    medal: '<circle cx="12" cy="15" r="5"/><path d="m8.5 3 2 3.4M15.5 3l-2 3.4M9.8 14.2l1.3 1.4 2.6-2.7"/>',
    level: '<path d="M4 19V9M9.3 19V5M14.6 19v-6M20 19V8"/>',
  };
  function icon(name, size = 22) {
    const p = ICONS[name] || '';
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  }
  function iconFill(name, size = 22) {
    const p = ICONS[name] || '';
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round">${p}</svg>`;
  }

  /* ---------------- 头像 ---------------- */
  function avatarHTML(user, cls = '') {
    if (!user) return `<div class="avatar ${cls}" style="background:#C9C9C9">?</div>`;
    const av = user.avatar || '';
    const name = user.nickname || '?';
    const vipCls = user.isVip ? ' vip' : '';
    if (av.startsWith('/uploads/') || av.startsWith('http')) {
      return `<div class="avatar ${cls}${vipCls}"><img src="${esc(av)}" alt="${esc(name)}" loading="lazy" /></div>`;
    }
    let color = '#07C160';
    let ch = name[0];
    if (av.startsWith('avatar:')) {
      const parts = av.split(':');
      color = parts[1] || color;
      ch = parts[2] || ch;
    }
    return `<div class="avatar ${cls}${vipCls}" style="background:${esc(color)}">${esc(ch)}</div>`;
  }

  function fileToDataURL(file, maxSize) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          let { width, height } = img;
          const scale = Math.min(1, maxSize / Math.max(width, height));
          width = Math.round(width * scale); height = Math.round(height * scale);
          const canvas = document.createElement('canvas');
          canvas.width = width; canvas.height = height;
          canvas.getContext('2d').drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', 0.86));
        };
        img.onerror = () => resolve(reader.result);
        img.src = reader.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  /* ---------------- 请求封装工厂 ----------------
     前台与后台的登录态存储位置不同，因此用工厂注入 token 读写与过期处理。
     - getToken(): 当前 token
     - setToken(t): 更新 token（传空字符串表示清除）
     - onAuthExpired(ctx): 登录确实失效时回调（ctx.silent 表示是否静默请求）
     - onNeedLogin(): 未登录却访问了需登录的接口
  */
  function createApi({ getToken, setToken, onAuthExpired, onNeedLogin, baseURL = '' } = {}) {
    const readToken = getToken || (() => '');
    const writeToken = setToken || (() => {});
    // 同一时刻只做一次 440 二次确认，避免并发请求同时打 /api/me
    let verifying = null;

    async function confirmInvalid(token) {
      if (verifying) return verifying;
      verifying = (async () => {
        try {
          const r2 = await fetch(baseURL + '/api/me?_t=' + encodeURIComponent(token), {
            headers: { Authorization: 'Bearer ' + token },
          });
          const d2 = await r2.json().catch(() => ({}));
          return r2.status === 440 || (d2 && d2.data && d2.data.user === null);
        } catch (e) {
          return false; // 网络抖动时不误杀登录态
        } finally {
          verifying = null;
        }
      })();
      return verifying;
    }

    return async function api(path, { method = 'GET', body, silent } = {}) {
      // 云端网关（CloudStudio Gateway）会丢弃自定义请求头，Authorization 传不到后端，
      // 表现为「登录成功但下一个请求就说请先登录」。因此 token 同时走 query 参数 _t，
      // 请求头保留给本地直连/其他环境使用，两边都兼容。
      const token = readToken();
      let url = baseURL + path;
      const headers = { 'Content-Type': 'application/json' };
      if (token) {
        headers.Authorization = 'Bearer ' + token;
        url += (path.includes('?') ? '&' : '?') + '_t=' + encodeURIComponent(token);
      }
      let res;
      try {
        res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
      } catch (e) {
        toast('网络连接失败，请检查服务是否启动');
        throw e;
      }
      let data = {};
      try { data = await res.json(); } catch (e) { /* ignore */ }
      // 后端滑动续期：剩余不足 7 天会下发新 token，这里静默替换，用户无感
      const renewed = res.headers.get('X-Renew-Token');
      if (renewed && token) writeToken(renewed);

      if (!res.ok || data.ok === false) {
        // 440 = 未登录 / 登录已过期。
        // 只有「本来有 token 但确实校验失败」才清理登录态；未登录者只是被拦下，不动任何状态。
        if (res.status === 440) {
          const wasLogged = !!token;
          let reallyInvalid = false;
          if (wasLogged) reallyInvalid = await confirmInvalid(token); // 二次确认
          if (wasLogged && reallyInvalid) {
            writeToken('');
            if (onAuthExpired) onAuthExpired({ silent });
          } else if (!wasLogged) {
            if (onNeedLogin) onNeedLogin(); else toast('请先登录后再操作');
          }
          const e2 = new Error(data.error || '请先登录');
          e2.status = 440;
          throw e2;
        }
        if (!silent) toast(data.error || '请求失败');
        const err = new Error(data.error || 'request failed');
        err.status = res.status;
        throw err;
      }
      return data.data;
    };
  }

  window.WFCore = {
    $, $$, esc, num, uid,
    toast, closeOverlays, openSheet, confirmDialog, viewer,
    ICONS, icon, iconFill,
    avatarHTML, fileToDataURL,
    createApi,
  };
})();
