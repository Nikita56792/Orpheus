/**
 * NetworkManager v2 — Надёжный P2P-транспорт без зависимости от PeerJS Cloud.
 *
 * Почему v1 не работал:
 * 1) Публичный сервер 0.peerjs.com заблокирован/отдаёт 403.
 * 2) openrelay.metered.ca недоступен/заглушен на локальных сетях.
 * 3) NTP-пинги шли по одному каналу с передачей MP3 (огромный джиттер).
 *
 * Архитектура v2 (100% статика на GitHub Pages, работает в одной Wi-Fi сети,
 * между разными SSID/VLAN одной точки доступа (School ↔ DOS-WIFI-FREE) и через NAT/VPN):
 *
 * 1. Многоканальный сигналинг по HTTPS/WSS (порт 443, проходит любые школьные/корпоративные файрволы):
 *    - Основной: ntfy.sh WebSocket + HTTPS POST (мгновенный обмен SDP Offer/Answer + ICE).
 *    - Резервный (параллельно): BroadcastChannel (мгновенно для вкладок одного устройства)
 *      + WebTorrent WSS трекеры (tracker.webtorrent.dev, tracker.openwebtorrent.com).
 *
 * 2. Нативный RTCPeerConnection с 3 выделенными DataChannel:
 *    - `orpheus-ntp`  (ordered: false, maxRetransmits: 0) — чистый UDP-NTP без задержек!
 *    - `orpheus-ctrl` (ordered: true) — команды Play/Pause, плейлист, глобальная BT-задержка.
 *    - `orpheus-data` (ordered: true, binary ArrayBuffer) — скоростная бинарная передача аудио
 *      без base64-накладных расходов и с предзагрузкой следующего трека плейлиста!
 *
 * 3. Умная маршрутизация ICE:
 *    - В одной подсети (один Wi-Fi / AP) WebRTC автоматически выбирает локальные LAN host-кандидаты
 *      (трафик не выходит в интернет, RTT 1–5 мс!).
 *    - Между разными подсетями/SSID (School ↔ DOS-WIFI-FREE) WebRTC пробивает NAT напрямую по UDP
 *      через пул быстрых STUN-серверов (вкл. stun.sipnet.ru, Google, Cloudflare).
 *    - Если UDP полностью заблокирован жёстким файрволом — автоматический бесшовный переход
 *      на WSS Relay Fallback (ntfy.sh), включая передачу файлов!
 */
class NetworkManager {
  static CHUNK_SIZE = 16000; // 16 КБ чистых байт (безопасно для SCTP iOS/Android, без base64!)
  static MAX_BUFFERED_AMOUNT = 128 * 1024;
  static ICE_GATHER_WAIT_MS = 2400;
  static P2P_TIMEOUT_MS = 10000;
  static NTFY_BASE = 'https://ntfy.sh';
  static NTFY_WS_BASE = 'wss://ntfy.sh';

