/**
 * WakeLockManager — управление Screen Wake Lock API.
 * Предотвращает засыпание экрана телефона и троттлинг вкладки во время воспроизведения.
 * Автоматически восстанавливает блокировку при возврате на вкладку (visibilitychange).
 */
class WakeLockManager {
  constructor(onStateChange) {
    this.sentinel = null;
    this.desiredActive = false;
    this.supported = 'wakeLock' in navigator;
    this.onStateChange = onStateChange || (() => {});

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.desiredActive) {
        this.acquire();
      }
    });
  }

  async acquire() {
    this.desiredActive = true;
    if (!this.supported) {
      this.onStateChange({ active: false, supported: false });
      return false;
    }

    if (this.sentinel && !this.sentinel.released) {
      this.onStateChange({ active: true, supported: true });
      return true;
    }

    try {
      this.sentinel = await navigator.wakeLock.request('screen');
      this.sentinel.addEventListener('release', () => {
        this.onStateChange({ active: false, supported: true });
      });
      this.onStateChange({ active: true, supported: true });
      return true;
    } catch (err) {
      // Может не сработать при низком заряде батареи или в фоне
      console.warn('[WakeLock] Не удалось активировать:', err.message);
      this.onStateChange({ active: false, supported: true });
      return false;
    }
  }

  async release() {
    this.desiredActive = false;
    if (this.sentinel) {
      try {
        await this.sentinel.release();
      } catch (_) {}
      this.sentinel = null;
    }
    this.onStateChange({ active: false, supported: this.supported });
  }
}

window.WakeLockManager = WakeLockManager;
