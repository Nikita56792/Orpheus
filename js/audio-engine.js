/**
 * AudioEngine — полностью автоматический аудиодвижок (Web Audio API)
 * с глобальным выравниванием системных и Bluetooth-задержек по всему зданию.
 *
 * Всё работает автоматически без ручных настроек:
 * 1. Неслышимый keepalive-узел держит аппаратный тракт активным, чтобы
 *    AudioContext.outputLatency / baseLatency / getOutputTimestamp() всегда отдавали
 *    точную системную задержку динамика или подключённого Bluetooth-устройства.
 * 2. Событие devicechange + фоновый мониторинг мгновенно замечают подключение/отключение
 *    Bluetooth на любом устройстве и автоматически пересинхронизируют сеть.
 * 3. Все устройства синхронизируются по единому акустическому времени T_acoustic:
 *    T_feed_i = T_acoustic - totalLatencyMs_i
 *    — Bluetooth-устройства подают звук заранее, а обычные телефоны ждут разницу.
 *    — При подключении новых устройств прямо во время воспроизведения (Late Join)
 *      они мгновенно встраиваются в акустическую шкалу времени с учётом своей задержки.
 */
class AudioEngine {
  static MAX_CACHED_BUFFERS = 12;

  constructor({ onDrift, onEnded, onStateChange, onLatencyChange } = {}) {
    this.ctx = null;
    this.masterGain = null;
    this.analyser = null;
    this.buffer = null;
    this.currentTrackId = null;
    this.bufferCache = new Map();

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
    this.pausedPosition = 0;

    // Точный трекинг текущей позиции с учётом переменного playbackRate
    this.anchorAudioTime = 0;
    this.anchorTrackPos = 0;
    this.currentRate = 1.0;

    // Автоматически измеряемые задержки аудиовывода и Bluetooth
    this.autoSystemLatency = true;
    this.extraLatencyMs = 0;
    this.baseLatencyMs = 0;
    this.outputLatencyMs = 0;
    this.impliedLatencyMs = 0;
    this.systemLatencyMs = 0;
    this.isBluetoothDetected = false;
    this.outputDeviceLabel = '';
    this.roomMaxLatencyMs = 0;

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

  getTotalOutputLatencyMs() {
    const sys = this.autoSystemLatency ? this.systemLatencyMs : 0;
    return Math.max(0, Math.round(sys + this.extraLatencyMs));
  }

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

  /** Программная подстройка (для тестов/диагностики) */
  setExtraLatency(ms) {
    this.extraLatencyMs = Math.max(-500, Math.min(1200, Math.round(ms)));
    this._lastReportedLatencySig = '';
    this.onLatencyChange(this.getLatencyProfile());
    if (this.isPlaying && this.buffer) {
      this._stopSourceNode(true);
      this._startSourceAligned();
    }
    return this.getLatencyProfile();
  }

  async unlock() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
      throw new Error('Браузер не поддерживает Web Audio API');
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

    // 1) Синхронный прогрев 1-сэмпловым буфером (iOS Safari)
    try {
      const silentBuf = this.ctx.createBuffer(1, 1, 22050);
      const src = this.ctx.createBufferSource();
      src.buffer = silentBuf;
      src.connect(this.ctx.destination);
      src.start(0);
    } catch (_) {}

    // 2) Тихий WAV для активации Media Playback режима на iOS
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

    if (this.ctx.state === 'suspended') {
      try {
        await Promise.race([
          this.ctx.resume(),
          new Promise((r) => setTimeout(r, 450)),
        ]);
      } catch (_) {}
    }

    // 3) Неслышимый keepalive-узел — держит outputLatency и getOutputTimestamp() живыми
    this._ensureKeepalive();
    this._startLatencyMonitor();
    await this.probeAudioDevices();
    this.measureSystemLatency(true);

    // Повторное быстрое измерение через 300 мс после старта keepalive (когда ОС прогрела A2DP/DAC)
    setTimeout(() => this.measureSystemLatency(false), 300);

    this.unlocked = true;
    return true;
  }

