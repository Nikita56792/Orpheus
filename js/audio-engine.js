/**
 * AudioEngine v2.2 — полностью автоматический аудиодвижок (Web Audio API)
 * с прогрессивным стримингом во время кэширования (как при просмотре фильмов)
 * и глобальным выравниванием системных и Bluetooth-задержек.
 *
 * Ключевые возможности:
 * 1. Прогрессивный стриминг: воспроизведение начинается по первому короткому
 *    аудиосегменту (~6 сек, передаётся за < 0.5 сек), пока полный файл ещё
 *    кэшируется в фоне. По завершении кэширования происходит бесшовная
 *    подмена на полный декодированный AudioBuffer с микро-кроссфейдом 12 мс.
 * 2. Поддержка Late Join: при подключении во время воспроизведения сегмент
 *    нарезается ровно с текущей позиции трека — звук включается сразу в такт.
 * 3. Полностью автоматическая компенсация Bluetooth/динамика по всему зданию.
 */
class AudioEngine {
  static MAX_CACHED_BUFFERS = 12;

  constructor({ onDrift, onEnded, onStateChange, onLatencyChange, onNeedNextSegment } = {}) {
    this.ctx = null;
    this.masterGain = null;
    this.analyser = null;
    this.buffer = null; // Полный декодированный AudioBuffer активного трека (если уже закэширован)
    this.currentTrackId = null;
    this.currentTrackDuration = 0;

    this.bufferCache = new Map();    // trackId -> AudioBuffer (полные треки)
    this.streamSegments = new Map(); // trackId -> [{ startSec, endSec, buffer }] (прогрессивные сегменты)
    this.playingFromSegment = false;
    this.activeSegmentEndSec = 0;
    this._requestedNextSegAt = -1;

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
    this.hostStartTime = 0;
    this.startTrackOffset = 0;
    this.pausedPosition = 0;

    this.anchorAudioTime = 0;
    this.anchorTrackPos = 0;
    this.currentRate = 1.0;

    // Автоматические системные и Bluetooth-задержки
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
    this._driftStrikeCount = 0;
    this._hardDriftStrikes = 0;
    this._playingLatencyStrike = 0;
    this._lastReportedLatencySig = '';
    this._latencySamples = [];
    this._outlierStreak = 0;
    this._unlockAt = 0;

    this.onDrift = onDrift || (() => {});
    this.onEnded = onEnded || (() => {});
    this.onStateChange = onStateChange || (() => {});
    this.onLatencyChange = onLatencyChange || (() => {});
    this.onNeedNextSegment = onNeedNextSegment || (() => {});

    this._iosSilentAudio = null;
    this._driftTimer = null;
    this._latencyTimer = null;
    this._warmupTimers = [];
    this._deviceChangeBound = null;
    this._getHostTimeFn = null;
    this._isAndroid = /Android/i.test(navigator.userAgent || '');
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

  setExtraLatency(ms) {
    this.extraLatencyMs = Math.max(-500, Math.min(1200, Math.round(ms)));
    this._lastReportedLatencySig = '';
    this.onLatencyChange(this.getLatencyProfile());
    if (this.isPlaying && this.hasPlayableAudio()) {
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

    try {
      const silentBuf = this.ctx.createBuffer(1, 1, 22050);
      const src = this.ctx.createBufferSource();
      src.buffer = silentBuf;
      src.connect(this.ctx.destination);
      src.start(0);
    } catch (_) {}

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

    if (this.ctx.state !== 'running') {
      try {
        await Promise.race([
          this.ctx.resume(),
          new Promise((r) => setTimeout(r, 450)),
        ]);
      } catch (_) {}
    }

    this._unlockAt = Date.now();
    this._latencySamples = [];
    this._outlierStreak = 0;
    this._ensureKeepalive();
    this._startLatencyMonitor();
    await this.probeAudioDevices();
    this.measureSystemLatency(true);

    // Android/Bluetooth A2DP выход просыпается в течение 250–900 мс после старта аудио-графа —
    // делаем серию быстрых замеров прогрева, чтобы реальная задержка ушла на Хост до старта музыки.
    for (const tm of this._warmupTimers) clearTimeout(tm);
    this._warmupTimers = [140, 320, 550, 850, 1300, 2000].map((ms) =>
      setTimeout(() => {
        if (this.ctx) this.measureSystemLatency(false);
      }, ms)
    );

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
    if (this.ctx && this.ctx.state !== 'running') {
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
      const inputs = devices.filter((d) => d.kind === 'audioinput');
      const btRegex = /bluetooth|a2dp|airpods|buds|jbl|sony|bose|marshall|beats|sennheiser|anker|soundcore|harman|bang|wireless|headset|earbuds|hands-free|wh-|wf-|flip|charge|xtreme|boombox|partybox|clip|encore|srs-|yandex|alice|sber|xiaomi|redmi|tronsmart|edifier|sven|hoco|baseus|ugreen|qcy|haylou|speaker|колонка|гарнитура|наушники|\bbt\b/i;

      let detectedLabel = '';
      let detectedBt = false;

      const defaultOut = outputs.find((d) => d.deviceId === 'default' && d.label);
      if (defaultOut) {
        detectedLabel = defaultOut.label.replace(/^Default\s*-\s*/i, '').trim();
        if (btRegex.test(detectedLabel)) detectedBt = true;
      }

      if (!detectedBt) {
        const btDev = outputs.find((d) => d.label && btRegex.test(d.label)) ||
          inputs.find((d) => d.label && btRegex.test(d.label));
        if (btDev) {
          detectedBt = true;
          if (!detectedLabel) detectedLabel = btDev.label.replace(/^Default\s*-\s*/i, '').trim();
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

  _median(arr) {
    if (!arr || arr.length === 0) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
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
          if (Number.isFinite(raw) && raw >= 0 && raw < 1500) {
            impliedMs = raw;
          }
        }
      } catch (_) {}
    }

    this.baseLatencyMs = baseMs;
    this.outputLatencyMs = outMs;
    this.impliedLatencyMs = impliedMs;

    // Если браузер отдаёт нативный AudioContext.outputLatency (Chrome/Edge) — доверяем ему,
    // а НЕ берём Math.max с шумным getOutputTimestamp() (иначе единичный GC-скачок завышает задержку).
    let rawOsMs = 0;
    if (outMs > 0) {
      rawOsMs = outMs + baseMs;
    } else if (impliedMs > 0) {
      rawOsMs = impliedMs + baseMs * 0.5;
    } else {
      rawOsMs = baseMs;
    }

    // Скользящая медиана (5 замеров): отсеивает единичные всплески, но за 2 такта схватывает реальную смену устройства
    if (this._latencySamples.length > 0) {
      const curMed = this._median(this._latencySamples);
      if (Math.abs(rawOsMs - curMed) > 75) {
        this._outlierStreak++;
        if (this._outlierStreak >= 2 || Date.now() - this._unlockAt < 1800) {
          this._latencySamples = [rawOsMs];
          this._outlierStreak = 0;
        }
      } else {
        this._outlierStreak = 0;
        this._latencySamples.push(rawOsMs);
        if (this._latencySamples.length > 5) this._latencySamples.shift();
      }
    } else {
      this._latencySamples.push(rawOsMs);
    }

    const stableOsMs = this._median(this._latencySamples);
    const isBt = this.isBluetoothDetected || stableOsMs >= 95;

    let measured = stableOsMs;
    if (this._isAndroid && isBt) {
      // На Android с A2DP Offload (Samsung/Qualcomm) AudioFlinger отдаёт ~150..325 мс без AVRCP DelayReport колонки (~155 мс).
      // На Android-устройствах, чей HAL УЖЕ включает полный AVRCP DelayReport (>= 445 мс), надбавка плавно сходит в 0,
      // чтобы не было двойного сложения (как 604 + 155 = 759 мс).
      if (stableOsMs <= 325) {
        measured = stableOsMs + 155;
      } else if (stableOsMs < 445) {
        measured = stableOsMs + Math.round((155 * (445 - stableOsMs)) / 120);
      } else {
        measured = stableOsMs;
      }
    }

    const warmingUp = Date.now() - this._unlockAt < 2500;
    const minJump = warmingUp ? 10 : 18;
    const deltaLat = Math.abs(measured - this.systemLatencyMs);

    if (this.isPlaying && !forceEmit && this.systemLatencyMs > 0) {
      // Во время активного воспроизведения аппаратная задержка вывода не меняется сама по себе:
      // фиксируем её, если не было реальной смены аудиовыхода (>= 70 мс три замера подряд).
      if (deltaLat >= 70) {
        this._playingLatencyStrike++;
        if (this._playingLatencyStrike >= 3) {
          this.systemLatencyMs = measured;
          this._playingLatencyStrike = 0;
        }
      } else {
        this._playingLatencyStrike = 0;
      }
    } else if (this.systemLatencyMs === 0 || deltaLat >= minJump) {
      this.systemLatencyMs = measured;
      this._playingLatencyStrike = 0;
    }

    const newTotal = this.getTotalOutputLatencyMs();
    const profile = this.getLatencyProfile();
    const sig = `${profile.totalLatencyMs}|${profile.systemLatencyMs}|${profile.isBluetooth}|${profile.outputDeviceLabel}`;

    if (forceEmit || sig !== this._lastReportedLatencySig) {
      this._lastReportedLatencySig = sig;
      this.onLatencyChange(profile);

      if (this.isPlaying && this.hasPlayableAudio() && Math.abs(newTotal - prevTotal) >= 65) {
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

  /* ==================== ПРОГРЕССИВНЫЙ СТРИМИНГ (НАРЕЗКА И ПРИЁМ СЕГМЕНТОВ) ==================== */

  /**
   * На Хосте: быстро нарезает компактный WAV-сегмент (32 кГц, 16-бит стерео, ~128 КБ/сек)
   * из уже декодированного AudioBuffer для мгновенного старта воспроизведения,
   * пока основной файл ещё скачивается/кэшируется на телефоны!
   */
  encodeStreamSegmentWav(trackId, startSec = 0, durationSec = 6) {
    const srcBuf = this.bufferCache.get(trackId);
    if (!srcBuf) return null;

    const clampedStart = Math.max(0, Math.min(startSec, Math.max(0, srcBuf.duration - 0.2)));
    const actualDur = Math.min(durationSec, srcBuf.duration - clampedStart);
    if (actualDur <= 0.15) return null;

    const targetRate = Math.min(22050, srcBuf.sampleRate);
    const outFrames = Math.floor(actualDur * targetRate);
    const numCh = Math.min(2, srcBuf.numberOfChannels);
    const ratio = srcBuf.sampleRate / targetRate;
    const startSample = Math.floor(clampedStart * srcBuf.sampleRate);

    const ch0 = srcBuf.getChannelData(0);
    const ch1 = numCh > 1 ? srcBuf.getChannelData(1) : ch0;

    const dataBytes = outFrames * 2 * 2; // Всегда 16-bit stereo
    const wav = new ArrayBuffer(44 + dataBytes);
    const dv = new DataView(wav);
    const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };

    writeStr(0, 'RIFF');
    dv.setUint32(4, 36 + dataBytes, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);
    dv.setUint16(22, 2, true);
    dv.setUint32(24, targetRate, true);
    dv.setUint32(28, targetRate * 4, true);
    dv.setUint16(32, 4, true);
    dv.setUint16(34, 16, true);
    writeStr(36, 'data');
    dv.setUint32(40, dataBytes, true);

    const maxIdx = ch0.length - 1;
    let byteOff = 44;
    for (let i = 0; i < outFrames; i++) {
      const pos = startSample + i * ratio;
      const idx = Math.min(maxIdx, pos | 0);
      const frac = pos - idx;
      const idx2 = Math.min(maxIdx, idx + 1);

      const sL = ch0[idx] + (ch0[idx2] - ch0[idx]) * frac;
      const sR = ch1[idx] + (ch1[idx2] - ch1[idx]) * frac;

      dv.setInt16(byteOff, Math.max(-32768, Math.min(32767, (sL * 32767) | 0)), true);
      dv.setInt16(byteOff + 2, Math.max(-32768, Math.min(32767, (sR * 32767) | 0)), true);
      byteOff += 4;
    }

    return {
      trackId,
      startSec: clampedStart,
      endSec: clampedStart + actualDur,
      totalDuration: srcBuf.duration,
      buffer: wav,
    };
  }

  /**
   * На Слушателе: декодирует полученный потоковый сегмент и делает его сразу доступным
   * для воспроизведения, не дожидаясь 100% загрузки основного файла!
   */
  async addStreamSegment(trackId, startSec, totalDuration, wavArrayBuffer) {
    if (!this.ctx) await this.unlock();
    const copy = wavArrayBuffer.slice(0);
    const decoded = await new Promise((resolve, reject) => {
      const res = this.ctx.decodeAudioData(copy, resolve, reject);
      if (res && typeof res.then === 'function') res.then(resolve).catch(reject);
    });

    const seg = {
      startSec,
      endSec: startSec + decoded.duration,
      buffer: decoded,
    };

    if (!this.streamSegments.has(trackId)) {
      this.streamSegments.set(trackId, []);
    }
    const list = this.streamSegments.get(trackId);
    // Заменяем перекрывающийся дубликат или добавляем
    const existingIdx = list.findIndex((s) => Math.abs(s.startSec - startSec) < 0.25);
    if (existingIdx >= 0) list[existingIdx] = seg;
    else list.push(seg);
    list.sort((a, b) => a.startSec - b.startSec);

    if (totalDuration > 0 && trackId === this.currentTrackId) {
      this.currentTrackDuration = totalDuration;
    }

    // Если сейчас ждём продолжения потока во время воспроизведения — сразу подхватываем новый сегмент!
    if (this.isPlaying && this.currentTrackId === trackId && !this.buffer && !this.source) {
      this._startSourceAligned();
    }

    return seg;
  }

  hasCachedTrack(trackId) {
    return this.bufferCache.has(trackId);
  }

  hasStreamOrCachedTrack(trackId) {
    if (this.bufferCache.has(trackId)) return true;
    const segs = this.streamSegments.get(trackId);
    return Boolean(segs && segs.length > 0);
  }

  hasPlayableAudio() {
    return Boolean(this.buffer || (this.currentTrackId && this.hasStreamOrCachedTrack(this.currentTrackId)));
  }

  _findSegmentForPosition(trackId, posSec) {
    const segs = this.streamSegments.get(trackId);
    if (!segs || segs.length === 0) return null;
    // Если позиция попадает в зону перекрытия двух сегментов — берём тот, у которого больше запас вперёд!
    let best = null;
    for (const s of segs) {
      if (posSec >= s.startSec - 0.05 && posSec < s.endSec - 0.05) {
        if (!best || s.endSec > best.endSec) best = s;
      }
    }
    return best;
  }

  /** Возвращает непрерывный конец закэшированных потоковых сегментов, начиная от posSec */
  getContiguousStreamEndSec(trackId, posSec) {
    if (this.bufferCache.has(trackId)) {
      return this.bufferCache.get(trackId).duration;
    }
    const segs = this.streamSegments.get(trackId);
    if (!segs || segs.length === 0) return 0;

    let frontier = posSec;
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const s of segs) {
        if (s.startSec <= frontier + 0.18 && s.endSec > frontier + 0.05) {
          frontier = s.endSec;
          expanded = true;
        }
      }
    }
    return frontier;
  }

  _putCache(trackId, audioBuffer) {
    if (this.bufferCache.has(trackId)) {
      this.bufferCache.delete(trackId);
    }
    this.bufferCache.set(trackId, audioBuffer);
    while (this.bufferCache.size > AudioEngine.MAX_CACHED_BUFFERS) {
      let evictKey = null;
      for (const k of this.bufferCache.keys()) {
        if (k !== this.currentTrackId) {
          evictKey = k;
          break;
        }
      }
      if (!evictKey) break;
      this.bufferCache.delete(evictKey);
    }
    // Чистим устаревшие потоковые сегменты неактивных треков (защита от утечки RAM)
    if (this.streamSegments.size > 3) {
      for (const k of Array.from(this.streamSegments.keys())) {
        if (k !== this.currentTrackId && k !== trackId) {
          this.streamSegments.delete(k);
        }
      }
    }
  }

  async decodeToCache(trackId, arrayBuffer) {
    if (this.bufferCache.has(trackId)) {
      return this.bufferCache.get(trackId);
    }
    if (!this.ctx) await this.unlock();
    const copy = arrayBuffer.slice(0);
    const decoded = await new Promise((resolve, reject) => {
      const res = this.ctx.decodeAudioData(copy, resolve, reject);
      if (res && typeof res.then === 'function') res.then(resolve).catch(reject);
    });
    this._putCache(trackId, decoded);
    // Очищаем временные потоковые сегменты для этого трека (полный буфер готов)
    this.streamSegments.delete(trackId);
    return decoded;
  }

  /**
   * Бесшовная подмена потокового сегмента на полный закэшированный AudioBuffer
   * прямо во время воспроизведения (с микро-кроссфейдом 12 мс, без паузы и щелчка!).
   */
  promoteFullBuffer(trackId, decodedBuffer) {
    this._putCache(trackId, decodedBuffer);
    this.streamSegments.delete(trackId);

    if (this.currentTrackId === trackId) {
      const wasStreaming = this.isPlaying && this.playingFromSegment;
      this.buffer = decodedBuffer;
      this.currentTrackDuration = decodedBuffer.duration;
      this.playingFromSegment = false;
      this._requestedNextSegAt = -1;

      if (wasStreaming) {
        // Бесшовно переключаем активный AudioBufferSourceNode на полный файл!
        this._stopSourceNode(true);
        this._startSourceAligned();
      }
    }
  }

  /** Активация трека в режиме стриминга (до завершения загрузки полного файла) */
  activateStreamTrack(trackId, totalDuration) {
    if (this.currentTrackId === trackId && this.isPlaying) {
      this.currentTrackDuration = totalDuration || this.currentTrackDuration;
      return;
    }
    this.stopInternal();
    this.currentTrackId = trackId;
    this.buffer = this.bufferCache.get(trackId) || null;
    this.currentTrackDuration = this.buffer ? this.buffer.duration : (totalDuration || 0);
    this.pausedPosition = 0;
    this._requestedNextSegAt = -1;
  }

  activateTrack(trackId) {
    const buf = this.bufferCache.get(trackId);
    if (!buf) return null;
    // Переносим активный трек в конец LRU-кэша
    this.bufferCache.delete(trackId);
    this.bufferCache.set(trackId, buf);
    this.stopInternal();
    this.currentTrackId = trackId;
    this.buffer = buf;
    this.currentTrackDuration = buf.duration;
    this.playingFromSegment = false;
    this.pausedPosition = 0;
    this._requestedNextSegAt = -1;
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
    if (this.buffer) return this.buffer.duration;
    return this.currentTrackDuration || 0;
  }

  /* ==================== АКУСТИЧЕСКОЕ ПЛАНИРОВАНИЕ (ПОЛНЫЙ БУФЕР + ПОТОКОВЫЕ СЕГМЕНТЫ) ==================== */

  async schedulePlay({ hostStartTime, trackOffset, getHostTime }) {
    if (!this.hasPlayableAudio()) return;
    await this.ensureResumed();
    this.measureSystemLatency(false);

    this._stopSourceNode(true);

    this.hostStartTime = hostStartTime;
    const dur = this.getDuration();
    this.startTrackOffset = Math.max(0, dur > 0 ? Math.min(trackOffset, dur) : trackOffset);
    this._getHostTimeFn = getHostTime;
    this.isPlaying = true;
    this.lastDriftMs = 0;
    this._driftStrikeCount = 0;
    this._playingLatencyStrike = 0;
    this._requestedNextSegAt = -1;

    this._startSourceAligned();
    this._startDriftMonitor();
    this.onStateChange({ playing: true, scheduled: this.isScheduled });
  }

  _startSourceAligned() {
    if (!this.ctx || !this._getHostTimeFn) return;

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
      const lookahead = 0.025;
      whenAudioTime = audioNow + lookahead;
      offsetInTrack = Math.max(0, this.startTrackOffset + -delaySec + lookahead);
      this.isScheduled = false;
    }

    const totalDur = this.getDuration();
    if (totalDur > 0 && offsetInTrack >= totalDur) {
      this.pause(totalDur);
      this.onEnded();
      return;
    }

    // Выбираем источник: либо полный AudioBuffer, либо потоковый сегмент!
    let targetBuffer = this.buffer;
    let bufferLocalOffset = offsetInTrack;
    let usingSegment = false;
    let segEndSec = totalDur;

    if (!targetBuffer && this.currentTrackId) {
      const seg = this._findSegmentForPosition(this.currentTrackId, offsetInTrack);
      if (!seg) {
        // Сегмент для этой позиции ещё в пути — запрашиваем его у Хоста!
        this.playingFromSegment = true;
        this.activeSegmentEndSec = 0;
        this._requestNextSegmentIfNeeded(offsetInTrack);
        return;
      }
      targetBuffer = seg.buffer;
      bufferLocalOffset = Math.max(0, offsetInTrack - seg.startSec);
      usingSegment = true;
      segEndSec = seg.endSec;
    }

    if (!targetBuffer) return;

    const src = this.ctx.createBufferSource();
    src.buffer = targetBuffer;
    src.playbackRate.value = 1.0;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, whenAudioTime);
    gain.gain.linearRampToValueAtTime(1.0, whenAudioTime + 0.012);

    src.connect(gain);
    gain.connect(this.masterGain);

    src.onended = () => {
      if (this.source !== src) return;
      this.source = null;
      this.sourceGain = null;

      if (!this.isPlaying) return;

      if (usingSegment && totalDur > 0 && segEndSec < totalDur - 0.2) {
        // Сегмент закончился — бесшовно переходим на следующий сегмент или полный буфер!
        this._startSourceAligned();
        return;
      }

      if (!usingSegment || (totalDur > 0 && this.getCurrentPosition() >= totalDur - 0.25)) {
        this.pause(0);
        this.onEnded();
      }
    };

    src.start(whenAudioTime, bufferLocalOffset);

    this.source = src;
    this.sourceGain = gain;
    this.playingFromSegment = usingSegment;
    this.activeSegmentEndSec = segEndSec;
    this.anchorAudioTime = whenAudioTime;
    this.anchorTrackPos = offsetInTrack;
    this.currentRate = 1.0;
  }

  _requestNextSegmentIfNeeded(fromSec) {
    if (!this.currentTrackId || this.buffer) return;
    const totalDur = this.getDuration();
    if (totalDur > 0 && fromSec >= totalDur - 0.25) return;

    if (this._findSegmentForPosition(this.currentTrackId, fromSec + 0.25)) return;

    const bucket = Math.floor(fromSec / 2);
    if (bucket === this._requestedNextSegAt) return;
    this._requestedNextSegAt = bucket;
    this.onNeedNextSegment({ trackId: this.currentTrackId, fromSec: Math.max(0, fromSec) });
  }

  pause(explicitPos = null) {
    const pos = explicitPos !== null ? explicitPos : this.getCurrentPosition();
    this.stopInternal();
    this.pausedPosition = Math.max(0, this.getDuration() > 0 ? Math.min(pos, this.getDuration()) : pos);
    this.onStateChange({ playing: false, scheduled: false });
  }

  stopInternal() {
    this._stopDriftMonitor();
    this._stopSourceNode(true);
    this.isPlaying = false;
    this.isScheduled = false;
    this.playingFromSegment = false;
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
    if (!this.hasPlayableAudio()) return 0;
    if (!this.isPlaying || !this.ctx) return this.pausedPosition;

    const audioNow = this.ctx.currentTime;
    if (audioNow < this.anchorAudioTime) {
      return this.startTrackOffset;
    }

    const elapsed = (audioNow - this.anchorAudioTime) * this.currentRate;
    const dur = this.getDuration();
    const pos = this.anchorTrackPos + elapsed;
    return Math.max(0, dur > 0 ? Math.min(pos, dur) : pos);
  }

  getAcousticPosition() {
    if (!this.hasPlayableAudio()) return 0;
    if (!this.isPlaying || !this._getHostTimeFn) return this.pausedPosition;
    const hostNow = this._getHostTimeFn();
    if (hostNow < this.hostStartTime) return this.startTrackOffset;
    const dur = this.getDuration();
    const pos = this.startTrackOffset + (hostNow - this.hostStartTime) / 1000;
    return Math.max(0, dur > 0 ? Math.min(pos, dur) : pos);
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
    this._driftTimer = setInterval(() => this.checkDrift(), 550);
  }

  _stopDriftMonitor() {
    if (this._driftTimer) {
      clearInterval(this._driftTimer);
      this._driftTimer = null;
    }
  }

  checkDrift() {
    if (!this.isPlaying || !this.ctx || !this._getHostTimeFn) return;
    if (this.ctx.state !== 'running') {
      // Если AudioContext приостановлен (например, до клика после F5 или прерывание ОС) — не перезапускаем источник в цикле
      this.ctx.resume().catch(() => {});
      return;
    }

    // Бесшовное подкачивание следующего потокового сегмента за 5.5 сек до исчерпания буфера
    if (this.playingFromSegment && !this.buffer && this.currentTrackId) {
      const curPos = this.getCurrentPosition();
      const contiguousEnd = this.getContiguousStreamEndSec(this.currentTrackId, curPos);
      const totalDur = this.getDuration();
      if (contiguousEnd > 0 && (totalDur === 0 || contiguousEnd < totalDur - 0.2)) {
        if (contiguousEnd - curPos < 5.5) {
          this._requestNextSegmentIfNeeded(Math.max(0, contiguousEnd - 0.25));
        }
      }

      // Если до конца ТЕКУЩЕГО сегмента осталось < 0.35 сек, а следующий уже декодирован —
      // бесшовно переключаемся на него ДО обрыва звука!
      if (this.source && this.activeSegmentEndSec > 0 && this.activeSegmentEndSec - curPos < 0.35) {
        const nextSeg = this._findSegmentForPosition(this.currentTrackId, curPos + 0.4);
        if (nextSeg && nextSeg.endSec > this.activeSegmentEndSec + 0.5) {
          this._stopSourceNode(true);
          this._startSourceAligned();
          return;
        }
      }
    }

    if (!this.source) return;

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

    // Защита от искажения тональности (pitch wobble):
    // 1) Никогда не меняем playbackRate при обычном джиттере (<= 35 мс) — чистый 1.000x без изменения тональности.
    // 2) При устойчивом реальном дрейфе (35..140 мс три проверки подряд) используем неслышимую микро-подстройку
    //    ±0.15% (~2.5 цента, ниже порога слухового восприятия высоты тона) вместо заметных ±1.5%.
    // 3) При реальном крупном сдвиге (> 140 мс два раза подряд) делаем чистую пересинхронизацию с кроссфейдом.
    if (absDrift <= 18) {
      this._driftStrikeCount = 0;
      this._hardDriftStrikes = 0;
      if (this.currentRate !== 1.0) this._setPlaybackRate(1.0);
      this.onDrift(driftMs, 'locked');
    } else if (absDrift <= 35) {
      this._driftStrikeCount = 0;
      this._hardDriftStrikes = 0;
      // Сбрасываем rate обратно в 1.0, если ранее шла коррекция в противоположную сторону или дрейф уменьшился
      const opposing = (driftMs > 0 && this.currentRate > 1.0) || (driftMs < 0 && this.currentRate < 1.0);
      if (this.currentRate !== 1.0 && (absDrift <= 22 || opposing)) {
        this._setPlaybackRate(1.0);
      }
      this.onDrift(driftMs, 'locked');
    } else if (absDrift <= 140) {
      this._hardDriftStrikes = 0;
      this._driftStrikeCount++;
      if (this._driftStrikeCount >= 3) {
        const correctionRate = driftMs > 0 ? 0.9985 : 1.0015;
        this._setPlaybackRate(correctionRate);
        this.onDrift(driftMs, 'nudging');
      } else {
        this.onDrift(driftMs, 'locked');
      }
    } else {
      this._hardDriftStrikes++;
      if (this._hardDriftStrikes >= 2) {
        this._driftStrikeCount = 0;
        this._hardDriftStrikes = 0;
        this._stopSourceNode(true);
        this._startSourceAligned();
        this.onDrift(driftMs, 'resynced');
      } else {
        this.onDrift(driftMs, 'nudging');
      }
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
