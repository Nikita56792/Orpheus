/**
 * ClockSync — реализация NTP-алгоритма (4 временные метки) поверх WebRTC DataChannel.
 *
 * Почему performance.now(), а не Date.now():
 * performance.now() строго монотонен и имеет субмиллисекундную точность.
 * Даже если телефон во время трека скорректирует системные часы по сотовой сети,
 * наш монотонник не «прыгнет» и музыка не собьётся.
 *
 * Формулы NTP:
 *   t0 — локальное время Слушателя при отправке PING
 *   t1 — локальное время Хоста при получении PING
 *   t2 — локальное время Хоста при отправке PONG
 *   t3 — локальное время Слушателя при получении PONG
 *
 *   RTT    = (t3 - t0) - (t2 - t1)
 *   offset = ((t1 - t0) + (t2 - t3)) / 2
 *
 *   Текущее время Хоста на Слушателе = performance.now() + offset
 */
class ClockSync {
  constructor({ isHost, sendPing, onUpdate }) {
    this.isHost = isHost;
    this.sendPing = sendPing;
    this.onUpdate = onUpdate || (() => {});

    this.offsetMs = 0;        // hostTime - localTime
    this.rttMs = 0;           // лучшая медианная задержка туда-обратно
    this.synced = isHost;     // Хост синхронизирован сам с собой изначально
    this.samples = [];        // скользящее окно замеров { rtt, offset, ts }
    this.maxSamples = 14;
    this.seq = 0;
    this.pending = new Map(); // seq -> t0
    this.intervalId = null;
    this.burstTimeoutIds = [];
  }

  /** Локальное монотонное время в миллисекундах */
  localNow() {
    return performance.now();
  }

  /** Единое время комнаты (время Хоста) в миллисекундах */
  hostNow() {
    if (this.isHost) return this.localNow();
    return this.localNow() + this.offsetMs;
  }

  /** Конвертация целевого времени Хоста в локальное performance.now() */
  hostToLocal(hostTimeMs) {
    if (this.isHost) return hostTimeMs;
    return hostTimeMs - this.offsetMs;
  }

  /** Запуск серии быстрых пингов для первичной калибровки + фоновый опрос */
  start() {
    if (this.isHost) return;
    this.stop();

    // Начальная серия: 8 пингов с шагом 130 мс (~1 секунда до точной калибровки)
    for (let i = 0; i < 8; i++) {
      const id = setTimeout(() => this._firePing(), i * 130);
      this.burstTimeoutIds.push(id);
    }

    // Периодическая подстройка каждые 3 секунды для компенсации дрейфа кварца
    this.intervalId = setInterval(() => this._firePing(), 3000);
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
    this.synced = this.isHost;
  }

  _firePing() {
    const seq = ++this.seq;
    const t0 = this.localNow();
    this.pending.set(seq, t0);

    // Очистка зависших пингов старше 5 секунд
    if (this.pending.size > 20) {
      const cutoff = t0 - 5000;
      for (const [k, v] of this.pending.entries()) {
        if (v < cutoff) this.pending.delete(k);
      }
    }

    this.sendPing({ type: 'SYNC_PING', seq, t0 });
  }

  /** Обработка ответа PONG от Хоста */
  handlePong({ seq, t0, t1, t2 }) {
    if (this.isHost) return;
    const t3 = this.localNow();

    if (!this.pending.has(seq)) return;
    this.pending.delete(seq);

    const hostProc = Math.max(0, t2 - t1);
    const rtt = Math.max(0, (t3 - t0) - hostProc);
    const offset = ((t1 - t0) + (t2 - t3)) / 2;

    // Отбрасываем аномальные спайки (> 1500 мс) если уже есть хорошие сэмплы
    if (rtt > 1500 && this.samples.length >= 3) return;

    this.samples.push({ rtt, offset, ts: t3 });
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }

    this._recomputeEstimate();
  }

  /**
   * Алгоритм фильтрации:
   * 1. Сортируем окно по минимальному RTT (минимальный RTT = наименьшая очередь и асимметрия сети).
   * 2. Берём лучшие 50% замеров (но не меньше 1 и не больше 6).
   * 3. Вычисляем медиану и среднее без выбросов.
   * 4. Плавно обновляем offsetMs через EMA, чтобы не дёргать аудиодвижок.
   */
  _recomputeEstimate() {
    if (this.samples.length === 0) return;

    const byRtt = [...this.samples].sort((a, b) => a.rtt - b.rtt);
    const keepCount = Math.max(1, Math.min(6, Math.ceil(byRtt.length * 0.5)));
    const best = byRtt.slice(0, keepCount);

    // Медиана смещения среди лучших по RTT
    const sortedOffsets = best.map((s) => s.offset).sort((a, b) => a - b);
    const mid = Math.floor(sortedOffsets.length / 2);
    const medianOffset =
      sortedOffsets.length % 2 === 0
        ? (sortedOffsets[mid - 1] + sortedOffsets[mid]) / 2
        : sortedOffsets[mid];

    // Среднее по замерам, близким к медиане (отсекаем редкие асимметричные выбросы)
    const filtered = best.filter((s) => Math.abs(s.offset - medianOffset) <= Math.max(25, s.rtt));
    const finalSet = filtered.length > 0 ? filtered : best;
    const avgOffset = finalSet.reduce((sum, s) => sum + s.offset, 0) / finalSet.length;
    const avgRtt = finalSet.reduce((sum, s) => sum + s.rtt, 0) / finalSet.length;

    if (!this.synced || this.samples.length <= 4) {
      // На старте быстро схватываем точное смещение
      this.offsetMs = avgOffset;
    } else {
      // В процессе воспроизведения мягко сглаживаем (EMA)
      const diff = avgOffset - this.offsetMs;
      if (Math.abs(diff) > 120) {
        this.offsetMs = avgOffset;
      } else {
        this.offsetMs += diff * 0.25;
      }
    }

    this.rttMs = avgRtt;
    this.synced = true;

    this.onUpdate({
      offsetMs: this.offsetMs,
      rttMs: this.rttMs,
      sampleCount: this.samples.length,
    });
  }
}

window.ClockSync = ClockSync;