  _ensureKeepalive() {
    if (!this.ctx || this._keepaliveOsc) return;
    try {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.frequency.value = 30;
      gain.gain.value = 0;
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

  async probeAudioDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const outputs = devices.filter((d) => d.kind === 'audiooutput');
      const btRegex = /bluetooth|a2dp|airpods|buds|jbl|sony|bose|marshall|beats|sennheiser|anker|soundcore|harman|bang|wireless|headset|earbuds|hands-free|wh-|wf-|flip|charge|xtreme|boombox|bt\b/i;

      let detectedLabel = '';
      let detectedBt = false;

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

    let measured = 0;
    if (outMs > 0) {
      measured = Math.max(outMs + baseMs, impliedMs);
    } else if (impliedMs > 0) {
      measured = impliedMs + baseMs * 0.5;
    } else {
      measured = baseMs;
    }

    if (this.systemLatencyMs === 0 || Math.abs(measured - this.systemLatencyMs) > 18) {
      this.systemLatencyMs = measured;
    } else {
      this.systemLatencyMs = this.systemLatencyMs * 0.7 + measured * 0.3;
    }

    const newTotal = this.getTotalOutputLatencyMs();
    const profile = this.getLatencyProfile();
    const sig = `${profile.totalLatencyMs}|${profile.systemLatencyMs}|${profile.isBluetooth}|${profile.outputDeviceLabel}`;

    if (forceEmit || sig !== this._lastReportedLatencySig) {
      this._lastReportedLatencySig = sig;
      this.onLatencyChange(profile);

      // Если во время игры подключился/отключился Bluetooth — мгновенно перестраиваемся
      if (this.isPlaying && this.buffer && Math.abs(newTotal - prevTotal) >= 12) {
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
    }, 1000);

    if (!this._deviceChangeBound && navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      this._deviceChangeBound = async () => {
        await this.probeAudioDevices();
        setTimeout(() => this.measureSystemLatency(true), 300);
        setTimeout(() => this.measureSystemLatency(true), 900);
      };
      navigator.mediaDevices.addEventListener('devicechange', this._deviceChangeBound);
    }
  }

  /* ==================== КЭШ И ДЕКОДИРОВАНИЕ ==================== */

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

  async generateDemoTrack(trackId = 'demo-120bpm-v2', activate = true) {
    if (this.bufferCache.has(trackId)) {
      return activate ? this.activateTrack(trackId) : this.bufferCache.get(trackId);
    }
    if (!this.ctx) await this.unlock();

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

  async generatePulseTrack(trackId = 'demo-pulse-60bpm-v2', activate = true) {
    if (this.bufferCache.has(trackId)) {
      return activate ? this.activateTrack(trackId) : this.bufferCache.get(trackId);
    }
    if (!this.ctx) await this.unlock();

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

  /* ==================== АКУСТИЧЕСКОЕ ПЛАНИРОВАНИЕ ==================== */

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

  _startSourceAligned() {
    if (!this.buffer || !this.ctx || !this._getHostTimeFn) return;

    const hostNow = this._getHostTimeFn();
    const audioNow = this.ctx.currentTime;
    const totalLatencyMs = this.getTotalOutputLatencyMs();

    const feedTargetHostMs = this.hostStartTime - totalLatencyMs;
    const delaySec = (feedTargetHostMs - hostNow) / 1000;

    let whenAudioTime;
    let offsetInTrack;

    if (delaySec > 0.015) {
      whenAudioTime = audioNow + delaySec;
      offsetInTrack = Math.max(0, this.startTrackOffset);
      this.isScheduled = true;
    } else {
      // Поздний вход (Late Join) или мгновенный ресинк
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

  getAcousticPosition() {
    if (!this.buffer) return 0;
    if (!this.isPlaying || !this._getHostTimeFn) return this.pausedPosition;
    const hostNow = this._getHostTimeFn();
    if (hostNow < this.hostStartTime) return this.startTrackOffset;
    return Math.max(0, Math.min(this.startTrackOffset + (hostNow - this.hostStartTime) / 1000, this.buffer.duration));
  }

  getCountdownSec() {
    if (!this.isPlaying || !this._getHostTimeFn) return 0;
    const rem = (this.hostStartTime - this._getHostTimeFn()) / 1000;
    if (rem <= 0) {
      this.isScheduled = false;
      return 0;
    }
    return rem;
  }

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
    this._driftTimer = setInterval(() => this.checkDrift(), 600);
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
