/* P2K bundle: assets/js/studio-5.js */
/* ============================================================================
   手机端初始化「兜底重试」
   ----------------------------------------------------------------------------
   背景：手机上偶尔（尤其经过公网隧道/弱网）登录注册按钮没有绑定事件，
   表现为点了没反应。原因是大段初始化脚本在个别环境下没跑完。
   做法：页面 load 之后检查关键接线，缺什么补什么。幂等，重复执行安全。
   ========================================================================== */
(function () {
  'use strict';

  function el(id) { return document.getElementById(id); }

  function isPhoneMode() {
    return /[?&]mode=app/.test(location.search);
  }

  function bindPhoneAuth() {
    if (!isPhoneMode()) return false;
    const register = el('phoneRegister');
    const login = el('phoneLoginButton');
    if (!register || !login) return false;
    if (typeof register.onclick === 'function' && typeof login.onclick === 'function') return true;

    // 依赖的全局函数缺失时，说明主流程真的没初始化，这里只能提示
    const need = ['p2kRegister', 'p2kLogin'];
    const missing = need.filter((name) => typeof window[name] !== 'function');
    if (missing.length) {
      const msg = el('phoneAuthMsg');
      if (msg && !msg.textContent) {
        msg.textContent = '页面初始化未完成，请下拉刷新一次再试（网络较慢时容易出现）。';
      }
      return false;
    }

    const done = async (ok) => {
      if (!ok) return;
      el('phoneLogin').hidden = true;
      const out = el('phoneLogout');
      if (out) out.hidden = false;
      el('phoneLibrary').hidden = false;
      if (typeof window.p2kRenderLibraryOffline === 'function') window.p2kRenderLibraryOffline();
      if (typeof window.p2kSyncLibraryNow === 'function') window.p2kSyncLibraryNow();
    };

    if (typeof register.onclick !== 'function') {
      register.onclick = async () => done(await window.p2kRegister(
        el('phoneUsername').value, el('phonePassword').value, el('phoneConsent'), el('phoneAuthMsg')));
    }
    if (typeof login.onclick !== 'function') {
      login.onclick = async () => done(await window.p2kLogin(
        el('phoneUsername').value, el('phonePassword').value, el('phoneAuthMsg')));
    }
    const logout = el('phoneLogout');
    if (logout && typeof logout.onclick !== 'function') {
      logout.onclick = () => {
        if (typeof window.p2kLogout === 'function') window.p2kLogout();
        el('phonePractice').hidden = true;
        el('phoneLibrary').hidden = true;
        el('phoneLogin').hidden = false;
        logout.hidden = true;
      };
    }
    return true;
  }

  /* 主流程没跑完时，把手机端关键按钮补齐 */
  function rescue() {
    const fixed = bindPhoneAuth();
    if (fixed) {
      window.__p2kPhoneRescued = true;
    }
  }

  if (document.readyState === 'complete') {
    setTimeout(rescue, 500);
  } else {
    window.addEventListener('load', () => setTimeout(rescue, 500), { once: true });
  }
  // 弱网时再多试两次
  setTimeout(rescue, 3000);
  setTimeout(rescue, 8000);

  window.p2kPhoneRescue = rescue;
})();

