/**
 * AudioEngine — высокоточный аудиодвижок на базе Web Audio API.
 *
 * Ключевые решения:
 * 1. Аппаратные часы AudioContext.currentTime вместо <audio> (точность до сэмпла).
 * 2. Полная разблокировка Autoplay на iOS Safari / Android Chrome (silent buffer + silent WAV <audio>).
 * 3. Двухуровневая компенсация дрейфа:
 *    - |drift| <= 12 мс: мёртвая зона (rate = 1.0)
 *    - 12..160 мс: плавная подстройка playbackRate (±1.5%, незаметна на слух, без щелчков)
 *    - > 160 мс: жёсткий ресинк с микро-фейдом 15 мс
 * 4. Ручная компенсация задержки (Bluetooth-наушники): manualOffsetMs (-50 / +50 мс).
 * 5. Встроенный детерминированный тест-бит (120 BPM) через OfflineAudioContext для мгновенной проверки синхрона.
 */
class AudioEngine {
  constructor({ onDrift, onEnded, onStateChange } = {}) {
    this.ctx = null;
    this.masterGain = null;
    this.analyser = null;
    this.buffer = null;

    this.source = null;
    this.sourceGain = null;

    this.volume = 1.0;
    this.muted = false;
    this.unlocked = false;

    // Состояние воспроизведения относительно единых часов Хоста
    this.isPlaying = false;
    this.isScheduled = false;
    this.hostStartTime = 0;   // Время Хоста (ms), в которое трек проходит точку startTrackOffset
    this.startTrackOffset = 0; // Позиция в треке (sec) в момент hostStartTime
    this.pausedPosition = 0;   // Сохранённая позиция на паузе (sec)

    // Точный трекинг текущей позиции AudioBufferSourceNode с учётом переменного playbackRate
    this.anchorAudioTime = 0;
    this.anchorTrackPos = 0;
    this.currentRate = 1.0;

    // Ручная коррекция (ms): отрицательное значение = запускать звук РАНЬШЕ (компенсация Bluetooth)
    this.manualOffsetMs = this._loadSavedManualOffset();
    this.lastDriftMs = 0;

    this.onDrift = onDrift || (() => {});
    this.onEnded = onEnded || (() => {});
    this.onStateChange = onStateChange || (() => {});

    this._iosSilentAudio = null;
    this._driftTimer = null;
    this._getHostTimeFn = null;
  }

  _loadSavedManualOffset() {
    try {
      const raw = localStorage.getItem('orpheus_manual_offset_ms');
      const val = Number(raw);
      return Number.isFinite(val) ? Math.max(-1000, Math.min(1000, val)) : 0;
    } catch (_) {
      return 0;
    }
  }

  _saveManualOffset(ms) {
    try {
      localStorage.setItem('orpheus_manual_offset_ms', String(ms));
    } catch (_) {}
  }

