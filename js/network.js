/**
 * NetworkManager — P2P-сеть на базе PeerJS (WebRTC DataChannel).
 * Не требует собственного бэкенда, ключей или регистрации — работает на GitHub Pages из коробки.
 *
 * Возможности:
 * - Короткие читаемые коды комнат (например, K7M-4PX) с пространством имён
 * - Двусторонняя передача NTP PING/PONG с минимальной задержкой
 * - Чанкованная передача локального аудиофайла (16 КБ чанки + backpressure контроль bufferedAmount)
 * - Поддержка URL-треков и встроенного тест-трека без лишнего трафика
 * - Автоматическая синхронизация «поздних» слушателей (Late Join)
 */
class NetworkManager {
  static PEER_PREFIX = 'orpheus-sync-v1-';
  static CHUNK_SIZE = 16384; // 16 КБ — безопасный размер SCTP-сообщения для Safari/Chrome/Firefox
  static MAX_BUFFERED_AMOUNT = 256 * 1024; // Пауза отправки, если буфер WebRTC > 256 КБ

  static ICE_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: 'stun:openrelay.metered.ca:80' },
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject',
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject',
      },
      {
        urls: 'turn:openrelay.metered.ca:443?transport=tcp',
        username: 'openrelayproject',
        credential: 'openrelayproject',
      },
    ],
    iceCandidatePoolSize: 4,
  };

  constructor(callbacks = {}) {
    this.cb = callbacks;
    this.peer = null;
    this.role = null;       // 'host' | 'listener'
    this.roomCode = null;   // 'K7M4PX'

    // Состояние Хоста
    this.clients = new Map(); // peerId -> { conn, label, rttMs, status, progress, readyTrackId }
    this.currentTrack = null; // { id, type: 'file'|'url'|'demo', name, size, mime, url, buffer }
    this.playbackState = {
      playing: false,
      hostStartTime: 0,
      trackOffset: 0,
      trackId: null,
    };

    // Состояние Слушателя
    this.hostConn = null;
    this.incomingFile = null; // { id, name, mime, totalChunks, totalBytes, chunks, receivedCount }
    this.clientCounter = 0;
  }

  /** Генерация удобного 6-символьного кода без путающихся символов (0/O, 1/I/L) */
  static generateRoomCode() {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
  }

  static normalizeCode(raw) {
    let str = String(raw || '').trim();
    // Если пользователь вставил полную ссылку ?room=K7M4PX
    const match = str.match(/[?&#]room=([A-Za-z0-9-]+)/i);
    if (match) str = match[1];
    return str
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 6);
  }

  static formatCode(code) {
    const c = NetworkManager.normalizeCode(code);
    return c.length > 3 ? `${c.slice(0, 3)}-${c.slice(3)}` : c;
  }

  /** Запуск комнаты в роли Хоста */
  startHost(preferredCode = null) {
    this.destroy();
    this.role = 'host';
    const code = preferredCode
      ? NetworkManager.normalizeCode(preferredCode)
      : NetworkManager.generateRoomCode();
    this.roomCode = code;

    return new Promise((resolve, reject) => {
      if (typeof Peer === 'undefined') {
        reject(new Error('Библиотека PeerJS не загрузилась. Проверьте интернет-соединение.'));
        return;
      }

      const peerId = NetworkManager.PEER_PREFIX + code;
      const peer = new Peer(peerId, {
        debug: 1,
        config: NetworkManager.ICE_CONFIG,
      });
      this.peer = peer;

      let settled = false;

      peer.on('open', () => {
        settled = true;
        resolve(code);
      });

      peer.on('connection', (conn) => this._handleIncomingListener(conn));

      peer.on('error', (err) => {
        console.error('[Network/Host] Peer error:', err);
        if (!settled && err.type === 'unavailable-id') {
          // Если код занят на сервере PeerJS — автоматически перегенерируем
          settled = true;
          this.startHost().then(resolve).catch(reject);
          return;
        }
        if (!settled) {
          settled = true;
          reject(err);
        } else if (this.cb.onError) {
          this.cb.onError(err);
        }
      });

      peer.on('disconnected', () => {
        // Попытка переподключения к сигнальному серверу PeerJS
        if (this.peer && !this.peer.destroyed) {
          setTimeout(() => {
            if (this.peer && !this.peer.destroyed) this.peer.reconnect();
          }, 1500);
        }
      });
    });
  }

  /** Подключение к комнате в роли Слушателя */
  joinAsListener(rawCode, onProgress = () => {}) {
    this.destroy();
    this.role = 'listener';
    const code = NetworkManager.normalizeCode(rawCode);
    if (code.length < 4) {
      return Promise.reject(new Error('Введите 6-значный код комнаты (например, K7M-4PX)'));
    }
    this.roomCode = code;

    return new Promise((resolve, reject) => {
      if (typeof Peer === 'undefined') {
        reject(new Error('Не загрузилась библиотека PeerJS. Проверьте интернет или отключите VPN/блокировщик.'));
        return;
      }

      onProgress('1/3 Подключение к сигнальному серверу...');

      const peer = new Peer({
        debug: 1,
        config: NetworkManager.ICE_CONFIG,
      });
      this.peer = peer;

      let settled = false;
      let stage = 'signaling';
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          const reason =
            stage === 'signaling'
              ? 'Не удалось связаться с сервером PeerJS (проверьте интернет или VPN на телефоне).'
              : 'Таймаут P2P-соединения (NAT/файрвол). Попробуйте подключить ПК и телефон к одному Wi-Fi или отключить VPN.';
          reject(new Error(reason));
        }
      }, 18000);

      peer.on('open', () => {
        stage = 'connecting';
        onProgress(`2/3 Поиск комнаты ${NetworkManager.formatCode(code)}...`);

        const hostPeerId = NetworkManager.PEER_PREFIX + code;
        // serialization: 'json' надёжно работает в iOS Safari и Android Chrome (без зависаний BinaryPack)
        const conn = peer.connect(hostPeerId, {
          reliable: true,
          serialization: 'json',
        });
        this.hostConn = conn;

        // Отслеживаем состояние WebRTC ICE для прозрачной диагностики
        const attachIceMonitor = () => {
          const pc = conn.peerConnection;
          if (!pc) return;
          pc.addEventListener('iceconnectionstatechange', () => {
            const st = pc.iceConnectionState;
            if (!settled) {
              if (st === 'checking') {
                onProgress('3/3 Установка прямого WebRTC-канала...');
              } else if (st === 'failed') {
                clearTimeout(timeout);
                settled = true;
                reject(new Error('Не удалось пробить NAT/файрвол (ICE failed). Попробуйте общий Wi-Fi или выключите VPN.'));
              }
            }
          });
        };
        attachIceMonitor();
        setTimeout(attachIceMonitor, 300);

        conn.on('open', () => {
          clearTimeout(timeout);
          if (!settled) {
            settled = true;
            resolve(code);
          }
          if (this.cb.onHostConnected) this.cb.onHostConnected();
        });

        conn.on('data', (msg) => this._handleHostMessage(msg));

        conn.on('close', () => {
          if (this.cb.onHostDisconnected) this.cb.onHostDisconnected();
        });

        conn.on('error', (err) => {
          console.error('[Network/Listener] Conn error:', err);
          clearTimeout(timeout);
          if (!settled) {
            settled = true;
            reject(err);
          } else if (this.cb.onError) {
            this.cb.onError(err);
          }
        });
      });

      peer.on('error', (err) => {
        console.error('[Network/Listener] Peer error:', err);
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          let message = err.message || 'Ошибка WebRTC-подключения';
          if (err.type === 'peer-unavailable') {
            message = `Комната ${NetworkManager.formatCode(code)} не найдена. Убедитесь, что вкладка Хоста открыта.`;
          } else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
            message = 'Не удалось подключиться к серверу PeerJS. Проверьте интернет или VPN.';
          }
          reject(new Error(message));
        } else if (this.cb.onError) {
          this.cb.onError(err);
        }
      });
    });
  }

  /* ==================== ХОСТ ==================== */

  _handleIncomingListener(conn) {
    const label = `Слушатель #${++this.clientCounter}`;
    const client = {
      id: conn.peer,
      conn,
      label,
      rttMs: null,
      status: 'Сверка часов...',
      progress: 0,
      readyTrackId: null,
    };

    conn.on('open', () => {
      this.clients.set(conn.peer, client);
      this._emitPeers();

      // Если у Хоста уже загружен трек — сразу отправляем его новому слушателю
      if (this.currentTrack) {
        this._sendTrackToClient(client, this.currentTrack);
      }
    });

    conn.on('data', (msg) => this._handleListenerMessage(client, msg));

    conn.on('close', () => {
      this.clients.delete(conn.peer);
      this._emitPeers();
    });

    conn.on('error', () => {
      this.clients.delete(conn.peer);
      this._emitPeers();
    });
  }

  _handleListenerMessage(client, msg) {
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'SYNC_PING': {
        // Максимально быстрый ответ с t1 и t2 по монотонным часам Хоста
        const t1 = performance.now();
        const t2 = performance.now();
        this._safeSend(client.conn, {
          type: 'SYNC_PONG',
          seq: msg.seq,
          t0: msg.t0,
          t1,
          t2,
        });
        break;
      }

      case 'CLIENT_METRICS': {
        client.rttMs = Math.round(msg.rttMs);
        if (client.status === 'Сверка часов...') {
          client.status = this.currentTrack ? 'Загрузка...' : 'Готов';
        }
        this._emitPeers();
        break;
      }

      case 'TRACK_PROGRESS': {
        client.progress = msg.progress;
        client.status = `Загрузка ${msg.progress}%`;
        this._emitPeers();
        break;
      }

      case 'TRACK_READY': {
        client.readyTrackId = msg.trackId;
        client.progress = 100;
        client.status = 'Готов';
        this._emitPeers();

        // Late Join: если Хост уже проигрывает этот трек — синхронизируем нового слушателя «на лету»!
        if (
          this.playbackState.playing &&
          this.playbackState.trackId === msg.trackId
        ) {
          this._safeSend(client.conn, {
            type: 'CMD_PLAY',
            trackId: this.playbackState.trackId,
            hostStartTime: this.playbackState.hostStartTime,
            trackOffset: this.playbackState.trackOffset,
          });
        }
        break;
      }

      case 'TRACK_ERROR': {
        client.status = 'Ошибка трека';
        this._emitPeers();
        break;
      }
    }
  }

  /** Установка трека на Хосте и раздача всем подключённым слушателям */
  setHostTrack(track) {
    this.currentTrack = track;
    this.playbackState = {
      playing: false,
      hostStartTime: 0,
      trackOffset: 0,
      trackId: track.id,
    };

    for (const client of this.clients.values()) {
      this._sendTrackToClient(client, track);
    }
  }

  async _sendTrackToClient(client, track) {
    if (!client.conn || !client.conn.open) return;

    if (client.readyTrackId === track.id) {
      client.status = 'Готов';
      this._emitPeers();
      return;
    }

    if (track.type === 'demo') {
      client.status = 'Генерация...';
      this._emitPeers();
      this._safeSend(client.conn, {
        type: 'TRACK_DEMO',
        trackId: track.id,
        name: track.name,
      });
      return;
    }

    if (track.type === 'url') {
      client.status = 'Загрузка URL...';
      this._emitPeers();
      this._safeSend(client.conn, {
        type: 'TRACK_URL',
        trackId: track.id,
        name: track.name,
        url: track.url,
      });
      return;
    }

    if (track.type === 'file' && track.buffer) {
      const totalBytes = track.buffer.byteLength;
      const chunkSize = NetworkManager.CHUNK_SIZE;
      const totalChunks = Math.ceil(totalBytes / chunkSize);

      client.status = 'Отправка 0%';
      client.progress = 0;
      this._emitPeers();

      this._safeSend(client.conn, {
        type: 'FILE_META',
        trackId: track.id,
        name: track.name,
        mime: track.mime || 'audio/mpeg',
        totalBytes,
        totalChunks,
      });

      const dc = client.conn.dataChannel;

      for (let i = 0; i < totalChunks; i++) {
        // Если слушатель отключился или Хост сменил трек — прерываем отправку
        if (!client.conn.open || this.currentTrack?.id !== track.id) return;

        // Контроль переполнения буфера WebRTC (backpressure)
        if (dc && dc.bufferedAmount > NetworkManager.MAX_BUFFERED_AMOUNT) {
          await this._waitForDrain(dc);
          if (!client.conn.open || this.currentTrack?.id !== track.id) return;
        }

        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, totalBytes);
        const slice = new Uint8Array(track.buffer, start, end - start);

        this._safeSend(client.conn, {
          type: 'FILE_CHUNK',
          trackId: track.id,
          index: i,
          b64: this._uint8ToBase64(slice),
        });

        // Периодически отдаём поток браузеру и обновляем статус
        if (i % 16 === 0 || i === totalChunks - 1) {
          const pct = Math.round(((i + 1) / totalChunks) * 100);
          client.progress = pct;
          client.status = pct < 100 ? `Отправка ${pct}%` : 'Декодирование...';
          this._emitPeers();
          await new Promise((r) => setTimeout(r, 0));
        }
      }
    }
  }

  _waitForDrain(dc) {
    return new Promise((resolve) => {
      const check = () => {
        if (dc.readyState !== 'open' || dc.bufferedAmount < NetworkManager.MAX_BUFFERED_AMOUNT / 2) {
          resolve();
        } else {
          setTimeout(check, 12);
        }
      };
      setTimeout(check, 12);
    });
  }

  /** Команды управления воспроизведением от Хоста всем слушателям */
  broadcastPlay({ hostStartTime, trackOffset, trackId }) {
    this.playbackState = { playing: true, hostStartTime, trackOffset, trackId };
    this._broadcast({
      type: 'CMD_PLAY',
      hostStartTime,
      trackOffset,
      trackId,
    });
  }

  broadcastPause({ trackOffset }) {
    this.playbackState.playing = false;
    this.playbackState.trackOffset = trackOffset;
    this._broadcast({
      type: 'CMD_PAUSE',
      trackOffset,
    });
  }

  _broadcast(payload) {
    for (const client of this.clients.values()) {
      this._safeSend(client.conn, payload);
    }
  }

  _emitPeers() {
    if (!this.cb.onPeersChanged) return;
    const list = Array.from(this.clients.values()).map((c) => ({
      id: c.id,
      label: c.label,
      rttMs: c.rttMs,
      status: c.status,
      ready: c.status === 'Готов',
    }));
    this.cb.onPeersChanged(list);
  }

  /* ==================== СЛУШАТЕЛЬ ==================== */

  sendToHost(payload) {
    if (this.hostConn && this.hostConn.open) {
      this._safeSend(this.hostConn, payload);
    }
  }

  _handleHostMessage(msg) {
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'SYNC_PONG':
        if (this.cb.onSyncPong) this.cb.onSyncPong(msg);
        break;

      case 'TRACK_DEMO':
        this.incomingFile = null;
        if (this.cb.onTrackDemo) this.cb.onTrackDemo(msg);
        break;

      case 'TRACK_URL':
        this.incomingFile = null;
        if (this.cb.onTrackUrl) this.cb.onTrackUrl(msg);
        break;

      case 'FILE_META':
        this.incomingFile = {
          trackId: msg.trackId,
          name: msg.name,
          mime: msg.mime,
          totalBytes: msg.totalBytes,
          totalChunks: msg.totalChunks,
          chunks: new Array(msg.totalChunks),
          receivedCount: 0,
          lastReportedPct: -1,
        };
        if (this.cb.onFileProgress) {
          this.cb.onFileProgress({ name: msg.name, pct: 0, phase: 'downloading' });
        }
        break;

      case 'FILE_CHUNK':
        this._handleFileChunk(msg);
        break;

      case 'CMD_PLAY':
        if (this.cb.onCmdPlay) this.cb.onCmdPlay(msg);
        break;

      case 'CMD_PAUSE':
        if (this.cb.onCmdPause) this.cb.onCmdPause(msg);
        break;
    }
  }

  _handleFileChunk(msg) {
    const f = this.incomingFile;
    if (!f || f.trackId !== msg.trackId) return;

    const bytes = msg.b64
      ? this._base64ToUint8(msg.b64)
      : this._toUint8Array(msg.data);
    if (!bytes) return;

    if (!f.chunks[msg.index]) {
      f.chunks[msg.index] = bytes;
      f.receivedCount++;
    }

    const pct = Math.round((f.receivedCount / f.totalChunks) * 100);
    if (pct !== f.lastReportedPct && (pct - f.lastReportedPct >= 4 || pct === 100)) {
      f.lastReportedPct = pct;
      if (this.cb.onFileProgress) {
        this.cb.onFileProgress({ name: f.name, pct, phase: 'downloading' });
      }
      this.sendToHost({ type: 'TRACK_PROGRESS', trackId: f.trackId, progress: pct });
    }

    if (f.receivedCount === f.totalChunks) {
      // Сборка единого ArrayBuffer из чанков
      const merged = new Uint8Array(f.totalBytes);
      let offset = 0;
      for (let i = 0; i < f.totalChunks; i++) {
        merged.set(f.chunks[i], offset);
        offset += f.chunks[i].byteLength;
      }
      const completed = {
        trackId: f.trackId,
        name: f.name,
        mime: f.mime,
        buffer: merged.buffer,
      };
      this.incomingFile = null;
      if (this.cb.onFileComplete) this.cb.onFileComplete(completed);
    }
  }

  _uint8ToBase64(u8) {
    let bin = '';
    const step = 0x8000;
    for (let i = 0; i < u8.length; i += step) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + step));
    }
    return btoa(bin);
  }

  _base64ToUint8(b64) {
    const bin = atob(b64);
    const len = bin.length;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  }

  _toUint8Array(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    return null;
  }

  _safeSend(conn, payload) {
    try {
      if (conn && conn.open) conn.send(payload);
    } catch (err) {
      console.warn('[Network] Send failed:', err);
    }
  }

  destroy() {
    for (const c of this.clients.values()) {
      try { c.conn.close(); } catch (_) {}
    }
    this.clients.clear();

    if (this.hostConn) {
      try { this.hostConn.close(); } catch (_) {}
      this.hostConn = null;
    }

    if (this.peer) {
      try { this.peer.destroy(); } catch (_) {}
      this.peer = null;
    }

    this.incomingFile = null;
    this.currentTrack = null;
    this.role = null;
    this.roomCode = null;
  }
}

window.NetworkManager = NetworkManager;
