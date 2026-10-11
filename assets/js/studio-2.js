/* P2K bundle: assets/js/studio-2.js */
/* ============================================================================
   手机端「音频/PDF 导入 → 本机转谱 → 直接练习」桥接层
   ----------------------------------------------------------------------------
   目标：App 里只留音频库；音频、PDF、谱面图片都从手机里选；
         转谱由手机本机引擎完成（p2k-ondevice-transcribe.js），不连电脑。
   ========================================================================== */
(function () {
  'use strict';

  const AUDIO_EXT = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'wma', 'aif', 'aiff', 'ape', 'mp4', 'webm'];
  const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'];
  const PDF_EXT = ['pdf'];

  function ext(name) {
    const dot = (name || '').lastIndexOf('.');
    return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  }

  function kindOf(file) {
    const name = (file && file.name) || '';
    const type = (file && file.type) || '';
    const suffix = ext(name);
    if (PDF_EXT.includes(suffix) || type === 'application/pdf') return 'pdf';
    if (IMAGE_EXT.includes(suffix) || type.startsWith('image/')) return 'image';
    if (AUDIO_EXT.includes(suffix) || type.startsWith('audio/') || type.startsWith('video/')) return 'audio';
    return 'unknown';
  }

  function noteCount(events) {
    return (events || []).reduce((sum, event) => sum + ((event.notes && event.notes.length) || 0), 0);
  }

  /* 把本机转谱结果装进练习页并切过去 */
  function loadIntoPractice(events, title) {
    if (typeof window.p2kSetPhoneEvents !== 'function') {
      throw new Error('练习页还没准备好，请稍后再试');
    }
    window.p2kSetPhoneEvents(events, title);
    const preview = document.getElementById('phonePreview');
    const library = document.getElementById('phoneLibrary');
    const practice = document.getElementById('phonePractice');
    if (library) library.hidden = true;
    if (practice) practice.hidden = true;
    if (preview) preview.hidden = false;
    const info = document.getElementById('phonePreviewInfo');
    if (info) info.textContent = title + ' · ' + events.length + ' 个音块 · 手机本机识别';
    return true;
  }

  /* 一次导入：自动判断类型并分流处理 */
  async function importFiles(files, hooks) {
    const callbacks = hooks || {};
    const log = callbacks.log || function () {};
    const results = [];
    const list = Array.from(files || []);
    for (let i = 0; i < list.length; i++) {
      const file = list[i];
      const kind = kindOf(file);
      log(`（${i + 1}/${list.length}）${file.name} · ${(file.size / 1048576).toFixed(1)}MB · 类型 ${kind}`);
      if (kind === 'audio') {
        const result = await transcribeFile(file, {
          onProgress: (ratio) => log(`　分析中 ${Math.round(ratio * 100)}%`),
        });
        results.push({ file, kind, result });
      } else if (kind === 'pdf' || kind === 'image') {
        const stored = await storeSheet(file);
        results.push({ file, kind, sheet: stored });
      } else {
        results.push({ file, kind, error: '这个格式不认识（支持 mp3/m4a/wav/flac 等音频，pdf/png/jpg 谱面）' });
      }
    }
    return results;
  }

  /* 音频文件 → 本机转谱 */
  async function transcribeFile(file, options) {
    const engine = window.p2kOnDeviceTranscribe;
    if (!engine) throw new Error('本机分析引擎没加载出来（请更新到最新版 App）');
    const opts = options || {};
    const settings = Object.assign({}, opts);
    // 直接透传进度回调（之前这里自己调自己，会爆栈）
    if (typeof opts.onProgress !== 'function') delete settings.onProgress;
    const raw = await engine.audition(file, settings);
    if (!raw || !raw.events || !raw.events.length) {
      throw new Error('这段音频没听出音符。试试更清晰的录音，或换一段乐器声明显的片段。');
    }
    return raw;
  }

  /* 把选中的 PDF / 图片存在本机（IndexedDB），下次离线也能打开 */
  async function storeSheet(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const id = 'sheet:' + (file.name || 'sheet') + ':' + bytes.length;
    try {
      if (window.p2kLocalPut) {
        await window.p2kLocalPut({
          id,
          title: file.name,
          kind: kindOf(file),
          bytes,
          size: bytes.length,
          updated_at: Date.now(),
        });
      }
    } catch (error) {
      // 存不进去也不影响本次打开
    }
    return { id, name: file.name, kind: kindOf(file), bytes };
  }

  /* 用页面自带的 PDF 阅读器打开谱面（APK 内置，离线可用） */
  async function openSheet(sheet) {
    if (typeof window.p2kOpenSheetBytes === 'function') {
      return window.p2kOpenSheetBytes(sheet.bytes, sheet.name);
    }
    throw new Error('当前版本还不能直接预览谱面（已保存到本机）');
  }

  /* 暴露给页面：用字节打开谱面 */
  window.p2kOpenSheetBytes = function (bytes, name) {
    try {
      const file = new File([bytes], name || 'sheet.pdf', { type: 'application/pdf' });
      const opener = window.p2kOpenSheetFile;
      if (typeof opener === 'function') return opener(file);
      // 退路：塞给主页面的谱面文件输入并触发 change（id="file"）
      const input = document.getElementById('file')
        || document.querySelector('input[type=file][accept*="pdf"], input[type=file][accept*=".pdf"]');
      if (input) {
        const list = new DataTransfer();
        list.items.add(file);
        input.files = list.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      throw new Error('页面上没有可用的谱面阅读入口');
    } catch (error) {
      throw new Error('打开谱面失败：' + error.message);
    }
  };

  /* 保存成本机曲谱（离线曲库），可选同步到账号 */
  async function saveAsScore(events, title, meta) {
    const engine = window.p2kOnDeviceTranscribe;
    const normalized = (events || []).map((event) => {
      if (event && event.notes) return event;
      return engine ? engine.toPracticeEvents({ events: [event] })[0] : null;
    }).filter(Boolean);
    const score = {
      id: 'local:' + Date.now(),
      title: title,
      note_count: noteCount(normalized),
      event_count: normalized.length,
      meter: (meta && meta.meter) || '4/4',
      events: normalized,
      source: 'on-device',
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    const stored = window.p2kLocalPut ? await window.p2kLocalPut(score).then(() => true).catch(() => false) : false;
    if (typeof window.p2kRenderLibraryOffline === 'function') window.p2kRenderLibraryOffline();
    return { score, stored };
  }

  window.p2kOnDevice = {
    version: '1.0.0',
    kindOf,
    importFiles,
    transcribeFile,
    storeSheet,
    openSheet,
    saveAsScore,
    loadIntoPractice,
    noteCount,
    AUDIO_EXT,
    IMAGE_EXT,
    PDF_EXT,
  };
})();

