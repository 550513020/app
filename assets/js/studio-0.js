/* ================= 五大系统 · 网页端「音乐工坊」=================
   把这些能力直接做进网页：账号、搜歌、音频库、音频转谱、系统总览。
   和服务端 systems/api_routes.py 一一对应。
   桌面网页端和手机端都能用（手机端也能搜歌、看音频库、跑转谱）。 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = 'p2k-account-token-v2';

  const state = {
    token: localStorage.getItem(TOKEN_KEY) || '',
    user: '',
    tab: 'account',
    search: [],
    selected: null,
    lastScore: null,
  };

  function api(path, options) {
    const opts = options || {};
    const base = apiBase();
    if (!base) {
      return Promise.reject(new Error('当前是离线内置页面，先联网点一次「⟳ 更新同步」把电脑地址记下来'));
    }
    const headers = opts.headers || {};
    if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
    // 手机版经常要等服务器识别（可能几分钟），所以支持自定义超时
    const fetchOptions = { ...opts, headers };
    delete fetchOptions.timeout;
    if (opts.timeout && typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
      fetchOptions.signal = AbortSignal.timeout(opts.timeout);
    }
    return fetch(base + path, fetchOptions).then(async (res) => {
      let data = {};
      try { data = await res.json(); } catch (e) { /* 空响应 */ }
      if (!res.ok) throw new Error(data.detail || ('请求失败 ' + res.status));
      return data;
    });
  }
  function apiBase() {
    // 内置到 APK 的页面是 file:// 打开：不能拼出 file:///…/api 这种地址（会被 CORS 拦掉）。
    // 这种情况下用之前联网时记下来的电脑地址（或原生注入的地址）。
    if (/^file:/i.test(location.protocol)) {
      const saved = localStorage.getItem('p2k-service-base-v1');
      if (saved) return saved.replace(/\/$/, '') + '/api';
      if (typeof P2K_NATIVE_BASE !== 'undefined' && P2K_NATIVE_BASE) return String(P2K_NATIVE_BASE).replace(/\/$/, '') + '/api';
      return '';
    }
    if (typeof P2K_API !== 'undefined' && P2K_API) return P2K_API.replace(/\/api$/, '') + '/api';
    // 联网打开时把地址记下来，供离线内置页面以后使用
    try { localStorage.setItem('p2k-service-base-v1', location.origin); } catch (e) { /* 隐私模式忽略 */ }
    return '/api';
  }
  function online() {
    return !!apiBase();
  }
  function msg(text, tone) {
    const box = $('p2kStudioMsg');
    if (!box) return;
    box.textContent = text;
    box.dataset.tone = tone || '';
    box.hidden = !text;
  }
  function esc(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /* 「找谱（仓库 PDF）」手机和电脑完全一样：都显示、都能看谱 */
  function openStudio(tab) {
    const panel = $('p2kStudio');
    if (!panel) return;
    panel.hidden = false;
    switchTab(tab || state.tab);
    renderAccount();
  }
  window.p2kOpenStudio = openStudio;

  function closeStudio() {
    const panel = $('p2kStudio');
    if (panel) panel.hidden = true;
  }

  function switchTab(tab) {
    state.tab = tab;
    document.querySelectorAll('#p2kStudio [data-tab]').forEach((button) => {
      button.classList.toggle('active', button.dataset.tab === tab);
    });
    document.querySelectorAll('#p2kStudio [data-panel]').forEach((section) => {
      section.hidden = section.dataset.panel !== tab;
    });
    if (tab === 'audio') {
      // 音频库（App 主功能）：手机本机引擎转谱 + 手机导入音频/PDF
      if (window.p2kAudioTab && typeof window.p2kAudioTab.render === 'function') {
        window.p2kAudioTab.render().catch((error) => msg('音频库加载失败：' + error.message, 'warn'));
      } else {
        loadAudioLibrary();
      }
    } else if (tab === 'search') {
      // 找谱：只列仓库里的 PDF（不再搜网络歌源）
      if (window.p2kScoreRepo && typeof window.p2kScoreRepo.render === 'function') {
        window.p2kScoreRepo.render().catch((error) => msg('找谱失败：' + error.message, 'warn'));
      }
    }
    if (tab === 'systems') loadSystems();
    if (tab === 'account') renderAccount();
  }

  // ------------------------------------------------------------ 01 账号
  function renderAccount() {
    const who = $('p2kStudioWho');
    if (who) who.textContent = state.user ? ('已登录：' + state.user) : '未登录（登录后曲库与收藏跟着账号走）';
    const out = $('p2kStudioAccountOut');
    if (out && !state.user) out.textContent = '还没有登录。注册只要账号 + 密码，不需要邮箱或手机验证。';
  }

  async function register() {
    const username = ($('p2kStudioUser') || {}).value || '';
    const password = ($('p2kStudioPass') || {}).value || '';
    try {
      msg('正在注册…');
      const data = await api('/account/register', { method: 'POST', body: JSON.stringify({ username, password }) });
      state.token = data.token || '';
      state.user = data.username || username;
      localStorage.setItem(TOKEN_KEY, state.token);
      msg('注册成功，已自动登录：' + state.user, 'ok');
      renderAccount();
      loadAccountItems();
    } catch (error) {
      msg('注册失败：' + error.message, 'warn');
    }
  }

  async function login() {
    const username = ($('p2kStudioUser') || {}).value || '';
    const password = ($('p2kStudioPass') || {}).value || '';
    try {
      msg('正在登录…');
      const data = await api('/account/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      state.token = data.token || '';
      state.user = data.username || username;
      localStorage.setItem(TOKEN_KEY, state.token);
      msg('登录成功：' + state.user, 'ok');
      renderAccount();
      loadAccountItems();
    } catch (error) {
      msg('登录失败：' + error.message, 'warn');
    }
  }

  async function loadAccountItems() {
    if (!state.token) return;
    try {
      const data = await api('/account/me');
      state.user = data.username;
      const summary = data.summary || {};
      const items = await api('/account/items');
      const list = (items.items || []).map((item) =>
        `<li><strong>${esc(item.title)}</strong> <span class="tiny muted">${esc(item.kind)} · ${esc(item.created_at)}</span></li>`).join('');
      const out = $('p2kStudioAccountOut');
      if (out) {
        out.innerHTML =
          `<p>曲谱 ${summary.scores || 0} · 收藏 ${summary.favorites || 0} · 音频 ${summary.audios || 0} · 离线可用：是</p>` +
          (list ? `<ul class="p2k-studio-list">${list}</ul>` : '<p class="tiny muted">这个账号还没有保存过内容。</p>');
      }
      renderAccount();
    } catch (error) {
      msg('读取账号信息失败：' + error.message, 'warn');
    }
  }

  function logout() {
    api('/account/logout', { method: 'POST' }).catch(() => {});
    state.token = '';
    state.user = '';
    localStorage.removeItem(TOKEN_KEY);
    renderAccount();
    msg('已退出登录', 'ok');
  }

  // ------------------------------------------------------------ 02 搜索
  async function doSearch() {
    const keyword = ($('p2kStudioQuery') || {}).value || '';
    if (!keyword.trim()) { msg('请输入歌名或歌手', 'warn'); return; }
    msg('正在完整版音源里查找「' + keyword + '」（ccMixter / Jamendo / Internet Archive / 本机文件）…');
    const box = $('p2kStudioResults');
    if (box) box.innerHTML = '<p class="tiny muted">搜索中…</p>';
    try {
      const data = await api('/music/search?limit=8&full_only=true&q=' + encodeURIComponent(keyword));
      state.search = data.results || [];
      renderResults(data);
      const failed = Object.keys(data.errors || {});
      msg('找到 ' + state.search.length + ' 个候选' + (data.fromCache ? '（来自缓存，断网也能看）' : '') +
          (failed.length ? ' · 这些源暂时不可用：' + failed.join('、') : ''), 'ok');
    } catch (error) {
      msg('搜索失败：' + error.message, 'warn');
      if (box) box.innerHTML = '';
    }
  }

  function renderResults(data) {
    const box = $('p2kStudioResults');
    if (!box) return;
    if (!state.search.length) {
      box.innerHTML = '<p class="tiny muted">没有匹配的候选。可以换个写法（比如只写歌名，或加上歌手名）。</p>';
      return;
    }
    box.innerHTML = state.search.map((item, index) => {
      const badges = [];
      if (item.alreadyLocal) badges.push('<em class="p2k-badge ok">本机已有</em>');
      if (item.fullLength) badges.push('<em class="p2k-badge ok">完整版</em>');
      if (item.canDownload) badges.push('<em class="p2k-badge">可下载</em>');
      if (!item.canDownload && !item.alreadyLocal) badges.push('<em class="p2k-badge muted">仅元数据</em>');
      const duration = item.durationSec ? Math.floor(item.durationSec / 60) + ':' + String(item.durationSec % 60).padStart(2, '0') : '';
      return `<div class="p2k-hit" data-index="${index}">
        <div class="p2k-hit-main">
          <strong>${esc(item.title)}</strong>
          <span class="tiny muted">${esc(item.artist || '未知艺人')}${item.album ? ' · ' + esc(item.album) : ''}${duration ? ' · ' + duration : ''}</span>
          <span class="tiny muted">${esc(item.source)} · ${esc(item.detail || '')}</span>
          <span>${badges.join(' ')}</span>
        </div>
        <div class="p2k-hit-actions">
          <button type="button" data-act="pick" data-index="${index}" class="primary">选它</button>
        </div>
      </div>`;
    }).join('');
    box.querySelectorAll('[data-act="pick"]').forEach((button) => {
      button.onclick = () => pickCandidate(Number(button.dataset.index));
    });
  }

  function pickCandidate(index) {
    const item = state.search[index];
    if (!item) return;
    state.selected = item;
    const box = $('p2kStudioPick');
    if (box) {
      box.hidden = false;
      box.innerHTML = `<p>已选：<strong>${esc(item.title)}</strong> ${item.artist ? '· ' + esc(item.artist) : ''}</p>
        <p class="tiny muted">${esc(item.source)} · ${esc(item.detail || '')}</p>
        <div class="p2k-studio-actions">
          ${item.alreadyLocal ? `<button type="button" id="p2kPickToScore" class="primary">用这个文件转琴谱</button>` : ''}
          ${item.downloadUrl ? `<button type="button" id="p2kPickDownload" class="${item.alreadyLocal ? '' : 'primary'}">下载到本机音频库</button>` : ''}
          ${item.pageUrl ? `<a class="p2k-link" href="${esc(item.pageUrl)}" target="_blank" rel="noreferrer">打开来源页面下载整曲</a>` : ''}
          ${!item.alreadyLocal && !item.downloadUrl && !item.pageUrl ? '<span class="tiny muted">这个来源只提供信息，换一个有「可下载」标记的候选。</span>' : ''}
        </div>`;
    }
    const downloadBtn = $('p2kPickDownload');
    if (downloadBtn) downloadBtn.onclick = () => downloadSelected();
    const toScoreBtn = $('p2kPickToScore');
    if (toScoreBtn) toScoreBtn.onclick = () => transcribe(item.path);
  }

  async function downloadSelected() {
    const item = state.selected;
    if (!item || !item.downloadUrl) { msg('这个候选没有可直接下载的链接', 'warn'); return; }
    try {
      msg('正在下载「' + item.title + '」…');
      const data = await api('/audio/fetch', {
        method: 'POST',
        body: JSON.stringify({ url: item.downloadUrl, title: item.title, artist: item.artist, kind: 'preview' }),
      });
      msg('已下载到本机：' + data.path, 'ok');
      item.alreadyLocal = true;
      item.path = data.path;
      pickCandidate(state.search.indexOf(item));
      loadAudioLibrary();
    } catch (error) {
      msg('下载失败：' + error.message, 'warn');
    }
  }

  // ------------------------------------------------------------ 03 音频库
  async function loadAudioLibrary() {
    const box = $('p2kStudioAudio');
    if (!box) return;
    box.innerHTML = '<p class="tiny muted">正在读取音频库…</p>';
    try {
      const data = await api('/audio/library');
      const downloaded = (data.downloaded || []).map((file) =>
        `<li><strong>${esc(file.name)}</strong> <span class="tiny muted">${esc(file.ext)} · ${esc(file.sizeText)}</span>
         <button type="button" data-path="${esc(file.path)}" class="p2k-mini primary">转琴谱</button></li>`).join('');
      const scanned = (data.scannedSample || []).slice(0, 12).map((file) =>
        `<li><strong>${esc(file.name)}</strong> <span class="tiny muted">${esc(file.ext)} · ${esc(file.sizeText)}</span>
         <button type="button" data-path="${esc(file.path)}" class="p2k-mini primary">转琴谱</button></li>`).join('');
      box.innerHTML = `
        <div class="p2k-studio-row">
          <button type="button" id="p2kAudioUploadBtn" class="primary">＋ 手动导入音频文件</button>
          <button type="button" id="p2kAudioRescan">重新扫描本机音频</button>
          <button type="button" id="p2kAudioOpenDir">打开下载目录</button>
          <button type="button" id="p2kAudioQq">唤起 QQ音乐下载</button>
          <input type="file" id="p2kAudioFile" accept="audio/*,.mp3,.flac,.wav,.m4a,.aac,.ogg,.wma,.ape" multiple hidden>
        </div>
        <p class="tiny muted">手动导入：直接选你电脑里的音频（自己买的、录的、下载的都行），导入后立刻能转谱练习。</p>
        <p class="tiny muted">已下载到项目：${(data.downloaded || []).length} 个 · 本机扫描到：${data.scannedCount || 0} 个（下列为前 12 个）</p>
        <h4>已下载（可直接转谱）</h4>
        <ul class="p2k-studio-list">${downloaded || '<li class="tiny muted">还没有下载过音频。可以去「搜歌」里挑一个可下载的候选。</li>'}</ul>
        <h4>本机音乐文件</h4>
        <ul class="p2k-studio-list">${scanned || '<li class="tiny muted">没扫到音频。把文件放进「音乐」文件夹或 QQ音乐下载目录后重新扫描。</li>'}</ul>`;
      box.querySelectorAll('[data-path]').forEach((button) => {
        button.onclick = () => transcribe(button.dataset.path);
      });
      const rescan = $('p2kAudioRescan');
      if (rescan) rescan.onclick = loadAudioLibrary;
      const uploadBtn = $('p2kAudioUploadBtn');
      const fileInput = $('p2kAudioFile');
      if (uploadBtn && fileInput) {
        uploadBtn.onclick = () => fileInput.click();
        fileInput.onchange = () => uploadFiles(fileInput.files);
      }
      const openDir = $('p2kAudioOpenDir');
      if (openDir) openDir.onclick = async () => {
        const r = await api('/audio/reveal', { method: 'POST', body: JSON.stringify({ which: 'downloads' }) });
        msg('已打开：' + r.path, 'ok');
      };
      const qq = $('p2kAudioQq');
      if (qq) qq.onclick = async () => {
        const keyword = ($('p2kStudioQuery') || {}).value || '';
        const r = await api('/audio/open-qqmusic', { method: 'POST', body: JSON.stringify({ q: keyword, mode: 'search' }) });
        msg(r.hint || '已唤起 QQ音乐', r.ok ? 'ok' : 'warn');
      };
    } catch (error) {
      box.innerHTML = '<p class="tiny warn">音频库读取失败：' + esc(error.message) + '</p>';
    }
  }

  // 手动导入：把选中的文件逐个上传到本机音频库
  async function uploadFiles(files) {
    if (!files || !files.length) return;
    msg('正在导入 ' + files.length + ' 个文件…');
    let ok = 0;
    const failed = [];
    for (const file of files) {
      try {
        const form = new FormData();
        form.append('file', file, file.name);
        const res = await fetch(apiBase() + '/audio/upload', { method: 'POST', body: form });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || ('HTTP ' + res.status));
        ok += 1;
      } catch (error) {
        failed.push(file.name + '：' + error.message);
      }
    }
    msg('导入完成：成功 ' + ok + ' 个' + (failed.length ? '；失败 ' + failed.length + ' 个 —— ' + failed.slice(0, 2).join('；') : ''), failed.length ? 'warn' : 'ok');
    loadAudioLibrary();
  }

  // ------------------------------------------------------------ 04 音频转谱
  async function transcribe(path) {
    if (!path) { msg('没有选中的音频文件', 'warn'); return; }
    switchTab('score');
    const box = $('p2kStudioScore');
    const tempo = Number(($('p2kStudioTempo') || {}).value) || 100;
    if (box) box.innerHTML = '<p class="tiny muted">正在分析音频、提取音高…（一首歌可能要几十秒）</p>';
    msg('正在转谱：' + path.split(/[\\/]/).pop());
    try {
      const data = await api('/score/transcribe', { method: 'POST', body: JSON.stringify({ path, tempo }) });
      state.lastScore = data;
      if (box) {
        box.innerHTML = `
          <p class="ok">识别完成：<strong>${data.noteCount}</strong> 个音 · 音域 ${esc(data.pitchRange || '')}</p>
          <div class="p2k-studio-actions">
            <button type="button" id="p2kUseInPractice" class="primary">拿去练习（载入音块）</button>
            <button type="button" id="p2kCapellaRun">用 Capella 高质量转谱</button>
            <button type="button" id="p2kSaveFavorite">存进我的收藏</button>
          </div>
          <p class="tiny muted">MIDI：${esc(data.midi)}<br>琴谱：${esc(data.musicxml)}</p>
          <div class="p2k-score-preview">${(data.notes || []).slice(0, 40).map((n) =>
            `<span class="p2k-note">${esc(n.name)}<em>${n.start}s</em></span>`).join('')}</div>`;
      }
      msg('转谱完成，可以直接拿去练习', 'ok');
      const useBtn = $('p2kUseInPractice');
      if (useBtn) useBtn.onclick = useInPractice;
      const capellaBtn = $('p2kCapellaRun');
      if (capellaBtn) capellaBtn.onclick = () => capellaRun(path);
      const favBtn = $('p2kSaveFavorite');
      if (favBtn) favBtn.onclick = saveScoreAsFavorite;
    } catch (error) {
      if (box) box.innerHTML = '<p class="tiny warn">转谱失败：' + esc(error.message) + '</p>';
      msg('转谱失败：' + error.message, 'warn');
    }
  }

  function useInPractice() {
    const data = state.lastScore;
    if (!data || !data.events || !data.events.length) { msg('还没有可用的识别结果', 'warn'); return; }
    if (typeof window.p2kPhoneLoadEventsForTest === 'function') {
      window.p2kPhoneLoadEventsForTest({ title: '音频转谱 · ' + (data.source || '').split(/[\\/]/).pop(), events: data.events, meter: '4/4' });
      closeStudio();
      msg('已载入练习页，点「选择模式」开始', 'ok');
    } else {
      msg('当前不在手机练习页，请先打开手机的练习页面再试', 'warn');
    }
  }

  async function saveScoreAsFavorite() {
    const data = state.lastScore;
    if (!data) return;
    if (!state.token) { msg('先登录账号再保存收藏（这样换设备也能看到）', 'warn'); return; }
    try {
      await api('/account/items', {
        method: 'POST',
        body: JSON.stringify({ kind: 'score', title: (data.source || '音频转谱').split(/[\\/]/).pop(), payload: JSON.stringify({ events: data.events, musicxml: data.musicxml, midi: data.midi }) }),
      });
      msg('已存进账号的曲库', 'ok');
      loadAccountItems();
    } catch (error) {
      msg('保存失败：' + error.message, 'warn');
    }
  }

  async function capellaRun(path) {
    try {
      msg('正在唤起本机 capella audio2score pro 5 …');
      const data = await api('/score/capella-run', { method: 'POST', body: JSON.stringify({ path }) });
      msg(data.ok ? ('Capella 转谱完成：' + (data.outDir || '')) : ('Capella：' + (data.error || '需要手动点一下')), data.ok ? 'ok' : 'warn');
    } catch (error) {
      msg('Capella 调用失败：' + error.message, 'warn');
    }
  }

  // ------------------------------------------------------------ 系统总览
  async function loadSystems() {
    const box = $('p2kStudioSystems');
    if (!box) return;
    box.innerHTML = '<p class="tiny muted">正在读取系统状态…</p>';
    try {
      const data = await api('/systems');
      const systems = (data.systems || []).map((s) => `
        <div class="p2k-sys-card">
          <div class="p2k-sys-head"><span class="p2k-sys-key">${esc(s.key)}</span><strong>${esc(s.title)}</strong>
            <em class="p2k-badge ${/已实现/.test(s.status) ? 'ok' : ''}">${esc(s.status)}</em></div>
          <p class="tiny muted">${esc(s.summary)}</p>
          <p class="tiny muted">目录：<code>${esc(s.folder)}</code></p>
          <p class="tiny muted">接口：${(s.endpoints || []).map((e) => '<code>' + esc(e) + '</code>').join(' ') || '—'}</p>
        </div>`).join('');
      const tools = (data.tools || []).map((t) => `
        <li><strong>${esc(t.name)}</strong> ${t.available ? '<em class="p2k-badge ok">可用</em>' : '<em class="p2k-badge muted">未安装</em>'}
        <span class="tiny muted">${esc(t.path || (t.note || ''))}</span></li>`).join('');
      box.innerHTML = `<h4>五大系统</h4>${systems}<h4>本机可用软件</h4><ul class="p2k-studio-list">${tools}</ul>`;
    } catch (error) {
      box.innerHTML = '<p class="tiny warn">读取失败：' + esc(error.message) + '</p>';
    }
  }

  // ------------------------------------------------------------ 绑定
  function bind() {
    // 桌面工具栏 + 手机曲库页 + 手机设置面板，三处入口都绑上
    const openers = ['p2kOpenStudioBtn', 'p2kOpenStudioTop', 'phoneOpenStudio', 'phoneOpenStudio2'];
    openers.forEach((id) => {
      const el = $(id);
      if (el) el.onclick = () => openStudio();
    });
    const close = $('p2kStudioClose');
    if (close) close.onclick = closeStudio;
    document.querySelectorAll('#p2kStudio [data-tab]').forEach((button) => {
      button.onclick = () => switchTab(button.dataset.tab);
    });
    const searchBtn = $('p2kStudioSearchBtn');
    if (searchBtn) searchBtn.onclick = doSearch;
    const query = $('p2kStudioQuery');
    if (query) query.addEventListener('keydown', (event) => { if (event.key === 'Enter') doSearch(); });
    const regBtn = $('p2kStudioRegisterBtn');
    if (regBtn) regBtn.onclick = register;
    const loginBtn = $('p2kStudioLoginBtn');
    if (loginBtn) loginBtn.onclick = login;
    const outBtn = $('p2kStudioLogoutBtn');
    if (outBtn) outBtn.onclick = logout;
    // 离线内置页面（file://）不发网络请求，只提示联网后再用
    if (online() && state.token) loadAccountItems();
    else if (!online()) msg('当前是离线内置页面：曲库/收藏照常能用；账号、搜歌、转谱请先联网点一次「⟳ 更新同步」。');
    renderAccount();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();

  window.p2kStudio = {
    open: openStudio,
    search: doSearch,
    transcribe,
    state,
    reload: loadSystems,
  };
  // 给「音频库」等其他模块用：接口调用与地址判断
  window.p2kStudioInternals = {
    api,
    apiBase,
    hasBase: () => !!apiBase(),
    state,
    msg,
  };
})();
