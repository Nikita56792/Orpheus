/**
 * NetworkManager v2.2 — Мгновенная синхронизация + прогрессивный стриминг аудио
 * во время фонового кэширования + надёжный многоканальный WebRTC / WSS Relay.
 *
 * Исправлено в v2.2:
 * - Не сбрасывает NTP-пинги, если канал orpheus-ntp ещё открывается (мгновенный fallback на orpheus-ctrl).
 * - Ожидает готовности бинарного канала orpheus-data перед передачей файлов (не отменяет загрузку молча!).
 * - Прогрессивный стриминг: для файлов > 700 КБ первым делом отправляется лёгкий стартовый
 *   сегмент (~6 сек, < 0.5 сек передачи), чтобы музыка заиграла СРАЗУ, пока полный файл
 *   продолжает кэшироваться с отображением процентов 0%..100% на главном устройстве.
 */
class NetworkManager {
  static DEFAULT_CHUNK_SIZE = 16000;
  static MAX_CHUNK_SIZE = 60000; // До 60 КБ на чанк при поддержке SCTP maxMessageSize (в 3.7x быстрее!)
  static MAX_BUFFERED_AMOUNT = 1024 * 1024; // 1 МБ окно буфера — полная загрузка канала Wi-Fi P2P
  static STREAM_THRESHOLD_BYTES = 600 * 1024;
  static ICE_GATHER_WAIT_MS = 1600;
  static P2P_TIMEOUT_MS = 7000;
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
    this.role = null;
    this.roomCode = null;
    this.selfId = NetworkManager.generatePeerId();
    this.deviceName = NetworkManager.detectDeviceName();

    // Сигналинг (ntfy.sh WSS + BroadcastChannel)
    this._sigWs = null;
    this._sigTopic = null;
    this._sigReconnectTimer = null;
    this._sigAlive = false;
    this._bc = null;
    this._seenMsgIds = new Set();

    // Хост
    this.clients = new Map();
    this.clientCounter = 0;
    this.playlist = [];
    this.activeTrackId = null;
    this.playbackState = {
      playing: false,
      hostStartTime: 0,
      trackOffset: 0,
      trackId: null,
    };
    this.hostLatencyProfile = { totalLatencyMs: 0, systemLatencyMs: 0, isBluetooth: false, outputDeviceLabel: '' };
    this.roomLatencyState = { roomMaxLatencyMs: 0, slowestLabel: 'Хост', bluetoothCount: 0, deviceCount: 1 };

    // Слушатель
    this.hostPeerId = null;
    this.hostPc = null;
    this.hostChannels = { ntp: null, ctrl: null, data: null };
    this.hostTransport = 'connecting';
    this._listenerJoinResolve = null;
    this._listenerJoinReject = null;
    this._listenerJoinTimer = null;
    this._listenerProgressCb = null;
    this._listenerConnected = false;
    this._listenerPendingIce = [];

    this.incomingTransfers = new Map(); // transferHash -> { kind: 'file'|'seg', ... }
    this.earlyChunks = new Map();       // transferHash -> Map(index -> Uint8Array) если бинарный пакет опередил META
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

  static hashKey(key) {
    let h = 2166136261;
    const s = String(key);
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
    if (/Windows/i.test(ua)) return 'Windows';
    return 'Устройство';
  }

  /* ==================== СИГНАЛИНГ ==================== */

  _roomTopic(code) {
    return `orpheus-sync-v2-room-${code.toLowerCase()}`;
  }

