/* TESLA Home 登录页逻辑 */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const form = $('#login-form');
  const btn = $('#login-btn');
  const msg = $('#login-msg');

  // 登录成功后回到最初想访问的页面(仅允许站内路径,防开放重定向)
  function nextTarget() {
    const next = new URLSearchParams(location.search).get('next') || '/';
    return next.startsWith('/') && !next.startsWith('//') ? next : '/';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.textContent = '';
    btn.disabled = true;
    btn.textContent = '登录中…';
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: $('#login-user').value.trim(),
          password: $('#login-pass').value,
        }),
      });
      if (res.ok) {
        location.href = nextTarget();
        return;
      }
      const data = await res.json().catch(() => ({}));
      msg.textContent = data.detail || (res.status === 429 ? '尝试次数过多,请稍后再试' : '登录失败,请稍后再试');
    } catch (err) {
      msg.textContent = '网络错误,请稍后再试';
    }
    btn.disabled = false;
    btn.textContent = '登 录';
  });
})();
