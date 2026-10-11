/* P2K bundle: assets/js/studio-1.js */
/* ============================================================================
   手机端独立「音频 → 琴谱」引擎（纯 JS，无服务器、无外部依赖）
   ----------------------------------------------------------------------------
   为什么需要：以前音频转谱要连电脑上的 Python 服务。现在手机自己就能算完，
   只要手机能联网（只为下载音频），分析过程完全在本机完成，不依赖电脑地址。

   流程：
     音频文件 / ArrayBuffer
       → decodeAudioData 得到 PCM（浏览器自带解码，mp3/m4a/wav/flac 都行）
       → 分帧 STFT（汉宁窗 + 自实现 FFT）
       → 每帧找基频候选（谐波求和法，比单纯峰值稳）
       → 帧序列聚成音符（起止、音名、力度、时长）
       → 输出与练习页一致的 event 结构（notes/page/x/y/m/h/f + durationBeats）

   设计取舍：
     - 自实现 radix-2 FFT，避免引第三方库（APK 体积与离线可用性都更好）。
     - 谐波求和（HPS/HS）而不是单峰，能明显减少八度错误与相邻音串音。
     - 支持最多 3 个同时音（三和弦够用），并按能量排序。
   ========================================================================== */
(function () {
  'use strict';

  const A4 = 440;
  const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

  function midiToName(midi) {
    const index = ((midi % 12) + 12) % 12;
    return NOTE_NAMES[index] + (Math.floor(midi / 12) - 1);
  }

  function midiToFreq(midi) {
    return A4 * Math.pow(2, (midi - 69) / 12);
  }

  function freqToMidi(freq) {
    return 69 + 12 * Math.log2(freq / A4);
  }

  // ------------------------------------------------------------ FFT（radix-2，迭代版）
  function makeFft(size) {
    const levels = Math.round(Math.log2(size));
    if (Math.pow(2, levels) !== size) throw new Error('FFT 长度必须是 2 的幂');
    const cosTable = new Float32Array(size / 2);
    const sinTable = new Float32Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      cosTable[i] = Math.cos((2 * Math.PI * i) / size);
      sinTable[i] = Math.sin((2 * Math.PI * i) / size);
    }
    const reverse = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let value = 0;
      for (let bit = 0; bit < levels; bit++) value = (value << 1) | ((i >>> bit) & 1);
      reverse[i] = value;
    }
    return function fft(re, im) {
      for (let i = 0; i < size; i++) {
        const j = reverse[i];
        if (j > i) {
          let temp = re[i]; re[i] = re[j]; re[j] = temp;
          temp = im[i]; im[i] = im[j]; im[j] = temp;
        }
      }
      for (let span = 1; span < size; span <<= 1) {
        const step = size / (span << 1);
        for (let start = 0; start < size; start += span << 1) {
          for (let offset = 0; offset < span; offset++) {
            const table = offset * step;
            const cos = cosTable[table];
            const sin = sinTable[table];
            const even = start + offset;
            const odd = even + span;
            const tre = re[odd] * cos + im[odd] * sin;
            const tim = -re[odd] * sin + im[odd] * cos;
            re[odd] = re[even] - tre;
            im[odd] = im[even] - tim;
            re[even] += tre;
            im[even] += tim;
          }
        }
      }
    };
  }

  // ------------------------------------------------------------ 音频解码
  async function decodeToMono(input, options) {
    const settings = options || {};
    const AudioCtor = settings.AudioContext || (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext));
    if (!AudioCtor) throw new Error('这台设备不支持音频解码（AudioContext 不可用）');
    let bytes;
    if (input instanceof ArrayBuffer) bytes = input;
    else if (input && input.buffer instanceof ArrayBuffer) bytes = input.buffer;
    else if (input && typeof input.arrayBuffer === 'function') bytes = await input.arrayBuffer();
    else throw new Error('无法读取音频数据');
    const context = new AudioCtor();
    let audioBuffer;
    try {
      audioBuffer = await context.decodeAudioData(bytes.slice(0));
    } finally {
      if (context.close) context.close().catch(() => {});
    }
    const channels = audioBuffer.numberOfChannels;
    const length = audioBuffer.length;
    const mono = new Float32Array(length);
    for (let channel = 0; channel < channels; channel++) {
      const data = audioBuffer.getChannelData(channel);
      for (let i = 0; i < length; i++) mono[i] += data[i] / channels;
    }
    return { samples: mono, sampleRate: audioBuffer.sampleRate, duration: audioBuffer.duration };
  }

  // ------------------------------------------------------------ 谐波求和找基频
  function makeHarmonicSieve(freqs, harmonics) {
    const table = new Float32Array(freqs.length * harmonics);
    for (let h = 1; h <= harmonics; h++) {
      const weight = 1 / h;
      const offset = (h - 1) * freqs.length;
      for (let i = 0; i < freqs.length; i++) {
        let best = -1;
        let bestDistance = Infinity;
        const target = freqs[i] * h;
        // 在 bin 上找最接近目标频率的格点
        const approximate = target;
        for (let j = Math.max(0, i); j < freqs.length; j++) {
          const distance = Math.abs(freqs[j] - approximate);
          if (distance < bestDistance) { bestDistance = distance; best = j; }
          if (freqs[j] > approximate * 1.05) break;
        }
        table[offset + i] = best >= 0 ? weight : 0;
      }
    }
    return table;
  }

  const MIDI_LOW = 24;   // 大字一组 C
  const MIDI_HIGH = 96;  // 小字五组 C

  function createPitchTable(sampleRate, fftSize) {
    const binCount = fftSize >> 1;
    const freqs = new Float32Array(binCount);
    for (let i = 0; i < binCount; i++) freqs[i] = (i * sampleRate) / fftSize;

    // 每个 MIDI 音对应的基频最接近的 bin（及其 ±1 bin，容忍跑调）
    const notes = [];
    for (let midi = MIDI_LOW; midi <= MIDI_HIGH; midi++) {
      const freq = midiToFreq(midi);
      const bin = Math.round((freq * fftSize) / sampleRate);
      if (bin < 2 || bin >= binCount - 2) continue;
      notes.push({ midi, freq, bin });
    }
    return { freqs, binCount, notes };
  }

  /* 单帧分析：返回 [{midi, strength}]，按强度排序 */
  function analyzeFrame(spectrum, table, harmonics, threshold, maxPolyphony, noteFreq) {
    const candidates = [];
    for (const note of table.notes) {
      let sum = 0;
      let count = 0;
      const base = note.bin;
      for (let h = 1; h <= harmonics; h++) {
        const bin = base * h;
        if (bin + 1 >= table.binCount) break;
        // 取 ±1 bin 的最大值，允许轻微跑调
        const energy = Math.max(
          Math.hypot(spectrum.re[bin], spectrum.im[bin]),
          Math.hypot(spectrum.re[bin - 1], spectrum.im[bin - 1]),
          Math.hypot(spectrum.re[bin + 1], spectrum.im[bin + 1]),
        );
        sum += energy / h;
        count += 1;
      }
      if (count > 0) {
        const strength = sum / Math.sqrt(count);
        if (strength > threshold) {
          // 基频自身的能量（用于排除低八度伪音：那些其实只是别人的泛音）
          const fundamental = Math.hypot(spectrum.re[base], spectrum.im[base]);
          const harmonic2 = base * 2 + 1 < table.binCount
            ? Math.hypot(spectrum.re[base * 2], spectrum.im[base * 2])
            : 0;
          candidates.push({ midi: note.midi, strength, fundamental, harmonic2 });
        }
      }
    }
    /* 闸门：一个音要算数，它自己的基频必须有实际能量。
       否则就是"低八度伪音"——真实音是别的音，只因为泛音结构被判成了它。
       例：C4 的能量会被 C3 的谐波列捡到，但 C3 基频位置几乎没有能量。 */
    const strongestHarmonic = candidates.reduce((max, item) => Math.max(max, item.harmonic2), 0) || 1;
    const gated = candidates.filter((item) => {
      if (item.fundamental <= 0) return false;
      // 基频能量至少要达到"最强的二次谐波"的一小部分
      return item.fundamental >= strongestHarmonic * 0.2 || item.fundamental >= item.strength * 0.2;
    });
    candidates.length = 0;
    candidates.push.apply(candidates, gated.sort((a, b) => b.strength - a.strength));
    /* 关键一步：泛音归并。
       钢琴一个音带 2×、3×… 泛音，谐波求和会把它们也判成独立"音"，
       于是 C4 会同时出现 C4/C5/G5…（听感完全错）。
       做法：从强到弱扫；若当前候选是「已保留音」的整数倍频率（±2%），
       它就是那个音的泛音，丢掉。已保留的都是基频（排在前面的更强）。 */
    const kept = [];
    for (const candidate of candidates) {
      const freq = noteFreq(candidate.midi);
      let overtoneOfKept = false;
      for (const existing of kept) {
        const ratio = freq / noteFreq(existing.midi);
        if (ratio <= 1.5) continue;
        const nearest = Math.round(ratio);
        if (nearest >= 2 && Math.abs(ratio - nearest) / nearest <= 0.02) { overtoneOfKept = true; break; }
      }
      if (overtoneOfKept) continue;
      // 相邻半音只留更强的（一个音不会被判成两个相邻音）
      if (kept.some((k) => Math.abs(k.midi - candidate.midi) <= 1)) continue;
      kept.push(candidate);
      if (kept.length >= maxPolyphony) break;
    }
    return kept;
  }

  /* 主入口：把 PCM 转成音符序列 */
  function transcribeSamples(samples, sampleRate, options) {
    const settings = Object.assign({
      fftSize: 4096,
      hopSize: 1024,
      harmonics: 6,
      threshold: 0.06,
      minNoteMs: 90,
      mergeGapMs: 90,
      maxPolyphony: 3,
      onProgress: null,
    }, options || {});

    const fft = makeFft(settings.fftSize);
    const table = createPitchTable(sampleRate, settings.fftSize);
    const window = new Float32Array(settings.fftSize);
    for (let i = 0; i < settings.fftSize; i++) {
      window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (settings.fftSize - 1));  // 汉宁窗
    }
    const re = new Float32Array(settings.fftSize);
    const im = new Float32Array(settings.fftSize);
    const hop = settings.hopSize;
    const frames = Math.max(1, Math.floor((samples.length - settings.fftSize) / hop) + 1);
    const frameMs = (hop / sampleRate) * 1000;

    // 逐帧取候选音
    const frameCandidates = [];
    const frameEnergies = [];
    let peak = 1e-6;
    for (let frame = 0; frame < frames; frame++) {
      const start = frame * hop;
      for (let i = 0; i < settings.fftSize; i++) {
        const sample = samples[start + i] || 0;
        re[i] = sample * window[i];
        im[i] = 0;
      }
      fft(re, im);
      const found = analyzeFrame({ re, im }, table, settings.harmonics, 0, settings.maxPolyphony, midiToFreq);
      let frameEnergy = 0;
      for (let i = 0; i < settings.fftSize >> 1; i++) frameEnergy += (re[i] * re[i] + im[i] * im[i]);
      frameCandidates.push(found);
      frameEnergies.push(frameEnergy);
      for (const item of found) if (item.strength > peak) peak = item.strength;
      if (settings.onProgress && frame % 200 === 0) {
        settings.onProgress(frame / frames);
      }
    }
    const threshold = Math.max(settings.threshold, peak * 0.14);

    // 帧候选 → 音符段（同一个音连续出现就合并）
    const active = new Map();   // midi → {startFrame, lastFrame, strengths[]}
    const notes = [];
    // 把一条活跃音轨收成一个音符（时长达标才收）
    const pushNote = (track) => {
      if (!track || !track.midi) return;
      const frames_ = track.lastFrame - track.startFrame + 1;
      const durationMs = frames_ * frameMs;
      if (durationMs < settings.minNoteMs) return;
      const average = track.strengths.reduce((a, b) => a + b, 0) / track.strengths.length;
      notes.push({
        midi: track.midi,
        name: midiToName(track.midi),
        startSec: (track.startFrame * hop) / sampleRate,
        durationSec: Math.max(0.08, durationMs / 1000),
        velocity: Math.max(0.2, Math.min(1, average / (peak || 1))),
        strength: average,
      });
    };
    const flush = () => {
      for (const track of active.values()) pushNote(track);
      active.clear();
    };

    for (let frame = 0; frame < frames; frame++) {
      const found = frameCandidates[frame].filter((item) => item.strength >= threshold);
      const seen = new Set();
      for (const item of found.slice(0, settings.maxPolyphony)) {
        seen.add(item.midi);
        const track = active.get(item.midi);
        if (track) {
          /* 同一个音高再次被弹响（重新起音）时，要切成两个音，
             否则"小星星"里连续的 C4 C4 会被并成一个长音。 */
          const previousEnergy = frameEnergies[frame - 1] || 0;
          const isReAttack = previousEnergy > 0 && frameEnergies[frame] > previousEnergy * 1.6;
          if (isReAttack) {
            pushNote(track);
            active.delete(item.midi);
            active.set(item.midi, { midi: item.midi, startFrame: frame, lastFrame: frame, strengths: [item.strength] });
          } else {
            track.lastFrame = frame;
            track.strengths.push(item.strength);
          }
        } else {
          active.set(item.midi, { midi: item.midi, startFrame: frame, lastFrame: frame, strengths: [item.strength] });
        }
      }
      // 连续 2 帧没出现就算结束
      for (const [midi, track] of Array.from(active)) {
        if (!seen.has(midi) && frame - track.lastFrame >= 1) {
          pushNote(track);
          active.delete(midi);
        }
      }
    }
    flush();

    // 按时间排序；同一时刻的合并成和弦
    notes.sort((a, b) => a.startSec - b.startSec || a.midi - b.midi);
    const events = [];
    const onsetTolerance = settings.mergeGapMs / 1000;
    for (const note of notes) {
      const last = events[events.length - 1];
      if (last && Math.abs(last.startSec - note.startSec) <= onsetTolerance) {
        last.midi.push(note.midi);
        last.durationSec = Math.max(last.durationSec, note.durationSec);
        last.velocity = Math.max(last.velocity, note.velocity);
      } else {
        events.push({
          startSec: note.startSec,
          durationSec: note.durationSec,
          velocity: note.velocity,
          midi: [note.midi],
        });
      }
    }
    if (settings.onProgress) settings.onProgress(1);
    return { notes, events, peak, frameMs, threshold };
  }

  /* 转成练习页认识的事件结构：
     { notes:[{page,x,y,m,h,f}], durationBeats } —— x/y 由上层按琴键布局算，这里给占位值。 */
  function toPracticeEvents(result, options) {
    const settings = Object.assign({ bpm: 90, beatsPerBar: 4 }, options || {});
    const beatSec = 60 / settings.bpm;
    return result.events.map((event) => {
      const durationBeats = Math.max(0.5, Math.round((event.durationSec / beatSec) * 2) / 2);
      return {
        notes: event.midi.map((midi) => ({
          page: 1,
          x: 0,
          y: 0,
          m: midi,
          h: midi >= 60 ? 'R' : 'L',
          f: 0,
          velocity: Math.round(event.velocity * 127),
        })),
        durationBeats,
        _startSec: event.startSec,
      };
    });
  }

  window.p2kOnDeviceTranscribe = {
    version: '1.0.0',
    midiToName,
    midiToFreq,
    freqToMidi,
    decodeToMono,
    transcribeSamples,
    toPracticeEvents,
    /* 一步到位：音频文件 → 音符事件 */
    async audition(input, options) {
      const settings = options || {};
      const decoded = await decodeToMono(input, settings);
      const result = transcribeSamples(decoded.samples, decoded.sampleRate, settings);
      const events = toPracticeEvents(result, settings);
      return {
        ok: true,
        engine: 'on-device',
        durationSec: decoded.duration,
        sampleRate: decoded.sampleRate,
        noteCount: result.notes.length,
        eventCount: events.length,
        notes: result.notes,
        events,
        names: result.notes.map((note) => note.name),
      };
    },
  };
})();