  async _openSignaling(code) {
    this._closeSignaling();
    this._sigTopic = this._roomTopic(code);
    this._sigAlive = true;

    try {
      this._bc = new BroadcastChannel(this._sigTopic);
      this._bc.onmessage = (ev) => {
        if (ev.data) this._onSignalMessage(ev.data);
      };
    } catch (_) {}

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
              reject(new Error('Не удалось подключиться к сигнальному серверу (WSS 443).'));
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
              this._sigReconnectTimer = setTimeout(connectWs, 1500);
            }
          };

          ws.onerror = () => {};
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

  async _sendSignal(payload, attempt = 0) {
    if (!this._sigTopic) return;
    const msg = {
      ...payload,
      from: this.selfId,
      mid: payload.mid || `${this.selfId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    };
    this._seenMsgIds.add(msg.mid);

    if (this._bc && attempt === 0) {
      try { this._bc.postMessage(msg); } catch (_) {}
    }

    try {
      const resp = await fetch(`${NetworkManager.NTFY_BASE}/${this._sigTopic}`, {
        method: 'POST',
        body: JSON.stringify(msg),
      });
      if (resp.status === 429 && attempt < 2) {
        await new Promise((r) => setTimeout(r, 450 + attempt * 500));
        return this._sendSignal(msg, attempt + 1);
      }
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

  /* ==================== ХОСТ ==================== */

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
        await this._hostAcceptListener(msg.from, msg.deviceName || 'Устройство', msg.offer, msg.candidates || []);
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
        const client = this.clients.get(msg.from);
        if (client) {
          client.transport = 'relay';
          client.transportLabel = 'Relay';
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
      transportLabel: 'Подкл.',
      open: false,
      label,
      rttMs: null,
      status: 'Подключение...',
      phase: 'connecting',
      progress: 0,
      readyTracks: new Set(),
      streamReadyTracks: new Set(),
      urgentSegments: [], // Приоритетные потоковые сегменты (вставляются поверх фонового кэша!)
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
            }, 250);
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
            client.phase = 'syncing';
            client.status = 'Синхронизация...';
            this._detectTransportType(pc, (type, text) => {
              client.transport = type;
              client.transportLabel = text;
              this._emitPeers();
            });
            this._emitPeers();
            this._hostSyncNewClient(client);
          } else if (ch.label === 'orpheus-data' && !client.isSendingFile && client.transferQueue.length > 0) {
            // Если data-канал открылся на пару миллисекунд позже ctrl — сразу запускаем очередь!
            this._processClientTransferQueue(client);
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
      await this._waitIceGathering(pc, NetworkManager.ICE_GATHER_WAIT_MS);
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
    this._recomputeRoomLatency();
    this._sendToClient(client, 'ctrl', {
      type: 'ROOM_LATENCY',
      ...this.roomLatencyState,
    });

    this._sendToClient(client, 'ctrl', {
      type: 'PLAYLIST_STATE',
      activeTrackId: this.activeTrackId,
      tracks: this._serializePlaylistMeta(),
    });

    if (this.activeTrackId) {
      const active = this.playlist.find((t) => t.id === this.activeTrackId);
      if (active) {
        client.phase = 'loading';
        client.progress = 0;
        client.status = 'Загрузка 0%';
        this._emitPeers();
        this._queueTrackForClient(client, active, true);
      }
      const next = this._getNextPlaylistTrack(this.activeTrackId);
      if (next && next.id !== this.activeTrackId) {
        this._queueTrackForClient(client, next, false);
      }
    } else {
      client.phase = 'ready';
      client.progress = 100;
      client.status = 'Готово';
      this._emitPeers();
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
        if (client.phase === 'syncing' || client.phase === 'connecting') {
          if (!this.activeTrackId || client.readyTracks.has(this.activeTrackId)) {
            client.phase = 'ready';
            client.progress = 100;
            client.status = 'Готово';
          }
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
        const prevMax = this.roomLatencyState.roomMaxLatencyMs;
        this._recomputeRoomLatency();
        const newMax = this.roomLatencyState.roomMaxLatencyMs;

        if (
          this.playbackState.playing &&
          newMax > prevMax &&
          this.playbackState.hostStartTime - performance.now() > 150 &&
          this.playbackState.hostStartTime - newMax < performance.now() + 250
        ) {
          const shiftedStart = performance.now() + newMax + 600;
          this.playbackState.hostStartTime = shiftedStart;
          this._broadcast('ctrl', {
            type: 'CMD_PLAY',
            trackId: this.playbackState.trackId,
            hostStartTime: shiftedStart,
            trackOffset: this.playbackState.trackOffset,
            roomMaxLatencyMs: newMax,
          });
          if (this.cb.onHostRescheduleNeeded) {
            this.cb.onHostRescheduleNeeded(this.playbackState);
          }
        }
        this._emitPeers();
        break;
      }

      case 'TRACK_PROGRESS': {
        if (msg.trackId === this.activeTrackId) {
          const p = Math.max(0, Math.min(99, Math.round(msg.progress || 0)));
          client.progress = Math.max(client.progress, p);
          const streaming = client.streamReadyTracks.has(msg.trackId);
          client.phase = msg.phase === 'decoding' ? 'decoding' : streaming ? 'streaming' : 'loading';
          client.status =
            msg.phase === 'decoding'
              ? `Обработка ${client.progress}%`
              : streaming
              ? `Играет · кэш ${client.progress}%`
              : `Загрузка ${client.progress}%`;
          this._emitPeers();
        }
        break;
      }

      case 'TRACK_STREAM_READY': {
        // Слушатель получил стартовый потоковый сегмент — можно СРАЗУ запускать звук,
        // не дожидаясь 100% скачивания полного файла!
        client.streamReadyTracks.add(msg.trackId);
        if (msg.trackId === this.activeTrackId && !client.readyTracks.has(msg.trackId)) {
          client.phase = 'streaming';
          client.progress = Math.max(client.progress, 12);
          client.status = `Поток · кэш ${client.progress}%`;
          this._emitPeers();

          if (this.playbackState.playing && this.playbackState.trackId === msg.trackId) {
            this._sendToClient(client, 'ctrl', {
              type: 'CMD_PLAY',
              trackId: this.playbackState.trackId,
              hostStartTime: this.playbackState.hostStartTime,
              trackOffset: this.playbackState.trackOffset,
              roomMaxLatencyMs: this.roomLatencyState.roomMaxLatencyMs,
              isLateJoin: true,
            });
          }
        }
        break;
      }

      case 'NEED_STREAM_SEG': {
        // Если основной файл уже докачан >= 80%, не тратим канал на лишний сегмент — даём файлу завершиться за доли секунды!
        if (
          msg.trackId &&
          typeof msg.fromSec === 'number' &&
          !client.readyTracks.has(msg.trackId) &&
          !(msg.trackId === this.activeTrackId && client.progress >= 80)
        ) {
          client.urgentSegments.push({ trackId: msg.trackId, fromSec: msg.fromSec, durationSec: 8 });
          if (!client.isSendingFile) {
            this._processClientTransferQueue(client);
          }
        }
        break;
      }

      case 'TRACK_READY': {
        client.readyTracks.add(msg.trackId);
        client.streamReadyTracks.add(msg.trackId);
        if (msg.trackId === this.activeTrackId) {
          client.progress = 100;
          client.phase = 'ready';
          client.status = 'Готово';
          this._emitPeers();

          // Если ещё не отправили CMD_PLAY на этапе STREAM_READY — отправляем сейчас
          if (this.playbackState.playing && this.playbackState.trackId === msg.trackId) {
            this._sendToClient(client, 'ctrl', {
              type: 'CMD_PLAY',
              trackId: this.playbackState.trackId,
              hostStartTime: this.playbackState.hostStartTime,
              trackOffset: this.playbackState.trackOffset,
              roomMaxLatencyMs: this.roomLatencyState.roomMaxLatencyMs,
              isLateJoin: true,
            });
          }
        }
        break;
      }

      case 'TRACK_ERROR': {
        if (msg.trackId === this.activeTrackId) {
          client.phase = 'error';
          client.status = 'Ошибка';
          this._emitPeers();
        }
        break;
      }
    }
  }

  /* ==================== ГЛОБАЛЬНАЯ СИНХРОНИЗАЦИЯ ЗАДЕРЖЕК ==================== */

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
      ? `Хост (${this.hostLatencyProfile.outputDeviceLabel || this.deviceName})`
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

  /* ==================== ПЛЕЙЛИСТ И ПРОГРЕССИВНАЯ ПЕРЕДАЧА ==================== */

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

    this._broadcast('ctrl', {
      type: 'PLAYLIST_STATE',
      activeTrackId: this.activeTrackId,
      tracks: this._serializePlaylistMeta(),
    });

    const activeTrack = this.playlist.find((t) => t.id === activeTrackId);
    const nextTrack = this._getNextPlaylistTrack(activeTrackId);

    for (const client of this.clients.values()) {
      if (activeTrack) {
        if (client.readyTracks.has(activeTrack.id)) {
          client.progress = 100;
          client.phase = 'ready';
          client.status = 'Готово';
        } else {
          client.progress = 0;
          client.phase = 'loading';
          client.status = 'Загрузка 0%';
        }
        this._queueTrackForClient(client, activeTrack, true);
      } else {
        client.progress = 100;
        client.phase = 'ready';
        client.status = 'Готово';
      }
      if (nextTrack && nextTrack.id !== activeTrackId) {
        this._queueTrackForClient(client, nextTrack, false);
      }
    }
    this._emitPeers();
  }

  _queueTrackForClient(client, track, highPriority) {
    if (!client.open || !track) return;
    if (client.readyTracks.has(track.id)) {
      if (track.id === this.activeTrackId) {
        client.progress = 100;
        client.phase = 'ready';
        client.status = 'Готово';
        this._emitPeers();
      }
      return;
    }

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
      while (client.open && (client.urgentSegments.length > 0 || client.transferQueue.length > 0)) {
        if (client.urgentSegments.length > 0) {
          const req = client.urgentSegments.shift();
          await this._sendStreamSegmentToClient(client, req.trackId, req.fromSec, req.durationSec);
          continue;
        }
        const { track } = client.transferQueue.shift();
        if (client.readyTracks.has(track.id)) continue;
        await this._sendTrackToClient(client, track);
      }
    } finally {
      client.isSendingFile = false;
    }
  }

  async _waitChannelOpen(client, chName, timeoutMs = 4500) {
    const start = Date.now();
    while (client.open && client.transport !== 'relay') {
      const ch = client.channels[chName];
      if (ch && ch.readyState === 'open') return ch;
      if (Date.now() - start > timeoutMs) return null;
      await new Promise((r) => setTimeout(r, 35));
    }
    return null;
  }

  _getOptimalChunkSize(client) {
    const sctpMax = client?.pc?.sctp?.maxMessageSize;
    if (Number.isFinite(sctpMax) && sctpMax >= 32768) {
      return Math.min(NetworkManager.MAX_CHUNK_SIZE, Math.max(NetworkManager.DEFAULT_CHUNK_SIZE, sctpMax - 4096));
    }
    return NetworkManager.DEFAULT_CHUNK_SIZE;
  }

  async _sendStreamSegmentToClient(client, trackId, fromSec, durationSec = 6) {
    if (!client.open || client.transport === 'relay' || !this.cb.onBuildStreamSegment) return false;
    const dataCh = await this._waitChannelOpen(client, 'data', 4000);
    if (!dataCh) return false;

    const seg = this.cb.onBuildStreamSegment(trackId, fromSec, durationSec);
    if (!seg || !seg.buffer) return false;

    const track = this.playlist.find((t) => t.id === trackId);
    const totalBytes = seg.buffer.byteLength;
    const chunkSize = this._getOptimalChunkSize(client);
    const totalChunks = Math.ceil(totalBytes / chunkSize);
    const segKey = `seg:${trackId}:${Math.round(seg.startSec * 10)}`;
    const transferHash = NetworkManager.hashKey(segKey);

    this._sendToClient(client, 'ctrl', {
      type: 'STREAM_SEG_META',
      trackId,
      name: track?.name || 'Аудио',
      transferHash,
      startSec: seg.startSec,
      endSec: seg.endSec,
      totalDuration: seg.totalDuration,
      totalBytes,
      totalChunks,
    });

    await new Promise((r) => setTimeout(r, 12));

    const rawBytes = new Uint8Array(seg.buffer);
    for (let i = 0; i < totalChunks; i++) {
      if (!client.open || dataCh.readyState !== 'open') return false;
      if (dataCh.bufferedAmount > NetworkManager.MAX_BUFFERED_AMOUNT) {
        await this._waitForDrain(dataCh);
        if (!client.open || dataCh.readyState !== 'open') return false;
      }

      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, totalBytes);
      const packet = new ArrayBuffer(12 + (end - start));
      const view = new DataView(packet);
      view.setUint32(0, transferHash, false);
      view.setUint32(4, i, false);
      view.setUint32(8, totalChunks, false);
      new Uint8Array(packet, 12).set(rawBytes.subarray(start, end));

      try {
        dataCh.send(packet);
      } catch (_) {
        return false;
      }
    }
    return true;
  }

  async _sendTrackToClient(client, track) {
    if (!client.open) return;
    const isActive = track.id === this.activeTrackId;

    if (track.type === 'demo' || track.type === 'pulse') {
      if (isActive) {
        client.progress = 25;
        client.phase = 'loading';
        client.status = 'Подготовка 25%';
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
        client.progress = 10;
        client.phase = 'loading';
        client.status = 'Загрузка 10%';
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
      if (client.transport === 'relay') {
        await this._sendFileViaRelay(client, track, isActive);
        return;
      }

      // Ждём открытия бинарного канала orpheus-data (устраняет зависание при раннем старте!)
      const dataCh = await this._waitChannelOpen(client, 'data', 5000);
      if (!dataCh) return;

      const totalBytes = track.buffer.byteLength;

      // ПРОГРЕССИВНЫЙ СТРИМИНГ: для активного файла > 700 КБ СНАЧАЛА шлём 6-секундный стартовый сегмент
      // с текущей позиции воспроизведения, чтобы музыка заиграла СРАЗУ во время кэширования полного файла!
      if (isActive && totalBytes > NetworkManager.STREAM_THRESHOLD_BYTES && this.cb.onBuildStreamSegment) {
        let startSec = 0;
        if (this.playbackState.playing && this.playbackState.trackId === track.id) {
          const elapsed = Math.max(0, (performance.now() - this.playbackState.hostStartTime) / 1000);
          startSec = Math.max(0, Math.floor(this.playbackState.trackOffset + elapsed + 0.7));
        } else {
          startSec = Math.max(0, Math.floor(this.playbackState.trackOffset || 0));
        }

        client.progress = 5;
        client.phase = 'loading';
        client.status = 'Буфер потока...';
        this._emitPeers();

        await this._sendStreamSegmentToClient(client, track.id, startSec, 6);
        if (!client.open || dataCh.readyState !== 'open') return;
      }

      // Далее передаём ПОЛНЫЙ оригинальный файл в фоне для 100% кэша!
      const chunkSize = this._getOptimalChunkSize(client);
      const totalChunks = Math.ceil(totalBytes / chunkSize);
      const transferHash = NetworkManager.hashKey(`file:${track.id}`);

      if (isActive && !client.streamReadyTracks.has(track.id)) {
        client.progress = Math.max(client.progress, 10);
        client.phase = 'loading';
        client.status = `Загрузка ${client.progress}%`;
        this._emitPeers();
      }

      this._sendToClient(client, 'ctrl', {
        type: 'FILE_META',
        trackId: track.id,
        transferHash,
        name: track.name,
        mime: track.mime || 'audio/mpeg',
        totalBytes,
        totalChunks,
        isActive,
      });

      await new Promise((r) => setTimeout(r, 15));

      const rawBytes = new Uint8Array(track.buffer);
      let lastUiPct = -1;

      for (let i = 0; i < totalChunks; i++) {
        if (!client.open || dataCh.readyState !== 'open') return;

        // Если слушателю срочно нужен следующий потоковый сегмент — вставляем его вне очереди!
        if (client.urgentSegments.length > 0) {
          const req = client.urgentSegments.shift();
          await this._sendStreamSegmentToClient(client, req.trackId, req.fromSec, req.durationSec);
          if (!client.open || dataCh.readyState !== 'open') return;
        }

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
        const packet = new ArrayBuffer(12 + (end - start));
        const view = new DataView(packet);
        view.setUint32(0, transferHash, false);
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
          const baseOffset = totalBytes > NetworkManager.STREAM_THRESHOLD_BYTES ? 12 : 0;
          const pct = Math.min(94, baseOffset + Math.round(((i + 1) / totalChunks) * (94 - baseOffset)));
          if (pct !== lastUiPct && (pct - lastUiPct >= 2 || i === totalChunks - 1)) {
            lastUiPct = pct;
            client.progress = Math.max(client.progress, pct);
            const streaming = client.streamReadyTracks.has(track.id);
            client.phase = i === totalChunks - 1 ? 'decoding' : streaming ? 'streaming' : 'loading';
            client.status =
              i === totalChunks - 1
                ? 'Обработка 95%'
                : streaming
                ? `Играет · кэш ${client.progress}%`
                : `Загрузка ${client.progress}%`;
            this._emitPeers();
          }
        } else if (i % 10 === 0) {
          await new Promise((r) => setTimeout(r, 8));
        }
      }
    }
  }

  async _sendFileViaRelay(client, track, isActive) {
    if (track.buffer.byteLength > 14 * 1024 * 1024) {
      if (isActive) {
        client.phase = 'error';
        client.status = 'Файл >14 МБ';
        this._emitPeers();
      }
      return;
    }

    if (isActive) {
      client.progress = 15;
      client.phase = 'loading';
      client.status = 'Отправка 15%';
      this._emitPeers();
    }

    try {
      if (!track._relayUrl) {
        const fileTopic = `${this._sigTopic}-f-${NetworkManager.hashKey(track.id)}`;
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

      if (isActive) {
        client.progress = 55;
        client.status = 'Загрузка 55%';
        this._emitPeers();
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
        client.phase = 'error';
        client.status = 'Ошибка загрузки';
        this._emitPeers();
      }
    }
  }

  _waitForDrain(dc) {
    return new Promise((resolve) => {
      const lowThreshold = 256 * 1024;
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
      const fallbackTimer = setTimeout(finish, 25);
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
    // Проверяем readyState === 'open' (если ntp ещё не открылся — шлём через ctrl без потери пакетов!)
    const preferred = client.channels[channelName];
    const ch = preferred && preferred.readyState === 'open' ? preferred : client.channels.ctrl;
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
      phase: c.phase,
      progress: c.progress,
      transport: c.transport,
      transportLabel: c.transportLabel,
      ready: c.phase === 'ready',
      streaming: c.phase === 'streaming',
      latencyMs: c.latency?.totalLatencyMs || 0,
      isBluetooth: Boolean(c.latency?.isBluetooth),
      outputDeviceLabel: c.latency?.outputDeviceLabel || '',
    }));
    this.cb.onPeersChanged(list);
  }

  /* ==================== СЛУШАТЕЛЬ ==================== */

  async joinAsListener(rawCode, onProgress = () => {}) {
    this.destroy();
    this.role = 'listener';
    this.selfId = NetworkManager.generatePeerId();
    const code = NetworkManager.normalizeCode(rawCode);
    if (code.length < 4) {
      throw new Error('Введите 6-значный код комнаты');
    }
    this.roomCode = code;
    this._listenerProgressCb = onProgress;

    onProgress('Подключение...');
    await this._openSignaling(code);

    return new Promise(async (resolve, reject) => {
      this._listenerJoinResolve = resolve;
      this._listenerJoinReject = reject;
      this._listenerConnected = false;

      const pc = new RTCPeerConnection(NetworkManager.ICE_CONFIG);
      this.hostPc = pc;

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
              }, 250);
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
      ntpCh.onopen = () => {
        onDataChannelReady();
        if (this._listenerConnected && this.cb.onNtpChannelReady) {
          this.cb.onNtpChannelReady();
        }
      };

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
          onProgress('Установка соединения...');
        } else if (st === 'connected' || st === 'completed') {
          this._detectTransportType(pc, (type, text) => {
            this.hostTransport = type;
            if (this.cb.onTransportChanged) this.cb.onTransportChanged(type, text);
          });
        } else if (st === 'failed') {
          if (!this._listenerConnected && this.hostPeerId) {
            this._activateListenerRelayFallback(onProgress);
          } else if (this._listenerConnected && this.hostTransport !== 'relay') {
            this._listenerConnected = false;
            if (this.cb.onHostDisconnected) this.cb.onHostDisconnected('ice-failed');
          }
        }
      };

      onProgress(`Поиск комнаты ${NetworkManager.formatCode(code)}...`);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this._waitIceGathering(pc, NetworkManager.ICE_GATHER_WAIT_MS);
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

      sendJoinReq();
      const retryReqTimer = setTimeout(sendJoinReq, 2800);

      this._listenerJoinTimer = setTimeout(() => {
        clearTimeout(retryReqTimer);
        if (this._listenerConnected) return;

        if (this.hostPeerId) {
          this._activateListenerRelayFallback(onProgress);
        } else if (this._listenerJoinReject) {
          const rej = this._listenerJoinReject;
          this._listenerJoinResolve = null;
          this._listenerJoinReject = null;
          rej(new Error(`Комната ${NetworkManager.formatCode(code)} не найдена.`));
        }
      }, NetworkManager.P2P_TIMEOUT_MS);
    });
  }

  async _activateListenerRelayFallback(onProgress) {
    if (this._listenerConnected || this.hostTransport === 'relay' || !this.hostPeerId) return;
    this.hostTransport = 'relay';
    onProgress('Подключение через резервный канал...');
    await this._sendSignal({ sig: 'RELAY_ENABLE', to: this.hostPeerId });

    setTimeout(() => {
      if (!this._listenerConnected && this._listenerJoinReject) {
        const rej = this._listenerJoinReject;
        this._listenerJoinResolve = null;
        this._listenerJoinReject = null;
        rej(new Error('Не удалось подключиться к комнате.'));
      }
    }, 5500);
  }

  async _listenerHandleSignal(msg) {
    switch (msg.sig) {
      case 'JOIN_ANS': {
        if (!this.hostPc || this.hostPeerId) return;
        this.hostPeerId = msg.from;
        if (this._listenerProgressCb) {
          this._listenerProgressCb('Установка соединения...');
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
        if (this.cb.onTransportChanged) this.cb.onTransportChanged('relay', 'Relay');
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
    // Проверяем readyState === 'open' (если ntp ещё не открылся — надёжно отправляем через ctrl!)
    const preferred = this.hostChannels[channelName];
    const ch = preferred && preferred.readyState === 'open' ? preferred : this.hostChannels.ctrl;
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

      case 'STREAM_SEG_META': {
        this.incomingTransfers.set(msg.transferHash, {
          kind: 'seg',
          trackId: msg.trackId,
          name: msg.name,
          transferHash: msg.transferHash,
          startSec: msg.startSec,
          endSec: msg.endSec,
          totalDuration: msg.totalDuration,
          totalBytes: msg.totalBytes,
          totalChunks: msg.totalChunks,
          chunks: new Array(msg.totalChunks),
          receivedCount: 0,
        });
        this._drainEarlyChunks(msg.transferHash);
        break;
      }

      case 'FILE_META': {
        const hash = msg.transferHash ?? msg.trackHash;
        const state = {
          kind: 'file',
          trackId: msg.trackId,
          transferHash: hash,
          name: msg.name,
          mime: msg.mime,
          totalBytes: msg.totalBytes,
          totalChunks: msg.totalChunks,
          isActive: Boolean(msg.isActive),
          chunks: new Array(msg.totalChunks),
          receivedCount: 0,
          lastReportedPct: -1,
        };
        this.incomingTransfers.set(hash, state);
        if (state.isActive && this.cb.onFileProgress) {
          this.cb.onFileProgress({ trackId: msg.trackId, name: msg.name, pct: 0, isActive: true });
        }
        this._drainEarlyChunks(hash);
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

  _drainEarlyChunks(transferHash) {
    const early = this.earlyChunks.get(transferHash);
    if (!early) return;
    this.earlyChunks.delete(transferHash);
    for (const [index, bytes] of early.entries()) {
      this._applyBinaryChunk(transferHash, index, bytes);
    }
  }

  _listenerHandleBinaryChunk(arrayBuffer) {
    if (arrayBuffer.byteLength < 12) return;
    const view = new DataView(arrayBuffer);
    const transferHash = view.getUint32(0, false);
    const index = view.getUint32(4, false);
    const bytes = new Uint8Array(arrayBuffer, 12);

    if (!this.incomingTransfers.has(transferHash)) {
      if (!this.earlyChunks.has(transferHash)) {
        this.earlyChunks.set(transferHash, new Map());
      }
      this.earlyChunks.get(transferHash).set(index, bytes);
      return;
    }

    this._applyBinaryChunk(transferHash, index, bytes);
  }

  _applyBinaryChunk(transferHash, index, bytes) {
    const t = this.incomingTransfers.get(transferHash);
    if (!t || index >= t.totalChunks) return;

    if (!t.chunks[index]) {
      t.chunks[index] = bytes;
      t.receivedCount++;
    }

    if (t.kind === 'file') {
      const pct = Math.round((t.receivedCount / t.totalChunks) * 94);
      if (pct !== t.lastReportedPct && (pct - t.lastReportedPct >= 3 || t.receivedCount === t.totalChunks)) {
        t.lastReportedPct = pct;
        if (t.isActive && this.cb.onFileProgress) {
          this.cb.onFileProgress({ trackId: t.trackId, name: t.name, pct, isActive: true });
        }
        if (t.isActive) {
          this.sendToHost({ type: 'TRACK_PROGRESS', trackId: t.trackId, progress: pct, phase: 'loading' });
        }
      }
    }

    if (t.receivedCount === t.totalChunks) {
      const merged = new Uint8Array(t.totalBytes);
      let offset = 0;
      for (let i = 0; i < t.totalChunks; i++) {
        merged.set(t.chunks[i], offset);
        offset += t.chunks[i].byteLength;
      }
      this.incomingTransfers.delete(transferHash);

      if (t.kind === 'seg') {
        if (this.cb.onStreamSegmentComplete) {
          this.cb.onStreamSegmentComplete({
            trackId: t.trackId,
            name: t.name,
            startSec: t.startSec,
            endSec: t.endSec,
            totalDuration: t.totalDuration,
            buffer: merged.buffer,
          });
        }
      } else {
        if (this.cb.onFileComplete) {
          this.cb.onFileComplete({
            trackId: t.trackId,
            name: t.name,
            mime: t.mime,
            isActive: t.isActive,
            buffer: merged.buffer,
          });
        }
      }
    }
  }

  /* ==================== УТИЛИТЫ WEBRTC ==================== */

  _waitIceGathering(pc, maxWaitMs) {
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
        if (ev.candidate.candidate && ev.candidate.candidate.includes('typ srflx') && !earlyTimer) {
          earlyTimer = setTimeout(done, 120);
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
        cb('turn', 'Relay');
      } else if (lt === 'host' && rt === 'host') {
        cb('p2p-lan', 'LAN');
      } else {
        cb('p2p-udp', 'P2P');
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
    this.incomingTransfers.clear();
    this.earlyChunks.clear();
    this.playlist = [];
    this.activeTrackId = null;
    this.role = null;
    this.roomCode = null;
  }
}

window.NetworkManager = NetworkManager;
