/**
 * AudioEngine — высокоточный аудиодвижок (Web Audio API) с глобальной компенсацией
 * задержки Bluetooth и системного аудиовывода по всей сети.
 *
 * Архитектура глобального выравнивания (Building-Wide Acoustic Sync):
 * - Каждое устройство (Хост и каждый Слушатель) непрерывно измеряет собственную
 *   аппаратную/Bluetooth-задержку вывода:
 *     systemLatencyMs = задержка AudioContext (outputLatency / getOutputTimestamp + baseLatency)
 *     totalLatencyMs  = (autoSystemLatency ? systemLatencyMs : 0) + extraLatencyMs
 * - Каждое устройство сообщает totalLatencyMs Хосту.
 * - Хост вычисляет roomMaxLatencyMs = max(всех устройств в комнате) и рассылает всем.
 * - Команда старта задаёт T_acoustic (hostStartTime) — момент времени Хоста, когда
 *   АКУСТИЧЕСКАЯ ВОЛНА должна выйти из динамиков ВСЕХ устройств одновременно.
 * - Каждое устройство i подаёт сигнал в Web Audio в момент:
 *     T_feed_i = T_acoustic - totalLatencyMs_i
 * - В результате:
 *   • Устройство с Bluetooth (например, 260 мс) подаёт звук первым (за 260 мс до T_acoustic)
 *   • Устройство с другим Bluetooth (например, 180 мс) ждёт +80 мс и подаёт за 180 мс
 *   • Обычный телефон без Bluetooth (например, 24 мс) ждёт +236 мс и подаёт за 24 мс
 *   • Акустически звук выходит ИЗ ВСЕХ КОЛОНОК И ТЕЛЕФОНОВ В ЗДАНИИ В ОДНУ МИЛЛИСЕКУНДУ!
 * - При подключении/отключении Bluetooth «на лету» (devicechange / polling) устройство
 *   автоматически пересчитывает задержку, бесшовно пересинхронизируется и обновляет сеть.
 */
class AudioEngine {
  static MAX_CACHED_BUFFERS = 12;

  constructor({ onDrift, onEnded, onStateChange, onLatencyChange } = {}) {
    this.ctx = null;
    this.masterGain = null;
    this.analyser = null;
    this.buffer = null;
    this.currentTrackId = null;
    this.bufferCache = new Map(); // trackId -> AudioBuffer (LRU кэш для мгновенного плейлиста)

    this.source = null;
    this.sourceGain = null;
    this._keepaliveOsc = null;
    this._keepaliveGain = null;

    this.volume = 1.0;
    this.muted = false;
    this.unlocked = false;

    // Состояние воспроизведения относительно единого акустического времени Хоста (T_acoustic)
    this.isPlaying = false;
    this.isScheduled = false;
    this.hostStartTime = 0;    // T_acoustic (ms) по часам Хоста
    this.startTrackOffset = 0; // Позиция трека (sec) в момент T_acoustic
    this.pausedPosition = 0;   // Позиция на паузе (sec)

    // Точный трекинг текущей позиции с учётом переменного playbackRate
    this.anchorAudioTime = 0;
    this.anchorTrackPos = 0;
    this.currentRate = 1.0;

    // Задержки аудиовывода и Bluetooth
    this.autoSystemLatency = this._loadBool('orpheus_auto_sys_latency', true);
    this.extraLatencyMs = this._loadNumber('orpheus_extra_latency_ms', 0, -500, 1200);
    this.baseLatencyMs = 0;
    this.outputLatencyMs = 0;
    this.impliedLatencyMs = 0;
    this.systemLatencyMs = 0;
    this.isBluetoothDetected = false;
    this.outputDeviceLabel = '';
    this.roomMaxLatencyMs = 0; // Максимум по всей комнате (от Хоста)

    this.lastDriftMs = 0;
    this._lastReportedLatencySig = '';

    this.onDrift = onDrift || (() => {});
    this.onEnded = onEnded || (() => {});
    this.onStateChange = onStateChange || (() => {});
    this.onLatencyChange = onLatencyChange || (() => {});

    this._iosSilentAudio = null;
    this._driftTimer = null;
    this._latencyTimer = null;
    this._deviceChangeBound = null;
    this._getHostTimeFn = null;
  }