  static ICE_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: 'stun:stun.sipnet.ru:3478' },
    ],
    iceCandidatePoolSize: 4,
  };

  constructor(callbacks = {}) {
    this.cb = callbacks;
    this.role = null;       // 'host' | 'listener'
    this.roomCode = null;   // 'K7M4PX'
    this.selfId = NetworkManager.generatePeerId();
    this.deviceName = NetworkManager.detectDeviceName();

    // Сигналинг (ntfy.sh WSS + BroadcastChannel)
    this._sigWs = null;
    this._sigTopic = null;
    this._sigReconnectTimer = null;
    this._sigAlive = false;
    this._bc = null;
    this._seenMsgIds = new Set();

    // Хост: список подключённых слушателей
    this.clients = new Map(); // peerId -> clientObj
    this.clientCounter = 0;

    // Хост: состояние плейлиста и воспроизведения
    this.playlist = [];       // [{ id, type, name, duration, size, mime, url, buffer }]
    this.activeTrackId = null;
    this.playbackState = {
      playing: false,
      hostStartTime: 0,
      trackOffset: 0,
      trackId: null,
    };
    this.hostLatencyProfile = { totalLatencyMs: 0, systemLatencyMs: 0, isBluetooth: false, outputDeviceLabel: '' };
    this.roomLatencyState = { roomMaxLatencyMs: 0, slowestLabel: 'Хост', bluetoothCount: 0, deviceCount: 1 };

    // Слушатель: соединение с Хостом
    this.hostPeerId = null;
    this.hostPc = null;
    this.hostChannels = { ntp: null, ctrl: null, data: null };
    this.hostTransport = 'connecting'; // 'p2p-lan' | 'p2p-udp' | 'relay'
    this._listenerJoinResolve = null;
    this._listenerJoinReject = null;
    this._listenerJoinTimer = null;
    this._listenerProgressCb = null;
    this._listenerConnected = false;
    this._listenerPendingIce = [];
    this._listenerHeartbeatTimer = null;

    // Приём бинарных файлов на Слушателе (поддерживает параллельную предзагрузку!)
    this.incomingFiles = new Map(); // trackHash -> fileRecvState
    this._trackHashToMeta = new Map(); // trackHash -> { trackId, name, mime, totalBytes, totalChunks }
  }

  static generatePeerId() {
    const arr = new Uint8Array(6);
    crypto.getRandomValues(arr);
    return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
  }

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
    const match = str.match(/[?&#]room=([A-Za-z0-9-]+)/i);
    if (match) str = match[1];
    return str.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  }

  static formatCode(code) {
    const c = NetworkManager.normalizeCode(code);
    return c.length > 3 ? `${c.slice(0, 3)}-${c.slice(3)}` : c;
  }

  static hashTrackId(trackId) {
    let h = 2166136261;
    const s = String(trackId);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  static detectDeviceName() {
    const ua = navigator.userAgent || '';
    if (/SM-S928|S24 Ultra/i.test(ua)) return 'Galaxy S24 Ultra';
    const smMatch = ua.match(/SM-[A-Z0-9]+/i);
    if (smMatch) return `Samsung ${smMatch[0]}`;
    if (/iPhone/i.test(ua)) return 'iPhone';
    if (/iPad/i.test(ua)) return 'iPad';
    if (/Android/i.test(ua)) return 'Android';
    if (/Macintosh|Mac OS/i.test(ua)) return 'Mac';
    if (/Windows/i.test(ua)) return 'Windows PC';
    return 'Устройство';
  }

  /* ==================== СИГНАЛИНГ (NTFY.SH WSS + BROADCASTCHANNEL) ==================== */

  _roomTopic(code) {
    return `orpheus-sync-v2-room-${code.toLowerCase()}`;
  }

  async _openSignaling(code) {
    this._closeSignaling();
    this._sigTopic = this._roomTopic(code);
    this._sigAlive = true;

    // 1. Локальный BroadcastChannel для мгновенной работы вкладок на одном устройстве
    try {
      this._bc = new BroadcastChannel(this._sigTopic);
      this._bc.onmessage = (ev) => {
        if (ev.data) this._onSignalMessage(ev.data);
      };
    } catch (_) {}

    // 2. Ntfy.sh WebSocket (порт 443 — проходит School, DOS-WIFI-FREE, VPN, сотовые сети)
    return new Promise((resolve, reject) => {
      let settled = false;
      const wsUrl = `${NetworkManager.NTFY_WS_BASE}/${this._sigTopic}/ws`;
      const connectWs = () => {
        if (!this._sigAlive) return;
        try {
          const ws = new WebSocket(wsUrl);
          this._sigWs = ws;

          const openTimeout = setTimeout(() => {
            if (!settled) {
              settled = true;
              reject(new Error('Не удалось подключиться к сигнальному серверу (WSS 443). Проверьте интернет.'));
            }
          }, 9000);

          ws.onopen = () => {
            clearTimeout(openTimeout);
            if (!settled) {
              settled = true;
              resolve();
            }
          };

          ws.onmessage = async (ev) => {
            try {
              const envelope = JSON.parse(ev.data);
              if (envelope.event !== 'message') return;
              let rawText = envelope.message || '';
              if (envelope.attachment && envelope.attachment.url) {
                const r = await fetch(envelope.attachment.url);
                if (r.ok) rawText = await r.text();
              }
              if (!rawText) return;
              const data = JSON.parse(rawText);
              this._onSignalMessage(data);
            } catch (_) {}
          };

          ws.onclose = () => {
            if (this._sigAlive && this._sigWs === ws) {
              this._sigReconnectTimer = setTimeout(connectWs, 1800);
            }
          };

          ws.onerror = () => {
            // onclose вызовет переподключение
          };
        } catch (err) {
          if (!settled) {
            settled = true;
            reject(err);
          }
        }
      };

      connectWs();
    });
  }

  _closeSignaling() {
    this._sigAlive = false;
    if (this._sigReconnectTimer) {
      clearTimeout(this._sigReconnectTimer);
      this._sigReconnectTimer = null;
    }
    if (this._sigWs) {
      try { this._sigWs.close(); } catch (_) {}
      this._sigWs = null;
    }
    if (this._bc) {
      try { this._bc.close(); } catch (_) {}
      this._bc = null;
    }
  }

  async _sendSignal(payload) {
    if (!this._sigTopic) return;
    const msg = {
      ...payload,
      from: this.selfId,
      mid: `${this.selfId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    };
    this._seenMsgIds.add(msg.mid);

    // 1. Локальный BroadcastChannel
    if (this._bc) {
      try { this._bc.postMessage(msg); } catch (_) {}
    }

    // 2. HTTPS POST на ntfy.sh
    try {
      await fetch(`${NetworkManager.NTFY_BASE}/${this._sigTopic}`, {
        method: 'POST',
        body: JSON.stringify(msg),
      });
    } catch (err) {
      console.warn('[Network] Signal POST error:', err);
    }
  }

  _onSignalMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.from === this.selfId) return;
    if (msg.to && msg.to !== this.selfId) return;
    if (msg.mid) {
      if (this._seenMsgIds.has(msg.mid)) return;
      this._seenMsgIds.add(msg.mid);
      if (this._seenMsgIds.size > 400) {
        const first = this._seenMsgIds.values().next().value;
        this._seenMsgIds.delete(first);
      }
    }

    if (this.role === 'host') {
      this._hostHandleSignal(msg);
    } else if (this.role === 'listener') {
      this._listenerHandleSignal(msg);
    }
  }

  /* ==================== ЗАПУСК ХОСТА ==================== */

  async startHost(preferredCode = null) {
    this.destroy();
    this.role = 'host';
    this.selfId = NetworkManager.generatePeerId();
    const code = preferredCode
      ? NetworkManager.normalizeCode(preferredCode)
      : NetworkManager.generateRoomCode();
    this.roomCode = code;

    await this._openSignaling(code);
    return code;
  }

  async _hostHandleSignal(msg) {
    switch (msg.sig) {
      case 'JOIN_REQ': {
        await this._hostAcceptListener(msg.from, msg.deviceName || 'Слушатель', msg.offer, msg.candidates || []);
        break;
      }

      case 'ICE_BATCH': {
        const client = this.clients.get(msg.from);
        if (client && client.pc && Array.isArray(msg.candidates)) {
          for (const c of msg.candidates) {
            try { await client.pc.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {}
          }
        }
        break;
      }

      case 'RELAY_ENABLE': {
        // Слушатель не смог пробить UDP NAT — переключаем его на WSS Relay Fallback!
        const client = this.clients.get(msg.from);
        if (client) {
          client.transport = 'relay';
          client.transportLabel = 'WSS Relay';
          client.open = true;
          this._emitPeers();
          await this._sendSignal({ sig: 'RELAY_ACK', to: msg.from });
          this._hostSyncNewClient(client);
        }
        break;
      }

      case 'RELAY_MSG': {
        const client = this.clients.get(msg.from);
        if (client && msg.payload) {
          this._hostHandleClientMessage(client, msg.payload);
        }
        break;
      }

      case 'LEAVE': {
        this._hostRemoveClient(msg.from);
        break;
      }
    }
  }

  async _hostAcceptListener(peerId, deviceName, remoteOffer, remoteCandidates) {
    // Если этот peerId переподключается — аккуратно закрываем старый PC
    if (this.clients.has(peerId)) {
      this._hostRemoveClient(peerId, false);
    }

    const pc = new RTCPeerConnection(NetworkManager.ICE_CONFIG);
    const label = `${deviceName} #${++this.clientCounter}`;
    const client = {
      id: peerId,
      pc,
      channels: { ntp: null, ctrl: null, data: null },
      transport: 'connecting',
      transportLabel: 'Подкл...',
      open: false,
      label,
      rttMs: null,
      status: 'Подключение...',
      progress: 0,
      readyTracks: new Set(),
      transferQueue: [],
      isSendingFile: false,
      latency: { totalLatencyMs: 0, systemLatencyMs: 0, isBluetooth: false, outputDeviceLabel: '' },
      syncedOnce: false,
    };

    this.clients.set(peerId, client);
    this._emitPeers();

    const gatheredCandidates = [];
    let trickleSent = false;
    let lateCandidates = [];
    let lateFlushTimer = null;

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        const candJson = ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate;
        if (!trickleSent) {
          gatheredCandidates.push(candJson);
        } else {
          lateCandidates.push(candJson);
          if (!lateFlushTimer) {
            lateFlushTimer = setTimeout(() => {
              lateFlushTimer = null;
              if (lateCandidates.length > 0 && client.pc === pc) {
                const batch = lateCandidates;
                lateCandidates = [];
                this._sendSignal({ sig: 'ICE_BATCH', to: peerId, candidates: batch });
              }
            }, 300);
          }
        }
      }
    };

    pc.ondatachannel = (ev) => {
      const ch = ev.channel;
      ch.binaryType = 'arraybuffer';
      if (ch.label === 'orpheus-ntp') client.channels.ntp = ch;
      else if (ch.label === 'orpheus-ctrl') client.channels.ctrl = ch;
      else if (ch.label === 'orpheus-data') client.channels.data = ch;

      ch.onopen = () => {
        if (client.channels.ctrl && client.channels.ctrl.readyState === 'open') {
          client.open = true;
          if (client.transport === 'connecting') {
            client.transport = 'p2p';
            client.transportLabel = 'P2P';
          }
          if (!client.syncedOnce) {
            client.syncedOnce = true;
            client.status = 'Сверка часов...';
            this._detectTransportType(pc, (type, text) => {
              client.transport = type;
              client.transportLabel = text;
              this._emitPeers();
            });
            this._emitPeers();
            this._hostSyncNewClient(client);
          }
        }
      };

      ch.onmessage = (msgEv) => {
        if (typeof msgEv.data === 'string') {
          try {
            this._hostHandleClientMessage(client, JSON.parse(msgEv.data));
          } catch (_) {}
        }
      };

      ch.onclose = () => {
        if (ch.label === 'orpheus-ctrl' && client.transport !== 'relay') {
          this._hostRemoveClient(peerId);
        }
      };
    };

    pc.oniceconnectionstatechange = () => {
      const st = pc.iceConnectionState;
      if (st === 'connected' || st === 'completed') {
        this._detectTransportType(pc, (type, text) => {
          client.transport = type;
          client.transportLabel = text;
          this._emitPeers();
        });
      } else if (st === 'disconnected' || st === 'failed' || st === 'closed') {
        if (client.transport !== 'relay') {
          // Даём 2.5 сек на случай кратковременного роуминга между точками доступа в здании
          setTimeout(() => {
            if (this.clients.get(peerId) === client && client.transport !== 'relay') {
              const cur = pc.iceConnectionState;
              if (cur === 'failed' || cur === 'closed' || cur === 'disconnected') {
                this._hostRemoveClient(peerId);
              }
            }
          }, 2500);
        }
      }
    };

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(remoteOffer));
      for (const c of remoteCandidates) {
        try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {}
      }

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      // Ждём быстрый сбор локальных LAN и STUN кандидатов
      await this._waitIceGathering(pc, NetworkManager.ICE_GATHER_WAIT_MS, gatheredCandidates);
      trickleSent = true;

      await this._sendSignal({
        sig: 'JOIN_ANS',
        to: peerId,
        hostDeviceName: this.deviceName,
        answer: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
        candidates: gatheredCandidates,
      });
    } catch (err) {
      console.error('[Network/Host] Handshake error:', err);
      this._hostRemoveClient(peerId);
    }
  }

  _hostRemoveClient(peerId, emit = true) {
    const client = this.clients.get(peerId);
    if (!client) return;
    this.clients.delete(peerId);
    try { client.pc?.close(); } catch (_) {}
    if (emit) {
      this._recomputeRoomLatency();
      this._emitPeers();
    }
  }

  _hostSyncNewClient(client) {
    // 1. Отправляем текущее глобальное выравнивание задержек
    this._recomputeRoomLatency();
    this._sendToClient(client, 'ctrl', {
      type: 'ROOM_LATENCY',
      ...this.roomLatencyState,
    });

    // 2. Отправляем плейлист (метаданные без бинарных буферов)
    this._sendToClient(client, 'ctrl', {
      type: 'PLAYLIST_STATE',
      activeTrackId: this.activeTrackId,
      tracks: this._serializePlaylistMeta(),
    });

    // 3. Отправляем активный трек (и ставим следующий трек в фон на предзагрузку)
    if (this.activeTrackId) {
      const active = this.playlist.find((t) => t.id === this.activeTrackId);
      if (active) {
        this._queueTrackForClient(client, active, true);
      }
      const next = this._getNextPlaylistTrack(this.activeTrackId);
      if (next && next.id !== this.activeTrackId) {
        this._queueTrackForClient(client, next, false);
      }
    }
  }

  _hostHandleClientMessage(client, msg) {
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'SYNC_PING': {
        const t1 = performance.now();
        const t2 = performance.now();
        this._sendToClient(client, 'ntp', {
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
        if (client.status === 'Сверка часов...' || client.status === 'Подключение...') {
          client.status = this.activeTrackId ? (client.readyTracks.has(this.activeTrackId) ? 'Готов' : 'Загрузка...') : 'Готов';
        }
        this._emitPeers();
        break;
      }

      case 'DEVICE_LATENCY': {
        client.latency = {
          totalLatencyMs: Math.max(0, Math.round(msg.totalLatencyMs || 0)),
          systemLatencyMs: Math.max(0, Math.round(msg.systemLatencyMs || 0)),
          extraLatencyMs: Math.round(msg.extraLatencyMs || 0),
          isBluetooth: Boolean(msg.isBluetooth),
          outputDeviceLabel: String(msg.outputDeviceLabel || ''),
        };
        this._recomputeRoomLatency();
        this._emitPeers();
        break;
      }

      case 'TRACK_PROGRESS': {
        if (msg.trackId === this.activeTrackId) {
          client.progress = msg.progress;
          client.status = `Загрузка ${msg.progress}%`;
          this._emitPeers();
        }
        break;
      }

      case 'TRACK_READY': {
        client.readyTracks.add(msg.trackId);
        if (msg.trackId === this.activeTrackId) {
          client.progress = 100;
          client.status = 'Готов';
          this._emitPeers();

          // Late Join: если этот трек прямо сейчас играет — подключаем слушателя на лету!
          if (this.playbackState.playing && this.playbackState.trackId === msg.trackId) {
            this._sendToClient(client, 'ctrl', {
              type: 'CMD_PLAY',
              trackId: this.playbackState.trackId,
              hostStartTime: this.playbackState.hostStartTime,
              trackOffset: this.playbackState.trackOffset,
              roomMaxLatencyMs: this.roomLatencyState.roomMaxLatencyMs,
            });
          }
        }
        break;
      }

      case 'TRACK_ERROR': {
        if (msg.trackId === this.activeTrackId) {
          client.status = 'Ошибка трека';
          this._emitPeers();
        }
        break;
      }
    }
  }

  /* ==================== ГЛОБАЛЬНАЯ СИНХРОНИЗАЦИЯ ЗАДЕРЖЕК (BLUETOOTH) ==================== */

  updateHostLatency(profile) {
    this.hostLatencyProfile = {
      totalLatencyMs: Math.max(0, Math.round(profile.totalLatencyMs || 0)),
      systemLatencyMs: Math.max(0, Math.round(profile.systemLatencyMs || 0)),
      extraLatencyMs: Math.round(profile.extraLatencyMs || 0),
      isBluetooth: Boolean(profile.isBluetooth),
      outputDeviceLabel: String(profile.outputDeviceLabel || ''),
    };
    if (this.role === 'host') {
      this._recomputeRoomLatency();
    }
  }

  _recomputeRoomLatency() {
    if (this.role !== 'host') return;

    let maxMs = this.hostLatencyProfile.totalLatencyMs || 0;
    let slowestLabel = this.hostLatencyProfile.isBluetooth
      ? `Хост (BT: ${this.hostLatencyProfile.outputDeviceLabel || this.deviceName})`
      : `Хост (${this.deviceName})`;
    let btCount = this.hostLatencyProfile.isBluetooth ? 1 : 0;
    let devCount = 1;

    for (const c of this.clients.values()) {
      devCount++;
      const l = c.latency?.totalLatencyMs || 0;
      if (c.latency?.isBluetooth) btCount++;
      if (l > maxMs) {
        maxMs = l;
        slowestLabel = c.latency?.outputDeviceLabel
          ? `${c.label} (${c.latency.outputDeviceLabel})`
          : c.label;
      }
    }

    const next = {
      roomMaxLatencyMs: maxMs,
      slowestLabel,
      bluetoothCount: btCount,
      deviceCount: devCount,
    };

    const changed =
      next.roomMaxLatencyMs !== this.roomLatencyState.roomMaxLatencyMs ||
      next.slowestLabel !== this.roomLatencyState.slowestLabel ||
      next.bluetoothCount !== this.roomLatencyState.bluetoothCount ||
      next.deviceCount !== this.roomLatencyState.deviceCount;

    this.roomLatencyState = next;

    if (changed) {
      this._broadcast('ctrl', { type: 'ROOM_LATENCY', ...next });
      if (this.cb.onRoomLatencyChanged) this.cb.onRoomLatencyChanged(next);
    }
  }

  /* ==================== УПРАВЛЕНИЕ ПЛЕЙЛИСТОМ (ХОСТ) ==================== */

  _serializePlaylistMeta() {
    return this.playlist.map((t) => ({
      id: t.id,
      type: t.type,
      name: t.name,
      duration: t.duration || 0,
      size: t.size || 0,
      mime: t.mime || '',
      url: t.url || '',
    }));
  }

  _getNextPlaylistTrack(fromTrackId) {
    if (this.playlist.length <= 1) return null;
    const idx = this.playlist.findIndex((t) => t.id === fromTrackId);
    if (idx < 0) return this.playlist[0] || null;
    return this.playlist[(idx + 1) % this.playlist.length] || null;
  }

  setHostPlaylist(tracks, activeTrackId) {
    this.playlist = tracks;
    const prevActive = this.activeTrackId;
    this.activeTrackId = activeTrackId;

    if (prevActive !== activeTrackId) {
      this.playbackState = {
        playing: false,
        hostStartTime: 0,
        trackOffset: 0,
        trackId: activeTrackId,
      };
    }

    // Рассылаем обновлённый плейлист всем слушателям
    this._broadcast('ctrl', {
      type: 'PLAYLIST_STATE',
      activeTrackId: this.activeTrackId,
      tracks: this._serializePlaylistMeta(),
    });

    const activeTrack = this.playlist.find((t) => t.id === activeTrackId);
    const nextTrack = this._getNextPlaylistTrack(activeTrackId);

    for (const client of this.clients.values()) {
      if (activeTrack) {
        this._queueTrackForClient(client, activeTrack, true);
      }
      if (nextTrack && nextTrack.id !== activeTrackId) {
        this._queueTrackForClient(client, nextTrack, false);
      }
    }
  }

  /** Фоновая предзагрузка конкретного трека (например, следующего в плейлисте) */
  preloadTrackForAll(track) {
    if (!track) return;
    for (const client of this.clients.values()) {
      this._queueTrackForClient(client, track, false);
    }
  }

  _queueTrackForClient(client, track, highPriority) {
    if (!client.open || !track) return;
    if (client.readyTracks.has(track.id)) {
      if (track.id === this.activeTrackId) {
        client.status = 'Готов';
        this._emitPeers();
      }
      return;
    }

    // Убираем дубликат из очереди
    client.transferQueue = client.transferQueue.filter((item) => item.track.id !== track.id);
    if (highPriority) {
      client.transferQueue.unshift({ track, highPriority: true });
    } else {
      client.transferQueue.push({ track, highPriority: false });
    }

    if (!client.isSendingFile) {
      this._processClientTransferQueue(client);
    }
  }

  async _processClientTransferQueue(client) {
    if (client.isSendingFile) return;
    client.isSendingFile = true;

    try {
      while (client.open && client.transferQueue.length > 0) {
        const { track } = client.transferQueue.shift();
        if (client.readyTracks.has(track.id)) continue;
        await this._sendTrackToClient(client, track);
      }
    } finally {
      client.isSendingFile = false;
    }
  }

  async _sendTrackToClient(client, track) {
    if (!client.open) return;
    const isActive = track.id === this.activeTrackId;

    if (track.type === 'demo' || track.type === 'pulse') {
      if (isActive) {
        client.status = 'Синтез...';
        this._emitPeers();
      }
      this._sendToClient(client, 'ctrl', {
        type: 'TRACK_SYNTH',
        trackId: track.id,
        synthType: track.type,
        name: track.name,
        isActive,
      });
      return;
    }

    if (track.type === 'url') {
      if (isActive) {
        client.status = 'Загрузка URL...';
        this._emitPeers();
      }
      this._sendToClient(client, 'ctrl', {
        type: 'TRACK_URL',
        trackId: track.id,
        name: track.name,
        url: track.url,
        isActive,
      });
      return;
    }

    if (track.type === 'file' && track.buffer) {
      // Если клиент на резервном WSS Relay — загружаем файл один раз через ntfy.sh attachment!
      if (client.transport === 'relay') {
        await this._sendFileViaRelay(client, track, isActive);
        return;
      }

      const dataCh = client.channels.data;
      if (!dataCh || dataCh.readyState !== 'open') return;

      const totalBytes = track.buffer.byteLength;
      const chunkSize = NetworkManager.CHUNK_SIZE;
      const totalChunks = Math.ceil(totalBytes / chunkSize);
      const trackHash = NetworkManager.hashTrackId(track.id);

      if (isActive) {
        client.status = 'Отправка 0%';
        client.progress = 0;
        this._emitPeers();
      }

      this._sendToClient(client, 'ctrl', {
        type: 'FILE_META',
        trackId: track.id,
        trackHash,
        name: track.name,
        mime: track.mime || 'audio/mpeg',
        totalBytes,
        totalChunks,
        isActive,
      });

      // Даём метаданным дойти по ctrl раньше первых бинарных чанков
      await new Promise((r) => setTimeout(r, 25));

      const rawBytes = new Uint8Array(track.buffer);
      let lastUiPct = -1;

      for (let i = 0; i < totalChunks; i++) {
        if (!client.open || dataCh.readyState !== 'open') return;

        // Если это фоновая предзагрузка, а Хост переключил активный трек на другой — прерываем фон
        if (!isActive && client.transferQueue.some((q) => q.highPriority)) {
          client.transferQueue.push({ track, highPriority: false });
          return;
        }

        if (dataCh.bufferedAmount > NetworkManager.MAX_BUFFERED_AMOUNT) {
          await this._waitForDrain(dataCh);
          if (!client.open || dataCh.readyState !== 'open') return;
        }

        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, totalBytes);
        const payloadLen = end - start;

        // Компактный бинарный пакет: [4B trackHash][4B chunkIndex][4B totalChunks][rawBytes]
        const packet = new ArrayBuffer(12 + payloadLen);
        const view = new DataView(packet);
        view.setUint32(0, trackHash, false);
        view.setUint32(4, i, false);
        view.setUint32(8, totalChunks, false);
        new Uint8Array(packet, 12).set(rawBytes.subarray(start, end));

        try {
          dataCh.send(packet);
        } catch (err) {
          console.warn('[Network] Binary send failed:', err);
          return;
        }

        if (isActive) {
          const pct = Math.round(((i + 1) / totalChunks) * 100);
          if (pct !== lastUiPct && (pct - lastUiPct >= 5 || pct === 100)) {
            lastUiPct = pct;
            client.progress = pct;
            client.status = pct < 100 ? `Отправка ${pct}%` : 'Декодирование...';
            this._emitPeers();
          }
        } else if (i % 10 === 0) {
          // Фоновая предзагрузка не мешает текущему аудио и UI
          await new Promise((r) => setTimeout(r, 8));
        }
      }
    }
  }

  /** Резервная передача файла через ntfy.sh attachment при жёстко заблокированном UDP */
  async _sendFileViaRelay(client, track, isActive) {
    if (track.buffer.byteLength > 14 * 1024 * 1024) {
      if (isActive) {
        client.status = 'Файл >14 МБ (Relay)';
        this._emitPeers();
      }
      return;
    }

    if (isActive) {
      client.status = 'Загрузка в Relay...';
      this._emitPeers();
    }

    try {
      if (!track._relayUrl) {
        const fileTopic = `${this._sigTopic}-f-${NetworkManager.hashTrackId(track.id)}`;
        const resp = await fetch(`${NetworkManager.NTFY_BASE}/${fileTopic}`, {
          method: 'PUT',
          headers: { Filename: encodeURIComponent(track.name || 'track.mp3') },
          body: track.buffer,
        });
        const meta = await resp.json();
        if (meta && meta.attachment && meta.attachment.url) {
          track._relayUrl = meta.attachment.url;
        } else {
          throw new Error('Relay upload failed');
        }
      }

      this._sendToClient(client, 'ctrl', {
        type: 'TRACK_URL',
        trackId: track.id,
        name: track.name,
        url: track._relayUrl,
        isActive,
      });
    } catch (err) {
      console.warn('[Network] Relay file upload failed:', err);
      if (isActive) {
        client.status = 'Ошибка Relay-файла';
        this._emitPeers();
      }
    }
  }

  _waitForDrain(dc) {
    return new Promise((resolve) => {
      const lowThreshold = NetworkManager.MAX_BUFFERED_AMOUNT / 2;
      if (dc.readyState !== 'open' || dc.bufferedAmount <= lowThreshold) {
        resolve();
        return;
      }
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        dc.onbufferedamountlow = null;
        clearTimeout(fallbackTimer);
        resolve();
      };
      dc.bufferedAmountLowThreshold = lowThreshold;
      dc.onbufferedamountlow = finish;
      const fallbackTimer = setTimeout(finish, 40);
    });
  }

  broadcastPlay({ hostStartTime, trackOffset, trackId }) {
    this.playbackState = { playing: true, hostStartTime, trackOffset, trackId };
    this._broadcast('ctrl', {
      type: 'CMD_PLAY',
      hostStartTime,
      trackOffset,
      trackId,
      roomMaxLatencyMs: this.roomLatencyState.roomMaxLatencyMs,
    });
  }

  broadcastPause({ trackOffset }) {
    this.playbackState.playing = false;
    this.playbackState.trackOffset = trackOffset;
    this._broadcast('ctrl', {
      type: 'CMD_PAUSE',
      trackOffset,
    });
  }

  _sendToClient(client, channelName, payload) {
    if (!client) return;
    if (client.transport === 'relay') {
      this._sendSignal({ sig: 'RELAY_MSG', to: client.id, payload });
      return;
    }
    const ch =
      channelName === 'ntp'
        ? client.channels.ntp || client.channels.ctrl
        : client.channels[channelName] || client.channels.ctrl;
    if (ch && ch.readyState === 'open') {
      try {
        ch.send(JSON.stringify(payload));
      } catch (err) {
        console.warn('[Network/Host] Send error:', err);
      }
    }
  }

  _broadcast(channelName, payload) {
    for (const client of this.clients.values()) {
      if (client.open) {
        this._sendToClient(client, channelName, payload);
      }
    }
  }

  _emitPeers() {
    if (!this.cb.onPeersChanged) return;
    const list = Array.from(this.clients.values()).map((c) => ({
      id: c.id,
      label: c.label,
      rttMs: c.rttMs,
      status: c.status,
      transport: c.transport,
      transportLabel: c.transportLabel,
      ready: c.status === 'Готов',
      latencyMs: c.latency?.totalLatencyMs || 0,
      isBluetooth: Boolean(c.latency?.isBluetooth),
      outputDeviceLabel: c.latency?.outputDeviceLabel || '',
    }));
    this.cb.onPeersChanged(list);
  }

  /* ==================== ЗАПУСК СЛУШАТЕЛЯ ==================== */

  async joinAsListener(rawCode, onProgress = () => {}) {
    this.destroy();
    this.role = 'listener';
    this.selfId = NetworkManager.generatePeerId();
    const code = NetworkManager.normalizeCode(rawCode);
    if (code.length < 4) {
      throw new Error('Введите 6-значный код комнаты (например, K7M-4PX)');
    }
    this.roomCode = code;
    this._listenerProgressCb = onProgress;

    onProgress('1/4 Подключение к каналу обнаружения...');
    await this._openSignaling(code);

    return new Promise(async (resolve, reject) => {
      this._listenerJoinResolve = resolve;
      this._listenerJoinReject = reject;
      this._listenerConnected = false;

      const pc = new RTCPeerConnection(NetworkManager.ICE_CONFIG);
      this.hostPc = pc;

      // Создаём 3 раздельных WebRTC DataChannel
      const ntpCh = pc.createDataChannel('orpheus-ntp', { ordered: false, maxRetransmits: 0 });
      const ctrlCh = pc.createDataChannel('orpheus-ctrl', { ordered: true });
      const dataCh = pc.createDataChannel('orpheus-data', { ordered: true });
      ntpCh.binaryType = 'arraybuffer';
      ctrlCh.binaryType = 'arraybuffer';
      dataCh.binaryType = 'arraybuffer';
      this.hostChannels = { ntp: ntpCh, ctrl: ctrlCh, data: dataCh };

      const gatheredCandidates = [];
      let offerSent = false;
      let lateCandidates = [];
      let lateTimer = null;

      pc.onicecandidate = (ev) => {
        if (ev.candidate) {
          const candJson = ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate;
          if (!offerSent) {
            gatheredCandidates.push(candJson);
          } else if (this.hostPeerId) {
            lateCandidates.push(candJson);
            if (!lateTimer) {
              lateTimer = setTimeout(() => {
                lateTimer = null;
                if (lateCandidates.length > 0 && this.hostPeerId) {
                  const batch = lateCandidates;
                  lateCandidates = [];
                  this._sendSignal({ sig: 'ICE_BATCH', to: this.hostPeerId, candidates: batch });
                }
              }, 300);
            }
          }
        }
      };

      const onDataChannelReady = () => {
        if (this.hostPc !== pc) return;
        if (ctrlCh.readyState === 'open') {
          const wasRelay = this._listenerConnected && this.hostTransport === 'relay';
          if (!this._listenerConnected || wasRelay) {
            this._listenerConnected = true;
            clearTimeout(this._listenerJoinTimer);
            this.hostTransport = 'p2p';

            this._detectTransportType(pc, (type, text) => {
              this.hostTransport = type;
              if (this.cb.onTransportChanged) this.cb.onTransportChanged(type, text);
            });

            if (this._listenerJoinResolve) {
              const res = this._listenerJoinResolve;
              this._listenerJoinResolve = null;
              this._listenerJoinReject = null;
              res(code);
            }
            if (!wasRelay && this.cb.onHostConnected) {
              this.cb.onHostConnected('p2p');
            }
          }
        }
      };

      ctrlCh.onopen = onDataChannelReady;
      ntpCh.onopen = onDataChannelReady;

      ntpCh.onmessage = (ev) => {
        if (this.hostPc !== pc) return;
        if (typeof ev.data === 'string') {
          try { this._listenerHandleHostMessage(JSON.parse(ev.data)); } catch (_) {}
        }
      };

      ctrlCh.onmessage = (ev) => {
        if (this.hostPc !== pc) return;
        if (typeof ev.data === 'string') {
          try { this._listenerHandleHostMessage(JSON.parse(ev.data)); } catch (_) {}
        }
      };

      dataCh.onmessage = (ev) => {
        if (this.hostPc !== pc) return;
        if (ev.data instanceof ArrayBuffer) {
          this._listenerHandleBinaryChunk(ev.data);
        } else if (ev.data instanceof Blob) {
          ev.data.arrayBuffer().then((ab) => this._listenerHandleBinaryChunk(ab));
        }
      };

      ctrlCh.onclose = () => {
        if (this.hostPc !== pc || this.hostTransport === 'relay') return;
        if (this._listenerConnected && this.cb.onHostDisconnected) {
          this._listenerConnected = false;
          this.cb.onHostDisconnected(pc.iceConnectionState || 'closed');
        }
      };

      pc.oniceconnectionstatechange = () => {
        if (this.hostPc !== pc) return;
        const st = pc.iceConnectionState;
        if (st === 'checking' && !this._listenerConnected) {
          onProgress('3/4 Установка прямого P2P-канала...');
        } else if (st === 'connected' || st === 'completed') {
          this._detectTransportType(pc, (type, text) => {
            this.hostTransport = type;
            if (this.cb.onTransportChanged) this.cb.onTransportChanged(type, text);
          });
        } else if (st === 'failed') {
          if (!this._listenerConnected && this.hostPeerId) {
            // Автоматически переходим на WSS Relay Fallback!
            this._activateListenerRelayFallback(onProgress);
          } else if (this._listenerConnected && this.hostTransport !== 'relay') {
            this._listenerConnected = false;
            if (this.cb.onHostDisconnected) this.cb.onHostDisconnected('ice-failed');
          }
        }
      };

      // Собираем Offer + ICE кандидаты
      onProgress(`2/4 Поиск комнаты ${NetworkManager.formatCode(code)}...`);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this._waitIceGathering(pc, NetworkManager.ICE_GATHER_WAIT_MS, gatheredCandidates);
      offerSent = true;

      const sendJoinReq = () => {
        if (this._listenerConnected || this.hostPeerId || this.role !== 'listener') return;
        this._sendSignal({
          sig: 'JOIN_REQ',
          deviceName: this.deviceName,
          offer: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
          candidates: gatheredCandidates,
        });
      };

      // Отправляем запрос на вход (и повторяем через 3.2 сек, если Хост пропустил первый пакет)
      sendJoinReq();
      const retryReqTimer = setTimeout(sendJoinReq, 3200);

      // Таймаут прямого P2P: если Хост ответил, но UDP заблокирован — переключаемся на WSS Relay!
      this._listenerJoinTimer = setTimeout(() => {
        clearTimeout(retryReqTimer);
        if (this._listenerConnected) return;

        if (this.hostPeerId) {
          this._activateListenerRelayFallback(onProgress);
        } else if (this._listenerJoinReject) {
          const rej = this._listenerJoinReject;
          this._listenerJoinResolve = null;
          this._listenerJoinReject = null;
          rej(new Error(`Комната ${NetworkManager.formatCode(code)} не отвечает. Проверьте код и что вкладка Хоста открыта.`));
        }
      }, NetworkManager.P2P_TIMEOUT_MS);
    });
  }

  async _activateListenerRelayFallback(onProgress) {
    if (this._listenerConnected || this.hostTransport === 'relay' || !this.hostPeerId) return;
    this.hostTransport = 'relay';
    onProgress('4/4 Строгий NAT — включаем WSS Relay...');
    await this._sendSignal({ sig: 'RELAY_ENABLE', to: this.hostPeerId });

    setTimeout(() => {
      if (!this._listenerConnected && this._listenerJoinReject) {
        const rej = this._listenerJoinReject;
        this._listenerJoinResolve = null;
        this._listenerJoinReject = null;
        rej(new Error('Не удалось установить связь с Хостом даже через резервный канал.'));
      }
    }, 5500);
  }

  async _listenerHandleSignal(msg) {
    switch (msg.sig) {
      case 'JOIN_ANS': {
        if (!this.hostPc || this.hostPeerId) return;
        this.hostPeerId = msg.from;
        if (this._listenerProgressCb) {
          this._listenerProgressCb('3/4 Хост найден! Пробиваем P2P-канал...');
        }
        try {
          await this.hostPc.setRemoteDescription(new RTCSessionDescription(msg.answer));
          for (const c of msg.candidates || []) {
            try { await this.hostPc.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {}
          }
          for (const c of this._listenerPendingIce) {
            try { await this.hostPc.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {}
          }
          this._listenerPendingIce = [];
        } catch (err) {
          console.error('[Network/Listener] Answer error:', err);
        }
        break;
      }

      case 'ICE_BATCH': {
        if (!this.hostPc) return;
        for (const c of msg.candidates || []) {
          if (this.hostPc.remoteDescription) {
            try { await this.hostPc.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {}
          } else {
            this._listenerPendingIce.push(c);
          }
        }
        break;
      }

      case 'RELAY_ACK': {
        if (this._listenerConnected) return;
        this._listenerConnected = true;
        this.hostTransport = 'relay';
        clearTimeout(this._listenerJoinTimer);
        if (this.cb.onTransportChanged) this.cb.onTransportChanged('relay', 'WSS Relay');
        if (this._listenerJoinResolve) {
          const res = this._listenerJoinResolve;
          this._listenerJoinResolve = null;
          this._listenerJoinReject = null;
          res(this.roomCode);
        }
        if (this.cb.onHostConnected) this.cb.onHostConnected('relay');
        break;
      }

      case 'RELAY_MSG': {
        if (msg.payload) {
          this._listenerHandleHostMessage(msg.payload);
        }
        break;
      }
    }
  }

  sendToHost(payload, channelName = 'ctrl') {
    if (!this._listenerConnected) return;
    if (this.hostTransport === 'relay') {
      if (this.hostPeerId) {
        this._sendSignal({ sig: 'RELAY_MSG', to: this.hostPeerId, payload });
      }
      return;
    }
    const ch =
      channelName === 'ntp'
        ? this.hostChannels.ntp || this.hostChannels.ctrl
        : this.hostChannels[channelName] || this.hostChannels.ctrl;
    if (ch && ch.readyState === 'open') {
      try {
        ch.send(JSON.stringify(payload));
      } catch (err) {
        console.warn('[Network/Listener] Send error:', err);
      }
    }
  }

  _listenerHandleHostMessage(msg) {
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'SYNC_PONG':
        if (this.cb.onSyncPong) this.cb.onSyncPong(msg);
        break;

      case 'ROOM_LATENCY':
        this.roomLatencyState = {
          roomMaxLatencyMs: msg.roomMaxLatencyMs || 0,
          slowestLabel: msg.slowestLabel || 'Хост',
          bluetoothCount: msg.bluetoothCount || 0,
          deviceCount: msg.deviceCount || 1,
        };
        if (this.cb.onRoomLatencyChanged) this.cb.onRoomLatencyChanged(this.roomLatencyState);
        break;

      case 'PLAYLIST_STATE':
        if (this.cb.onPlaylistState) this.cb.onPlaylistState(msg);
        break;

      case 'TRACK_SYNTH':
        if (this.cb.onTrackSynth) this.cb.onTrackSynth(msg);
        break;

      case 'TRACK_URL':
        if (this.cb.onTrackUrl) this.cb.onTrackUrl(msg);
        break;

      case 'FILE_META': {
        const state = {
          trackId: msg.trackId,
          trackHash: msg.trackHash,
          name: msg.name,
          mime: msg.mime,
          totalBytes: msg.totalBytes,
          totalChunks: msg.totalChunks,
          isActive: Boolean(msg.isActive),
          chunks: new Array(msg.totalChunks),
          receivedCount: 0,
          lastReportedPct: -1,
        };
        this.incomingFiles.set(msg.trackHash, state);
        if (state.isActive && this.cb.onFileProgress) {
          this.cb.onFileProgress({ trackId: msg.trackId, name: msg.name, pct: 0, isActive: true });
        }
        break;
      }

      case 'CMD_PLAY':
        if (typeof msg.roomMaxLatencyMs === 'number') {
          this.roomLatencyState.roomMaxLatencyMs = msg.roomMaxLatencyMs;
          if (this.cb.onRoomLatencyChanged) this.cb.onRoomLatencyChanged(this.roomLatencyState);
        }
        if (this.cb.onCmdPlay) this.cb.onCmdPlay(msg);
        break;

      case 'CMD_PAUSE':
        if (this.cb.onCmdPause) this.cb.onCmdPause(msg);
        break;
    }
  }

  _listenerHandleBinaryChunk(arrayBuffer) {
    if (arrayBuffer.byteLength < 12) return;
    const view = new DataView(arrayBuffer);
    const trackHash = view.getUint32(0, false);
    const index = view.getUint32(4, false);

    const f = this.incomingFiles.get(trackHash);
    if (!f || index >= f.totalChunks) return;

    const bytes = new Uint8Array(arrayBuffer, 12);
    if (!f.chunks[index]) {
      f.chunks[index] = bytes;
      f.receivedCount++;
    }

    const pct = Math.round((f.receivedCount / f.totalChunks) * 100);
    if (pct !== f.lastReportedPct && (pct - f.lastReportedPct >= 5 || pct === 100)) {
      f.lastReportedPct = pct;
      if (f.isActive && this.cb.onFileProgress) {
        this.cb.onFileProgress({ trackId: f.trackId, name: f.name, pct, isActive: true });
      }
      if (f.isActive) {
        this.sendToHost({ type: 'TRACK_PROGRESS', trackId: f.trackId, progress: pct });
      }
    }

    if (f.receivedCount === f.totalChunks) {
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
        isActive: f.isActive,
        buffer: merged.buffer,
      };
      this.incomingFiles.delete(trackHash);
      if (this.cb.onFileComplete) this.cb.onFileComplete(completed);
    }
  }

  /* ==================== УТИЛИТЫ WEBRTC ==================== */

  _waitIceGathering(pc, maxWaitMs, gatheredRef = null) {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') {
        resolve();
        return;
      }
      let settled = false;
      let earlyTimer = null;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(earlyTimer);
        pc.removeEventListener('icegatheringstatechange', onState);
        pc.removeEventListener('icecandidate', onCand);
        resolve();
      };
      const onState = () => {
        if (pc.iceGatheringState === 'complete') done();
      };
      const onCand = (ev) => {
        if (!ev.candidate) {
          done();
          return;
        }
        // Как только получили хотя бы 1 srflx (STUN) кандидат — даём 250 мс добрать остальные и стартуем!
        if (ev.candidate.candidate && ev.candidate.candidate.includes('typ srflx') && !earlyTimer) {
          earlyTimer = setTimeout(done, 250);
        }
      };
      pc.addEventListener('icegatheringstatechange', onState);
      pc.addEventListener('icecandidate', onCand);
      const timer = setTimeout(done, maxWaitMs);
    });
  }

  async _detectTransportType(pc, cb) {
    if (!pc || typeof pc.getStats !== 'function') return;
    try {
      const stats = await pc.getStats();
      let pair = null;
      stats.forEach((r) => {
        if (r.type === 'candidate-pair' && (r.nominated || r.state === 'succeeded')) {
          pair = r;
        }
      });
      if (!pair) return;
      const local = stats.get(pair.localCandidateId);
      const remote = stats.get(pair.remoteCandidateId);
      const lt = local?.candidateType || '';
      const rt = remote?.candidateType || '';

      if (lt === 'relay' || rt === 'relay') {
        cb('turn', 'TURN Relay');
      } else if (lt === 'host' && rt === 'host') {
        cb('p2p-lan', 'LAN Прямой');
      } else {
        cb('p2p-udp', 'P2P UDP');
      }
    } catch (_) {}
  }

  destroy() {
    if (this.role === 'listener' && this.hostPeerId) {
      this._sendSignal({ sig: 'LEAVE', to: this.hostPeerId }).catch(() => {});
    }
    clearTimeout(this._listenerJoinTimer);
    this._listenerJoinResolve = null;
    this._listenerJoinReject = null;
    this._listenerConnected = false;

    for (const c of this.clients.values()) {
      try { c.pc?.close(); } catch (_) {}
    }
    this.clients.clear();

    if (this.hostPc) {
      try { this.hostPc.close(); } catch (_) {}
      this.hostPc = null;
    }
    this.hostChannels = { ntp: null, ctrl: null, data: null };
    this.hostPeerId = null;

    this._closeSignaling();
    this.incomingFiles.clear();
    this.playlist = [];
    this.activeTrackId = null;
    this.role = null;
    this.roomCode = null;
  }
}

window.NetworkManager = NetworkManager;
