/**
 * ClockSync — высокоточный NTP-алгоритм (4 временные метки) поверх выделенного канала.
 *
 * Особенности:
 * - Работает поверх монотонного performance.now() (невосприимчив к скачкам системных часов).
 * - При работе поверх WebRTC использует отдельный неупорядоченный UDP-канал (orpheus-ntp),
 *   поэтому передача тяжёлых аудиофайлов вообще не искажает пинг и не вносит джиттер.
 * - Фильтрация по минимальному RTT (отсекает очереди Wi-Fi и асимметричные скачки).
 * - Адаптивный интервал опроса (чаще по LAN/P2P, бережно в WSS Relay).
 */
class ClockSync {
  constructor({ isHost, sendPing, onUpdate, mode = 'p2p' }) {
    this.isHost = isHost;
    this.sendPing = sendPing;
    this.onUpdate = onUpdate || (() => {});
    this.mode = mode; // 'p2p' | 'relay'

    this.offsetMs = 0;        // hostTime - localTime
    this.rttMs = 0;           // лучший фильтрованный RTT
    this.jitterMs = 0;        // оценка джиттера
    this.synced = isHost;
    this.samples = [];        // скользящее окно замеров { rtt, offset, ts }
    this.maxSamples = 18;
    this.seq = 0;
    this.pending = new Map(); // seq -> t0
    this.intervalId = null;
    this.burstTimeoutIds = [];
  }

  localNow() {
    return performance.now();
  }

  hostNow() {
    if (this.isHost) return this.localNow();
    return this.localNow() + this.offsetMs;
  }

  hostToLocal(hostTimeMs) {
    if (this.isHost) return hostTimeMs;
    return hostTimeMs - this.offsetMs;
  }

  setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    if (!this.isHost && this.intervalId) {
      this.start();
    }
  }

  start() {
    if (this.isHost) return;
    this.stop();

    if (this.mode === 'relay') {
      // Бережный режим для публичного WSS-релея (без перегрузки лимитов)
      for (let i = 0; i < 4; i++) {
        const id = setTimeout(() => this._firePing(), i * 450);
        this.burstTimeoutIds.push(id);
      }
      this.intervalId = setInterval(() => this._firePing(), 5000);
    } else {
      // Мгновенный первый пинг + быстрая серия (11 пингов за ~0.75 сек) для захвата часов за < 200 мс
      this._firePing();
      for (let i = 1; i <= 10; i++) {
        const id = setTimeout(() => this._firePing(), i * 75);
        this.burstTimeoutIds.push(id);
      }
      // Фоновая подстройка каждые 2.5 секунды
      this.intervalId = setInterval(() => this._firePing(), 2500);
    }
  }

  /** Быстрая до-калибровка (например, после смены сети или выхода из фона) */
  reburst() {
    if (this.isHost) return;
    const count = this.mode === 'relay' ? 2 : 5;
    const step = this.mode === 'relay' ? 500 : 100;
    for (let i = 0; i < count; i++) {
      const id = setTimeout(() => this._firePing(), i * step);
      this.burstTimeoutIds.push(id);
    }
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    for (const id of this.burstTimeoutIds) clearTimeout(id);
    this.burstTimeoutIds = [];
    this.pending.clear();
  }

  reset() {
    this.stop();
    this.samples = [];
    this.offsetMs = 0;
    this.rttMs = 0;
    this.jitterMs = 0;
    this.synced = this.isHost;
  }

  _firePing() {
    const seq = ++this.seq;
    const t0 = this.localNow();
    this.pending.set(seq, t0);

    if (this.pending.size > 24) {
      const cutoff = t0 - 6000;
      for (const [k, v] of this.pending.entries()) {
        if (v < cutoff) this.pending.delete(k);
      }
    }

    this.sendPing({ type: 'SYNC_PING', seq, t0 });
  }

  handlePong({ seq, t0, t1, t2 }) {
    if (this.isHost) return;
    const t3 = this.localNow();

    if (!this.pending.has(seq)) return;
    this.pending.delete(seq);

    const hostProc = Math.max(0, t2 - t1);
    const rtt = Math.max(0, (t3 - t0) - hostProc);
    const offset = ((t1 - t0) + (t2 - t3)) / 2;

    // Отбрасываем сильные выбросы, если уже накоплена база
    const maxAcceptableRtt = this.mode === 'relay' ? 3000 : 1200;
    if (rtt > maxAcceptableRtt && this.samples.length >= 3) return;

    this.samples.push({ rtt, offset, ts: t3 });
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }

    this._recomputeEstimate();
  }

  _recomputeEstimate() {
    if (this.samples.length === 0) return;

    // Сортируем по минимальному RTT — минимальный RTT имеет наименьшую асимметрию маршрута
    const byRtt = [...this.samples].sort((a, b) => a.rtt - b.rtt);
    const keepCount = Math.max(1, Math.min(7, Math.ceil(byRtt.length * 0.45)));
    const best = byRtt.slice(0, keepCount);

    const sortedOffsets = best.map((s) => s.offset).sort((a, b) => a - b);
    const mid = Math.floor(sortedOffsets.length / 2);
    const medianOffset =
      sortedOffsets.length % 2 === 0
        ? (sortedOffsets[mid - 1] + sortedOffsets[mid]) / 2
        : sortedOffsets[mid];

    // Отсеиваем редкие асимметричные выбросы дальше от медианы
    const tolerance = Math.max(15, best[0].rtt * 0.8 + 10);
    const filtered = best.filter((s) => Math.abs(s.offset - medianOffset) <= tolerance);
    const finalSet = filtered.length > 0 ? filtered : best;

    const avgOffset = finalSet.reduce((sum, s) => sum + s.offset, 0) / finalSet.length;
    const avgRtt = finalSet.reduce((sum, s) => sum + s.rtt, 0) / finalSet.length;

    const spread =
      finalSet.length > 1
        ? Math.max(...finalSet.map((s) => s.offset)) - Math.min(...finalSet.map((s) => s.offset))
        : 0;
    this.jitterMs = spread / 2;

    if (!this.synced || this.samples.length <= 5) {
      this.offsetMs = avgOffset;
    } else {
      const diff = avgOffset - this.offsetMs;
      if (Math.abs(diff) > 150) {
        // Реальный скачок маршрута/часов — перезахват
        this.offsetMs = avgOffset;
      } else if (Math.abs(diff) > 15) {
        // Очень мягкая подстройка медленного дрейфа кварца
        this.offsetMs += diff * 0.04;
      } else if (Math.abs(diff) > 4 && this.mode === 'p2p' && this.rttMs < 25) {
        // При переходе на сверхнизкий пинг LAN/P2P тихо доуточняем офсет на доли миллисекунды
        this.offsetMs += diff * 0.02;
      }
    }

    this.rttMs = avgRtt;
    this.synced = true;

    this.onUpdate({
      offsetMs: this.offsetMs,
      rttMs: this.rttMs,
      jitterMs: this.jitterMs,
      sampleCount: this.samples.length,
    });
  }
}

window.ClockSync = ClockSync;