  /**
   * Инициализация и разблокировка Web Audio API.
   * ОБЯЗАТЕЛЬНО вызывать напрямую внутри обработчика клика/тапа пользователя!
   */
  async unlock() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!this.ctx) {
      this.ctx = new AudioCtx({ latencyHint: 'interactive' });

      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.muted ? 0 : this.volume;

      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 128;
      this.analyser.smoothingTimeConstant = 0.78;

      this.masterGain.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    }

    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }

    // 1) Проигрываем 1-сэмпловый тихий буфер в Web Audio (разблокировка iOS Safari / Chrome)
    try {
      const silentBuf = this.ctx.createBuffer(1, 1, 22050);
      const src = this.ctx.createBufferSource();
      src.buffer = silentBuf;
      src.connect(this.ctx.destination);
      src.start(0);
    } catch (err) {
      console.warn('[AudioEngine] Silent WebAudio warm-up:', err);
    }

    // 2) Прогрев HTML5 <audio> миниатюрным WAV-файлом тишины — на iOS переводит аудио-сессию
    //    в режим Media Playback, чтобы Web Audio работал надёжнее.
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

    this.unlocked = true;
    return true;
  }

  /** Проверка и восстановление AudioContext при возврате из фона */
  async ensureResumed() {
    if (this.ctx && this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch (_) {}
    }
  }

  /** Декодирование ArrayBuffer (MP3/WAV/M4A/OGG) в аппаратный AudioBuffer */
  async decodeArrayBuffer(arrayBuffer) {
    if (!this.ctx) {
      await this.unlock();
    }
    // Делаем копию буфера, так как decodeAudioData «отцепляет» (detaches) исходный ArrayBuffer
    const copy = arrayBuffer.slice(0);
    const decoded = await new Promise((resolve, reject) => {
      const res = this.ctx.decodeAudioData(copy, resolve, reject);
      if (res && typeof res.then === 'function') {
        res.then(resolve).catch(reject);
      }
    });
    this.stopInternal();
    this.buffer = decoded;
    this.pausedPosition = 0;
    return decoded;
  }

  /**
   * Детерминированный встроенный тест-трек (120 BPM, 32 секунды).
   * Генерируется локально на каждом устройстве с точностью до сэмпла без передачи по сети.
   * Чёткая бочка и хай-хэты позволяют на слух оценить синхронность до ~10 мс.
   */
  async generateDemoTrack() {
    if (!this.ctx) {
      await this.unlock();
    }

    const sampleRate = 44100;
    const bpm = 120;
    const beatSec = 60 / bpm; // 0.5 сек
    const totalBeats = 64;    // 32 секунды
    const duration = totalBeats * beatSec;

    const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const offline = new OfflineCtx(2, Math.floor(sampleRate * duration), sampleRate);

    // Мастер-компрессор для плотного студийного звучания
    const comp = offline.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    comp.connect(offline.destination);

    // Прогрессия аккордов (Am9 - Fmaj7 - Cmaj7 - G6)
    const chords = [
      [220.0, 261.63, 329.63, 392.0, 493.88],
      [174.61, 220.0, 261.63, 329.63],
      [130.81, 196.0, 246.94, 329.63],
      [196.0, 246.94, 293.66, 329.63],
    ];
    const bassNotes = [110.0, 87.31, 65.41, 98.0];

    // Детерминированный буфер белого шума для хай-хэтов и клэпов
    const noiseLen = Math.floor(sampleRate * 0.25);
    const noiseBuf = offline.createBuffer(1, noiseLen, sampleRate);
    const noiseData = noiseBuf.getChannelData(0);
    let seed = 1337;
    for (let i = 0; i < noiseLen; i++) {
      seed = (seed * 16807) % 2147483647;
      noiseData[i] = (seed / 1073741823.5) - 1;
    }

    for (let beat = 0; beat < totalBeats; beat++) {
      const t = beat * beatSec;
      const bar = Math.floor(beat / 4);
      const chordIdx = bar % chords.length;

      // 1. Чёткая бочка на каждую четверть (идеально слышно рассинхрон)
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

      // Короткий клик-транзиент бочки (помогает слышать точность до миллисекунд)
      const clickOsc = offline.createOscillator();
      const clickGain = offline.createGain();
      clickOsc.type = 'triangle';
      clickOsc.frequency.setValueAtTime(1200, t);
      clickOsc.frequency.exponentialRampToValueAtTime(200, t + 0.015);
      clickGain.gain.setValueAtTime(beat % 4 === 0 ? 0.35 : 0.18, t);
      clickGain.gain.exponentialRampToValueAtTime(0.001, t + 0.02);
      clickOsc.connect(clickGain).connect(comp);
      clickOsc.start(t);
      clickOsc.stop(t + 0.025);

      // 2. Клэп/снейр на 2-ю и 4-ю долю
      if (beat % 2 === 1) {
        const clap = offline.createBufferSource();
        clap.buffer = noiseBuf;
        const hp = offline.createBiquadFilter();
        hp.type = 'bandpass';
        hp.frequency.value = 1800;
        hp.Q.value = 1.2;
        const cg = offline.createGain();
        cg.gain.setValueAtTime(0.32, t);
        cg.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
        clap.connect(hp).connect(cg).connect(comp);
        clap.start(t);
        clap.stop(t + 0.16);
      }

      // 3. Хай-хэт на восьмые доли
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

      // 4. Синт-бас на восьмые (качающий)
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

      // 5. Пэд-аккорды в начале каждого такта
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
    this.stopInternal();
    this.buffer = rendered;
    this.pausedPosition = 0;
    return rendered;
  }

  getDuration() {
    return this.buffer ? this.buffer.duration : 0;
  }

  /**
   * Запланированный аппаратный старт (Scheduled Playback).
   * @param {number} hostStartTime - Время по часам Хоста (ms), в которое трек равен trackOffset
   * @param {number} trackOffset - Позиция в треке (сек)
   * @param {Function} getHostTime - Функция возвращающая текущее время Хоста (ms)
   */
  async schedulePlay({ hostStartTime, trackOffset, getHostTime }) {
    if (!this.buffer) return;
    await this.ensureResumed();

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
   * Внутренний запуск AudioBufferSourceNode, точно выровненный по (hostStartTime, startTrackOffset, manualOffsetMs).
   * Работает одинаково точно и для будущего старта (+3000 мс), и для позднего входа / жёсткого ресинка.
   */
  _startSourceAligned() {
    if (!this.buffer || !this.ctx || !this._getHostTimeFn) return;

    const hostNow = this._getHostTimeFn();
    const audioNow = this.ctx.currentTime;

    // Сколько осталось до момента старта с учётом ручной коррекции Bluetooth:
    // Если manualOffsetMs = -100 (наушники отстают на 100мс), стартуем на 100мс РАНЬШЕ.
    const delaySec = (this.hostStartTime + this.manualOffsetMs - hostNow) / 1000;

    let whenAudioTime;
    let offsetInTrack;

    if (delaySec > 0.015) {
      // Старт в будущем (буфер 2-3 секунды)
      whenAudioTime = audioNow + delaySec;
      offsetInTrack = Math.max(0, this.startTrackOffset);
      this.isScheduled = true;
    } else {
      // Точка старта уже в прошлом (поздний вход или мгновенный ресинк)
      const lookahead = 0.025; // 25 мс запаса для плавного старта без щелчка
      whenAudioTime = audioNow + lookahead;
      offsetInTrack = Math.max(0, this.startTrackOffset + (-delaySec) + lookahead);
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
    // Микро-фейд 12 мс убирает щелчок при пересинхронизации
    gain.gain.setValueAtTime(0.0001, whenAudioTime);
    gain.gain.linearRampToValueAtTime(1.0, whenAudioTime + 0.012);

    src.connect(gain);
    gain.connect(this.masterGain);

    src.onended = () => {
      // Игнорируем onended от старых остановленных узлов
      if (this.source !== src) return;
      if (this.isPlaying && this.getCurrentPosition() >= this.buffer.duration - 0.15) {
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

  /** Пауза с запоминанием позиции */
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

  /** Точная фактическая позиция трека, воспроизводимая сейчас аудиокартой (сек) */
  getCurrentPosition() {
    if (!this.buffer) return 0;
    if (!this.isPlaying || !this.ctx) return this.pausedPosition;

    const audioNow = this.ctx.currentTime;
    if (audioNow < this.anchorAudioTime) {
      // Идёт обратный отсчёт перед стартом
      return this.startTrackOffset;
    }

    const elapsed = (audioNow - this.anchorAudioTime) * this.currentRate;
    return Math.max(0, Math.min(this.anchorTrackPos + elapsed, this.buffer.duration));
  }

  /** Сколько секунд осталось до запланированного старта (0, если уже играет) */
  getCountdownSec() {
    if (!this.isPlaying || !this.ctx) return 0;
    const rem = this.anchorAudioTime - this.ctx.currentTime;
    if (rem <= 0) {
      this.isScheduled = false;
      return 0;
    }
    return rem;
  }

  /** Ожидаемая позиция трека по единому времени Хоста (сек) */
  getExpectedPosition() {
    if (!this.isPlaying || !this._getHostTimeFn) return this.pausedPosition;
    const hostNow = this._getHostTimeFn();
    return this.startTrackOffset + (hostNow - (this.hostStartTime + this.manualOffsetMs)) / 1000;
  }

  /** Плавное изменение скорости воспроизведения с сохранением точной позиции якоря */
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

  /** Мониторинг и компенсация дрейфа (запускается каждые 700 мс) */
  _startDriftMonitor() {
    this._stopDriftMonitor();
    this._driftTimer = setInterval(() => this.checkDrift(), 700);
  }

  _stopDriftMonitor() {
    if (this._driftTimer) {
      clearInterval(this._driftTimer);
      this._driftTimer = null;
    }
  }

  checkDrift() {
    if (!this.isPlaying || !this.ctx || !this.source || !this._getHostTimeFn) return;

    // Пока идёт предстартовый отсчёт (ещё не заиграло), дрейф не трогаем
    if (this.ctx.currentTime < this.anchorAudioTime + 0.05) {
      this.lastDriftMs = 0;
      this.onDrift(0, 'scheduled');
      return;
    }

    const actual = this.getCurrentPosition();
    const expected = this.getExpectedPosition();
    const driftMs = (actual - expected) * 1000;
    this.lastDriftMs = driftMs;

    const absDrift = Math.abs(driftMs);

    if (absDrift <= 12) {
      // В пределах мёртвой зоны ±12 мс — идеальный синхрон
      if (this.currentRate !== 1.0) {
        this._setPlaybackRate(1.0);
      }
      this.onDrift(driftMs, 'locked');
    } else if (absDrift <= 160) {
      // Мягкая подстройка скорости (незаметна на слух, без щелчков)
      // Если driftMs > 0 (мы спешим), чуть замедляемся (0.985), иначе чуть ускоряемся (1.015)
      const correctionRate = driftMs > 0 ? 0.985 : 1.015;
      this._setPlaybackRate(correctionRate);
      this.onDrift(driftMs, 'nudging');
    } else {
      // Большой рассинхрон (например, после сворачивания вкладки или резкой смены offset)
      this._stopSourceNode(true);
      this._startSourceAligned();
      this.onDrift(driftMs, 'resynced');
    }
  }

  /**
   * Если во время обратного отсчёта (до старта звука) NTP уточнил смещение часов > 6 мс,
   * бесшумно перепланируем точку старта, чтобы самый первый удар попал идеально в такт.
   */
  refineScheduledStart() {
    if (!this.isPlaying || !this.isScheduled || !this.ctx || !this._getHostTimeFn) return;
    const rem = this.anchorAudioTime - this.ctx.currentTime;
    if (rem < 0.25) return; // Слишком близко к старту, не трогаем

    const hostNow = this._getHostTimeFn();
    const idealAudioTime = this.ctx.currentTime + (this.hostStartTime + this.manualOffsetMs - hostNow) / 1000;
    if (Math.abs(idealAudioTime - this.anchorAudioTime) > 0.006) {
      this._stopSourceNode(false);
      this._startSourceAligned();
    }
  }

  /**
   * Ручная микро-коррекция (кнопки -50 мс / +50 мс для Bluetooth-наушников).
   * Применяется мгновенно во время проигрывания.
   */
  setManualOffset(ms) {
    this.manualOffsetMs = Math.max(-1000, Math.min(1000, Math.round(ms)));
    this._saveManualOffset(this.manualOffsetMs);

    if (this.isPlaying && this.buffer) {
      // Если изменение ощутимое (>= 25 мс) — мгновенно пересинхронизируем с микро-фейдом,
      // чтобы пользователь сразу услышал эффект нажатия кнопки
      this._stopSourceNode(true);
      this._startSourceAligned();
    }
    return this.manualOffsetMs;
  }

  nudgeManualOffset(deltaMs) {
    if (deltaMs === 0) return this.setManualOffset(0);
    return this.setManualOffset(this.manualOffsetMs + deltaMs);
  }

  setVolume(val) {
    this.volume = Math.max(0, Math.min(1, val));
    if (this.masterGain && !this.muted) {
      this.masterGain.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
    }
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    if (this.masterGain) {
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
