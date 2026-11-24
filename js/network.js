/**
 * NetworkManager v3.0 — Гибридный движок «Выделенный сервер + Локальный P2P».
 *
 * Архитектура:
 * 1. Мгновенный WebSocket-хаб на выделенном сервере (/ws):
 *    - Создание и вход в комнату за миллисекунды, работает при включённом VPN на любых устройствах.
 *    - Мгновенный обмен NTP, задержками Bluetooth, плейлистом и командами Play/Pause без ожидания ICE.
 * 2. Параллельный локальный P2P-апгрейд (WebRTC):
 *    - Сразу после входа через серверный /ws в фоне поднимается прямой локальный канал (LAN / P2P UDP).
 *    - Как только прямой канал готов, NTP-синхронизация автоматически переходит на прямой UDP-канал
 *      orpheus-ntp с минимальным джиттером; в локальной сети аудио дополнительно летит напрямую по LAN.
 * 3. Двухпутевая прогрессивная доставка аудио (Сервер HTTPS + P2P):
 *    - Стартовый потоковый сегмент (8.5 сек) загружается на сервер и отдаётся всем устройствам за ~0.5 сек —
 *      музыка начинает играть СРАЗУ во время кэширования полного файла.
 *    - Полный файл загружается Хостом на сервер 1 раз, а все устройства параллельно качают его по HTTPS
 *      с отображением живых процентов (0%..100%) на главном устройстве.
 *    - Если кэш ещё не завершён, следующие потоковые сегменты подгружаются отдельными независимыми
 *      HTTPS-запросами (не блокируются фоновой закачкой — 0 разрывов звука).
 * 4. Авто-резерв: если выделенный сервер временно недоступен, автоматически включается резервный
 *    многоузловой P2P-сигналинг.
 */
class NetworkManager {
  static DEFAULT_CHUNK_SIZE = 16000;
  static MAX_CHUNK_SIZE = 60000;
  static MAX_BUFFERED_AMOUNT = 768 * 1024;
  static STREAMING_DATA_BUFFER_LIMIT = 128 * 1024;
  static STREAM_THRESHOLD_BYTES = 350 * 1024;
  static ICE_GATHER_WAIT_MS = 1400;
  static P2P_TIMEOUT_MS = 7000;

  // Постоянный выделенный Docker-сервер Orpheus с доверенным TLS (работает напрямую без туннелей и с VPN)
  static DEFAULT_SERVER_URL = 'https://158.160.205.107/orpheus';
  static SERVER_STORAGE_KEY = 'orpheus_server_url_v4';

  // Резервный кластер сигналинга (используется только если выделенный сервер полностью недоступен)
  static SIGNALING_NODES = [
    { id: 'adminforge', http: 'https://ntfy.adminforge.de', ws: 'wss://ntfy.adminforge.de' },
    { id: 'envs', http: 'https://ntfy.envs.net', ws: 'wss://ntfy.envs.net' },
    { id: 'ntfy', http: 'https://ntfy.sh', ws: 'wss://ntfy.sh' },
  ];

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

    // Выделенный сервер (primary)
    this._serverBaseUrl = null;
    this._serverWs = null;
    this._serverMode = false;
    this._serverKeepaliveTimer = null;
    this._serverReconnectTimer = null;
    this._pendingServerResolve = null;
    this._pendingServerReject = null;

    // Резервный кластер сигналинга
    this._sigNodes = [];
    this._sigTopic = null;
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
    this.volumeState = {
      volume: 1.0,
      muted: false,
    };
    this.hostLatencyProfile = { totalLatencyMs: 0, systemLatencyMs: 0, isBluetooth: false, outputDeviceLabel: '' };
    this.roomLatencyState = { roomMaxLatencyMs: 0, slowestLabel: 'Хост', bluetoothCount: 0, deviceCount: 1 };

    // Слушатель
    this.hostPeerId = null;
    this.hostPc = null;
    this.hostChannels = { ntp: null, ctrl: null, stream: null, data: null };
    this.hostTransport = 'connecting';
    this._listenerJoinResolve = null;
    this._listenerJoinReject = null;
    this._listenerJoinTimer = null;
    this._listenerProgressCb = null;
    this._listenerConnected = false;
    this._listenerP2pReady = false;
    this._listenerPendingIce = [];
    this._downloadingTracks = new Set();
    this._downloadingSegments = new Set();

    this.incomingTransfers = new Map();
    this.earlyChunks = new Map();
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

  /* ==================== ОБНАРУЖЕНИЕ И ПОДКЛЮЧЕНИЕ К ВЫДЕЛЕННОМУ СЕРВЕРУ ==================== */

  _serverHeaders(extra = {}) {
    return { ...extra };
  }