  _loadNumber(key, fallback, min, max) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      const val = Number(raw);
      return Number.isFinite(val) ? Math.max(min, Math.min(max, val)) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  _loadBool(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      return raw === '1' || raw === 'true';
    } catch (_) {
      return fallback;
    }
  }

  _savePref(key, val) {
    try {
      localStorage.setItem(key, String(val));
    } catch (_) {}
  }

  /** Итоговая полная задержка вывода этого устройства (ms, >= 0) */
  getTotalOutputLatencyMs() {
    const sys = this.autoSystemLatency ? this.systemLatencyMs : 0;
    return Math.max(0, Math.round(sys + this.extraLatencyMs));
  }

  /** Снимок телеметрии задержки устройства для UI и отправки Хосту */
  getLatencyProfile() {
    const totalLatencyMs = this.getTotalOutputLatencyMs();
    const waitDelayMs = Math.max(0, Math.round(this.roomMaxLatencyMs - totalLatencyMs));
    return {
      autoSystemLatency: this.autoSystemLatency,
      baseLatencyMs: Math.round(this.baseLatencyMs),
      outputLatencyMs: Math.round(this.outputLatencyMs),
      impliedLatencyMs: Math.round(this.impliedLatencyMs),
      systemLatencyMs: Math.round(this.systemLatencyMs),
      extraLatencyMs: Math.round(this.extraLatencyMs),
      totalLatencyMs,
      roomMaxLatencyMs: Math.round(this.roomMaxLatencyMs),
      waitDelayMs,
      isBluetooth: this.isBluetoothDetected || this.systemLatencyMs >= 75 || this.extraLatencyMs >= 60,
      outputDeviceLabel: this.outputDeviceLabel,
    };
  }

  setRoomMaxLatency(maxMs) {
    this.roomMaxLatencyMs = Math.max(0, Math.round(maxMs || 0));
    this.onLatencyChange(this.getLatencyProfile());
  }

  /**
   * Инициализация и разблокировка Web Audio API строго внутри пользовательского клика.
   */
  async unlock() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
      throw new Error('Ваш браузер не поддерживает Web Audio API');
    }

    if (!this.ctx) {
      try {
        this.ctx = new AudioCtx({ latencyHint: 'interactive' });
      } catch (_) {
        this.ctx = new AudioCtx();
      }

      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.muted ? 0 : this.volume;

      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 128;
      this.analyser.smoothingTimeConstant = 0.78;

      this.masterGain.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    }

    // 1) СИНХРОННЫЙ 1-сэмпловый прогрев внутри тапа (iOS Safari)
    try {
      const silentBuf = this.ctx.createBuffer(1, 1, 22050);
      const src = this.ctx.createBufferSource();
      src.buffer = silentBuf;
      src.connect(this.ctx.destination);
      src.start(0);
    } catch (_) {}

    // 2) Миниатюрный тихий WAV для iOS Media Playback режима
    if (!this._iosSilentAudio) {
      try {
        const silentWav =
          'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
        const el = new Audio(silentWav);
        el.setAttribute('playsinline', '');
        el.volume = 0.001;
        this._iosSilentAudio = el;
        el.play().catch(() => {});
      } catch (_) {}
    }

    // 3) Не зависаем навечно на resume()
    if (this.ctx.state === 'suspended') {
      try {
        await Promise.race([
          this.ctx.resume(),
          new Promise((r) => setTimeout(r, 450)),
        ]);
      } catch (_) {}
    }

    // 4) Неслышимый keepalive-узел (gain = 0):
    //    Держит аппаратный аудиотракт Android/macOS/iOS «живым», чтобы ctx.outputLatency
    //    и ctx.getOutputTimestamp() ВСЕГДА отдавали реальную задержку Bluetooth/динамика!
    this._ensureKeepalive();

    // 5) Запускаем непрерывный мониторинг аппаратной/Bluetooth задержки
    this._startLatencyMonitor();
    await this.probeAudioDevices();
    this.measureSystemLatency(true);

    this.unlocked = true;
    return true;
  }

  _ensureKeepalive() {
    if (!this.ctx || this._keepaliveOsc) return;
    try {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.frequency.value = 30;
      gain.gain.value = 0; // Полная тишина
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      this._keepaliveOsc = osc;
      this._keepaliveGain = gain;
    } catch (_) {}
  }

  async ensureResumed() {
    if (this.ctx && this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch (_) {}
    }
    this._ensureKeepalive();
  }

  /**
   * Запрос опционального доступа к списку аудиоустройств (для показа точного имени
   * Bluetooth-колонки/наушников и раскрытия локального LAN IP в WebRTC ICE).
   */
  async requestDeviceLabelsAccess() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return false;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      await this.probeAudioDevices();
      this.measureSystemLatency(true);
      return true;
    } catch (_) {
      return false;
    }
  }

  /** Сканирование подключённых аудиовыходов (выявление Bluetooth/A2DP/гарнитур) */
  async probeAudioDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const outputs = devices.filter((d) => d.kind === 'audiooutput');
      const btRegex = /bluetooth|a2dp|airpods|buds|jbl|sony|bose|marshall|beats|sennheiser|anker|soundcore|harman|bang|wireless|headset|earbuds|hands-free|wh-|wf-|flip|charge|xtreme|boombox|bt\b/i;

      let detectedLabel = '';
      let detectedBt = false;

      // Проверяем default / communications / все доступные выходы с метками
      const defaultOut = outputs.find((d) => d.deviceId === 'default' && d.label);
      if (defaultOut) {
        detectedLabel = defaultOut.label.replace(/^Default\s*-\s*/i, '').trim();
        if (btRegex.test(detectedLabel)) detectedBt = true;
      }

      if (!detectedBt) {
        const btDev = outputs.find((d) => d.label && btRegex.test(d.label));
        if (btDev) {
          detectedBt = true;
          if (!detectedLabel) detectedLabel = btDev.label.trim();
        }
      }

      if (!detectedLabel) {
        const anyNamed = outputs.find((d) => d.label);
        if (anyNamed) detectedLabel = anyNamed.label.trim();
      }

      this.outputDeviceLabel = detectedLabel;
      this.isBluetoothDetected = detectedBt;
    } catch (_) {}
  }

  /**
   * Измерение реальной системной задержки аудиовывода (ms):
   * Использует AudioContext.outputLatency, AudioContext.baseLatency и ctx.getOutputTimestamp().
   */
  measureSystemLatency(forceEmit = false) {
    if (!this.ctx) return this.systemLatencyMs;

    const prevTotal = this.getTotalOutputLatencyMs();

    const baseMs = Number.isFinite(this.ctx.baseLatency) ? this.ctx.baseLatency * 1000 : 0;
    const outMs = Number.isFinite(this.ctx.outputLatency) ? this.ctx.outputLatency * 1000 : 0;

    let impliedMs = 0;
    if (typeof this.ctx.getOutputTimestamp === 'function' && this.ctx.state === 'running') {
      try {
        const ts = this.ctx.getOutputTimestamp();
        if (ts && ts.performanceTime > 0 && ts.contextTime > 0) {
          const ct = this.ctx.currentTime;
          const pn = performance.now();
          const raw = (ct - ts.contextTime) * 1000 + (ts.performanceTime - pn);
          if (Number.isFinite(raw) && raw >= 0 && raw < 2500) {
            impliedMs = raw;
          }
        }
      } catch (_) {}
    }

    this.baseLatencyMs = baseMs;
    this.outputLatencyMs = outMs;
    this.impliedLatencyMs = impliedMs;

    // Не суммируем outputLatency и impliedMs дважды:
    // impliedMs из getOutputTimestamp() уже отражает задержку до физического DAC/BT-выхода.
    // Берём максимум из (outputLatency + baseLatency) и (impliedMs), сглаживая мелкий шум.
    let measured = 0;
    if (outMs > 0) {
      measured = Math.max(outMs + baseMs, impliedMs);
    } else if (impliedMs > 0) {
      measured = impliedMs + baseMs * 0.5;
    } else {
      measured = baseMs;
    }

    if (this.systemLatencyMs === 0 || Math.abs(measured - this.systemLatencyMs) > 20) {
      // Резкий скачок (например, подключили или отключили Bluetooth-колонку!) — реагируем сразу
      this.systemLatencyMs = measured;
    } else {
      // Мелкие флуктуации (< 20 мс) мягко усредняем
      this.systemLatencyMs = this.systemLatencyMs * 0.7 + measured * 0.3;
    }

    const newTotal = this.getTotalOutputLatencyMs();
    const profile = this.getLatencyProfile();
    const sig = `${profile.totalLatencyMs}|${profile.systemLatencyMs}|${profile.isBluetooth}|${profile.outputDeviceLabel}`;

    if (forceEmit || sig !== this._lastReportedLatencySig) {
      this._lastReportedLatencySig = sig;
      this.onLatencyChange(profile);

      // Если во время воспроизведения подключился/отключился Bluetooth и задержка изменилась > 15 мс —
      // мгновенно пересинхронизируем источник, чтобы звук в комнате остался идеально ровным!
      if (this.isPlaying && this.buffer && Math.abs(newTotal - prevTotal) >= 15) {
        this._stopSourceNode(true);
        this._startSourceAligned();
      }
    }

    return this.systemLatencyMs;
  }

  _startLatencyMonitor() {
    if (this._latencyTimer) clearInterval(this._latencyTimer);
    this._latencyTimer = setInterval(() => {
      if (this.ctx && this.ctx.state === 'running') {
        this.measureSystemLatency(false);
      }
    }, 1200);

    if (!this._deviceChangeBound && navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      this._deviceChangeBound = async () => {
        await this.probeAudioDevices();
        // Даём ОС 350 мс и 900 мс перестроить Bluetooth A2DP тракт и обновить outputLatency
        setTimeout(() => this.measureSystemLatency(true), 350);
        setTimeout(() => this.measureSystemLatency(true), 950);
      };
      navigator.mediaDevices.addEventListener('devicechange', this._deviceChangeBound);
    }
  }

  /* ==================== КЭШИРОВАНИЕ И ДЕКОДИРОВАНИЕ ТРЕКОВ ==================== */

  hasCachedTrack(trackId) {
    return this.bufferCache.has(trackId);
  }

  _putCache(trackId, audioBuffer) {
    if (this.bufferCache.has(trackId)) {
      this.bufferCache.delete(trackId);
    }
    this.bufferCache.set(trackId, audioBuffer);
    while (this.bufferCache.size > AudioEngine.MAX_CACHED_BUFFERS) {
      const oldestKey = this.bufferCache.keys().next().value;
      if (oldestKey === this.currentTrackId) break;
      this.bufferCache.delete(oldestKey);
    }
  }

  /** Декодирование в кэш (без остановки текущего воспроизведения — для предзагрузки плейлиста!) */
  async decodeToCache(trackId, arrayBuffer) {
    if (this.bufferCache.has(trackId)) {
      return this.bufferCache.get(trackId);
    }
    if (!this.ctx) {
      await this.unlock();
    }
    const copy = arrayBuffer.slice(0);
    const decoded = await new Promise((resolve, reject) => {
      const res = this.ctx.decodeAudioData(copy, resolve, reject);
      if (res && typeof res.then === 'function') {
        res.then(resolve).catch(reject);
      }
    });
    this._putCache(trackId, decoded);
    return decoded;
  }

  /** Активация уже декодированного трека из кэша */
  activateTrack(trackId) {
    const buf = this.bufferCache.get(trackId);
    if (!buf) return null;
    this.stopInternal();
    this.currentTrackId = trackId;
    this.buffer = buf;
    this.pausedPosition = 0;
    return buf;
  }

  async decodeArrayBuffer(arrayBuffer, trackId = null) {
    const id = trackId || `anon-${Date.now()}`;
    const decoded = await this.decodeToCache(id, arrayBuffer);
    return this.activateTrack(id) || decoded;
  }

  /**
   * Встроенный детерминированный тест-бит (120 BPM, 32 сек) для точной проверки синхронизации.
   */
  async generateDemoTrack(trackId = 'demo-120bpm-v2', activate = true) {
    if (this.bufferCache.has(trackId)) {
      return activate ? this.activateTrack(trackId) : this.bufferCache.get(trackId);
    }
    if (!this.ctx) {
      await this.unlock();
    }

    const sampleRate = 44100;
    const bpm = 120;
    const beatSec = 60 / bpm;
    const totalBeats = 64;
    const duration = totalBeats * beatSec;

    const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const offline = new OfflineCtx(2, Math.floor(sampleRate * duration), sampleRate);

    const comp = offline.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    comp.connect(offline.destination);

    const chords = [
      [220.0, 261.63, 329.63, 392.0, 493.88],
      [174.61, 220.0, 261.63, 329.63],
      [130.81, 196.0, 246.94, 329.63],
      [196.0, 246.94, 293.66, 329.63],
    ];
    const bassNotes = [110.0, 87.31, 65.41, 98.0];

    const noiseLen = Math.floor(sampleRate * 0.25);
    const noiseBuf = offline.createBuffer(1, noiseLen, sampleRate);
    const noiseData = noiseBuf.getChannelData(0);
    let seed = 1337;
    for (let i = 0; i < noiseLen; i++) {
      seed = (seed * 16807) % 2147483647;
      noiseData[i] = seed / 1073741823.5 - 1;
    }

    for (let beat = 0; beat < totalBeats; beat++) {
      const t = beat * beatSec;
      const bar = Math.floor(beat / 4);
      const chordIdx = bar % chords.length;

      // Бочка
      const kickOsc = offline.createOscillator();
      const kickGain = offline.createGain();
      kickOsc.type = 'sine';
      kickOsc.frequency.setValueAtTime(145, t);
      kickOsc.frequency.exponentialRampToValueAtTime(42, t + 0.09);
      kickGain.gain.setValueAtTime(0.9, t);
      kickGain.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
      kickOsc.connect(kickGain).connect(comp);
      kickOsc.start(t);
      kickOsc.stop(t + 0.26);

      // Острый транзиент-клик (помогает на слух уловить рассинхрон даже 10 мс)
      const clickOsc = offline.createOscillator();
      const clickGain = offline.createGain();
      clickOsc.type = 'triangle';
      clickOsc.frequency.setValueAtTime(beat % 4 === 0 ? 1800 : 1200, t);
      clickOsc.frequency.exponentialRampToValueAtTime(220, t + 0.015);
      clickGain.gain.setValueAtTime(beat % 4 === 0 ? 0.42 : 0.2, t);
      clickGain.gain.exponentialRampToValueAtTime(0.001, t + 0.02);
      clickOsc.connect(clickGain).connect(comp);
      clickOsc.start(t);
      clickOsc.stop(t + 0.025);

      // Клэп на 2 и 4
      if (beat % 2 === 1) {
        const clap = offline.createBufferSource();
        clap.buffer = noiseBuf;
        const bp = offline.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 1800;
        bp.Q.value = 1.2;
        const cg = offline.createGain();
        cg.gain.setValueAtTime(0.32, t);
        cg.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
        clap.connect(bp).connect(cg).connect(comp);
        clap.start(t);
        clap.stop(t + 0.16);
      }

      // Хай-хэт
      for (let sub = 0; sub < 2; sub++) {
        const ht = t + sub * (beatSec / 2);
        const hat = offline.createBufferSource();
        hat.buffer = noiseBuf;
        const hpf = offline.createBiquadFilter();
        hpf.type = 'highpass';
        hpf.frequency.value = 7500;
        const hg = offline.createGain();
        hg.gain.setValueAtTime(sub === 1 ? 0.16 : 0.07, ht);
        hg.gain.exponentialRampToValueAtTime(0.001, ht + 0.055);
        hat.connect(hpf).connect(hg).connect(comp);
        hat.start(ht);
        hat.stop(ht + 0.06);
      }

      // Бас
      const bassFreq = bassNotes[chordIdx];
      const bassOsc = offline.createOscillator();
      const bassFilter = offline.createBiquadFilter();
      const bassGain = offline.createGain();
      bassOsc.type = 'sawtooth';
      bassOsc.frequency.setValueAtTime(bassFreq, t + beatSec * 0.5);
      bassFilter.type = 'lowpass';
      bassFilter.frequency.setValueAtTime(420, t + beatSec * 0.5);
      bassFilter.frequency.exponentialRampToValueAtTime(140, t + beatSec);
      bassGain.gain.setValueAtTime(0.24, t + beatSec * 0.5);
      bassGain.gain.exponentialRampToValueAtTime(0.001, t + beatSec);
      bassOsc.connect(bassFilter).connect(bassGain).connect(comp);
      bassOsc.start(t + beatSec * 0.5);
      bassOsc.stop(t + beatSec);

      // Пэд-аккорд
      if (beat % 4 === 0) {
        const chord = chords[chordIdx];
        const barDur = beatSec * 4;
        for (const freq of chord) {
          const osc = offline.createOscillator();
          const lpf = offline.createBiquadFilter();
          const g = offline.createGain();
          osc.type = 'triangle';
          osc.frequency.value = freq;
          lpf.type = 'lowpass';
          lpf.frequency.value = 1400;
          g.gain.setValueAtTime(0.001, t);
          g.gain.linearRampToValueAtTime(0.065, t + 0.12);
          g.gain.exponentialRampToValueAtTime(0.002, t + barDur - 0.05);
          osc.connect(lpf).connect(g).connect(comp);
          osc.start(t);
          osc.stop(t + barDur);
        }
      }
    }

    const rendered = await offline.startRendering();
    this._putCache(trackId, rendered);
    return activate ? this.activateTrack(trackId) : rendered;
  }

  /**
   * Встроенный калибровочный метроном (чёткие импульсы 1 Гц, 30 сек) для проверки Bluetooth-синхрона.
   */
  async generatePulseTrack(trackId = 'demo-pulse-60bpm-v2', activate = true) {
    if (this.bufferCache.has(trackId)) {
      return activate ? this.activateTrack(trackId) : this.bufferCache.get(trackId);
    }
    if (!this.ctx) {
      await this.unlock();
    }

    const sampleRate = 44100;
    const duration = 30;
    const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const offline = new OfflineCtx(2, Math.floor(sampleRate * duration), sampleRate);

    for (let sec = 0; sec < duration; sec++) {
      const isAccent = sec % 4 === 0;
      const osc = offline.createOscillator();
      const gain = offline.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(isAccent ? 1760 : 880, sec);
      gain.gain.setValueAtTime(0.0001, sec);
      gain.gain.linearRampToValueAtTime(isAccent ? 0.75 : 0.45, sec + 0.002);
      gain.gain.exponentialRampToValueAtTime(0.0001, sec + 0.045);
      osc.connect(gain).connect(offline.destination);
      osc.start(sec);
      osc.stop(sec + 0.05);
    }

    const rendered = await offline.startRendering();
    this._putCache(trackId, rendered);
    return activate ? this.activateTrack(trackId) : rendered;
  }

  getDuration() {
    return this.buffer ? this.buffer.duration : 0;
  }

  /* ==================== АКУСТИЧЕСКОЕ ПЛАНИРОВАНИЕ СТАРТА ==================== */

  /**
   * Запланированный старт с учётом собственной задержки аудио/Bluetooth:
   * hostStartTime = T_acoustic (когда звук должен выйти в воздух ИЗ ВСЕХ КОЛОНОК одновременно!).
   */
  async schedulePlay({ hostStartTime, trackOffset, getHostTime }) {
    if (!this.buffer) return;
    await this.ensureResumed();
    this.measureSystemLatency(false);

    this._stopSourceNode(true);

    this.hostStartTime = hostStartTime;
    this.startTrackOffset = Math.max(0, Math.min(trackOffset, this.buffer.duration));
    this._getHostTimeFn = getHostTime;
    this.isPlaying = true;
    this.lastDriftMs = 0;

    this._startSourceAligned();
    this._startDriftMonitor();
    this.onStateChange({ playing: true, scheduled: this.isScheduled });
  }

  /**
   * Внутренний старт AudioBufferSourceNode:
   * T_feed = T_acoustic - totalOutputLatencyMs
   * Устройство с BT 260 мс стартует подачу на 260 мс раньше T_acoustic;
   * Телефон без BT (24 мс) стартует подачу на 24 мс раньше T_acoustic (т.е. ждёт на 236 мс дольше).
   * Звук выходит из обоих устройств одновременно в T_acoustic!
   */
  _startSourceAligned() {
    if (!this.buffer || !this.ctx || !this._getHostTimeFn) return;

    const hostNow = this._getHostTimeFn();
    const audioNow = this.ctx.currentTime;
    const totalLatencyMs = this.getTotalOutputLatencyMs();

    // Целевое время подачи в Web Audio = hostStartTime (T_acoustic) - totalLatencyMs
    const feedTargetHostMs = this.hostStartTime - totalLatencyMs;
    const delaySec = (feedTargetHostMs - hostNow) / 1000;

    let whenAudioTime;
    let offsetInTrack;

    if (delaySec > 0.015) {
      whenAudioTime = audioNow + delaySec;
      offsetInTrack = Math.max(0, this.startTrackOffset);
      this.isScheduled = true;
    } else {
      const lookahead = 0.025;
      whenAudioTime = audioNow + lookahead;
      offsetInTrack = Math.max(0, this.startTrackOffset + -delaySec + lookahead);
      this.isScheduled = false;
    }

    if (offsetInTrack >= this.buffer.duration) {
      this.pause(this.buffer.duration);
      this.onEnded();
      return;
    }

    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = 1.0;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, whenAudioTime);
    gain.gain.linearRampToValueAtTime(1.0, whenAudioTime + 0.012);

    src.connect(gain);
    gain.connect(this.masterGain);

    src.onended = () => {
      if (this.source !== src) return;
      if (this.isPlaying && this.getCurrentPosition() >= this.buffer.duration - 0.18) {
        this.pause(0);
        this.onEnded();
      }
    };

    src.start(whenAudioTime, offsetInTrack);

    this.source = src;
    this.sourceGain = gain;
    this.anchorAudioTime = whenAudioTime;
    this.anchorTrackPos = offsetInTrack;
    this.currentRate = 1.0;
  }

  pause(explicitPos = null) {
    const pos = explicitPos !== null ? explicitPos : this.getCurrentPosition();
    this.stopInternal();
    this.pausedPosition = Math.max(0, Math.min(pos, this.getDuration()));
    this.onStateChange({ playing: false, scheduled: false });
  }

  stopInternal() {
    this._stopDriftMonitor();
    this._stopSourceNode(true);
    this.isPlaying = false;
    this.isScheduled = false;
    this.lastDriftMs = 0;
  }

  _stopSourceNode(withFade) {
    if (this.source) {
      const oldSrc = this.source;
      const oldGain = this.sourceGain;
      this.source = null;
      this.sourceGain = null;

      try {
        if (withFade && oldGain && this.ctx) {
          const now = this.ctx.currentTime;
          oldGain.gain.cancelScheduledValues(now);
          oldGain.gain.setValueAtTime(Math.max(0.0001, oldGain.gain.value), now);
          oldGain.gain.linearRampToValueAtTime(0.0001, now + 0.015);
          oldSrc.stop(now + 0.018);
        } else {
          oldSrc.stop();
        }
      } catch (_) {}
    }
  }

  /** Фактическая позиция в буфере Web Audio (сек) */
  getCurrentPosition() {
    if (!this.buffer) return 0;
    if (!this.isPlaying || !this.ctx) return this.pausedPosition;

    const audioNow = this.ctx.currentTime;
    if (audioNow < this.anchorAudioTime) {
      return this.startTrackOffset;
    }

    const elapsed = (audioNow - this.anchorAudioTime) * this.currentRate;
    return Math.max(0, Math.min(this.anchorTrackPos + elapsed, this.buffer.duration));
  }

  /** Акустическая позиция трека, звучащая в воздухе прямо сейчас (сек) */
  getAcousticPosition() {
    if (!this.buffer) return 0;
    if (!this.isPlaying || !this._getHostTimeFn) return this.pausedPosition;
    const hostNow = this._getHostTimeFn();
    if (hostNow < this.hostStartTime) return this.startTrackOffset;
    return Math.max(0, Math.min(this.startTrackOffset + (hostNow - this.hostStartTime) / 1000, this.buffer.duration));
  }

  /** Обратный отсчёт до акустического старта T_acoustic (сек) */
  getCountdownSec() {
    if (!this.isPlaying || !this._getHostTimeFn) return 0;
    const rem = (this.hostStartTime - this._getHostTimeFn()) / 1000;
    if (rem <= 0) {
      this.isScheduled = false;
      return 0;
    }
    return rem;
  }

  /** Ожидаемая позиция подачи в Web Audio с учётом локальной задержки вывода */
  getExpectedFeedPosition() {
    if (!this.isPlaying || !this._getHostTimeFn) return this.pausedPosition;
    const hostNow = this._getHostTimeFn();
    const feedTargetHostMs = this.hostStartTime - this.getTotalOutputLatencyMs();
    return this.startTrackOffset + (hostNow - feedTargetHostMs) / 1000;
  }

  _setPlaybackRate(newRate) {
    if (!this.source || !this.ctx || Math.abs(newRate - this.currentRate) < 0.0001) return;
    const audioNow = this.ctx.currentTime;
    if (audioNow >= this.anchorAudioTime) {
      this.anchorTrackPos += (audioNow - this.anchorAudioTime) * this.currentRate;
      this.anchorAudioTime = audioNow;
    }
    this.currentRate = newRate;
    this.source.playbackRate.setValueAtTime(newRate, audioNow);
  }

  _startDriftMonitor() {
    this._stopDriftMonitor();
    this._driftTimer = setInterval(() => this.checkDrift(), 650);
  }

  _stopDriftMonitor() {
    if (this._driftTimer) {
      clearInterval(this._driftTimer);
      this._driftTimer = null;
    }
  }

  checkDrift() {
    if (!this.isPlaying || !this.ctx || !this.source || !this._getHostTimeFn) return;

    if (this.ctx.currentTime < this.anchorAudioTime + 0.05) {
      this.lastDriftMs = 0;
      this.onDrift(0, 'scheduled');
      return;
    }

    const actual = this.getCurrentPosition();
    const expected = this.getExpectedFeedPosition();
    const driftMs = (actual - expected) * 1000;
    this.lastDriftMs = driftMs;

    const absDrift = Math.abs(driftMs);

    if (absDrift <= 8) {
      if (this.currentRate !== 1.0) this._setPlaybackRate(1.0);
      this.onDrift(driftMs, 'locked');
    } else if (absDrift <= 140) {
      const correctionRate = driftMs > 0 ? 0.985 : 1.015;
      this._setPlaybackRate(correctionRate);
      this.onDrift(driftMs, 'nudging');
    } else {
      this._stopSourceNode(true);
      this._startSourceAligned();
      this.onDrift(driftMs, 'resynced');
    }
  }

  refineScheduledStart() {
    if (!this.isPlaying || !this.isScheduled || !this.ctx || !this._getHostTimeFn) return;
    const rem = this.anchorAudioTime - this.ctx.currentTime;
    if (rem < 0.2) return;

    const hostNow = this._getHostTimeFn();
    const feedTargetHostMs = this.hostStartTime - this.getTotalOutputLatencyMs();
    const idealAudioTime = this.ctx.currentTime + (feedTargetHostMs - hostNow) / 1000;
    if (Math.abs(idealAudioTime - this.anchorAudioTime) > 0.005) {
      this._stopSourceNode(false);
      this._startSourceAligned();
    }
  }

  /* ==================== НАСТРОЙКИ ЗАДЕРЖКИ BLUETOOTH ==================== */

  setAutoSystemLatency(enabled) {
    this.autoSystemLatency = Boolean(enabled);
    this._savePref('orpheus_auto_sys_latency', this.autoSystemLatency ? '1' : '0');
    this._applyLatencyUpdate();
    return this.getLatencyProfile();
  }

  setExtraLatency(ms) {
    this.extraLatencyMs = Math.max(-500, Math.min(1200, Math.round(ms)));
    this._savePref('orpheus_extra_latency_ms', this.extraLatencyMs);
    this._applyLatencyUpdate();
    return this.getLatencyProfile();
  }

  nudgeExtraLatency(deltaMs) {
    if (deltaMs === 0) return this.setExtraLatency(0);
    return this.setExtraLatency(this.extraLatencyMs + deltaMs);
  }

  _applyLatencyUpdate() {
    const profile = this.getLatencyProfile();
    this._lastReportedLatencySig = '';
    this.onLatencyChange(profile);

    if (this.isPlaying && this.buffer) {
      this._stopSourceNode(true);
      this._startSourceAligned();
    }
  }

  setVolume(val) {
    this.volume = Math.max(0, Math.min(1, val));
    if (this.masterGain && !this.muted && this.ctx) {
      this.masterGain.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
    }
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    if (this.masterGain && this.ctx) {
      const target = this.muted ? 0 : this.volume;
      this.masterGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.02);
    }
  }

  getFrequencyData(targetUint8Array) {
    if (!this.analyser) return false;
    this.analyser.getByteFrequencyData(targetUint8Array);
    return true;
  }
}

window.AudioEngine = AudioEngine;
