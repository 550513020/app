/* P2K bundle: assets/js/studio-3.js */
/* ============================================================================
   音频库（App 里的主功能）
   ----------------------------------------------------------------------------
   目标：App 里只保留「音频库」这一块，且手机自己能完成转谱。
     - 从手机导入音频 → 手机本机引擎转谱 → 直接进练习（不连电脑）
     - 从手机导入 PDF / 谱面图片 → 存本机，离线可看
     - 电脑在线时的音频库仍然可见（可选，用于拿到电脑上已下载的音频）
   ========================================================================== */
(function () {
  'use strict';

  const P2K_STUDIO_AUDIO_VERSION = '2.0.0';

  function el(id) { return document.getElementById(id); }

  function escapeHtml(value) {
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

  /* 本机引擎是否可用 */
  function onDeviceReady() {
    return !!(window.p2kOnDeviceTranscribe && window.p2kOnDevice);
  }

  /* 把转谱结果装进练习页 */
  function useForPractice(result, title) {
    const events = (result && result.events) || [];
    if (!events.length) return false;
    window.p2kOnDevice.loadIntoPractice(events, title);
    say('已把「' + title + '」送进练习页（' + events.length + ' 个音块）', 'ok');
    return true;
  }

  /* 转谱一个音频文件（手机本机） */
  async function transcribeLocal(file) {
    const title = (file.name || '导入音频').replace(/\.[^.]+$/, '');
    say('正在本机分析「' + title + '」…（不需要电脑）');
    const started = Date.now();
    const result = await window.p2kOnDevice.transcribeFile(file, {
      onProgress: (ratio) => say('本机分析中 ' + Math.round(ratio * 100) + '%'),
    });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    say('识别完成：' + result.noteCount + ' 个音 / ' + result.eventCount + ' 个音块，用时 ' + seconds + ' 秒', 'ok');
    await window.p2kOnDevice.saveAsScore(result.events, title);
    useForPractice(result, title);
    return result;
  }

  /* 转谱一个「电脑上已有」的音频（需要电脑在线，可选功能） */
  async function transcribeRemote(path, title) {
    const studio = window.p2kStudioInternals;
    if (!studio || typeof studio.api !== 'function') throw new Error('当前没有连接电脑（App 本机转谱请看上面的导入按钮）');
    const data = await studio.api('/score/transcribe', {
      method: 'POST',
      body: JSON.stringify({ path: path, tempo: 90 }),
      timeout: 600000,
    });
    const notes = data.notes || [];
    if (!notes.length) throw new Error('没识别出音符');
    const beatSec = 60 / (data.tempo || 90);
    const events = (data.events || []).map((group) => ({
      notes: group.notes.map((note) => ({ page: 1, x: 0, y: 0, m: note.midi, h: note.midi >= 60 ? 'R' : 'L', f: 0 })),
      durationBeats: Math.max(0.5, Math.round(((group.durationSec || beatSec) / beatSec) * 2) / 2),
    }));
    window.p2kOnDevice.loadIntoPractice(events, title);
    say('（电脑）识别完成：' + notes.length + ' 个音', 'ok');
    return data;
  }

  /* 渲染音频库面板 */
  async function renderAudioTab() {
    const box = el('p2kStudioAudio');
    if (!box) return;
    const engineReady = onDeviceReady();

    let remote = null;
    const studio = window.p2kStudioInternals;
    if (studio && typeof studio.api === 'function' && studio.hasBase && studio.hasBase()) {
      try {
        remote = await studio.api('/audio/library');
      } catch (error) {
        remote = null;
      }
    }

    const remoteList = remote
      ? (remote.downloaded || []).map((file) => `
          <li><strong>${escapeHtml(file.name)}</strong>
            <span class="tiny muted">${escapeHtml(file.ext)} · ${escapeHtml(file.sizeText)}</span>
            <button type="button" class="p2k-mini primary" data-remote="${escapeHtml(file.path)}" data-name="${escapeHtml(file.name)}">转琴谱</button>
          </li>`).join('')
      : '';

    box.innerHTML = `
      <div class="p2k-audio-hero">
        <div class="p2k-audio-hero-title">从手机导入，手机自己转谱</div>
        <div class="tiny muted">不需要连电脑。音频在本机分析（引擎已内嵌在 App 里），网络只用于下载音频。</div>
        <div class="p2k-studio-row">
          <button type="button" id="p2kImportAudio" class="primary">＋ 导入音频（转琴谱）</button>
          <button type="button" id="p2kImportSheet">＋ 导入 PDF / 谱面图片</button>
        </div>
        <input type="file" id="p2kImportAudioInput" accept="audio/*,.mp3,.m4a,.aac,.wav,.flac,.ogg,.opus,.wma,.ape,.aif,.aiff" multiple hidden>
        <input type="file" id="p2kImportSheetInput" accept="application/pdf,.pdf,image/*,.png,.jpg,.jpeg,.webp,.bmp" multiple hidden>
        <div class="p2k-audio-engine ${engineReady ? 'ok' : 'bad'}">
          本机分析引擎：${engineReady ? '已内嵌，可用' : '未加载（请更新到最新版 App）'}
        </div>
      </div>
      <div id="p2kImportLog" class="p2k-import-log tiny muted"></div>
      <h4>最近导入</h4>
      <ul class="p2k-studio-list" id="p2kImportedList"><li class="tiny muted">还没有导入过东西。</li></ul>
      <h4>电脑上已下载的音频${remote ? '' : '（电脑不在线，暂不可用）'}</h4>
      <ul class="p2k-studio-list">${remoteList || '<li class="tiny muted">' + (remote ? '还没有下载过音频。' : '需要电脑在线；App 本机转谱不依赖它。') + '</li>'}</ul>
      <p class="tiny muted">手机支持的音频：mp3 / m4a / wav / flac / ogg / opus / wma / ape。谱面：pdf / png / jpg / webp。</p>
    `;

    const log = el('p2kImportLog');
    const writeLog = (line) => {
      if (!log) return;
      const row = document.createElement('div');
      row.textContent = line;
      log.append(row);
      log.scrollTop = log.scrollHeight;
    };

    const audioInput = el('p2kImportAudioInput');
    const sheetInput = el('p2kImportSheetInput');
    const audioBtn = el('p2kImportAudio');
    const sheetBtn = el('p2kImportSheet');

    if (audioBtn && audioInput) {
      audioBtn.onclick = () => audioInput.click();
      audioInput.onchange = async () => {
        const files = Array.from(audioInput.files || []);
        audioInput.value = '';
        if (!files.length) return;
        for (const file of files) {
          try {
            writeLog('（音频）' + file.name + ' · ' + (file.size / 1048576).toFixed(1) + 'MB');
            await transcribeLocal(file);
          } catch (error) {
            writeLog('失败：' + file.name + ' —— ' + error.message);
            say('转谱失败：' + error.message, 'warn');
          }
        }
        await refreshImportedList();
      };
    }

    if (sheetBtn && sheetInput) {
      sheetBtn.onclick = () => sheetInput.click();
      sheetInput.onchange = async () => {
        const files = Array.from(sheetInput.files || []);
        sheetInput.value = '';
        if (!files.length) return;
        for (const file of files) {
          try {
            const kind = window.p2kOnDevice.kindOf(file);
            writeLog('（谱面）' + file.name + ' · ' + (file.size / 1048576).toFixed(1) + 'MB · ' + kind);
            const stored = await window.p2kOnDevice.storeSheet(file);
            writeLog('　已存到本机：' + stored.name + '（离线可看）');
            if (kind === 'pdf' || kind === 'image') {
              try {
                await window.p2kOnDevice.openSheet(stored);
                writeLog('　已用内置阅读器打开');
              } catch (error) {
                writeLog('　已保存；预览需要联网加载阅读器：' + error.message);
              }
            }
          } catch (error) {
            writeLog('失败：' + file.name + ' —— ' + error.message);
          }
        }
        await refreshImportedList();
      };
    }

    box.querySelectorAll('[data-remote]').forEach((button) => {
      button.onclick = async () => {
        try {
          await transcribeRemote(button.dataset.remote, button.dataset.name.replace(/\.[^.]+$/, ''));
        } catch (error) {
          say('电脑转谱失败：' + error.message, 'warn');
        }
      };
    });

    await refreshImportedList();
  }

  /* 最近导入的东西（本机存档） */
  async function refreshImportedList() {
    const host = el('p2kImportedList');
    if (!host) return;
    let rows = [];
    try {
      const all = (await window.p2kLocalAll?.()) || [];
      rows = all
        .filter((item) => item && (item.source === 'on-device' || String(item.id || '').startsWith('local:') || String(item.id || '').startsWith('sheet:')))
        .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
        .slice(0, 12);
    } catch (error) {
      rows = [];
    }
    if (!rows.length) {
      host.innerHTML = '<li class="tiny muted">还没有导入过东西。</li>';
      return;
    }
    host.replaceChildren();
    for (const item of rows) {
      const li = document.createElement('li');
      const name = document.createElement('strong');
      name.textContent = item.title || item.id;
      const meta = document.createElement('span');
      meta.className = 'tiny muted';
      const isSheet = String(item.id || '').startsWith('sheet:');
      meta.textContent = isSheet
        ? '谱面 · ' + ((item.size || 0) / 1048576).toFixed(1) + 'MB · 离线可用'
        : (item.event_count || 0) + ' 个音块 · ' + (item.note_count || 0) + ' 个音 · 本机识别';
      li.append(name, meta);
      if (!isSheet && item.events && item.events.length) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'p2k-mini primary';
        button.textContent = '去练习';
        button.onclick = () => {
          window.p2kOnDevice.loadIntoPractice(item.events, item.title || '本机曲谱');
          say('已进入练习：' + (item.title || ''), 'ok');
        };
        li.append(button);
      }
      host.append(li);
    }
  }

  window.p2kAudioTab = {
    version: P2K_STUDIO_AUDIO_VERSION,
    render: renderAudioTab,
    transcribeLocal,
    transcribeRemote,
    refreshImportedList,
    onDeviceReady,
  };
})();