  async _probeServerHealth(baseUrl, timeoutMs = 2000) {
    if (!baseUrl) return null;
    const clean = baseUrl.replace(/\/+$/, '');
    try {
      const resp = await fetch(`${clean}/health`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      if (data && data.ok && data.service === 'orpheus-sync') {
        return clean;
      }
    } catch (_) {}
    return null;
  }

  async _resolveServerUrl() {
    if (this._serverBaseUrl) return this._serverBaseUrl;

    // 1. Явный параметр ?server=https://...
    try {
      const qs = new URLSearchParams(window.location.search).get('server');
      if (qs && /^https?:\/\//i.test(qs)) {
        const clean = qs.replace(/\/+$/, '');
        this._serverBaseUrl = clean;
        return clean;
      }
    } catch (_) {}

    // 2. Если страница открыта с нашего или standalone Docker-сервера — используем собственный origin без лишних кругов!
    const host = window.location.hostname || '';
    const path = window.location.pathname || '/';
    if (host === '158.160.205.107') {
      const url = path.startsWith('/orpheus') ? `${window.location.origin}/orpheus` : NetworkManager.DEFAULT_SERVER_URL;
      this._serverBaseUrl = url;
      return url;
    }

    if (host && !host.endsWith('github.io') && window.location.protocol !== 'file:') {
      const basePath = path.startsWith('/orpheus') ? `${window.location.origin}/orpheus` : window.location.origin;
      const sameOrigin = await this._probeServerHealth(basePath, 1200);
      if (sameOrigin) {
        this._serverBaseUrl = sameOrigin;
        return sameOrigin;
      }
    }

    // 3. Постоянный выделенный сервер — подключаемся к /ws СРАЗУ за 1 RTT (~50 мс) без предварительного /health!
    this._serverBaseUrl = NetworkManager.DEFAULT_SERVER_URL;
    return this._serverBaseUrl;
  }

  _openServerWs(baseUrl, timeoutMs = 4500) {
    return new Promise((resolve, reject) => {
      const wsUrl = baseUrl.replace(/^http/i, 'ws') + '/ws';
      let settled = false;
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { ws.close(); } catch (_) {}
          reject(new Error('Таймаут подключения к серверу'));
        }
      }, timeoutMs);

      ws.onopen = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(ws);
        }
      };
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('Ошибка WebSocket сервера'));
        }
      };
      ws.onclose = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('Сервер закрыл соединение'));
        }
      };
    });
  }

  _sendServerWs(obj) {
    if (this._serverWs && this._serverWs.readyState === WebSocket.OPEN) {
      try {
        this._serverWs.send(JSON.stringify(obj));
        return true;
      } catch (_) {}
    }
    return false;
  }

  _closeServerWs() {
    clearInterval(this._serverKeepaliveTimer);
    clearTimeout(this._serverReconnectTimer);
    this._serverKeepaliveTimer = null;
    this._serverReconnectTimer = null;
    this._serverMode = false;
    if (this._serverWs) {
      const old = this._serverWs;
      this._serverWs = null;
      old.onclose = null;
      old.onmessage = null;
      old.onerror = null;
      try { old.close(); } catch (_) {}
    }
  }

  /* ==================== РЕЗЕРВНЫЙ СИГНАЛИНГ (FALLBACK) ==================== */

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

    const handleEnvelope = async (node, envelope) => {
      if (!envelope || envelope.event !== 'message') return;
      if (envelope.time && envelope.time > node.lastTs) {
        node.lastTs = envelope.time;
      }
      let rawText = envelope.message || '';
      if (envelope.attachment && envelope.attachment.url) {
        const r = await fetch(envelope.attachment.url);
        if (r.ok) rawText = await r.text();
      }
      if (!rawText) return;
      const data = JSON.parse(rawText);
      this._onSignalMessage(data);
    };

    return new Promise((resolve, reject) => {
      let settled = false;
      const markReady = (node) => {
        if (node) {
          node.ready = true;
          node.failedUntil = 0;
        }
        if (!settled) {
          settled = true;
          clearTimeout(hardTimeout);
          resolve();
        }
      };

      const hardTimeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('Не удалось связаться с сервером. Проверьте подключение к интернету.'));
        }
      }, 9000);

      const startHttpsFallbackForNode = (node) => {
        if (!this._sigAlive || node.sse || node.pollTimer) return;
        if (typeof EventSource !== 'undefined') {
          try {
            const sse = new EventSource(`${node.cfg.http}/${this._sigTopic}/sse`);
            node.sse = sse;
            sse.onopen = () => markReady(node);
            sse.onmessage = (ev) => {
              try { handleEnvelope(node, JSON.parse(ev.data)); } catch (_) {}
            };
            sse.onerror = () => {};
          } catch (_) {}
        }
        const pollOnce = async () => {
          if (!this._sigAlive) return;
          if (this.role === 'listener' && this._listenerConnected && this.hostTransport !== 'relay') return;
          if (node.ws && node.ws.readyState === WebSocket.OPEN) return;
          if (node.failedUntil && Date.now() < node.failedUntil) return;
          try {
            const url = `${node.cfg.http}/${this._sigTopic}/json?poll=1&since=${node.lastTs}`;
            const resp = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(3500) });
            if (resp.ok) {
              markReady(node);
              const text = await resp.text();
              for (const line of text.split('\n')) {
                if (!line.trim()) continue;
                try { await handleEnvelope(node, JSON.parse(line)); } catch (_) {}
              }
            } else if (resp.status === 429) {
              node.failedUntil = Date.now() + 8000;
            }
          } catch (_) {
            node.failedUntil = Date.now() + 12000;
          }
        };
        pollOnce();
        node.pollTimer = setInterval(pollOnce, 1400);
      };

      for (const cfg of NetworkManager.SIGNALING_NODES) {
        const node = {
          cfg,
          ws: null,
          sse: null,
          pollTimer: null,
          reconnectTimer: null,
          fallbackTimer: null,
          lastTs: Math.floor(Date.now() / 1000) - 2,
          ready: false,
          failedUntil: 0,
        };
        this._sigNodes.push(node);

        node.fallbackTimer = setTimeout(() => {
          if (this._sigAlive && !node.ready) startHttpsFallbackForNode(node);
        }, 1600);

        const connectWs = () => {
          if (!this._sigAlive) return;
          try {
            const ws = new WebSocket(`${cfg.ws}/${this._sigTopic}/ws`);
            node.ws = ws;
            ws.onopen = () => {
              clearTimeout(node.fallbackTimer);
              markReady(node);
            };
            ws.onmessage = async (ev) => {
              try { await handleEnvelope(node, JSON.parse(ev.data)); } catch (_) {}
            };
            ws.onclose = () => {
              if (this._sigAlive && node.ws === ws) {
                if (node.ready) startHttpsFallbackForNode(node);
                node.reconnectTimer = setTimeout(connectWs, 4000);
              }
            };
            ws.onerror = () => startHttpsFallbackForNode(node);
          } catch (_) {
            startHttpsFallbackForNode(node);
          }
        };
        connectWs();
      }
    });
  }

  _closeSignaling() {
    this._sigAlive = false;
    for (const node of this._sigNodes) {
      if (node.fallbackTimer) clearTimeout(node.fallbackTimer);
      if (node.reconnectTimer) clearTimeout(node.reconnectTimer);
      if (node.pollTimer) clearInterval(node.pollTimer);
      if (node.sse) { try { node.sse.close(); } catch (_) {} }
      if (node.ws) { try { node.ws.close(); } catch (_) {} }
    }
    this._sigNodes = [];
    if (this._bc) {
      try { this._bc.close(); } catch (_) {}
      this._bc = null;
    }
  }

  _getHealthySignalingNodes() {
    const now = Date.now();
    const readyNodes = this._sigNodes.filter((n) => n.ready && (!n.failedUntil || n.failedUntil <= now));
    if (readyNodes.length > 0) return readyNodes;
    return this._sigNodes.filter((n) => !n.failedUntil || n.failedUntil <= now);
  }

  async _sendSignal(payload) {
    if (this._serverMode) {
      this._sendServerWs({
        t: 'SIGNAL',
        to: payload.to || undefined,
        data: payload,
      });
      return;
    }
    if (!this._sigTopic) return;
    const msg = {
      ...payload,
      from: this.selfId,
      mid: payload.mid || `${this.selfId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    };
    this._seenMsgIds.add(msg.mid);

    if (this._bc) {
      try { this._bc.postMessage(msg); } catch (_) {}
    }

    const body = JSON.stringify(msg);
    const targets = this._getHealthySignalingNodes();
    const list = targets.length > 0 ? targets : this._sigNodes;

    await Promise.allSettled(
      list.map(async (node) => {
        try {
          const resp = await fetch(`${node.cfg.http}/${this._sigTopic}`, {
            method: 'POST',
            body,
            signal: AbortSignal.timeout(4000),
          });
          if (resp.ok) {
            node.ready = true;
            node.failedUntil = 0;
          } else if (resp.status === 429) {
            node.failedUntil = Date.now() + 8000;
          }
        } catch (_) {
          node.failedUntil = Date.now() + 15000;
        }
      })
    );
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
    const wantedCode = preferredCode
      ? NetworkManager.normalizeCode(preferredCode)
      : NetworkManager.generateRoomCode();

    // 1. Быстрый путь: наш выделенный сервер (/ws) — мгновенное создание комнаты даже с VPN!
    const serverUrl = await this._resolveServerUrl();
    if (serverUrl) {
      try {
        const code = await this._startHostOnServer(serverUrl, wantedCode);
        return code;
      } catch (err) {
        console.warn('[Network/Host] Dedicated server failed, falling back to P2P cluster:', err);
        this._closeServerWs();
      }
    }

    // 2. Резервный путь: многоузловой P2P кластер
    this.roomCode = wantedCode;
    await this._openSignaling(wantedCode);
    return wantedCode;
  }

  async _startHostOnServer(serverUrl, wantedCode) {
    const ws = await this._openServerWs(serverUrl, 4500);
    this._serverWs = ws;
    this._serverBaseUrl = serverUrl;
    this._serverMode = true;

    return new Promise((resolve, reject) => {
      let created = false;
      const timeout = setTimeout(() => {
        if (!created) {
          created = true;
          this._closeServerWs();
          reject(new Error('Сервер не ответил на создание комнаты'));
        }
      }, 4500);

      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (_) { return; }
        if (!msg || typeof msg !== 'object') return;

        if (msg.t === 'ROOM_CREATED' && !created) {
          created = true;
          clearTimeout(timeout);
          this.roomCode = msg.code;
          this.selfId = msg.peerId || this.selfId;
          resolve(msg.code);
          return;
        }

        this._hostHandleServerMessage(msg);
      };

      ws.onclose = () => {
        if (!created) {
          created = true;
          clearTimeout(timeout);
          reject(new Error('Соединение с сервером разорвано'));
          return;
        }
        // Авто-переподключение Хоста к серверу с тем же кодом комнаты
        if (this.role === 'host' && this._serverMode && this.roomCode) {
          const keepCode = this.roomCode;
          this._serverReconnectTimer = setTimeout(async () => {
            if (this.role !== 'host' || this.roomCode !== keepCode) return;
            try {
              const freshUrl = await this._resolveServerUrl();
              if (freshUrl && this.role === 'host') {
                await this._startHostOnServer(freshUrl, keepCode);
              }
            } catch (_) {}
          }, 2500);
        }
      };

      this._sendServerWs({
        t: 'CREATE_ROOM',
        code: wantedCode,
        deviceName: this.deviceName,
      });
    });
  }

  _hostHandleServerMessage(msg) {
    switch (msg.t) {
      case 'PEER_JOINED': {
        this._hostAddServerClient(msg.peerId, msg.deviceName || 'Устройство');
        break;
      }

      case 'PEER_LEFT': {
        this._hostRemoveClient(msg.peerId);
        break;
      }

      case 'FROM_PEER': {
        const client = this.clients.get(msg.from);
        if (client && msg.payload) {
          this._hostHandleClientMessage(client, msg.payload);
        }
        break;
      }

      case 'SIGNAL': {
        if (msg.data) {
          this._hostHandleSignal({ ...msg.data, from: msg.from });
        }
        break;
      }
    }
  }

  _hostAddServerClient(peerId, deviceName) {
    if (this.clients.has(peerId)) {
      this._hostRemoveClient(peerId, false);
    }
    const label = `${deviceName} #${++this.clientCounter}`;
    const client = {
      id: peerId,
      pc: null,
      channels: { ntp: null, ctrl: null, stream: null, data: null },
      viaServer: true,
      p2pReady: false,
      transport: 'server',
      transportLabel: 'Сервер',
      open: true,
      label,
      rttMs: null,
      status: 'Синхронизация...',
      phase: 'syncing',
      progress: 0,
      readyTracks: new Set(),
      streamReadyTracks: new Set(),
      urgentSegments: [],
      transferQueue: [],
      isSendingFile: false,
      latency: { totalLatencyMs: 0, systemLatencyMs: 0, isBluetooth: false, outputDeviceLabel: '' },
      syncedOnce: true,
    };
    this.clients.set(peerId, client);
    this._emitPeers();
    // СРАЗУ синхронизируем часы, задержки и запускаем передачу/стрим аудио (0 мс ожидания ICE!)
    this._hostSyncNewClient(client);
  }

  async _hostHandleSignal(msg) {
    switch (msg.sig) {
      case 'JOIN_REQ': {
        await this._hostAcceptListener(msg.from, msg.deviceName || 'Устройство', msg.offer, msg.candidates || []);
        break;
      }

      case 'P2P_OFFER': {
        // Фоновый апгрейд уже подключённого через сервер клиента на прямой локальный P2P!
        const client = this.clients.get(msg.from);
        if (client && msg.offer) {
          await this._hostUpgradeClientToP2P(client, msg.offer, msg.candidates || []);
        }
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

  async _hostUpgradeClientToP2P(client, remoteOffer, remoteCandidates) {
    if (client.pc) {
      try { client.pc.close(); } catch (_) {}
    }
    const pc = new RTCPeerConnection(NetworkManager.ICE_CONFIG);
    client.pc = pc;

    const gatheredCandidates = [];
    let trickleSent = false;
    let lateCandidates = [];
    let lateFlushTimer = null;

    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
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
              this._sendSignal({ sig: 'ICE_BATCH', to: client.id, candidates: batch });
            }
          }, 200);
        }
      }
    };

    pc.ondatachannel = (ev) => {
      const ch = ev.channel;
      ch.binaryType = 'arraybuffer';
      if (ch.label === 'orpheus-ntp') client.channels.ntp = ch;
      else if (ch.label === 'orpheus-ctrl') client.channels.ctrl = ch;
      else if (ch.label === 'orpheus-stream') client.channels.stream = ch;
      else if (ch.label === 'orpheus-data') client.channels.data = ch;

      ch.onopen = () => {
        if (ch.label === 'orpheus-ntp' || ch.label === 'orpheus-ctrl') {
          client.p2pReady = true;
          this._detectTransportType(pc, (type, text) => {
            client.transport = type;
            client.transportLabel = type === 'p2p-lan' ? 'LAN' : text === 'P2P' ? 'P2P' : 'Сервер';
            this._emitPeers();
          });
        }
      };

      ch.onmessage = (msgEv) => {
        if (typeof msgEv.data === 'string') {
          try {
            this._hostHandleClientMessage(client, JSON.parse(msgEv.data));
          } catch (_) {}
        }
      };
    };

    pc.oniceconnectionstatechange = () => {
      const st = pc.iceConnectionState;
      if (st === 'connected' || st === 'completed') {
        client.p2pReady = true;
        this._detectTransportType(pc, (type, text) => {
          client.transport = type;
          client.transportLabel = type === 'p2p-lan' ? 'LAN' : text === 'P2P' ? 'P2P' : 'Сервер';
          this._emitPeers();
        });
      } else if (st === 'failed' || st === 'closed') {
        // Не отключаем клиента — он продолжает работать через сервер!
        client.p2pReady = false;
        if (client.viaServer) {
          client.transport = 'server';
          client.transportLabel = 'Сервер';
          this._emitPeers();
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
        sig: 'P2P_ANSWER',
        to: client.id,
        answer: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
        candidates: gatheredCandidates,
      });
    } catch (_) {
      client.p2pReady = false;
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
      channels: { ntp: null, ctrl: null, stream: null, data: null },
      viaServer: false,
      p2pReady: false,
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
      urgentSegments: [],
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
      else if (ch.label === 'orpheus-stream') client.channels.stream = ch;
      else if (ch.label === 'orpheus-data') client.channels.data = ch;

      ch.onopen = () => {
        if (client.channels.ctrl && client.channels.ctrl.readyState === 'open') {
          client.open = true;
          client.p2pReady = true;
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
          } else if (
            (ch.label === 'orpheus-data' || ch.label === 'orpheus-stream') &&
            !client.isSendingFile &&
            (client.transferQueue.length > 0 || client.urgentSegments.length > 0)
          ) {
            this._processClientTransferQueue(client);
          }
        }
      };

      ch.onmessage = (msgEv) => {
        if (typeof msgEv.data === 'string') {
          try { this._hostHandleClientMessage(client, JSON.parse(msgEv.data)); } catch (_) {}
        }
      };

      ch.onclose = () => {
        if (ch.label === 'orpheus-ctrl' && client.transport !== 'relay' && !client.viaServer) {
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
        if (client.transport !== 'relay' && !client.viaServer) {
          setTimeout(() => {
            if (this.clients.get(peerId) === client && client.transport !== 'relay' && !client.viaServer) {
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
      type: 'CMD_VOLUME',
      volume: this.volumeState.volume,
      muted: this.volumeState.muted,
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
        if (msg.trackId && typeof msg.fromSec === 'number' && !client.readyTracks.has(msg.trackId)) {
          if (client.viaServer && this._serverMode) {
            // Мгновенно отдаём сегмент через выделенный сервер (не зависит от очереди фонового кэша!)
            this._serveStreamSegmentViaServer(client, msg.trackId, msg.fromSec, 8.5);
          } else {
            const dup = client.urgentSegments.some(
              (s) => s.trackId === msg.trackId && Math.abs(s.fromSec - msg.fromSec) < 1.5
            );
            if (!dup) {
              client.urgentSegments.push({ trackId: msg.trackId, fromSec: msg.fromSec, durationSec: 8.5 });
            }
            if (!client.isSendingFile) {
              this._processClientTransferQueue(client);
            }
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

  /* ==================== ПЛЕЙЛИСТ И ДВУХПУТЕВАЯ ПРОГРЕССИВНАЯ ПЕРЕДАЧА ==================== */

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

    // Если активен наш сервер — сразу пре-загружаем файл в RAM сервера, чтобы даже новые устройства забирали мгновенно!
    if (this._serverMode && activeTrack && activeTrack.type === 'file' && activeTrack.buffer) {
      this._ensureTrackUploadedToServer(activeTrack).catch(() => {});
    }

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

  async _ensureTrackUploadedToServer(track) {
    if (!this._serverMode || !this._serverBaseUrl || !this.roomCode || !track.buffer) return null;
    if (track._serverTrackUrl && track._serverRoomCode === this.roomCode) {
      return track._serverTrackUrl;
    }
    if (track._serverUploadPromise && track._serverRoomCode === this.roomCode) {
      return track._serverUploadPromise;
    }

    const safeTrackId = encodeURIComponent(String(NetworkManager.hashKey(track.id)));
    const url = `${this._serverBaseUrl}/api/rooms/${this.roomCode}/tracks/${safeTrackId}`;
    track._serverRoomCode = this.roomCode;

    track._serverUploadPromise = (async () => {
      try {
        const resp = await fetch(url, {
          method: 'PUT',
          headers: this._serverHeaders({
            'Content-Type': track.mime || 'application/octet-stream',
            'X-Track-Name': encodeURIComponent(track.name || 'track'),
          }),
          body: track.buffer,
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        track._serverTrackUrl = url;
        return url;
      } catch (err) {
        track._serverUploadPromise = null;
        console.warn('[Network/Host] Server track upload error:', err);
        return null;
      }
    })();

    return track._serverUploadPromise;
  }

  async _ensureSegmentUploadedToServer(track, fromSec, durationSec = 8.5) {
    if (!this._serverMode || !this._serverBaseUrl || !this.roomCode || !this.cb.onBuildStreamSegment) {
      return null;
    }
    if (!track._serverSegments || track._serverRoomCode !== this.roomCode) {
      track._serverSegments = new Map();
    }
    const bucket = Math.max(0, Math.floor(fromSec * 2) / 2);
    const segKey = `${NetworkManager.hashKey(track.id)}_${Math.round(bucket * 10)}`;

    const existing = track._serverSegments.get(segKey);
    if (existing) return existing;

    const p = (async () => {
      const seg = this.cb.onBuildStreamSegment(track.id, bucket, durationSec);
      if (!seg || !seg.buffer) return null;
      const url = `${this._serverBaseUrl}/api/rooms/${this.roomCode}/seg/${segKey}`;
      try {
        const resp = await fetch(url, {
          method: 'PUT',
          headers: this._serverHeaders({ 'Content-Type': 'audio/wav' }),
          body: seg.buffer,
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return {
          url,
          startSec: seg.startSec,
          endSec: seg.endSec,
          totalDuration: seg.totalDuration,
        };
      } catch (err) {
        track._serverSegments.delete(segKey);
        console.warn('[Network/Host] Server segment upload error:', err);
        return null;
      }
    })();

    track._serverSegments.set(segKey, p);
    return p;
  }

  async _serveStreamSegmentViaServer(client, trackId, fromSec, durationSec = 8.5) {
    const track = this.playlist.find((t) => t.id === trackId);
    if (!track || !client.open) return false;
    const uploaded = await this._ensureSegmentUploadedToServer(track, fromSec, durationSec);
    if (!uploaded || !client.open) return false;

    this._sendToClient(client, 'ctrl', {
      type: 'SERVER_STREAM_SEG',
      trackId: track.id,
      name: track.name,
      url: uploaded.url,
      startSec: uploaded.startSec,
      endSec: uploaded.endSec,
      totalDuration: uploaded.totalDuration,
    });
    return true;
  }

  async _sendFileViaServer(client, track, isActive) {
    const totalBytes = track.buffer.byteLength;

    // 1. Запускаем загрузку ПОЛНОГО файла на сервер сразу в параллель (1 раз для всех устройств!)
    const fullUploadPromise = this._ensureTrackUploadedToServer(track);

    // 2. Для активного файла > 350 КБ ПЕРВЫМ делом отдаём стартовый 8.5-сек сегмент — музыка стартует за ~0.5 сек!
    if (isActive && totalBytes > NetworkManager.STREAM_THRESHOLD_BYTES && this.cb.onBuildStreamSegment) {
      let startSec = 0;
      if (this.playbackState.playing && this.playbackState.trackId === track.id) {
        const elapsed = Math.max(0, (performance.now() - this.playbackState.hostStartTime) / 1000);
        startSec = Math.max(0, Math.floor(this.playbackState.trackOffset + elapsed + 0.5));
      } else {
        startSec = Math.max(0, Math.floor(this.playbackState.trackOffset || 0));
      }

      client.progress = Math.max(client.progress, 5);
      client.phase = 'loading';
      client.status = 'Буфер потока...';
      this._emitPeers();

      await this._serveStreamSegmentViaServer(client, track.id, startSec, 8.5);
    }

    // 3. Как только полный файл на сервере — даём ссылку на параллельную скачку с живыми %!
    const trackUrl = await fullUploadPromise;
    if (!trackUrl || !client.open || client.readyTracks.has(track.id)) return;

    this._sendToClient(client, 'ctrl', {
      type: 'SERVER_FILE_READY',
      trackId: track.id,
      name: track.name,
      mime: track.mime || 'audio/mpeg',
      totalBytes,
      url: trackUrl,
      isActive,
    });
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

  async _sendStreamSegmentToClient(client, trackId, fromSec, durationSec = 8.5) {
    if (!client.open || client.transport === 'relay' || !this.cb.onBuildStreamSegment) return false;
    let streamCh = await this._waitChannelOpen(client, 'stream', 2000);
    if (!streamCh) streamCh = await this._waitChannelOpen(client, 'data', 3000);
    if (!streamCh) return false;

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

    const rawBytes = new Uint8Array(seg.buffer);
    for (let i = 0; i < totalChunks; i++) {
      if (!client.open || streamCh.readyState !== 'open') return false;
      if (streamCh.bufferedAmount > NetworkManager.MAX_BUFFERED_AMOUNT) {
        await this._waitForDrain(streamCh, 256 * 1024);
        if (!client.open || streamCh.readyState !== 'open') return false;
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
        streamCh.send(packet);
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
      // Если клиент в той же локальной сети LAN и P2P DataChannel уже открыт — отдаём прямо по LAN (20-50 МБ/с)!
      const canUseDirectLan =
        client.p2pReady &&
        client.transport === 'p2p-lan' &&
        client.channels.data &&
        client.channels.data.readyState === 'open';

      if (client.viaServer && this._serverMode && !canUseDirectLan) {
        await this._sendFileViaServer(client, track, isActive);
        return;
      }

      if (client.transport === 'relay') {
        await this._sendFileViaRelay(client, track, isActive);
        return;
      }

      const dataCh = await this._waitChannelOpen(client, 'data', 5000);
      if (!dataCh) {
        if (client.viaServer && this._serverMode) {
          await this._sendFileViaServer(client, track, isActive);
        }
        return;
      }

      const totalBytes = track.buffer.byteLength;

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

        await this._sendStreamSegmentToClient(client, track.id, startSec, 8.5);
        if (!client.open || dataCh.readyState !== 'open') return;
      }

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

      const rawBytes = new Uint8Array(track.buffer);

      for (let i = 0; i < totalChunks; i++) {
        if (!client.open || dataCh.readyState !== 'open') return;

        while (client.urgentSegments.length > 0) {
          const req = client.urgentSegments.shift();
          await this._sendStreamSegmentToClient(client, req.trackId, req.fromSec, req.durationSec);
          if (!client.open || dataCh.readyState !== 'open') return;
        }

        if (!isActive && client.transferQueue.some((q) => q.highPriority)) {
          client.transferQueue.push({ track, highPriority: false });
          return;
        }

        const isStreamingActive = isActive && this.playbackState.playing && client.streamReadyTracks.has(track.id);
        const bufLimit = isStreamingActive ? NetworkManager.STREAMING_DATA_BUFFER_LIMIT : NetworkManager.MAX_BUFFERED_AMOUNT;
        if (dataCh.bufferedAmount > bufLimit) {
          await this._waitForDrain(dataCh, Math.floor(bufLimit / 2));
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

        if (!isActive && i % 10 === 0) {
          await new Promise((r) => setTimeout(r, 6));
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
        const nodes = this._getHealthySignalingNodes();
        const tryList = nodes.length > 0 ? nodes : this._sigNodes;
        for (const node of tryList) {
          try {
            const resp = await fetch(`${node.cfg.http}/${fileTopic}`, {
              method: 'PUT',
              headers: { Filename: encodeURIComponent(track.name || 'track.mp3') },
              body: track.buffer,
              signal: AbortSignal.timeout(15000),
            });
            const meta = await resp.json();
            if (meta && meta.attachment && meta.attachment.url) {
              track._relayUrl = meta.attachment.url;
              break;
            }
          } catch (_) {}
        }
        if (!track._relayUrl) throw new Error('Relay upload failed');
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

  _waitForDrain(dc, lowThreshold = 256 * 1024) {
    return new Promise((resolve) => {
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

  broadcastVolume({ volume, muted }) {
    this.volumeState = {
      volume: Math.max(0, Math.min(1, Number(volume))),
      muted: Boolean(muted),
    };
    this._broadcast('ctrl', {
      type: 'CMD_VOLUME',
      volume: this.volumeState.volume,
      muted: this.volumeState.muted,
    });
  }

  _sendToClient(client, channelName, payload) {
    if (!client) return;
    // Если есть прямой открытый P2P-канал для NTP (или LAN ctrl) — используем прямой UDP-путь!
    if (channelName === 'ntp' && client.channels.ntp && client.channels.ntp.readyState === 'open') {
      try {
        client.channels.ntp.send(JSON.stringify(payload));
        return;
      } catch (_) {}
    }

    if (client.viaServer && this._serverMode) {
      this._sendServerWs({ t: 'TO_PEER', to: client.id, payload });
      return;
    }

    if (client.transport === 'relay') {
      this._sendSignal({ sig: 'RELAY_MSG', to: client.id, payload });
      return;
    }

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
    if (this._serverMode && channelName !== 'ntp') {
      // 1 пакет на сервер -> сервер мгновенно и параллельно рассылает всем слушателям
      this._sendServerWs({ t: 'TO_PEER', payload });
      for (const client of this.clients.values()) {
        if (client.open && !client.viaServer) {
          this._sendToClient(client, channelName, payload);
        }
      }
      return;
    }
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

    onProgress('Подключение к серверу...');
    const serverUrl = await this._resolveServerUrl();
    if (serverUrl) {
      try {
        return await this._joinViaServer(serverUrl, code, onProgress);
      } catch (err) {
        // Если сервер ответил что комната не найдена — пробрасываем ошибку сразу,
        // если сам сервер недоступен — пробуем резервный P2P кластер
        if (err && err._roomNotFound) throw err;
        console.warn('[Network/Listener] Server join failed, trying fallback cluster:', err);
        this._closeServerWs();
      }
    }

    return this._joinViaFallbackCluster(code, onProgress);
  }

  async _joinViaServer(serverUrl, code, onProgress) {
    const ws = await this._openServerWs(serverUrl, 4500);
    this._serverWs = ws;
    this._serverBaseUrl = serverUrl;
    this._serverMode = true;

    return new Promise((resolve, reject) => {
      let joined = false;
      const timeout = setTimeout(() => {
        if (!joined) {
          joined = true;
          this._closeServerWs();
          reject(new Error('Таймаут входа в комнату'));
        }
      }, 5000);

      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (_) { return; }
        if (!msg || typeof msg !== 'object') return;

        if (msg.t === 'ROOM_JOINED' && !joined) {
          joined = true;
          clearTimeout(timeout);
          this.roomCode = msg.code;
          this.selfId = msg.peerId || this.selfId;
          this.hostPeerId = msg.hostPeerId;
          this._listenerConnected = true;
          this.hostTransport = 'server';

          if (this.cb.onTransportChanged) this.cb.onTransportChanged('server', 'Сервер');
          resolve(msg.code);
          if (this.cb.onHostConnected) this.cb.onHostConnected('server');

          // В ФОНЕ (не блокируя старт музыки!) пробуем поднять прямой локальный P2P-канал
          this._startListenerBackgroundP2PUpgrade();
          return;
        }

        if (msg.t === 'JOIN_ERROR' && !joined) {
          joined = true;
          clearTimeout(timeout);
          this._closeServerWs();
          const err = new Error(msg.message || `Комната ${NetworkManager.formatCode(code)} не найдена.`);
          err._roomNotFound = true;
          reject(err);
          return;
        }

        if (msg.t === 'FROM_HOST' && msg.payload) {
          this._listenerHandleHostMessage(msg.payload);
        } else if (msg.t === 'SIGNAL' && msg.data) {
          this._listenerHandleSignal({ ...msg.data, from: msg.from });
        } else if (msg.t === 'HOST_LEFT') {
          if (this._listenerConnected) {
            this._listenerConnected = false;
            if (this.cb.onHostDisconnected) this.cb.onHostDisconnected('host-left');
          }
        }
      };

      ws.onclose = () => {
        if (!joined) {
          joined = true;
          clearTimeout(timeout);
          reject(new Error('Соединение с сервером закрыто'));
          return;
        }
        if (this._listenerConnected) {
          this._listenerConnected = false;
          if (this.cb.onHostDisconnected) this.cb.onHostDisconnected('server-closed');
        }
      };

      onProgress(`Вход в комнату ${NetworkManager.formatCode(code)}...`);
      this._sendServerWs({
        t: 'JOIN_ROOM',
        code,
        deviceName: this.deviceName,
      });
    });
  }

  async _startListenerBackgroundP2PUpgrade() {
    if (!this._serverMode || !this._listenerConnected || !this.hostPeerId) return;
    try {
      const pc = new RTCPeerConnection(NetworkManager.ICE_CONFIG);
      this.hostPc = pc;

      const ntpCh = pc.createDataChannel('orpheus-ntp', { ordered: false, maxRetransmits: 0 });
      const ctrlCh = pc.createDataChannel('orpheus-ctrl', { ordered: true });
      const streamCh = pc.createDataChannel('orpheus-stream', { ordered: true });
      const dataCh = pc.createDataChannel('orpheus-data', { ordered: true });
      ntpCh.binaryType = 'arraybuffer';
      ctrlCh.binaryType = 'arraybuffer';
      streamCh.binaryType = 'arraybuffer';
      dataCh.binaryType = 'arraybuffer';
      this.hostChannels = { ntp: ntpCh, ctrl: ctrlCh, stream: streamCh, data: dataCh };

      const gatheredCandidates = [];
      let offerSent = false;
      let lateCandidates = [];
      let lateTimer = null;

      pc.onicecandidate = (ev) => {
        if (!ev.candidate) return;
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
            }, 200);
          }
        }
      };

      ntpCh.onopen = () => {
        if (this.hostPc !== pc) return;
        this._listenerP2pReady = true;
        this._detectTransportType(pc, (type, text) => {
          this.hostTransport = type;
          if (this.cb.onTransportChanged) this.cb.onTransportChanged(type, text);
        });
        // Перезапускаем быстрый burst NTP уже по прямому локальному UDP-каналу!
        if (this.cb.onNtpChannelReady) this.cb.onNtpChannelReady();
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

      streamCh.onmessage = (ev) => {
        if (this.hostPc !== pc) return;
        if (ev.data instanceof ArrayBuffer) this._listenerHandleBinaryChunk(ev.data);
        else if (ev.data instanceof Blob) ev.data.arrayBuffer().then((ab) => this._listenerHandleBinaryChunk(ab));
      };

      dataCh.onmessage = (ev) => {
        if (this.hostPc !== pc) return;
        if (ev.data instanceof ArrayBuffer) this._listenerHandleBinaryChunk(ev.data);
        else if (ev.data instanceof Blob) ev.data.arrayBuffer().then((ab) => this._listenerHandleBinaryChunk(ab));
      };

      pc.oniceconnectionstatechange = () => {
        if (this.hostPc !== pc) return;
        const st = pc.iceConnectionState;
        if (st === 'connected' || st === 'completed') {
          this._listenerP2pReady = true;
          this._detectTransportType(pc, (type, text) => {
            this.hostTransport = type;
            if (this.cb.onTransportChanged) this.cb.onTransportChanged(type, text);
          });
        } else if (st === 'failed' || st === 'closed') {
          // Не мешаем работе через сервер!
          this._listenerP2pReady = false;
          this.hostTransport = 'server';
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this._waitIceGathering(pc, NetworkManager.ICE_GATHER_WAIT_MS);
      offerSent = true;

      await this._sendSignal({
        sig: 'P2P_OFFER',
        to: this.hostPeerId,
        offer: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
        candidates: gatheredCandidates,
      });
    } catch (_) {
      this._listenerP2pReady = false;
    }
  }

  async _joinViaFallbackCluster(code, onProgress) {
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
      const streamCh = pc.createDataChannel('orpheus-stream', { ordered: true });
      const dataCh = pc.createDataChannel('orpheus-data', { ordered: true });
      ntpCh.binaryType = 'arraybuffer';
      ctrlCh.binaryType = 'arraybuffer';
      streamCh.binaryType = 'arraybuffer';
      dataCh.binaryType = 'arraybuffer';
      this.hostChannels = { ntp: ntpCh, ctrl: ctrlCh, stream: streamCh, data: dataCh };

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
            this._listenerP2pReady = true;
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
      streamCh.onmessage = (ev) => {
        if (this.hostPc !== pc) return;
        if (ev.data instanceof ArrayBuffer) this._listenerHandleBinaryChunk(ev.data);
        else if (ev.data instanceof Blob) ev.data.arrayBuffer().then((ab) => this._listenerHandleBinaryChunk(ab));
      };
      dataCh.onmessage = (ev) => {
        if (this.hostPc !== pc) return;
        if (ev.data instanceof ArrayBuffer) this._listenerHandleBinaryChunk(ev.data);
        else if (ev.data instanceof Blob) ev.data.arrayBuffer().then((ab) => this._listenerHandleBinaryChunk(ab));
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
      case 'JOIN_ANS':
      case 'P2P_ANSWER': {
        if (!this.hostPc) return;
        if (msg.sig === 'JOIN_ANS' && this.hostPeerId) return;
        if (!this.hostPeerId) this.hostPeerId = msg.from;
        if (msg.sig === 'JOIN_ANS' && this._listenerProgressCb) {
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

    // Если прямой P2P NTP-канал открыт — шлём SYNC_PING прямо по UDP для минимального джиттера!
    if (channelName === 'ntp' && this.hostChannels.ntp && this.hostChannels.ntp.readyState === 'open') {
      try {
        this.hostChannels.ntp.send(JSON.stringify(payload));
        return;
      } catch (_) {}
    }

    if (this._serverMode) {
      this._sendServerWs({ t: 'TO_HOST', payload });
      return;
    }

    if (this.hostTransport === 'relay') {
      if (this.hostPeerId) {
        this._sendSignal({ sig: 'RELAY_MSG', to: this.hostPeerId, payload });
      }
      return;
    }

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

  async _listenerDownloadServerSegment(msg) {
    const key = `${msg.trackId}:${Math.round((msg.startSec || 0) * 10)}`;
    if (this._downloadingSegments.has(key)) return;
    this._downloadingSegments.add(key);

    try {
      const resp = await fetch(msg.url, {
        headers: this._serverHeaders(),
        cache: 'no-store',
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buffer = await resp.arrayBuffer();
      if (this.role !== 'listener') return;
      if (this.cb.onStreamSegmentComplete) {
        this.cb.onStreamSegmentComplete({
          trackId: msg.trackId,
          name: msg.name,
          startSec: msg.startSec,
          endSec: msg.endSec,
          totalDuration: msg.totalDuration,
          buffer,
        });
      }
    } catch (err) {
      console.warn('[Network/Listener] Server segment fetch error:', err);
    } finally {
      this._downloadingSegments.delete(key);
    }
  }

  async _listenerDownloadServerFile(msg) {
    if (this._downloadingTracks.has(msg.trackId)) return;
    this._downloadingTracks.add(msg.trackId);

    if (msg.isActive && this.cb.onFileProgress) {
      this.cb.onFileProgress({ trackId: msg.trackId, name: msg.name, pct: 0, isActive: true });
    }

    try {
      const resp = await fetch(msg.url, {
        headers: this._serverHeaders(),
        cache: 'no-store',
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const totalBytes = Number(resp.headers.get('Content-Length')) || msg.totalBytes || 0;
      let merged;

      if (resp.body && typeof resp.body.getReader === 'function' && totalBytes > 0) {
        const reader = resp.body.getReader();
        const chunks = [];
        let received = 0;
        let lastPct = -1;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (this.role !== 'listener') return;
          chunks.push(value);
          received += value.byteLength;

          const pct = Math.min(94, Math.round((received / totalBytes) * 94));
          if (pct !== lastPct && (pct - lastPct >= 3 || received >= totalBytes)) {
            lastPct = pct;
            if (msg.isActive && this.cb.onFileProgress) {
              this.cb.onFileProgress({ trackId: msg.trackId, name: msg.name, pct, isActive: true });
            }
            if (msg.isActive) {
              this.sendToHost({ type: 'TRACK_PROGRESS', trackId: msg.trackId, progress: pct, phase: 'loading' });
            }
          }
        }

        const out = new Uint8Array(received);
        let offset = 0;
        for (const c of chunks) {
          out.set(c, offset);
          offset += c.byteLength;
        }
        merged = out.buffer;
      } else {
        merged = await resp.arrayBuffer();
      }

      if (this.role !== 'listener') return;
      if (this.cb.onFileComplete) {
        this.cb.onFileComplete({
          trackId: msg.trackId,
          name: msg.name,
          mime: msg.mime,
          isActive: Boolean(msg.isActive),
          buffer: merged,
        });
      }
    } catch (err) {
      console.warn('[Network/Listener] Server file fetch error:', err);
      this.sendToHost({ type: 'TRACK_ERROR', trackId: msg.trackId });
    } finally {
      this._downloadingTracks.delete(msg.trackId);
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

      case 'SERVER_STREAM_SEG':
        this._listenerDownloadServerSegment(msg);
        break;

      case 'SERVER_FILE_READY':
        this._listenerDownloadServerFile(msg);
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

      case 'CMD_VOLUME':
        if (this.cb.onCmdVolume) this.cb.onCmdVolume(msg);
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
    if (this._serverMode) {
      this._sendServerWs({ t: 'LEAVE' });
    } else if (this.role === 'listener' && this.hostPeerId) {
      this._sendSignal({ sig: 'LEAVE', to: this.hostPeerId }).catch(() => {});
    }
    this._closeServerWs();

    clearTimeout(this._listenerJoinTimer);
    this._listenerJoinResolve = null;
    this._listenerJoinReject = null;
    this._listenerConnected = false;
    this._listenerP2pReady = false;
    this._downloadingTracks.clear();
    this._downloadingSegments.clear();

    for (const c of this.clients.values()) {
      try { c.pc?.close(); } catch (_) {}
    }
    this.clients.clear();

    if (this.hostPc) {
      try { this.hostPc.close(); } catch (_) {}
      this.hostPc = null;
    }
    this.hostChannels = { ntp: null, ctrl: null, stream: null, data: null };
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
