/* 个人中心:账号管理 + Tesla 授权状态/指引 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  function fmtTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function fmtAgo(ts) {
    if (!ts) return '—';
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 90) return `${Math.round(s)} 秒前`;
    if (s < 5400) return `${Math.round(s / 60)} 分钟前`;
    if (s < 129600) return `${(s / 3600).toFixed(1)} 小时前`;
    return `${Math.round(s / 86400)} 天前`;
  }

  // TeslaMate 管理页链接:与面板同主机,端口 4000(仅本机监听时提示 SSH 隧道)
  const tmUrl = `${location.protocol}//${location.hostname}:4000`;
  $('teslamate-link').href = tmUrl;
  $('teslamate-url').textContent = tmUrl;
  $('ssh-tunnel-cmd').textContent = `ssh -L 4000:127.0.0.1:4000 用户@${location.hostname}`;

  const STEP_ORDER = ['deployed', 'token', 'authorized', 'car', 'synced'];

  function renderSteps(steps) {
    // token(获取令牌)无法自动检测:前面的步骤完成即视为可执行
    const doneMap = {
      deployed: steps.deployed,
      token: steps.deployed,
      authorized: steps.authorized,
      car: steps.car_detected,
      synced: steps.synced,
    };
    let activeMarked = false;
    for (const key of STEP_ORDER) {
      const li = document.querySelector(`li[data-step="${key}"]`);
      const state = li.querySelector('[data-state]');
      li.classList.remove('done', 'active');
      if (doneMap[key]) {
        li.classList.add('done');
        if (state) { state.textContent = key === 'token' ? '' : '已完成'; }
      } else if (!activeMarked && key !== 'token') {
        li.classList.add('active');
        if (state) { state.textContent = '进行中'; state.className = 'step-state wait'; }
        activeMarked = true;
      } else if (state) {
        state.textContent = '';
      }
    }
  }

  function renderStatus(s) {
    $('acct-user-name').textContent = s.user || '—';

    const banner = $('tesla-banner');
    if (s.tesla.authorized) {
      banner.className = 'tesla-banner ok';
      $('tesla-banner-text').textContent = 'Tesla 账号已授权';
      $('tesla-banner-sub').textContent =
        s.tesla.token_updated_ts ? `令牌最近刷新:${fmtAgo(s.tesla.token_updated_ts)}` : '';
    } else {
      banner.className = 'tesla-banner pending';
      $('tesla-banner-text').textContent = '尚未授权 Tesla 账号';
      $('tesla-banner-sub').textContent = '按下方步骤完成授权';
    }

    renderSteps(s.steps || {});

    if (s.cars && s.cars.length) {
      const c = s.cars[0];
      $('car-detect-desc').textContent =
        `已识别:${c.name || '未命名车辆'}(VIN 后 6 位 ${c.vin_tail || '—'})`;
    }

    if (s.sync && s.sync.positions > 0) {
      $('sync-stats').hidden = false;
      $('stat-positions').textContent = s.sync.positions.toLocaleString();
      $('stat-drives').textContent = s.sync.drives.toLocaleString();
      $('stat-charges').textContent = s.sync.charges.toLocaleString();
      $('stat-last').textContent = fmtAgo(s.sync.last_data_ts);
    }

    renderUsers(s.users || [], s.user);
  }

  function renderUsers(users, me) {
    const ul = $('user-list');
    ul.textContent = '';
    for (const u of users) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = u;
      li.appendChild(name);
      if (u === me) {
        const tag = document.createElement('span');
        tag.className = 'me-tag';
        tag.textContent = '当前登录';
        li.appendChild(tag);
      }
      const spacer = document.createElement('span');
      spacer.className = 'spacer';
      li.appendChild(spacer);
      if (u !== me && users.length > 1) {
        const btn = document.createElement('button');
        btn.className = 'btn danger';
        btn.textContent = '删除';
        btn.onclick = () => removeUser(u);
        li.appendChild(btn);
      }
      ul.appendChild(li);
    }
  }

  async function api(path, opts) {
    const resp = await fetch(path, opts);
    if (!resp.ok) {
      let detail = `请求失败(${resp.status})`;
      try { detail = (await resp.json()).detail || detail; } catch (_) { /* 忽略 */ }
      throw new Error(detail);
    }
    return resp.json();
  }

  let pollTimer = null;
  async function loadStatus() {
    try {
      const s = await api('/api/account/status');
      renderStatus(s);
      const allDone = s.steps && s.steps.authorized && s.steps.car_detected && s.steps.synced;
      if (allDone && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    } catch (e) {
      $('tesla-banner-text').textContent = e.message;
    }
  }

  function msg(el, text, ok) {
    el.textContent = text;
    el.className = `form-msg ${ok ? 'ok' : 'err'}`;
  }

  $('pw-submit').onclick = async () => {
    const cur = $('pw-current').value;
    const nw = $('pw-new').value;
    const nw2 = $('pw-new2').value;
    const m = $('pw-msg');
    if (nw !== nw2) return msg(m, '两次输入的新密码不一致', false);
    try {
      await api('/api/account/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: cur, new_password: nw }),
      });
      msg(m, '✓ 修改成功,即将刷新页面,请用新密码重新登录', true);
      setTimeout(() => location.reload(), 2500);
    } catch (e) {
      msg(m, e.message, false);
    }
  };

  $('nu-submit').onclick = async () => {
    const username = $('nu-name').value.trim();
    const password = $('nu-pass').value;
    const m = $('nu-msg');
    try {
      await api('/api/account/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      msg(m, `✓ 已添加账号 ${username}`, true);
      $('nu-name').value = '';
      $('nu-pass').value = '';
      loadStatus();
    } catch (e) {
      msg(m, e.message, false);
    }
  };

  async function removeUser(name) {
    if (!confirm(`确定删除账号「${name}」?`)) return;
    try {
      await api(`/api/account/users/${encodeURIComponent(name)}`, { method: 'DELETE' });
      loadStatus();
    } catch (e) {
      alert(e.message);
    }
  }

  /* ---------- 数据备份 / 迁移 ---------- */
  const bkMsg = $('bk-msg');

  $('bk-export').onclick = () => {
    msg(bkMsg, '正在生成备份(数据库较大时可能需要一两分钟)…', true);
    window.location = '/api/backup/export';
    setTimeout(() => msg(bkMsg, '✓ 导出已开始下载', true), 3000);
  };

  $('bk-import').onclick = async () => {
    const f = $('bk-file').files[0];
    if (!f) { msg(bkMsg, '请先选择备份文件(.tar.gz)', false); return; }
    if (!confirm(`确定导入「${f.name}」?\n\n导入会覆盖当前数据库与面板账号,不可撤销。`)) return;
    const btn = $('bk-import');
    btn.disabled = true;
    msg(bkMsg, '上传并恢复中,请勿关闭页面…', true);
    try {
      const fd = new FormData();
      fd.append('file', f);
      const r = await fetch('/api/backup/import', { method: 'POST', body: fd });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || `HTTP ${r.status}`);
      msg(bkMsg, `✓ 恢复完成${data.users_restored ? '(含面板账号)' : ''}。建议刷新面板首页确认数据。`, true);
      $('bk-file').value = '';
    } catch (e) {
      msg(bkMsg, e.message, false);
    } finally {
      btn.disabled = false;
    }
  };

  loadStatus();
  pollTimer = setInterval(loadStatus, 15000); // 授权完成前每 15 秒自动刷新状态
})();
