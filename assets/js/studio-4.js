/* ============================================================================
   找谱（App 主功能之一）
   ----------------------------------------------------------------------------
   只搜「仓库」里的 PDF，不搜网络歌源：
     - 我的曲库（账号里带 PDF 的琴谱）
     - 本机琴谱文件夹
     - 手机里已导入的谱面（本机存档，离线也能看）
   点结果里的「查看」就打开内置 PDF 阅读器。
   ========================================================================== */
(function () {
  'use strict';

  function el(id) { return document.getElementById(id); }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
  }

  function say(message, kind) {
    const node = el('p2kStudioMsg');
    if (node) {
      node.textContent = message || '';
      node.className = 'p2k-studio-msg' + (kind ? ' ' + kind : '');
      node.hidden = !message;
    }
  }

  /* 手机里已导入的谱面（本机存档） */
  async function localSheets(keyword) {
    try {
      const all = (await window.p2kLocalAll?.()) || [];
      return all
        .filter((item) => String(item.id || '').startsWith('sheet:'))
        .filter((item) => !keyword || String(item.title || '').toLowerCase().includes(keyword))
        .map((item) => ({
          id: item.id,
          title: item.title || '本机谱面',
          source: '手机已导入',
          size: item.size || 0,
          sizeText: ((item.size || 0) / 1048576).toFixed(2) + ' MB',
          bytes: item.bytes,
          local: true,
          updatedAt: item.updated_at || 0,
        }));
    } catch (error) {
      return [];
    }
  }

  /* 仓库里的 PDF（需要服务端；手机离线时只用本机的那部分） */
  async function repoPdfs(keyword) {
    const studio = window.p2kStudioInternals;
    if (!studio || typeof studio.api !== 'function' || !studio.hasBase || !studio.hasBase()) return [];
    try {
      const data = await studio.api('/score/repo?q=' + encodeURIComponent(keyword || '') + '&limit=100');
      return (data.items || []).map((item) => Object.assign({}, item, { local: false }));
    } catch (error) {
      return [];
    }
  }

  /* 打开一份 PDF：用页面内置阅读器 */
  async function viewPdf(item) {
    try {
      let bytes = item.bytes;
      if (!bytes) {
        const studio = window.p2kStudioInternals;
        if (!studio || typeof studio.api !== 'function') throw new Error('需要连接电脑才能取这份琴谱');
        const base = studio.apiBase();
        const headers = {};
        if (studio.state && studio.state.token) headers['Authorization'] = 'Bearer ' + studio.state.token;
        const response = await fetch(base + '/score/repo/file?id=' + encodeURIComponent(item.id), { headers });
        if (!response.ok) throw new Error('取琴谱失败（HTTP ' + response.status + '）');
        bytes = new Uint8Array(await response.arrayBuffer());
      }
      const name = (item.title || 'score') + '.pdf';
      if (typeof window.p2kOpenSheetBytes !== 'function') throw new Error('阅读器没准备好');
      window.p2kOpenSheetBytes(bytes, name);
      say('已打开：' + (item.title || ''), 'ok');
    } catch (error) {
      say('打开失败：' + error.message, 'warn');
    }
  }

  function renderList(host, items) {
    if (!host) return;
    if (!items.length) {
      host.innerHTML = '<p class="tiny muted">仓库里没有匹配的 PDF。可以在「音频库」导入 PDF，或先在电脑端把琴谱同步到你的账号。</p>';
      return;
    }
    host.replaceChildren();
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'p2k-hit';
      row.innerHTML = `
        <div>
          <strong>${esc(item.title)}</strong>
          <div class="tiny muted">${esc(item.source || '')} · ${esc(item.sizeText || '')} · PDF</div>
        </div>
        <div class="p2k-hit-actions"><button type="button" class="primary">查看</button></div>`;
      row.querySelector('button').onclick = () => {
        const api = window.p2kScoreRepo || {};
        const call = typeof api.viewPdf === 'function' ? api.viewPdf : viewPdf;
        return call(item);
      };
      host.append(row);
    }
  }

  async function render() {
    const box = el('p2kStudioSearch');
    if (!box) return;
    box.innerHTML = `
      <p class="tiny muted">只搜「琴谱仓库」里的 PDF：我的曲库 / 本机琴谱 / 手机已导入的谱面。点「查看」直接看谱。</p>
      <div class="p2k-studio-row">
        <input id="p2kRepoQuery" type="text" placeholder="输入琴谱名字，留空则列出全部">
        <button type="button" id="p2kRepoSearchBtn" class="primary">找谱</button>
      </div>
      <div id="p2kRepoStatus" class="tiny muted"></div>
      <div id="p2kRepoResults" class="p2k-studio-results"></div>`;

    const input = el('p2kRepoQuery');
    const button = el('p2kRepoSearchBtn');
    const status = el('p2kRepoStatus');
    const results = el('p2kRepoResults');

    async function run() {
      const keyword = (input && input.value || '').trim().toLowerCase();
      if (status) status.textContent = '正在查仓库…';
      const api = window.p2kScoreRepo || {};
      const callRepo = typeof api.repoPdfs === 'function' ? api.repoPdfs : repoPdfs;
      const callLocal = typeof api.localSheets === 'function' ? api.localSheets : localSheets;
      const [remote, local] = await Promise.all([callRepo(keyword), callLocal(keyword)]);
      const merged = local.concat(remote);
      // 按更新时间倒序，但保证本机可离线看的排前面
      merged.sort((a, b) => (b.local ? 1 : 0) - (a.local ? 1 : 0) || (b.updatedAt || 0) - (a.updatedAt || 0));
      if (status) {
        status.textContent = merged.length
          ? `找到 ${merged.length} 份 PDF（其中 ${local.length} 份在本机，离线可看）`
          : '没找到匹配的 PDF';
      }
      renderList(results, merged);
    }

    if (button) button.onclick = run;
    if (input) input.onkeydown = (event) => { if (event.key === 'Enter') run(); };
    await run();
  }

  window.p2kScoreRepo = { version: '1.0.0', render, viewPdf, localSheets, repoPdfs };
})();
