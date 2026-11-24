/**
 * Orpheus Sync v2.2 — мгновенная синхронизация при подключении,
 * прогрессивный старт воспроизведения прямо во время кэширования аудио,
 * живые проценты загрузки на главном устройстве и автоматическая компенсация Bluetooth.
 */
(() => {
  const HOST_DEVICE_ID = '__host__';

  const $ = (id) => document.getElementById(id);

  const ui = {
    appShell: document.querySelector('.app-shell'),
    viewLanding: $('viewLanding'),
    viewInviteUnlock: $('viewInviteUnlock'),
    viewRoom: $('viewRoom'),

    btnHome: $('btnHome'),
    btnLeaveRoom: $('btnLeaveRoom'),

    btnCreateRoom: $('btnCreateRoom'),
    joinForm: $('joinForm'),
    inputRoomCode: $('inputRoomCode'),
    btnJoinRoom: $('btnJoinRoom'),
    joinStatus: $('joinStatus'),

    inviteRoomCode: $('inviteRoomCode'),
    btnUnlockAndJoin: $('btnUnlockAndJoin'),
    inviteStatus: $('inviteStatus'),
    btnCancelInvite: $('btnCancelInvite'),

    roleBadge: $('roleBadge'),
    displayRoomCode: $('displayRoomCode'),
    btnCopyCode: $('btnCopyCode'),
    hostShareActions: $('hostShareActions'),
    btnToggleQR: $('btnToggleQR'),
    btnShareLink: $('btnShareLink'),
    qrPanel: $('qrPanel'),
    qrCanvasWrap: $('qrCanvasWrap'),
    shareLinkInput: $('shareLinkInput'),

    metricStatus: $('metricStatus'),
    metricRtt: $('metricRtt'),
    metricDrift: $('metricDrift'),

    hostMapSection: $('hostMapSection'),
    hostNavBar: $('hostNavBar'),
    roomWorkspace: $('roomWorkspace'),
    hostYandexSection: $('hostYandexSection'),
    btnMapSelectAll: $('btnMapSelectAll'),
    btnMapClearSel: $('btnMapClearSel'),
    mapFloorPills: $('mapFloorPills'),
    mapZonesLegend: $('mapZonesLegend'),
    mapFloorGrid: $('mapFloorGrid'),
    mapUnlocatedWrap: $('mapUnlocatedWrap'),
    mapUnlocatedList: $('mapUnlocatedList'),
    mapMarqueeBox: $('mapMarqueeBox'),

    zoneTargetBar: $('zoneTargetBar'),
    zoneTargetDot: $('zoneTargetDot'),
    zoneTargetText: $('zoneTargetText'),
    btnToggleHostTarget: $('btnToggleHostTarget'),
    btnZoneResetAll: $('btnZoneResetAll'),

    hostTrackSection: $('hostTrackSection'),
    fileDropzone: $('fileDropzone'),
    audioFileInput: $('audioFileInput'),
    btnLoadDemoTrack: $('btnLoadDemoTrack'),
    btnLoadPulseTrack: $('btnLoadPulseTrack'),
    btnToggleUrlInput: $('btnToggleUrlInput'),
    urlTrackForm: $('urlTrackForm'),
    inputAudioUrl: $('inputAudioUrl'),

    playlistCount: $('playlistCount'),
    playlistList: $('playlistList'),
    loopToggleWrap: $('loopToggleWrap'),
    chkLoopPlaylist: $('chkLoopPlaylist'),

    trackCoverImg: $('trackCoverImg'),
    trackTitle: $('trackTitle'),
    trackPreviewBadge: $('trackPreviewBadge'),
    trackSub: $('trackSub'),
    countdownBadge: $('countdownBadge'),
    transferWrap: $('transferWrap'),
    transferLabel: $('transferLabel'),
    transferPct: $('transferPct'),
    transferBar: $('transferBar'),

    visualizerCanvas: $('visualizerCanvas'),
    timeCurrent: $('timeCurrent'),
    timeDuration: $('timeDuration'),
    seekSlider: $('seekSlider'),

    hostPlaybackControls: $('hostPlaybackControls'),
    btnPrevTrack: $('btnPrevTrack'),
    btnPlayPause: $('btnPlayPause'),
    btnNextTrack: $('btnNextTrack'),
    iconPlay: $('iconPlay'),
    iconPause: $('iconPause'),
    playPauseLabel: $('playPauseLabel'),
    btnForceResync: $('btnForceResync'),

    listenerPlaybackBanner: $('listenerPlaybackBanner'),
    listenerPulse: $('listenerPulse'),
    listenerBannerText: $('listenerBannerText'),
    btnListenerReconnect: $('btnListenerReconnect'),

    listenerLocationRow: $('listenerLocationRow'),
    listenerLocationText: $('listenerLocationText'),
    listenerApkLink: $('listenerApkLink'),

    btnMute: $('btnMute'),
    iconVolOn: $('iconVolOn'),
    iconVolOff: $('iconVolOff'),
    volumeSlider: $('volumeSlider'),
    volumePct: $('volumePct'),

    hostPeersSection: $('hostPeersSection'),
    peerCount: $('peerCount'),
    peersOverallProgress: $('peersOverallProgress'),
    peerList: $('peerList'),
    toastContainer: $('toastContainer'),
  };

  const state = {
    role: null,
    roomCode: null,
    playlist: [],
    activeTrackId: null, // локально активный трек (для Слушателя или локального плеера Хоста)
    loopPlaylist: true,
    isSeeking: false,
    rafId: null,
    pendingPlayCmd: null,
    pendingPlayTimer: null,
    reconnectAttempts: 0,
    reconnectTimer: null,
    roomLatency: { roomMaxLatencyMs: 0, slowestLabel: 'Хост', bluetoothCount: 0, deviceCount: 1 },
    peers: [],
    selectedDeviceIds: new Set(), // пусто = «Все устройства»
    localLocation: null,
    hostPlayback: { trackId: null, playing: false, hostStartTime: 0, trackOffset: 0 },
    lastWifiScanSentAt: 0,
    hasAutoCollapsedQr: false,
  };

  let _lastPeerControlSig = '';

  const darkThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
  let floorMap = null;
  let yandexPanel = null;
  let activeHostTab = 'map';

  /* ==================== ПОДСИСТЕМЫ ==================== */

  const wakeLock = new WakeLockManager(() => {});

  const audio = new AudioEngine({
    onDrift: (driftMs, mode) => updateDriftMetric(driftMs, mode),
    onEnded: () => handleTrackEnded(),
    onStateChange: ({ playing }) => {
      updatePlaybackUI(playing);
      if (playing || audio.isScheduled) ensureRenderLoopRunning();
      else drawVisualizerIdleOnce();
      yandexPanel?.syncPlaybackState();
    },
    onLatencyChange: () => {
      if (state.role) sendLocalLatencyToHost();
    },
    onNeedNextSegment: ({ trackId, fromSec }) => {
      if (state.role === 'listener') {
        network.sendToHost({ type: 'NEED_STREAM_SEG', trackId, fromSec }, 'ctrl');
      }
    },
  });

  let clock = null;

  const network = new NetworkManager({
    onPeersChanged: (peers) => {
      state.peers = peers || [];
      pruneStaleSelection();
      renderPeerList(state.peers);
      syncFloorMapData();

      // Автосворачиваем QR после первого подключённого слушателя, чтобы освободить рабочую область
      if (state.role === 'host' && state.peers.length > 0 && !state.hasAutoCollapsedQr) {
        state.hasAutoCollapsedQr = true;
        ui.qrPanel.classList.add('hidden');
      }

      if (state.role === 'host') {
        const ctrlSig = state.peers
          .map(
            (p) =>
              `${p.id}:${p.playback?.trackId || ''}:${p.playback?.playing ? 1 : 0}:${p.playback?.hostStartTime || 0}:${p.location?.floor ?? ''}:${p.volumeState?.volume ?? ''}:${p.volumeState?.muted ? 1 : 0}`
          )
          .join('|');
        if (ctrlSig !== _lastPeerControlSig) {
          _lastPeerControlSig = ctrlSig;
          refreshHostPlayerForSelection();
        }
        if (state.peers.some((p) => p.playback?.playing)) {
          ensureRenderLoopRunning();
        }
      }
    },

    onPeerLocation: () => {
      syncFloorMapData();
    },

    onLocalLocation: (loc) => {
      state.localLocation = loc || null;
      updateListenerLocationUI();
      if (state.role === 'host') syncFloorMapData();
    },

    onBuildStreamSegment: (trackId, startSec, durationSec) => {
      return audio.encodeStreamSegmentWav(trackId, startSec, durationSec);
    },

    onTransportChanged: (type) => {
      if (clock) clock.setMode(type === 'relay' ? 'relay' : 'p2p');
    },

    onRoomLatencyChanged: (roomLat) => {
      state.roomLatency = roomLat;
      audio.setRoomMaxLatency(roomLat.roomMaxLatencyMs);
    },

    onHostRescheduleNeeded: (pb) => {
      if (state.role === 'host' && audio.isPlaying && pb.trackId === state.activeTrackId) {
        audio.schedulePlay({
          hostStartTime: pb.hostStartTime,
          trackOffset: pb.trackOffset,
          getHostTime: () => clock.hostNow(),
        });
      }
    },

    onHostConnected: (transportType) => {
      state.reconnectAttempts = 0;
      if (state.reconnectTimer) {
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = null;
      }
      setStatusMetric('Синхронизация', 'metric-warn');
      ui.btnListenerReconnect.classList.add('hidden');
      if (!audio.isPlaying && !audio.hasPlayableAudio()) {
        ui.listenerBannerText.textContent = 'Синхронизация часов...';
      }

      // Сразу запускаем NTP-сверку и отправляем нашу системную/BT задержку (до завершения промиса!)
      ensureListenerClockStarted(transportType === 'relay' ? 'relay' : 'p2p');
      sendLocalLatencyToHost();
    },

    onNtpChannelReady: () => {
      if (clock && !clock.isHost) {
        clock.reburst();
      }
    },

    onHostReconnected: () => {
      if (state.role !== 'listener') return;
      clearPendingPlay();
      if (clock && !clock.isHost) {
        clock.reset();
        clock.start();
      }
      sendLocalLatencyToHost();
      requestNativeWifiScanIfAvailable();
    },

    onHostDisconnected: (reason = '') => {
      clearPendingPlay();
      audio.pause();
      if (clock) clock.stop();

      if (reason === 'host-left') {
        setStatusMetric('Закрыта', 'metric-bad');
        ui.btnListenerReconnect.classList.add('hidden');
        ui.listenerBannerText.textContent = 'Комната закрыта Хостом';
        showToast('Хост закрыл комнату', 'error');
        return;
      }

      setStatusMetric('Переподкл.', 'metric-warn');
      ui.btnListenerReconnect.classList.remove('hidden');

      if (state.role === 'listener' && state.roomCode && state.reconnectAttempts < 3) {
        state.reconnectAttempts++;
        ui.listenerBannerText.textContent = `Переподключение (${state.reconnectAttempts}/3)...`;
        state.reconnectTimer = setTimeout(() => {
          if (state.role === 'listener' && state.roomCode) {
            enterAsListener(state.roomCode, true);
          }
        }, 1800);
      } else {
        setStatusMetric('Отключён', 'metric-bad');
        ui.listenerBannerText.textContent = 'Связь потеряна. Нажмите «Повторить».';
        showToast('Соединение с комнатой прервано', 'error');
      }
    },

    onSyncPong: (msg) => {
      if (clock) clock.handlePong(msg);
    },

    onPlaylistState: ({ activeTrackId, tracks }) => {
      handleListenerPlaylistState(tracks || [], activeTrackId || null);
    },

    onTrackSynth: async ({ trackId, synthType, name, isActive }) => {
      await handleListenerSynthTrack(trackId, synthType, name, isActive);
    },

    onTrackUrl: async ({ trackId, name, url, isActive }) => {
      await handleListenerUrlTrack(trackId, name, url, isActive);
    },

    onStreamSegmentComplete: async (seg) => {
      await handleListenerStreamSegment(seg);
    },

    onFileProgress: ({ trackId, name, pct, isActive }) => {
      if (!isActive && trackId !== state.activeTrackId) return;
      // НЕ останавливаем воспроизведение, если трек уже играет из потокового сегмента!
      const alreadyStreaming = audio.currentTrackId === trackId && audio.hasStreamOrCachedTrack(trackId);
      if (pct === 0 && trackId === state.activeTrackId && !alreadyStreaming) {
        clearPendingPlay();
        audio.pause(0);
      }
      ui.trackTitle.textContent = name;
      ui.trackSub.textContent = alreadyStreaming ? `Кэширование в фоне (${pct}%)` : 'Загрузка аудио...';
      showTransfer(true, alreadyStreaming ? 'Кэширование' : 'Загрузка', pct);
    },

    onFileComplete: async ({ trackId, name, buffer, isActive }) => {
      await handleListenerFileComplete(trackId, name, buffer, isActive);
    },

    onCmdPlay: (cmd) => handleListenerPlayCmd(cmd),

    onCmdPause: ({ trackOffset }) => {
      clearPendingPlay();
      audio.pause(trackOffset);
      ui.listenerBannerText.textContent = 'На паузе';
    },

    onCmdVolume: ({ volume, muted }) => {
      const v = Math.max(0, Math.min(1, Number(volume)));
      const m = Boolean(muted);
      audio.setVolume(v);
      audio.setMuted(m);
      ui.volumeSlider.value = String(v);
      ui.volumePct.textContent = `${Math.round(v * 100)}%`;
      ui.iconVolOn.classList.toggle('hidden', m);
      ui.iconVolOff.classList.toggle('hidden', !m);
    },

    onError: (err) => {
      showToast(err.message || 'Сетевая ошибка', 'error');
    },
  });

  function ensureListenerClockStarted(mode = 'p2p') {
    if (clock && !clock.isHost) {
      clock.setMode(mode);
      return;
    }
    clock = new ClockSync({
      isHost: false,
      mode,
      sendPing: (payload) => network.sendToHost(payload, 'ntp'),
      onUpdate: ({ rttMs, sampleCount }) => {
        const rttRound = Math.round(rttMs);
        ui.metricRtt.textContent = `${rttRound} мс`;
        ui.metricRtt.className = `metric-value mono ${
          rttRound < 50 ? 'metric-good' : rttRound < 130 ? 'metric-warn' : 'metric-bad'
        }`;
        setStatusMetric('Синхронизирован', 'metric-good');
        if (!audio.isPlaying && ui.listenerBannerText.textContent === 'Синхронизация часов...') {
          ui.listenerBannerText.textContent = audio.hasPlayableAudio()
            ? 'Готово к воспроизведению'
            : 'Подключено · ожидание трека';
        }

        network.sendToHost({ type: 'CLIENT_METRICS', rttMs: rttRound }, 'ctrl');

        // Как только получили 2 точных пинга (или 1 в relay), сразу запускаем отложенный Late Join!
        const minSamples = network.hostTransport === 'relay' ? 1 : 2;
        if (
          state.pendingPlayCmd &&
          audio.hasPlayableAudio() &&
          state.activeTrackId === state.pendingPlayCmd.trackId &&
          sampleCount >= minSamples
        ) {
          const cmd = state.pendingPlayCmd;
          clearPendingPlay();
          executeScheduledPlay(cmd);
        } else if (audio.isScheduled) {
          audio.refineScheduledStart();
        } else if (audio.isPlaying && sampleCount <= 12) {
          audio.checkDrift();
        }
      },
    });
    clock.start();
  }

  /* ==================== УТИЛИТЫ UI ==================== */

  function showView(name) {
    document.documentElement.classList.remove('has-invite-room');
    document.documentElement.classList.remove('is-checking-room');
    ui.viewLanding.classList.toggle('hidden', name !== 'landing');
    ui.viewInviteUnlock.classList.toggle('hidden', name !== 'invite');
    ui.viewRoom.classList.toggle('hidden', name !== 'room');
    ui.btnLeaveRoom.classList.toggle('hidden', name !== 'room');
  }

  function showToast(text, type = 'info') {
    while (ui.toastContainer.children.length >= 3) {
      ui.toastContainer.firstElementChild?.remove();
    }
    const el = document.createElement('div');
    el.className = `toast ${type === 'error' ? 'toast-error' : type === 'success' ? 'toast-success' : ''}`;
    el.textContent = text;
    ui.toastContainer.appendChild(el);
    setTimeout(() => el.classList.add('toast-out'), 3050);
    setTimeout(() => el.remove(), 3320);
  }

  function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function buildShareUrl(code) {
    const base = `${window.location.origin}${window.location.pathname}`;
    return `${base}?room=${NetworkManager.normalizeCode(code)}`;
  }

  function setStatusMetric(text, cls = '') {
    ui.metricStatus.textContent = text;
    ui.metricStatus.className = `metric-value ${cls}`;
  }

  function updateDriftMetric(driftMs, mode) {
    const rounded = Math.round(driftMs);
    const sign = rounded > 0 ? '+' : '';
    ui.metricDrift.textContent = `${sign}${rounded} мс`;
    const abs = Math.abs(rounded);
    let cls = 'metric-good';
    if (abs > 45 || mode === 'resynced') cls = 'metric-bad';
    else if (abs > 12 || mode === 'nudging') cls = 'metric-warn';
    ui.metricDrift.className = `metric-value mono ${cls}`;
  }

  function showTransfer(visible, label = '', pct = 0) {
    ui.transferWrap.classList.toggle('hidden', !visible);
    if (visible) {
      ui.transferLabel.textContent = label;
      ui.transferPct.textContent = `${pct}%`;
      ui.transferBar.style.width = `${pct}%`;
    }
  }

  function renderQR(url) {
    ui.shareLinkInput.value = url;
    ui.qrCanvasWrap.innerHTML = '';
    if (typeof qrcode === 'undefined') {
      ui.qrCanvasWrap.textContent = 'QR недоступен';
      return;
    }
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    ui.qrCanvasWrap.innerHTML = qr.createSvgTag({ scalable: true, margin: 2 });
  }

  function sendLocalLatencyToHost() {
    const profile = audio.getLatencyProfile();
    if (state.role === 'host') {
      network.updateHostLatency(profile);
    } else if (state.role === 'listener') {
      network.sendToHost({
        type: 'DEVICE_LATENCY',
        totalLatencyMs: profile.totalLatencyMs,
        systemLatencyMs: profile.systemLatencyMs,
        extraLatencyMs: profile.extraLatencyMs,
        isBluetooth: profile.isBluetooth,
        outputDeviceLabel: profile.outputDeviceLabel,
      });
    }
  }

  function clearPendingPlay() {
    state.pendingPlayCmd = null;
    if (state.pendingPlayTimer) {
      clearTimeout(state.pendingPlayTimer);
      state.pendingPlayTimer = null;
    }
  }

  /* ==================== СОХРАНЕНИЕ И ВОССТАНОВЛЕНИЕ СЕССИИ ХОСТА (5 МИН) ==================== */

  const HOST_SESSION_KEY = 'orpheus_host_session_v1';
  const HOST_SESSION_TTL_MS = 5 * 60 * 1000;
  let hostSessionHeartbeat = null;
  let pendingGestureUnlockBound = false;

  function saveHostSession(code, hostSecret) {
    if (!code || !hostSecret) return;
    try {
      localStorage.setItem(
        HOST_SESSION_KEY,
        JSON.stringify({ code: NetworkManager.normalizeCode(code), hostSecret, savedAt: Date.now() })
      );
    } catch (_) {}
  }

  function touchHostSession() {
    if (state.role === 'host' && state.roomCode && network.hostSecret) {
      saveHostSession(state.roomCode, network.hostSecret);
    }
  }

  function loadHostSession() {
    try {
      const raw = localStorage.getItem(HOST_SESSION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const code = NetworkManager.normalizeCode(parsed?.code || '');
      const secret = String(parsed?.hostSecret || '').trim();
      const savedAt = Number(parsed?.savedAt || 0);
      if (code.length < 4 || !secret || !savedAt) return null;
      if (Date.now() - savedAt >= HOST_SESSION_TTL_MS) {
        clearHostSession();
        return null;
      }
      return { code, hostSecret: secret, savedAt };
    } catch (_) {
      return null;
    }
  }

  function clearHostSession() {
    try {
      localStorage.removeItem(HOST_SESSION_KEY);
    } catch (_) {}
    if (hostSessionHeartbeat) {
      clearInterval(hostSessionHeartbeat);
      hostSessionHeartbeat = null;
    }
  }

  function startHostSessionHeartbeat() {
    if (hostSessionHeartbeat) clearInterval(hostSessionHeartbeat);
    touchHostSession();
    hostSessionHeartbeat = setInterval(() => {
      touchHostSession();
    }, 25000);
  }

  function bindDeferredAudioUnlock() {
    if (pendingGestureUnlockBound) return;
    pendingGestureUnlockBound = true;
    const unlockOnce = async () => {
      pendingGestureUnlockBound = false;
      window.removeEventListener('pointerdown', unlockOnce, true);
      window.removeEventListener('keydown', unlockOnce, true);
      try {
        if (audio.ctx) {
          await audio.ensureResumed();
        } else {
          await audio.unlock();
        }
        wakeLock.acquire();
        if (state.role) sendLocalLatencyToHost();
      } catch (_) {}
    };
    window.addEventListener('pointerdown', unlockOnce, { capture: true, passive: true });
    window.addEventListener('keydown', unlockOnce, { capture: true, passive: true });
  }

  function setupHostRoomUI(code, { isResumed = false, restoredPeers = [] } = {}) {
    state.role = 'host';
    state.roomCode = code;
    state.playlist = [];
    state.activeTrackId = null;

    clock = new ClockSync({ isHost: true });

    const shareUrl = buildShareUrl(code);
    window.history.replaceState({}, '', `?room=${code}`);
    renderQR(shareUrl);

    ui.roleBadge.textContent = 'ХОСТ';
    ui.roleBadge.className = 'role-badge';
    ui.displayRoomCode.textContent = NetworkManager.formatCode(code);
    if (ui.appShell) ui.appShell.classList.add('is-host-room');

    ui.hostShareActions.classList.remove('hidden');
    ui.hostNavBar.classList.remove('hidden');
    setHostTab('map');
    ui.zoneTargetBar.classList.remove('hidden');
    ui.hostTrackSection.classList.remove('hidden');
    ui.hostPlaybackControls.classList.remove('hidden');
    ui.hostPeersSection.classList.remove('hidden');
    ui.loopToggleWrap.classList.remove('hidden');
    ui.listenerPlaybackBanner.classList.add('hidden');
    ui.listenerLocationRow.classList.add('hidden');
    // При восстановлении после перезагрузки QR можно свернуть, если уже есть подключённые устройства
    ui.qrPanel.classList.toggle('hidden', isResumed && restoredPeers.length > 0);

    setStatusMetric('Активна', 'metric-good');
    ui.metricRtt.textContent = '0 мс';
    ui.metricDrift.textContent = '0 мс';

    state.peers = restoredPeers;
    state.selectedDeviceIds.clear();
    state.hasAutoCollapsedQr = isResumed && restoredPeers.length > 0;
    _lastPeerControlSig = '';
    state.hostPlayback = { trackId: null, playing: false, hostStartTime: 0, trackOffset: 0 };

    startHostSessionHeartbeat();
    sendLocalLatencyToHost();
    network.broadcastVolume({ volume: audio.volume, muted: audio.muted });
    renderPlaylist();
    renderPeerList(state.peers);
    showView('room');
    ensureFloorMapInitialized();
    ensureYandexPanelInitialized();
    refreshHostPlayerForSelection();
    syncVisualizerSize();
    drawVisualizerIdleOnce();
    ensureRenderLoopRunning();
    requestNativeWifiScanIfAvailable();
  }

  /* ==================== ЗАПУСК И ВОССТАНОВЛЕНИЕ ХОСТА ==================== */

  async function enterAsHost() {
    ui.btnCreateRoom.disabled = true;
    ui.btnCreateRoom.textContent = 'Создание...';

    try {
      await audio.unlock();
      wakeLock.acquire();

      const code = await network.startHost();
      setupHostRoomUI(code, { isResumed: false, restoredPeers: [] });
      showToast(`Комната ${NetworkManager.formatCode(code)} создана`, 'success');
    } catch (err) {
      showToast(err.message || 'Не удалось создать комнату', 'error');
    } finally {
      ui.btnCreateRoom.disabled = false;
      ui.btnCreateRoom.textContent = 'Создать комнату';
    }
  }

  async function resumeHostSession(session) {
    try {
      const res = await network.resumeHost(session.code, session.hostSecret);
      // После F5 браузер может не разрешать AudioContext.resume() до первого клика — разблокируем мягко
      audio.unlock().catch(() => {});
      bindDeferredAudioUnlock();

      const restoredPeers = Array.from(network.clients.values()).map((c) => ({
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
        location: c.location || null,
        playback: c.playback ? { ...c.playback } : { trackId: null, playing: false, hostStartTime: 0, trackOffset: 0 },
        volumeState: c.volumeState ? { ...c.volumeState } : { volume: 1, muted: false },
      }));

      setupHostRoomUI(res.code, { isResumed: true, restoredPeers });
      return true;
    } catch (err) {
      clearHostSession();
      network.destroy(false);
      return false;
    }
  }

  function setConnectStatus(text, isError = false) {
    for (const el of [ui.joinStatus, ui.inviteStatus]) {
      if (!el) continue;
      if (!text) {
        el.classList.add('hidden');
        el.textContent = '';
        el.classList.remove('error');
      } else {
        el.classList.remove('hidden');
        el.textContent = text;
        el.classList.toggle('error', isError);
      }
    }
  }

  /* ==================== ЗАПУСК СЛУШАТЕЛЯ ==================== */

  async function enterAsListener(rawCode, isAutoReconnect = false) {
    const code = NetworkManager.normalizeCode(rawCode);
    if (code.length < 4) {
      const msg = 'Введите 6-значный код комнаты';
      setConnectStatus(msg, true);
      showToast(msg, 'error');
      return;
    }

    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    if (!isAutoReconnect) state.reconnectAttempts = 0;

    ui.btnJoinRoom.disabled = true;
    ui.btnUnlockAndJoin.disabled = true;
    ui.btnJoinRoom.textContent = 'Подключение...';
    ui.btnUnlockAndJoin.textContent = 'Подключение...';
    setConnectStatus('Включение звука...');

    try {
      if (!isAutoReconnect) {
        await audio.unlock();
        wakeLock.acquire();
      }

      // Готовим состояние ДО joinAsListener, чтобы входящие от Хоста пакеты
      // (PLAYLIST_STATE / STREAM_SEG / CMD_PLAY) не затирались после await!
      if (clock) {
        clock.stop();
        clock = null;
      }
      state.role = 'listener';
      state.roomCode = code;

      ui.roleBadge.textContent = 'СЛУШАТЕЛЬ';
      ui.roleBadge.className = 'role-badge listener';
      ui.displayRoomCode.textContent = NetworkManager.formatCode(code);
      if (ui.appShell) ui.appShell.classList.remove('is-host-room');

      ui.hostShareActions.classList.add('hidden');
      ui.hostNavBar.classList.add('hidden');
      ui.hostYandexSection.classList.add('hidden');
      ui.hostMapSection.classList.add('hidden');
      ui.zoneTargetBar.classList.add('hidden');
      ui.qrPanel.classList.add('hidden');
      ui.hostTrackSection.classList.add('hidden');
      ui.hostPlaybackControls.classList.add('hidden');
      ui.hostPeersSection.classList.add('hidden');
      ui.loopToggleWrap.classList.add('hidden');
      ui.listenerPlaybackBanner.classList.remove('hidden');
      ui.seekSlider.disabled = true;
      updateListenerLocationUI();

      if (!state.activeTrackId) {
        ui.trackTitle.textContent = 'Ожидание трека';
        ui.trackSub.textContent = 'Подключение к комнате...';
        ui.listenerBannerText.textContent = 'Синхронизация часов...';
      }

      await network.joinAsListener(code, (progressText) => {
        setConnectStatus(progressText, false);
      });
      setConnectStatus('');

      ensureListenerClockStarted(network.hostTransport === 'relay' ? 'relay' : 'p2p');
      sendLocalLatencyToHost();
      requestNativeWifiScanIfAvailable();

      renderPlaylist();
      showView('room');
      syncVisualizerSize();
      drawVisualizerIdleOnce();
      ensureRenderLoopRunning();
      showToast(`Подключено к ${NetworkManager.formatCode(code)}`, 'success');
    } catch (err) {
      const msg = err.message || 'Не удалось подключиться';
      if (isAutoReconnect && state.roomCode && state.reconnectAttempts < 3) {
        state.role = 'listener';
        state.reconnectAttempts++;
        ui.listenerBannerText.textContent = `Переподключение (${state.reconnectAttempts}/3)...`;
        state.reconnectTimer = setTimeout(() => {
          if (state.role === 'listener' && state.roomCode) {
            enterAsListener(state.roomCode, true);
          }
        }, 2200);
      } else {
        if (!isAutoReconnect) {
          state.role = null;
          setConnectStatus(msg, true);
        } else {
          setStatusMetric('Отключён', 'metric-bad');
          ui.listenerBannerText.textContent = 'Связь потеряна. Нажмите «Повторить».';
          ui.btnListenerReconnect.classList.remove('hidden');
        }
        showToast(msg, 'error');
      }
    } finally {
      ui.btnJoinRoom.disabled = false;
      ui.btnUnlockAndJoin.disabled = false;
      ui.btnJoinRoom.textContent = 'Подключиться';
      ui.btnUnlockAndJoin.textContent = 'Подключиться и включить звук';
    }
  }

  /* ==================== ПЛЕЙЛИСТ (ХОСТ) ==================== */

  async function hostAddFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) => f && f.size > 0);
    if (files.length === 0) return;

    let added = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.size > 40 * 1024 * 1024) {
        showToast(`Файл «${file.name}» больше 40 МБ — будет воспроизводиться потоком во время кэширования`, 'info');
      }
      showTransfer(true, `Обработка (${i + 1}/${files.length})`, Math.round(((i + 0.5) / files.length) * 100));

      try {
        const arrayBuffer = await file.arrayBuffer();
        const trackId = `file-${file.name}-${file.size}-${file.lastModified}`;
        const decoded = await audio.decodeToCache(trackId, arrayBuffer);

        if (!state.playlist.some((t) => t.id === trackId)) {
          state.playlist.push({
            id: trackId,
            type: 'file',
            name: file.name.replace(/\.[^.]+$/, '') || file.name,
            duration: decoded.duration,
            size: file.size,
            mime: file.type || 'audio/mpeg',
            buffer: arrayBuffer,
          });
          added++;
        }
      } catch (err) {
        console.error('[App] Decode failed:', file.name, err);
        showToast(`Не удалось открыть ${file.name}`, 'error');
      }
    }

    showTransfer(false);

    if (added > 0) {
      if (!state.activeTrackId) {
        await hostSelectTrack(state.playlist[0].id, false);
      } else {
        network.updatePlaylistCatalog(state.playlist);
        renderPlaylist();
      }
      showToast(added === 1 ? 'Трек добавлен' : `Добавлено треков: ${added}`, 'success');
    }
  }

  async function hostAddSynthTrack(type) {
    const isPulse = type === 'pulse';
    const trackId = isPulse ? 'demo-pulse-60bpm-v2' : 'demo-120bpm-v2';
    const name = isPulse ? 'Метроном (1 Гц)' : 'Тест-бит (120 BPM)';

    showTransfer(true, 'Подготовка...', 65);
    try {
      const decoded = isPulse
        ? await audio.generatePulseTrack(trackId, false)
        : await audio.generateDemoTrack(trackId, false);

      if (!state.playlist.some((t) => t.id === trackId)) {
        state.playlist.push({
          id: trackId,
          type,
          name,
          duration: decoded.duration,
          size: 0,
        });
      }
      showTransfer(false);
      await hostSelectTrack(trackId, false);
    } catch (_) {
      showTransfer(false);
      showToast('Ошибка генерации тест-трека', 'error');
    }
  }

  function setHostTab(tab) {
    activeHostTab = tab === 'yandex' ? 'yandex' : 'map';
    ui.hostMapSection.classList.toggle('hidden', activeHostTab !== 'map');
    ui.hostYandexSection.classList.toggle('hidden', activeHostTab !== 'yandex');
    ui.roomWorkspace?.classList.toggle('is-ym-tab', activeHostTab === 'yandex');
    ui.hostNavBar?.querySelectorAll('[data-host-view]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.hostView === activeHostTab);
    });
    if (activeHostTab === 'yandex') {
      ensureYandexPanelInitialized();
      yandexPanel?.onOpen();
    } else if (floorMap) {
      floorMap.renderAll();
    }
  }

  function ensureYandexPanelInitialized() {
    if (!window.YandexMusicPanel || !ui.hostYandexSection || yandexPanel) return;
    yandexPanel = new window.YandexMusicPanel({
      rootEl: ui.hostYandexSection,
      getServerBaseUrl: () => network._serverBaseUrl || NetworkManager.DEFAULT_SERVER_URL,
      getPlaylistContext: () => ({
        activeTrackId: getTargetControlSnapshot().trackId,
        playing: getTargetControlSnapshot().playing,
        trackIds: new Set(state.playlist.map((t) => t.id)),
      }),
      onPlayTrack: (ymTrack) => hostAddYandexTrack(ymTrack, { playNow: true }),
      onAddTrack: (ymTrack) => hostAddYandexTrack(ymTrack, { playNow: false }),
      onAddManyTracks: async (list, onProgress) => {
        let added = 0;
        for (let i = 0; i < list.length; i++) {
          const ok = await hostAddYandexTrack(list[i], { playNow: false, silent: true });
          if (ok) added++;
          if (onProgress) onProgress(i + 1, list.length);
        }
        if (added > 0) showToast(`Добавлено из Яндекс Музыки: ${added}`, 'success');
      },
      onToast: (msg, type) => showToast(msg, type),
    });
  }

  async function hostAddYandexTrack(ymTrack, { playNow = false, silent = false } = {}) {
    if (!ymTrack || !ymTrack.id) return false;
    const trackId = `ym-${ymTrack.id}`;
    const artists = Array.isArray(ymTrack.artists) ? ymTrack.artists.join(', ') : String(ymTrack.artists || '');
    const displayName = artists ? `${artists} — ${ymTrack.title}` : ymTrack.title || `Трек ${ymTrack.id}`;

    // Если трек уже загружен в плейлист — сразу играем без повторной загрузки!
    const existing = state.playlist.find((t) => t.id === trackId);
    if (existing) {
      if (playNow) {
        await hostSelectTrack(trackId, true);
      } else if (!silent) {
        showToast('Трек уже в плейлисте');
      }
      return true;
    }

    if (!silent) showTransfer(true, `Яндекс Музыка: ${ymTrack.title || 'загрузка'}...`, 35);
    try {
      const baseUrl = (network._serverBaseUrl || NetworkManager.DEFAULT_SERVER_URL).replace(/\/+$/, '');
      const safeHash = encodeURIComponent(String(NetworkManager.hashKey(trackId)));
      const qs = new URLSearchParams({
        quality: 'hq',
        room: state.roomCode || '',
        trackHash: safeHash,
        name: displayName,
      });
      const headers = {};
      const ymTok = yandexPanel?.getToken?.() || '';
      if (ymTok) headers['X-YM-Token'] = ymTok;

      const resp = await fetch(`${baseUrl}/api/ym/track/${encodeURIComponent(ymTrack.id)}/audio?${qs.toString()}`, {
        headers,
      });
      if (!resp.ok) {
        let errMsg = `HTTP ${resp.status}`;
        try {
          const j = await resp.json();
          if (j?.error) errMsg = j.error;
        } catch (_) {}
        throw new Error(errMsg);
      }
      const mime = resp.headers.get('Content-Type') || 'audio/mpeg';
      const isPreview = resp.headers.get('X-YM-Preview') === '1';
      const arrayBuffer = await resp.arrayBuffer();
      if (!silent) showTransfer(true, 'Декодирование...', 85);

      const decoded = await audio.decodeToCache(trackId, arrayBuffer);
      const trackObj = {
        id: trackId,
        type: 'file',
        name: displayName,
        duration: decoded.duration,
        size: arrayBuffer.byteLength,
        mime,
        buffer: arrayBuffer,
        ymId: String(ymTrack.id),
        coverUrl: ymTrack.coverUrl || '',
        isPreview,
      };
      // Сервер УЖЕ сохранил этот файл в RAM комнаты (room.tracks[safeHash]) —
      // помечаем _serverTrackUrl, чтобы Хост не перезагружал файл обратно на сервер!
      if (network._serverMode && state.roomCode) {
        trackObj._serverRoomCode = state.roomCode;
        trackObj._serverTrackUrl = `${baseUrl}/api/rooms/${state.roomCode}/tracks/${safeHash}`;
      }

      if (!state.playlist.some((t) => t.id === trackId)) {
        state.playlist.push(trackObj);
      }
      if (!silent) showTransfer(false);

      if (playNow) {
        await hostSelectTrack(trackId, true);
      } else if (!state.activeTrackId) {
        await hostSelectTrack(trackId, false);
      } else {
        network.updatePlaylistCatalog(state.playlist);
        renderPlaylist();
      }
      if (!silent) showToast(playNow ? `Играет: ${displayName}` : `Добавлено: ${displayName}`, 'success');
      return true;
    } catch (err) {
      if (!silent) {
        showTransfer(false);
        showToast(`Яндекс Музыка: ${err.message || 'не удалось загрузить трек'}`, 'error');
      }
      return false;
    }
  }

  async function hostAddUrlTrack(url) {
    showTransfer(true, 'Загрузка URL...', 40);
    try {
      const resp = await fetch(url, { mode: 'cors' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const arrayBuffer = await resp.arrayBuffer();
      const trackId = `url-${url}`;
      showTransfer(true, 'Обработка...', 85);
      const decoded = await audio.decodeToCache(trackId, arrayBuffer);
      const cleanName = decodeURIComponent(url.split('/').pop().split('?')[0] || 'Аудио по ссылке');

      if (!state.playlist.some((t) => t.id === trackId)) {
        state.playlist.push({
          id: trackId,
          type: 'url',
          name: cleanName,
          duration: decoded.duration,
          url,
        });
      }
      showTransfer(false);
      ui.inputAudioUrl.value = '';
      ui.urlTrackForm.classList.add('hidden');

      if (!state.activeTrackId) {
        await hostSelectTrack(trackId, false);
      } else {
        network.updatePlaylistCatalog(state.playlist);
        renderPlaylist();
      }
      showToast('Трек добавлен', 'success');
    } catch (_) {
      showTransfer(false);
      showToast('Не удалось загрузить ссылку (проверьте CORS)', 'error');
    }
  }

  async function ensureHostDecodedTrack(track) {
    if (!track) return null;
    if (audio.hasCachedTrack(track.id)) {
      return audio.bufferCache.get(track.id);
    }
    if (track.type === 'demo') return audio.generateDemoTrack(track.id, false);
    if (track.type === 'pulse') return audio.generatePulseTrack(track.id, false);
    if (track.type === 'file' && track.buffer) return audio.decodeToCache(track.id, track.buffer);
    if (track.type === 'url' && track.url) {
      const resp = await fetch(track.url, { mode: 'cors' });
      return audio.decodeToCache(track.id, await resp.arrayBuffer());
    }
    return null;
  }

  async function hostSelectTrack(trackId, autoPlay = false) {
    const track = state.playlist.find((t) => t.id === trackId);
    if (!track) return;

    const decoded = await ensureHostDecodedTrack(track);
    if (!decoded) return;

    const { isAll, includeHost, peerIds } = getActiveTargetScope();
    network.updatePlaylistCatalog(state.playlist);

    if (includeHost) {
      audio.pause(0);
      audio.activateTrack(trackId);
      state.activeTrackId = trackId;
      state.hostPlayback = { trackId, playing: false, hostStartTime: 0, trackOffset: 0 };
    }

    if (isAll) {
      network.setHostPlaylist(state.playlist, trackId);
    } else if (peerIds.length > 0) {
      network.assignTrackToTargets(trackId, peerIds);
    }

    refreshHostPlayerForSelection();
    renderPlaylist();
    syncFloorMapData();

    if (autoPlay) {
      hostSchedulePlay(0, trackId);
    }
  }

  function hostRemoveTrack(trackId) {
    const idx = state.playlist.findIndex((t) => t.id === trackId);
    if (idx < 0) return;

    const hostWasOnTrack = state.activeTrackId === trackId;
    const affectedPeerIds = state.peers
      .filter((p) => (p.playback?.trackId || null) === trackId)
      .map((p) => p.id);

    state.playlist.splice(idx, 1);
    network.updatePlaylistCatalog(state.playlist);

    const next = state.playlist[idx] || state.playlist[0] || null;

    if (hostWasOnTrack) {
      audio.pause(0);
      state.hostPlayback = { trackId: next ? next.id : null, playing: false, hostStartTime: 0, trackOffset: 0 };
      if (next) {
        state.activeTrackId = next.id;
        ensureHostDecodedTrack(next).then((dec) => {
          if (dec && state.activeTrackId === next.id) {
            audio.activateTrack(next.id);
            refreshHostPlayerForSelection();
          }
        });
      } else {
        state.activeTrackId = null;
        audio.buffer = null;
        resetPlayerNoTrackUI();
      }
    }

    if (affectedPeerIds.length > 0) {
      const allPeersAffected = affectedPeerIds.length === state.peers.length && hostWasOnTrack;
      network.broadcastPause({ trackOffset: 0, targetIds: allPeersAffected ? null : affectedPeerIds });
      if (next) {
        if (allPeersAffected) {
          network.setHostPlaylist(state.playlist, next.id);
        } else {
          network.assignTrackToTargets(next.id, affectedPeerIds);
        }
      } else if (allPeersAffected) {
        network.setHostPlaylist([], null);
      }
    } else if (state.playlist.length === 0) {
      network.setHostPlaylist([], null);
    }

    refreshHostPlayerForSelection();
    renderPlaylist();
    syncFloorMapData();
    yandexPanel?.syncPlaybackState();
  }

  function hostMoveTrack(trackId, dir) {
    const idx = state.playlist.findIndex((t) => t.id === trackId);
    const target = idx + dir;
    if (idx < 0 || target < 0 || target >= state.playlist.length) return;
    const [item] = state.playlist.splice(idx, 1);
    state.playlist.splice(target, 0, item);
    network.updatePlaylistCatalog(state.playlist);
    renderPlaylist();
    syncFloorMapData();
  }

  function handleTrackEnded() {
    updatePlaybackUI(false);
    if (state.role !== 'host') return;

    const finishedTrackId = state.activeTrackId;
    state.hostPlayback.playing = false;
    state.hostPlayback.trackOffset = 0;

    // Определяем, какие устройства реально играли этот завершившийся трек (не трогаем другие зоны!)
    const peerIdsOnTrack = state.peers
      .filter((p) => p.playback?.trackId === finishedTrackId && p.playback?.playing)
      .map((p) => p.id);
    const isAllRoom = peerIdsOnTrack.length === state.peers.length;

    let nextTrackId = null;
    if (state.playlist.length > 1) {
      const idx = state.playlist.findIndex((t) => t.id === finishedTrackId);
      const hasNext = idx >= 0 && idx < state.playlist.length - 1;
      if (hasNext) nextTrackId = state.playlist[idx + 1].id;
      else if (state.loopPlaylist) nextTrackId = state.playlist[0].id;
    } else if (state.playlist.length === 1 && state.loopPlaylist) {
      nextTrackId = state.playlist[0].id;
    }

    if (nextTrackId) {
      const nextTrack = state.playlist.find((t) => t.id === nextTrackId);
      if (nextTrack) {
        ensureHostDecodedTrack(nextTrack).then((dec) => {
          if (!dec || state.role !== 'host') return;
          audio.activateTrack(nextTrackId);
          state.activeTrackId = nextTrackId;
          const targetPeers = isAllRoom ? null : peerIdsOnTrack;
          if (isAllRoom) {
            network.setHostPlaylist(state.playlist, nextTrackId);
          } else if (peerIdsOnTrack.length > 0) {
            network.assignTrackToTargets(nextTrackId, peerIdsOnTrack);
          }
          const bufferMs = getEffectiveStartBufferMs(targetPeers, true);
          const hostStartTime = clock.hostNow() + bufferMs;
          state.hostPlayback = { trackId: nextTrackId, playing: true, hostStartTime, trackOffset: 0 };
          audio.schedulePlay({ hostStartTime, trackOffset: 0, getHostTime: () => clock.hostNow() });
          if (isAllRoom || peerIdsOnTrack.length > 0) {
            network.broadcastPlay({ hostStartTime, trackOffset: 0, trackId: nextTrackId, targetIds: targetPeers });
          }
          ensureRenderLoopRunning();
          refreshHostPlayerForSelection();
          renderPlaylist();
          syncFloorMapData();
        });
        return;
      }
    }

    if (isAllRoom) {
      network.broadcastPause({ trackOffset: 0, targetIds: null });
    } else if (peerIdsOnTrack.length > 0) {
      network.broadcastPause({ trackOffset: 0, targetIds: peerIdsOnTrack });
    }
    ensureRenderLoopRunning();
    refreshHostPlayerForSelection();
    syncFloorMapData();
  }

  /* ==================== ПЛЕЙЛИСТ И ПОТОКОВЫЙ СТАРТ (СЛУШАТЕЛЬ) ==================== */

  function handleListenerPlaylistState(tracks, activeTrackId) {
    state.playlist = tracks;
    const prevActive = state.activeTrackId;
    state.activeTrackId = activeTrackId;
    renderPlaylist();

    if (!activeTrackId) {
      audio.pause(0);
      resetPlayerNoTrackUI();
      return;
    }

    if (activeTrackId !== prevActive && audio.hasCachedTrack(activeTrackId)) {
      const decoded = audio.activateTrack(activeTrackId);
      const meta = state.playlist.find((t) => t.id === activeTrackId);
      if (decoded && meta) {
        onTrackReadyUI(meta.name, formatTime(decoded.duration), decoded.duration);
        showTransfer(false);
        ui.listenerBannerText.textContent = 'Готово к воспроизведению';
        network.sendToHost({ type: 'TRACK_READY', trackId: activeTrackId });
        tryApplyPendingPlay();
      }
    }
  }

  /**
   * Слушатель получил быстрый потоковый сегмент — активируем трек и разрешаем
   * СИНХРОННЫЙ СТАРТ СРАЗУ, пока полный файл ещё кэшируется в фоне!
   */
  async function handleListenerStreamSegment({ trackId, name, startSec, totalDuration, buffer }) {
    try {
      await audio.addStreamSegment(trackId, startSec, totalDuration, buffer);
      const isCurrent = trackId === state.activeTrackId || !state.activeTrackId;
      if (isCurrent) {
        state.activeTrackId = trackId;
        audio.activateStreamTrack(trackId, totalDuration);
        if (!audio.buffer) {
          onTrackReadyUI(name, `${formatTime(totalDuration)} • Поток (кэширование...)`, totalDuration);
          if (!audio.isPlaying) {
            ui.listenerBannerText.textContent = 'Поток готов — синхронный старт...';
          }
        }
        network.sendToHost({ type: 'TRACK_STREAM_READY', trackId });
        tryApplyPendingPlay();
      }
    } catch (err) {
      console.warn('[App/Listener] Stream segment decode error:', err);
    }
  }

  async function handleListenerSynthTrack(trackId, synthType, name, isActive) {
    const isCurrentlyActive = () => trackId === state.activeTrackId || (!state.activeTrackId && isActive);
    if (isCurrentlyActive()) {
      audio.pause(0);
      showTransfer(true, 'Подготовка...', 55);
      network.sendToHost({ type: 'TRACK_PROGRESS', trackId, progress: 55, phase: 'loading' });
    }
    try {
      const decoded =
        synthType === 'pulse'
          ? await audio.generatePulseTrack(trackId, false)
          : await audio.generateDemoTrack(trackId, false);

      if (isCurrentlyActive()) {
        audio.activateTrack(trackId);
        state.activeTrackId = trackId;
        onTrackReadyUI(name, formatTime(decoded.duration), decoded.duration);
        showTransfer(false);
        ui.listenerBannerText.textContent = 'Готово к воспроизведению';
      }
      network.sendToHost({ type: 'TRACK_READY', trackId });
      renderPlaylist();
      if (isCurrentlyActive()) tryApplyPendingPlay();
    } catch (_) {
      if (isCurrentlyActive()) showTransfer(false);
      network.sendToHost({ type: 'TRACK_ERROR', trackId });
    }
  }

  async function handleListenerUrlTrack(trackId, name, url, isActive) {
    const isCurrentlyActive = () => trackId === state.activeTrackId || (!state.activeTrackId && isActive);
    if (isCurrentlyActive()) {
      audio.pause(0);
      showTransfer(true, 'Загрузка...', 30);
      network.sendToHost({ type: 'TRACK_PROGRESS', trackId, progress: 30, phase: 'loading' });
    }
    try {
      const resp = await fetch(url, { mode: 'cors' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = await resp.arrayBuffer();
      if (isCurrentlyActive()) {
        showTransfer(true, 'Обработка...', 90);
        network.sendToHost({ type: 'TRACK_PROGRESS', trackId, progress: 90, phase: 'decoding' });
      }
      const decoded = await audio.decodeToCache(trackId, buf);
      if (isCurrentlyActive()) {
        audio.activateTrack(trackId);
        state.activeTrackId = trackId;
        onTrackReadyUI(name, formatTime(decoded.duration), decoded.duration);
        showTransfer(false);
        ui.listenerBannerText.textContent = 'Готово к воспроизведению';
      }
      network.sendToHost({ type: 'TRACK_READY', trackId });
      renderPlaylist();
      if (isCurrentlyActive()) tryApplyPendingPlay();
    } catch (_) {
      if (isCurrentlyActive()) showTransfer(false);
      network.sendToHost({ type: 'TRACK_ERROR', trackId });
    }
  }

  async function handleListenerFileComplete(trackId, name, buffer, isActive) {
    const isCurrentlyActive = () => trackId === state.activeTrackId || (!state.activeTrackId && isActive);
    const startedWhileStreaming = isCurrentlyActive() && audio.isPlaying && audio.playingFromSegment;

    if (isCurrentlyActive()) {
      showTransfer(true, startedWhileStreaming ? 'Финализация кэша...' : 'Обработка...', 96);
      network.sendToHost({ type: 'TRACK_PROGRESS', trackId, progress: 96, phase: 'decoding' });
    }
    try {
      const decoded = await audio.decodeToCache(trackId, buffer);
      // Повторно проверяем ПОСЛЕ await: трек мог начать играть с сегмента, пока шло декодирование!
      const isPlayingThis = audio.isPlaying && audio.currentTrackId === trackId;
      if (isCurrentlyActive()) {
        state.activeTrackId = trackId;
        if (isPlayingThis) {
          audio.promoteFullBuffer(trackId, decoded);
          ui.trackSub.textContent = formatTime(decoded.duration);
          showTransfer(false);
        } else {
          audio.activateTrack(trackId);
          onTrackReadyUI(name, formatTime(decoded.duration), decoded.duration);
          showTransfer(false);
          ui.listenerBannerText.textContent = 'Готово к воспроизведению';
        }
      }
      network.sendToHost({ type: 'TRACK_READY', trackId });
      renderPlaylist();
      if (isCurrentlyActive() && !isPlayingThis) tryApplyPendingPlay();
    } catch (err) {
      console.error('[App/Listener] Decode error:', err);
      if (isCurrentlyActive()) showTransfer(false);
      network.sendToHost({ type: 'TRACK_ERROR', trackId });
      if (isCurrentlyActive() && !startedWhileStreaming) showToast('Ошибка декодирования трека', 'error');
    }
  }

  function updatePlayerCoverAndPreview(track) {
    if (ui.trackCoverImg) {
      if (track?.coverUrl) {
        if (ui.trackCoverImg.src !== track.coverUrl) ui.trackCoverImg.src = track.coverUrl;
        ui.trackCoverImg.classList.remove('hidden');
      } else {
        ui.trackCoverImg.classList.add('hidden');
      }
    }
    if (ui.trackPreviewBadge) {
      ui.trackPreviewBadge.classList.toggle('hidden', !track?.isPreview);
    }
  }

  function onTrackReadyUI(title, subtitle, duration) {
    const activeMeta = state.playlist.find((t) => t.id === state.activeTrackId) || null;
    updatePlayerCoverAndPreview(activeMeta);
    ui.trackTitle.textContent = title;
    ui.trackSub.textContent = subtitle;
    ui.timeDuration.textContent = formatTime(duration);
    if (!audio.isPlaying) {
      ui.timeCurrent.textContent = '0:00';
      ui.seekSlider.value = '0';
    }
    ui.seekSlider.max = String(duration);

    if (state.role === 'host') {
      ui.seekSlider.disabled = false;
      ui.btnPlayPause.disabled = false;
      ui.btnPrevTrack.disabled = state.playlist.length === 0;
      ui.btnNextTrack.disabled = state.playlist.length === 0;
      ui.btnForceResync.disabled = false;
    }
  }

  function resetPlayerNoTrackUI() {
    updatePlayerCoverAndPreview(null);
    ui.trackTitle.textContent = 'Плейлист пуст';
    ui.trackSub.textContent = state.role === 'host' ? 'Добавьте треки ниже' : 'Ожидание треков...';
    ui.timeCurrent.textContent = '0:00';
    ui.timeDuration.textContent = '0:00';
    ui.seekSlider.value = '0';
    ui.seekSlider.disabled = true;
    ui.btnPlayPause.disabled = true;
    ui.btnPrevTrack.disabled = true;
    ui.btnNextTrack.disabled = true;
    ui.btnForceResync.disabled = true;
  }

  function renderPlaylist() {
    ui.playlistCount.textContent = String(state.playlist.length);
    if (state.role === 'host') {
      ui.btnPrevTrack.disabled = state.playlist.length === 0;
      ui.btnNextTrack.disabled = state.playlist.length === 0;
    }

    if (state.playlist.length === 0) {
      ui.playlistList.innerHTML =
        state.role === 'host'
          ? '<li class="peer-empty">Добавьте аудиофайлы или выберите тест-бит.</li>'
          : '<li class="peer-empty">Ожидание плейлиста...</li>';
      return;
    }

    const scope = state.role === 'host' ? getActiveTargetScope() : null;
    const focusTrackId = state.role === 'host' ? getTargetControlSnapshot().trackId : state.activeTrackId;

    ui.playlistList.innerHTML = state.playlist
      .map((t, idx) => {
        const isActive = t.id === focusTrackId;
        const cached = audio.hasCachedTrack(t.id);
        const streaming = !cached && audio.hasStreamOrCachedTrack(t.id);
        const color = window.FloorMapPanel ? window.FloorMapPanel.getTrackColor(t.id, state.playlist) : '#007aff';
        const badge =
          state.role === 'listener'
            ? cached
              ? '<span class="track-pill ready">Готово</span>'
              : streaming
              ? '<span class="track-pill">Поток</span>'
              : '<span class="track-pill">Ожидание</span>'
            : '';

        const controls =
          state.role === 'host'
            ? `<div class="playlist-actions">
                <button class="mini-btn" data-pl-up="${escapeHtml(t.id)}" title="Выше" ${idx === 0 ? 'disabled' : ''}>↑</button>
                <button class="mini-btn" data-pl-down="${escapeHtml(t.id)}" title="Ниже" ${idx === state.playlist.length - 1 ? 'disabled' : ''}>↓</button>
                <button class="mini-btn mini-btn-danger" data-pl-del="${escapeHtml(t.id)}" title="Удалить">✕</button>
              </div>`
            : '';

        const coverHtml = t.coverUrl
          ? `<img class="playlist-cover" src="${escapeHtml(t.coverUrl)}" alt="" loading="lazy" />`
          : '';
        const previewBadge = t.isPreview ? '<span class="track-pill">30с</span>' : '';

        return `
          <li class="playlist-item ${isActive ? 'active' : ''}" data-pl-select="${escapeHtml(t.id)}">
            <div class="playlist-item-main">
              <span class="playlist-color-dot" style="background:${color}"></span>
              ${coverHtml || `<span class="playlist-num mono">${isActive ? '▶' : idx + 1}</span>`}
              <div class="playlist-item-text">
                <div class="playlist-item-name">${escapeHtml(t.name)}</div>
                <div class="playlist-item-meta mono">${formatTime(t.duration)} ${previewBadge} ${badge}</div>
              </div>
            </div>
            ${controls}
          </li>`;
      })
      .join('');
    yandexPanel?.syncPlaybackState();
    void scope;
  }

  /* ==================== МНОГОЗОННОЕ УПРАВЛЕНИЕ И МГНОВЕННЫЙ СТАРТ ==================== */

  function getActiveTargetScope() {
    const sel = state.selectedDeviceIds;
    if (!sel || sel.size === 0) {
      return {
        isAll: true,
        includeHost: true,
        peerIds: state.peers.map((p) => p.id),
      };
    }
    const includeHost = sel.has(HOST_DEVICE_ID);
    const peerIds = state.peers.filter((p) => sel.has(p.id)).map((p) => p.id);
    // Если явно выбраны ВСЕ устройства (Хост + каждый слушатель) — считаем глобальной операцией,
    // чтобы сохранять playbackState/volumeState для новых Late Join слушателей!
    const allSelected = includeHost && peerIds.length === state.peers.length;
    return {
      isAll: allSelected,
      includeHost,
      peerIds,
    };
  }

  function getPeerAcousticPosition(peer) {
    const pb = peer?.playback;
    if (!pb) return 0;
    const track = state.playlist.find((t) => t.id === pb.trackId);
    const dur = track?.duration || 0;
    if (!pb.playing || !clock) return Math.max(0, pb.trackOffset || 0);
    const hostNow = clock.hostNow();
    if (hostNow < pb.hostStartTime) return Math.max(0, pb.trackOffset || 0);
    const pos = (pb.trackOffset || 0) + (hostNow - pb.hostStartTime) / 1000;
    return Math.max(0, dur > 0 ? Math.min(pos, dur) : pos);
  }

  function getTargetControlSnapshot() {
    const { isAll, includeHost, peerIds } = getActiveTargetScope();
    const targetPeers = state.peers.filter((p) => peerIds.includes(p.id));

    if (includeHost && (isAll || targetPeers.length === 0)) {
      const tid = state.activeTrackId || state.playlist[0]?.id || null;
      const track = state.playlist.find((t) => t.id === tid) || null;
      return {
        trackId: tid,
        track,
        duration: track?.duration || audio.getDuration() || 0,
        playing: audio.isPlaying,
        position: audio.hasPlayableAudio() ? audio.getAcousticPosition() : 0,
        volume: audio.volume,
        muted: audio.muted,
      };
    }

    // Берём ведущее устройство из выбранной группы (приоритет: играющий пир -> первый пир -> Хост)
    const leadPeer = targetPeers.find((p) => p.playback?.playing) || targetPeers[0] || null;
    if (leadPeer) {
      const tid = leadPeer.playback?.trackId || state.activeTrackId || state.playlist[0]?.id || null;
      const track = state.playlist.find((t) => t.id === tid) || null;
      const playing = Boolean(leadPeer.playback?.playing) || (includeHost && audio.isPlaying);
      const pos = leadPeer.playback?.trackId
        ? getPeerAcousticPosition(leadPeer)
        : includeHost
        ? audio.getAcousticPosition()
        : 0;
      const volState = leadPeer.volumeState || { volume: audio.volume, muted: audio.muted };
      return {
        trackId: tid,
        track,
        duration: track?.duration || 0,
        playing,
        position: pos,
        volume: volState.volume,
        muted: volState.muted,
      };
    }

    const tid = state.activeTrackId || state.playlist[0]?.id || null;
    const track = state.playlist.find((t) => t.id === tid) || null;
    return {
      trackId: tid,
      track,
      duration: track?.duration || 0,
      playing: audio.isPlaying,
      position: audio.getAcousticPosition(),
      volume: audio.volume,
      muted: audio.muted,
    };
  }

  function refreshHostPlayerForSelection() {
    if (state.role !== 'host') return;
    const { isAll, includeHost, peerIds } = getActiveTargetScope();
    const totalCount = (includeHost ? 1 : 0) + peerIds.length;
    const snap = getTargetControlSnapshot();

    // Обновляем верхний баннер выбранной зоны
    ui.zoneTargetBar.classList.toggle('is-subset', !isAll);
    ui.btnZoneResetAll.classList.toggle('hidden', isAll);
    ui.btnMapClearSel.classList.toggle('hidden', isAll);
    ui.btnToggleHostTarget.classList.toggle('active', includeHost);

    const targetColor = window.FloorMapPanel
      ? window.FloorMapPanel.getTrackColor(snap.trackId, state.playlist)
      : '#007aff';
    ui.zoneTargetDot.style.background = targetColor;

    if (isAll) {
      ui.zoneTargetText.textContent = `Все устройства (${state.peers.length + 1})`;
    } else {
      const floors = new Set();
      for (const pid of peerIds) {
        const p = state.peers.find((x) => x.id === pid);
        if (p?.location) floors.add(p.location.floor);
      }
      if (includeHost && state.localLocation) floors.add(state.localLocation.floor);
      const flList = Array.from(floors).sort((a, b) => a - b);
      const flTxt = flList.length > 0 ? ` · этажи ${flList.join(', ')}` : '';
      ui.zoneTargetText.textContent = `Выбрано: ${totalCount} устр.${flTxt}`;
    }

    if (snap.track) {
      updatePlayerCoverAndPreview(snap.track);
      const sub =
        snap.track.type === 'file' && snap.track.size
          ? `${formatTime(snap.duration)} • ${(snap.track.size / 1024 / 1024).toFixed(1)} МБ`
          : formatTime(snap.duration);
      ui.trackTitle.textContent = snap.track.name;
      ui.trackSub.textContent = sub;
      ui.timeDuration.textContent = formatTime(snap.duration);
      ui.seekSlider.max = String(snap.duration || 100);
      if (!state.isSeeking) {
        ui.seekSlider.value = String(snap.position || 0);
        ui.timeCurrent.textContent = formatTime(snap.position || 0);
      }
      ui.seekSlider.disabled = false;
      ui.btnPlayPause.disabled = false;
      ui.btnPrevTrack.disabled = state.playlist.length === 0;
      ui.btnNextTrack.disabled = state.playlist.length === 0;
      ui.btnForceResync.disabled = false;
    } else if (state.playlist.length === 0) {
      resetPlayerNoTrackUI();
    }

    updatePlaybackUI(snap.playing);
    yandexPanel?.syncPlaybackState();
  }

  function pruneStaleSelection() {
    if (state.selectedDeviceIds.size === 0) return;
    const valid = new Set(state.peers.map((p) => p.id));
    valid.add(HOST_DEVICE_ID);
    let changed = false;
    for (const id of Array.from(state.selectedDeviceIds)) {
      if (!valid.has(id)) {
        state.selectedDeviceIds.delete(id);
        changed = true;
      }
    }
    if (changed && floorMap) {
      floorMap.setSelectedIds(state.selectedDeviceIds);
    }
  }

  function setSelection(nextSet) {
    state.selectedDeviceIds = new Set(nextSet);
    if (floorMap) floorMap.setSelectedIds(state.selectedDeviceIds);
    renderPeerList(state.peers);
    renderPlaylist();
    refreshHostPlayerForSelection();
  }

  function buildMapDevicesList() {
    const list = [];
    // Сам Хост (виден на карте, если у Хоста есть Wi-Fi позиция, иначе в списке вне карты)
    const hostTrack = state.playlist.find((t) => t.id === state.activeTrackId);
    list.push({
      id: HOST_DEVICE_ID,
      label: `Хост (${network.deviceName})`,
      isHost: true,
      location: state.localLocation,
      trackId: state.activeTrackId,
      trackName: hostTrack?.name || '',
      playing: audio.isPlaying,
      isBluetooth: audio.isBluetoothDetected,
      latencyMs: audio.getTotalOutputLatencyMs(),
    });
    for (const p of state.peers) {
      const tid = p.playback?.trackId || state.activeTrackId;
      const tr = state.playlist.find((t) => t.id === tid);
      list.push({
        id: p.id,
        label: p.label,
        isHost: false,
        location: p.location || null,
        trackId: tid,
        trackName: tr?.name || '',
        playing: Boolean(p.playback?.playing),
        isBluetooth: p.isBluetooth,
        latencyMs: p.latencyMs,
      });
    }
    return list;
  }

  function ensureFloorMapInitialized() {
    if (!window.FloorMapPanel || !ui.hostMapSection) return;
    if (!floorMap) {
      floorMap = new window.FloorMapPanel({
        rootEl: ui.hostMapSection,
        gridEl: ui.mapFloorGrid,
        floorPillsEl: ui.mapFloorPills,
        zonesLegendEl: ui.mapZonesLegend,
        unlocatedWrapEl: ui.mapUnlocatedWrap,
        unlocatedListEl: ui.mapUnlocatedList,
        marqueeEl: ui.mapMarqueeBox,
        siteButtons: Array.from(ui.hostMapSection.querySelectorAll('[data-site]')),
        onSelectionChange: (ids) => {
          state.selectedDeviceIds = new Set(ids);
          renderPeerList(state.peers);
          renderPlaylist();
          refreshHostPlayerForSelection();
        },
      });
      floorMap.init().then(() => syncFloorMapData()).catch((err) => {
        console.warn('[FloorMap] init error:', err);
      });
    } else {
      syncFloorMapData();
    }
  }

  let _lastMapDataSig = '';
  function syncFloorMapData(force = false) {
    if (!floorMap || state.role !== 'host') return;
    const devs = buildMapDevicesList();
    const selKey = Array.from(state.selectedDeviceIds).sort().join(',');
    const sig = `${selKey}|${state.playlist.map((t) => t.id).join(',')}|${devs
      .map((d) => `${d.id}:${d.trackId || ''}:${d.playing ? 1 : 0}:${d.location ? `${d.location.site}:${d.location.floor}:${d.location.lx}:${d.location.ly}` : ''}`)
      .join(';')}`;
    if (!force && sig === _lastMapDataSig) return;
    _lastMapDataSig = sig;
    floorMap.setData({
      devices: devs,
      playlist: state.playlist,
      selectedIds: state.selectedDeviceIds,
    });
  }

  function getEffectiveStartBufferMs(peerIds = null, includeHost = true) {
    // Без лишней 2-секундной задержки!
    // Берём ровно столько запаса, сколько физически нужно самому медленному Bluetooth/RTT устройству в целевой группе.
    const stats = network.getTargetLatencyStats(peerIds, includeHost);
    if (stats.count <= 1 && includeHost) {
      // Только Хост — практически мгновенный старт (~60 мс)
      return Math.max(45, audio.getTotalOutputLatencyMs() + 35);
    }
    const netMargin = Math.min(280, Math.max(95, Math.round(stats.maxRttMs * 1.6 + 65)));
    return Math.max(130, stats.maxLatencyMs + netMargin);
  }

  async function hostSchedulePlay(trackOffset = null, explicitTrackId = null) {
    if (!clock || state.playlist.length === 0) return;

    const { isAll, includeHost, peerIds } = getActiveTargetScope();
    const snap = getTargetControlSnapshot();
    const targetTrackId = explicitTrackId || snap.trackId || state.playlist[0]?.id;
    const track = state.playlist.find((t) => t.id === targetTrackId);
    if (!track) return;

    const decoded = await ensureHostDecodedTrack(track);
    if (!decoded) return;

    const dur = decoded.duration || track.duration || 0;
    const rawOffset = trackOffset !== null ? trackOffset : snap.position;
    const clampedOffset = Math.max(0, dur > 0 ? Math.min(rawOffset, Math.max(0, dur - 0.1)) : rawOffset);

    const bufferMs = getEffectiveStartBufferMs(isAll ? null : peerIds, includeHost);
    const hostStartTime = clock.hostNow() + bufferMs;

    if (includeHost) {
      if (audio.currentTrackId !== targetTrackId) {
        audio.activateTrack(targetTrackId);
      }
      state.activeTrackId = targetTrackId;
      state.hostPlayback = {
        trackId: targetTrackId,
        playing: true,
        hostStartTime,
        trackOffset: clampedOffset,
      };
      audio.schedulePlay({
        hostStartTime,
        trackOffset: clampedOffset,
        getHostTime: () => clock.hostNow(),
      });
    }

    if (isAll) {
      network.broadcastPlay({
        hostStartTime,
        trackOffset: clampedOffset,
        trackId: targetTrackId,
        targetIds: null,
      });
    } else if (peerIds.length > 0) {
      network.broadcastPlay({
        hostStartTime,
        trackOffset: clampedOffset,
        trackId: targetTrackId,
        targetIds: peerIds,
      });
    }

    ensureRenderLoopRunning();
    refreshHostPlayerForSelection();
    syncFloorMapData();
  }

  function hostPause() {
    const { isAll, includeHost, peerIds } = getActiveTargetScope();
    const snap = getTargetControlSnapshot();
    const pos = snap.position;

    if (includeHost) {
      const hostPos = audio.getAcousticPosition();
      audio.pause(hostPos);
      state.hostPlayback.playing = false;
      state.hostPlayback.trackOffset = hostPos;
    }

    if (isAll) {
      network.broadcastPause({ trackOffset: pos, targetIds: null });
    } else if (peerIds.length > 0) {
      network.broadcastPause({ trackOffset: pos, targetIds: peerIds });
    }

    ensureRenderLoopRunning();
    refreshHostPlayerForSelection();
    syncFloorMapData();
  }

  function handleListenerPlayCmd(cmd) {
    if (cmd.trackId && cmd.trackId !== state.activeTrackId && audio.hasCachedTrack(cmd.trackId)) {
      const decoded = audio.activateTrack(cmd.trackId);
      const meta = state.playlist.find((t) => t.id === cmd.trackId);
      if (decoded && meta) {
        state.activeTrackId = cmd.trackId;
        onTrackReadyUI(meta.name, formatTime(decoded.duration), decoded.duration);
        renderPlaylist();
      }
    }

    // Если уже играем ровно этот же трек по тому же расписанию (например, уже стартанули со STREAM_READY,
    // а потом пришёл повторный CMD_PLAY при 100% кэше) — не перезапускаем лишний раз!
    if (
      audio.isPlaying &&
      state.activeTrackId === cmd.trackId &&
      Math.abs(audio.hostStartTime - cmd.hostStartTime) < 15
    ) {
      return;
    }

    const minSamples = network.hostTransport === 'relay' ? 1 : 2;
    const clockReady = clock && clock.synced && (clock.samples.length >= minSamples || !cmd.isLateJoin);

    if (!audio.hasPlayableAudio() || state.activeTrackId !== cmd.trackId || !clockReady) {
      clearPendingPlay();
      state.pendingPlayCmd = cmd;
      if (cmd.isLateJoin) {
        state.pendingPlayTimer = setTimeout(() => {
          if (state.pendingPlayCmd && audio.hasPlayableAudio() && state.activeTrackId === state.pendingPlayCmd.trackId && clock && clock.synced) {
            const c = state.pendingPlayCmd;
            clearPendingPlay();
            executeScheduledPlay(c);
          }
        }, 700);
      }
      return;
    }

    clearPendingPlay();
    executeScheduledPlay(cmd);
  }

  function tryApplyPendingPlay() {
    if (!state.pendingPlayCmd || !clock || !clock.synced || state.activeTrackId !== state.pendingPlayCmd.trackId) {
      return;
    }
    const minSamples = network.hostTransport === 'relay' ? 1 : 2;
    if (state.pendingPlayCmd.isLateJoin && clock.samples.length < minSamples) {
      return;
    }
    const cmd = state.pendingPlayCmd;
    clearPendingPlay();
    executeScheduledPlay(cmd);
  }

  function executeScheduledPlay(cmd) {
    audio.measureSystemLatency(false);
    sendLocalLatencyToHost();
    audio.schedulePlay({
      hostStartTime: cmd.hostStartTime,
      trackOffset: cmd.trackOffset,
      getHostTime: () => clock.hostNow(),
    });
    ensureRenderLoopRunning();
    ui.listenerBannerText.textContent = 'Синхронное воспроизведение';
  }

  function updatePlaybackUI(isPlaying) {
    ui.iconPlay.classList.toggle('hidden', isPlaying);
    ui.iconPause.classList.toggle('hidden', !isPlaying);
    ui.playPauseLabel.textContent = isPlaying ? 'Пауза' : 'Воспроизвести';
    ui.listenerPulse.classList.toggle('playing', isPlaying);
    if (!isPlaying) {
      ui.countdownBadge.classList.add('hidden');
    }
  }

  /* ==================== СПИСОК УСТРОЙСТВ (KEYED DOM PATCHING) ==================== */

  function renderPeerList(peers) {
    ui.peerCount.textContent = String(peers.length);

    if (peers.length === 0) {
      ui.peersOverallProgress.textContent = 'Ожидание';
      if (!ui.peerList.querySelector('.peer-empty')) {
        ui.peerList.innerHTML =
          '<li class="peer-empty">Пока никто не подключился. Покажите QR-код или отправьте ссылку.</li>';
      }
      return;
    }

    const readyCount = peers.filter((p) => p.ready).length;
    const avgPct = Math.round(peers.reduce((acc, p) => acc + (p.progress || 0), 0) / peers.length);
    const overallText =
      readyCount === peers.length
        ? `Готовы все (${readyCount}/${peers.length})`
        : `Кэш ${avgPct}% (${readyCount}/${peers.length})`;
    if (ui.peersOverallProgress.textContent !== overallText) {
      ui.peersOverallProgress.textContent = overallText;
    }

    const existingEmpty = ui.peerList.querySelector('.peer-empty');
    if (existingEmpty) existingEmpty.remove();

    const existingMap = new Map();
    for (const child of Array.from(ui.peerList.children)) {
      const id = child.dataset?.peerSelect;
      if (id) existingMap.set(id, child);
      else child.remove();
    }

    const seen = new Set();
    for (let i = 0; i < peers.length; i++) {
      const p = peers[i];
      seen.add(p.id);
      const pct = Math.max(0, Math.min(100, Math.round(p.progress || 0)));
      const dotCls = p.phase === 'error' ? 'error' : p.ready || p.streaming ? 'ready' : '';
      const isSel = state.selectedDeviceIds.has(p.id);

      const assignedTrack = state.playlist.find((t) => t.id === (p.playback?.trackId || state.activeTrackId));
      const zoneColor = window.FloorMapPanel
        ? window.FloorMapPanel.getTrackColor(assignedTrack?.id, state.playlist)
        : '#007aff';
      const chipsSig = `${p.label}|${p.transportLabel || ''}|${p.isBluetooth ? p.latencyMs : ''}|${p.location ? `${p.location.siteName}:${p.location.floor}:${p.location.room || ''}` : ''}|${assignedTrack?.id || ''}:${p.playback?.playing ? 1 : 0}:${zoneColor}`;

      let li = existingMap.get(p.id);
      if (!li) {
        li = document.createElement('li');
        li.className = 'peer-item';
        li.dataset.peerSelect = p.id;
        li.innerHTML = `
          <div class="peer-top">
            <div class="peer-main">
              <span class="peer-status-dot"></span>
              <div class="peer-title-row"></div>
            </div>
            <div class="peer-right mono">
              <span class="peer-rtt">—</span>
              <span class="peer-pct">0%</span>
            </div>
          </div>
          <div class="peer-progress-row">
            <div class="peer-progress-track">
              <div class="peer-progress-fill" style="width: 0%"></div>
            </div>
            <span class="peer-status-label"></span>
          </div>`;
        ui.peerList.appendChild(li);
      }

      li.classList.toggle('selected', isSel);

      const dotEl = li.querySelector('.peer-status-dot');
      const wantDotClass = dotCls ? `peer-status-dot ${dotCls}` : 'peer-status-dot';
      if (dotEl.className !== wantDotClass) dotEl.className = wantDotClass;

      if (li.dataset.chipsSig !== chipsSig) {
        li.dataset.chipsSig = chipsSig;
        const btChip = p.isBluetooth ? `<span class="peer-chip peer-chip-bt">BT ${p.latencyMs} мс</span>` : '';
        const netChip = p.transportLabel ? `<span class="peer-chip">${escapeHtml(p.transportLabel)}</span>` : '';
        const locChip = p.location
          ? `<span class="peer-chip peer-chip-loc">${escapeHtml(p.location.siteName)} · ${p.location.floor} эт.${p.location.room ? ` (${escapeHtml(p.location.room)})` : ''}</span>`
          : '';
        const zoneChip = assignedTrack
          ? `<span class="peer-chip peer-chip-zone" style="border-left: 3px solid ${zoneColor}">${p.playback?.playing ? '▶ ' : '⏸ '}${escapeHtml(assignedTrack.name)}</span>`
          : '';
        li.querySelector('.peer-title-row').innerHTML = `<strong>${escapeHtml(p.label)}</strong>${netChip}${btChip}${locChip}${zoneChip}`;
      }

      const rttText = p.rttMs !== null ? `${p.rttMs} мс` : '—';
      const rttEl = li.querySelector('.peer-rtt');
      if (rttEl.textContent !== rttText) rttEl.textContent = rttText;

      const pctText = `${pct}%`;
      const pctEl = li.querySelector('.peer-pct');
      if (pctEl.textContent !== pctText) pctEl.textContent = pctText;
      pctEl.classList.toggle('ready', Boolean(p.ready));

      const fillEl = li.querySelector('.peer-progress-fill');
      const pctWidth = `${pct}%`;
      if (fillEl.style.width !== pctWidth) fillEl.style.width = pctWidth;
      fillEl.classList.toggle('ready', Boolean(p.ready));

      const statusEl = li.querySelector('.peer-status-label');
      const statusText = String(p.status || '');
      if (statusEl.textContent !== statusText) statusEl.textContent = statusText;

      if (ui.peerList.children[i] !== li) {
        ui.peerList.insertBefore(li, ui.peerList.children[i] || null);
      }
    }

    for (const [id, node] of existingMap.entries()) {
      if (!seen.has(id)) node.remove();
    }
  }

  /* ==================== ВИЗУАЛИЗАТОР (DPR + DEMAND-DRIVEN LOOP) ==================== */

  const freqBins = new Uint8Array(64);
  let _vizCssW = 600;
  let _vizCssH = 74;
  let _lastSliderVal = -1;
  let _lastCountdownText = '';
  let _lastCountdownVisible = false;

  function syncVisualizerSize() {
    const canvas = ui.visualizerCanvas;
    if (!canvas) return;
    const rect = canvas.parentElement?.getBoundingClientRect();
    const w = Math.max(120, Math.round(rect?.width || 600));
    const h = Math.max(48, Math.round(rect?.height || 74));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    _vizCssW = w;
    _vizCssH = h;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
  }

  function drawVisualizerFrame(forceIdle = false) {
    const canvas = ui.visualizerCanvas;
    if (!canvas) return;
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;

    const dpr = canvas.width / Math.max(1, _vizCssW);
    const w = _vizCssW;
    const h = _vizCssH;
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2d.clearRect(0, 0, w, h);

    const isDark = darkThemeQuery.matches;
    const hasAudio = !forceIdle && audio.isPlaying && audio.getFrequencyData(freqBins);
    const barCount = Math.max(24, Math.min(44, Math.floor(w / 11)));
    const gap = 4;
    const barWidth = Math.max(3, (w - gap * (barCount - 1)) / barCount);

    ctx2d.fillStyle = hasAudio
      ? isDark
        ? '#0a84ff'
        : '#007aff'
      : isDark
      ? 'rgba(255, 255, 255, 0.14)'
      : 'rgba(0, 0, 0, 0.12)';

    for (let i = 0; i < barCount; i++) {
      const binIdx = Math.min(freqBins.length - 1, Math.floor((i * 42) / barCount));
      const val = hasAudio ? freqBins[binIdx] / 255 : 0.08;
      const barH = Math.max(4, val * (h - 14));
      const x = i * (barWidth + gap);
      const y = (h - barH) / 2;

      ctx2d.beginPath();
      if (typeof ctx2d.roundRect === 'function') {
        ctx2d.roundRect(x, y, barWidth, barH, 3);
      } else {
        ctx2d.rect(x, y, barWidth, barH);
      }
      ctx2d.fill();
    }
  }

  function drawVisualizerIdleOnce() {
    syncVisualizerSize();
    drawVisualizerFrame(true);
  }

  if (typeof ResizeObserver !== 'undefined' && ui.visualizerCanvas?.parentElement) {
    const vizRo = new ResizeObserver(() => {
      syncVisualizerSize();
      drawVisualizerFrame(!audio.isPlaying);
    });
    vizRo.observe(ui.visualizerCanvas.parentElement);
  }
  if (darkThemeQuery.addEventListener) {
    darkThemeQuery.addEventListener('change', () => drawVisualizerFrame(!audio.isPlaying));
  }

  function needsActiveRenderLoop() {
    if (!state.role || document.visibilityState === 'hidden') return false;
    if (audio.isPlaying || audio.isScheduled) return true;
    if (state.role === 'host' && state.peers.some((p) => p.playback?.playing)) return true;
    return false;
  }

  function ensureRenderLoopRunning() {
    if (state.rafId) return;
    if (!needsActiveRenderLoop()) {
      drawVisualizerIdleOnce();
      return;
    }

    const tick = () => {
      state.rafId = null;

      const countdown = audio.getCountdownSec();
      const showCd = countdown > 0.35;
      if (showCd !== _lastCountdownVisible) {
        _lastCountdownVisible = showCd;
        ui.countdownBadge.classList.toggle('hidden', !showCd);
      }
      if (showCd) {
        const cdTxt = `${countdown.toFixed(1)}с`;
        if (_lastCountdownText !== cdTxt) {
          _lastCountdownText = cdTxt;
          ui.countdownBadge.textContent = cdTxt;
          if (state.role === 'listener') {
            ui.listenerBannerText.textContent = `Старт через ${countdown.toFixed(1)} с`;
          }
        }
      } else if (state.role === 'listener' && audio.isPlaying) {
        const wantBanner = audio.playingFromSegment
          ? 'Воспроизведение (кэширование...)'
          : 'Синхронное воспроизведение';
        if (ui.listenerBannerText.textContent !== wantBanner) {
          ui.listenerBannerText.textContent = wantBanner;
        }
      }

      if (!state.isSeeking) {
        let pos = null;
        if (state.role === 'host') {
          const snap = getTargetControlSnapshot();
          if (snap.track) pos = snap.position;
        } else if (audio.hasPlayableAudio()) {
          pos = audio.getAcousticPosition();
        }
        if (pos !== null) {
          const tStr = formatTime(pos);
          if (ui.timeCurrent.textContent !== tStr) ui.timeCurrent.textContent = tStr;
          if (Math.abs(pos - _lastSliderVal) >= 0.08) {
            _lastSliderVal = pos;
            ui.seekSlider.value = String(pos);
          }
        }
      }

      drawVisualizerFrame(false);

      if (needsActiveRenderLoop()) {
        state.rafId = requestAnimationFrame(tick);
      } else {
        drawVisualizerFrame(true);
      }
    };

    state.rafId = requestAnimationFrame(tick);
  }

  function leaveRoom() {
    clearPendingPlay();
    if (state.role === 'host') {
      clearHostSession();
    }
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    state.reconnectAttempts = 0;
    if (state.rafId) {
      cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
    if (clock) {
      clock.stop();
      clock = null;
    }
    audio.stopInternal();
    audio.buffer = null;
    audio.currentTrackId = null;
    audio.currentTrackDuration = 0;
    network.destroy(true);
    wakeLock.release();

    state.role = null;
    state.roomCode = null;
    state.playlist = [];
    state.activeTrackId = null;
    state.peers = [];
    state.selectedDeviceIds.clear();
    state.hostPlayback = { trackId: null, playing: false, hostStartTime: 0, trackOffset: 0 };
    state.roomLatency = { roomMaxLatencyMs: 0, slowestLabel: 'Хост', bluetoothCount: 0, deviceCount: 1 };
    if (ui.appShell) ui.appShell.classList.remove('is-host-room');

    resetPlayerNoTrackUI();
    showTransfer(false);
    renderPeerList([]);
    renderPlaylist();

    window.history.replaceState({}, '', window.location.pathname);
    showView('landing');
  }

  /* ==================== ОБРАБОТЧИКИ СОБЫТИЙ ==================== */

  ui.btnCreateRoom.addEventListener('click', enterAsHost);

  ui.joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    enterAsListener(ui.inputRoomCode.value);
  });

  ui.btnUnlockAndJoin.addEventListener('click', () => {
    enterAsListener(ui.inviteRoomCode.dataset.code || '');
  });

  ui.btnCancelInvite.addEventListener('click', () => {
    window.history.replaceState({}, '', window.location.pathname);
    showView('landing');
  });

  ui.btnLeaveRoom.addEventListener('click', () => {
    if (state.role === 'host' && state.peers.length > 0) {
      const ok = window.confirm(
        `Закрыть комнату и отключить ${state.peers.length} подключённ${state.peers.length === 1 ? 'ое устройство' : 'ых устройств'}?`
      );
      if (!ok) return;
    }
    leaveRoom();
  });
  ui.btnHome.addEventListener('click', () => {
    if (state.role) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  });

  // Десктопные горячие клавиши (Space, ←/→, M, Escape)
  window.addEventListener('keydown', (e) => {
    if (!state.role) return;
    const tag = (e.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) return;

    if (e.code === 'Escape') {
      if (!ui.qrPanel.classList.contains('hidden')) {
        ui.qrPanel.classList.add('hidden');
        return;
      }
      if (yandexPanel?.deviceAuth) {
        yandexPanel.stopDeviceAuth();
        return;
      }
      if (state.role === 'host' && state.selectedDeviceIds.size > 0) {
        setSelection(new Set());
      }
      return;
    }

    if (e.code === 'KeyM' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      ui.btnMute.click();
      return;
    }

    if (state.role !== 'host' || state.playlist.length === 0) return;

    if (e.code === 'Space') {
      e.preventDefault();
      ui.btnPlayPause.click();
    } else if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
      e.preventDefault();
      const snap = getTargetControlSnapshot();
      const delta = e.code === 'ArrowRight' ? 5 : -5;
      const dur = snap.duration || 0;
      const nextPos = Math.max(0, dur > 0 ? Math.min(dur - 0.1, snap.position + delta) : snap.position + delta);
      if (snap.playing) {
        hostSchedulePlay(nextPos, snap.trackId);
      } else {
        const { isAll, includeHost, peerIds } = getActiveTargetScope();
        if (includeHost) {
          audio.pause(nextPos);
          state.hostPlayback.playing = false;
          state.hostPlayback.trackOffset = nextPos;
        }
        if (isAll) network.broadcastPause({ trackOffset: nextPos, targetIds: null });
        else if (peerIds.length > 0) network.broadcastPause({ trackOffset: nextPos, targetIds: peerIds });
        refreshHostPlayerForSelection();
      }
    }
  });

  ui.hostNavBar?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-host-view]');
    if (btn) setHostTab(btn.dataset.hostView);
  });

  ui.btnToggleQR.addEventListener('click', () => {
    ui.qrPanel.classList.toggle('hidden');
  });

  const copyShareLink = async () => {
    const url = buildShareUrl(state.roomCode);
    try {
      await navigator.clipboard.writeText(url);
      showToast('Ссылка скопирована', 'success');
    } catch (_) {
      ui.shareLinkInput.select();
      document.execCommand('copy');
      showToast('Ссылка скопирована', 'success');
    }
  };

  ui.btnCopyCode.addEventListener('click', copyShareLink);

  ui.btnShareLink.addEventListener('click', async () => {
    const url = buildShareUrl(state.roomCode);
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Orpheus Sync',
          text: `Комната ${NetworkManager.formatCode(state.roomCode)}`,
          url,
        });
        return;
      } catch (_) {}
    }
    copyShareLink();
  });

  ui.audioFileInput.addEventListener('change', (e) => {
    if (e.target.files?.length) hostAddFiles(e.target.files);
    e.target.value = '';
  });

  ui.fileDropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    ui.fileDropzone.classList.add('dragover');
  });
  ui.fileDropzone.addEventListener('dragleave', () => {
    ui.fileDropzone.classList.remove('dragover');
  });
  ui.fileDropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    ui.fileDropzone.classList.remove('dragover');
    if (e.dataTransfer?.files?.length) hostAddFiles(e.dataTransfer.files);
  });

  ui.btnLoadDemoTrack.addEventListener('click', () => hostAddSynthTrack('demo'));
  ui.btnLoadPulseTrack.addEventListener('click', () => hostAddSynthTrack('pulse'));

  ui.btnToggleUrlInput.addEventListener('click', () => {
    ui.urlTrackForm.classList.toggle('hidden');
  });

  ui.urlTrackForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = ui.inputAudioUrl.value.trim();
    if (url) hostAddUrlTrack(url);
  });

  ui.chkLoopPlaylist.addEventListener('change', () => {
    state.loopPlaylist = ui.chkLoopPlaylist.checked;
  });

  ui.playlistList.addEventListener('click', (e) => {
    if (state.role !== 'host') return;
    const upBtn = e.target.closest('[data-pl-up]');
    if (upBtn) {
      e.stopPropagation();
      hostMoveTrack(upBtn.dataset.plUp, -1);
      return;
    }
    const downBtn = e.target.closest('[data-pl-down]');
    if (downBtn) {
      e.stopPropagation();
      hostMoveTrack(downBtn.dataset.plDown, 1);
      return;
    }
    const delBtn = e.target.closest('[data-pl-del]');
    if (delBtn) {
      e.stopPropagation();
      hostRemoveTrack(delBtn.dataset.plDel);
      return;
    }
    const item = e.target.closest('[data-pl-select]');
    if (item) {
      const id = item.dataset.plSelect;
      const snap = getTargetControlSnapshot();
      if (id === snap.trackId) {
        if (snap.playing) hostPause();
        else hostSchedulePlay(snap.position, id);
      } else {
        hostSelectTrack(id, snap.playing);
      }
    }
  });

  ui.btnPlayPause.addEventListener('click', () => {
    if (state.playlist.length === 0) return;
    const snap = getTargetControlSnapshot();
    if (snap.playing) hostPause();
    else hostSchedulePlay(snap.position, snap.trackId);
  });

  ui.btnPrevTrack.addEventListener('click', () => {
    if (state.playlist.length === 0) return;
    const snap = getTargetControlSnapshot();
    if (snap.position > 3 || state.playlist.length <= 1) {
      if (snap.playing) hostSchedulePlay(0, snap.trackId);
      else {
        const { isAll, includeHost, peerIds } = getActiveTargetScope();
        if (includeHost) {
          audio.pause(0);
          state.hostPlayback.playing = false;
          state.hostPlayback.trackOffset = 0;
        }
        if (isAll) network.broadcastPause({ trackOffset: 0, targetIds: null });
        else if (peerIds.length > 0) network.broadcastPause({ trackOffset: 0, targetIds: peerIds });
        refreshHostPlayerForSelection();
      }
    } else {
      const idx = state.playlist.findIndex((t) => t.id === snap.trackId);
      const nextIdx = idx <= 0 ? state.playlist.length - 1 : idx - 1;
      hostSelectTrack(state.playlist[nextIdx].id, snap.playing);
    }
  });

  ui.btnNextTrack.addEventListener('click', () => {
    if (state.playlist.length > 1) {
      const snap = getTargetControlSnapshot();
      const idx = state.playlist.findIndex((t) => t.id === snap.trackId);
      const nextIdx = idx < 0 || idx >= state.playlist.length - 1 ? 0 : idx + 1;
      hostSelectTrack(state.playlist[nextIdx].id, snap.playing);
    }
  });

  ui.btnForceResync.addEventListener('click', () => {
    if (state.playlist.length === 0) return;
    const snap = getTargetControlSnapshot();
    if (snap.playing) {
      hostSchedulePlay(snap.position, snap.trackId);
      showToast('Синхронизация обновлена', 'success');
    } else {
      showToast('Сначала нажмите «Воспроизвести»');
    }
  });

  ui.seekSlider.addEventListener('input', () => {
    state.isSeeking = true;
    ui.timeCurrent.textContent = formatTime(Number(ui.seekSlider.value));
  });

  ui.seekSlider.addEventListener('change', () => {
    state.isSeeking = false;
    const targetSec = Number(ui.seekSlider.value);
    if (state.role !== 'host' || state.playlist.length === 0) return;
    const snap = getTargetControlSnapshot();

    if (snap.playing) {
      hostSchedulePlay(targetSec, snap.trackId);
    } else {
      const { isAll, includeHost, peerIds } = getActiveTargetScope();
      if (includeHost) {
        audio.pause(targetSec);
        state.hostPlayback.playing = false;
        state.hostPlayback.trackOffset = targetSec;
      }
      if (isAll) network.broadcastPause({ trackOffset: targetSec, targetIds: null });
      else if (peerIds.length > 0) network.broadcastPause({ trackOffset: targetSec, targetIds: peerIds });
      refreshHostPlayerForSelection();
    }
  });

  // Клик по карточке устройства в списке синхронизируется с выделением на карте
  ui.peerList.addEventListener('click', (e) => {
    if (state.role !== 'host') return;
    const row = e.target.closest('[data-peer-select]');
    if (!row) return;
    const id = row.dataset.peerSelect;
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const next = additive ? new Set(state.selectedDeviceIds) : new Set();
    if (additive && next.has(id)) next.delete(id);
    else if (!additive && state.selectedDeviceIds.size === 1 && state.selectedDeviceIds.has(id)) next.clear();
    else next.add(id);
    setSelection(next);
  });

  ui.btnMapSelectAll?.addEventListener('click', () => {
    const allIds = new Set([HOST_DEVICE_ID, ...state.peers.map((p) => p.id)]);
    setSelection(allIds);
  });

  ui.btnMapClearSel?.addEventListener('click', () => setSelection(new Set()));
  ui.btnZoneResetAll?.addEventListener('click', () => setSelection(new Set()));

  ui.btnToggleHostTarget?.addEventListener('click', () => {
    const { isAll } = getActiveTargetScope();
    const next = isAll
      ? new Set(state.peers.map((p) => p.id)) // был режим «Все» -> исключаем Хост, оставляем слушателей
      : new Set(state.selectedDeviceIds);
    if (!isAll) {
      if (next.has(HOST_DEVICE_ID)) next.delete(HOST_DEVICE_ID);
      else next.add(HOST_DEVICE_ID);
    }
    setSelection(next);
  });

  /* ==================== НАТИВНЫЙ ANDROID WI-FI BRIDGE ==================== */

  function isNativeAndroidApp() {
    return Boolean(window.OrpheusNative && typeof window.OrpheusNative.requestWifiScan === 'function');
  }

  function updateListenerLocationUI() {
    if (state.role !== 'listener') return;
    const isAndroid = /Android/i.test(navigator.userAgent || '');
    const isNative = isNativeAndroidApp();
    const loc = state.localLocation;

    if (loc) {
      ui.listenerLocationRow.classList.remove('hidden');
      const roomTxt = loc.room ? ` · ${loc.room}` : '';
      ui.listenerLocationText.textContent = `Wi-Fi: ${loc.siteName}, ${loc.floor} эт.${roomTxt}`;
      ui.listenerLocationText.classList.add('located');
      ui.listenerApkLink.classList.add('hidden');
    } else if (isNative) {
      ui.listenerLocationRow.classList.remove('hidden');
      ui.listenerLocationText.textContent = 'Wi-Fi позиция: поиск сетей здания...';
      ui.listenerLocationText.classList.remove('located');
      ui.listenerApkLink.classList.add('hidden');
    } else if (isAndroid) {
      ui.listenerLocationRow.classList.remove('hidden');
      ui.listenerLocationText.textContent = 'Браузер не даёт BSSID Wi-Fi';
      ui.listenerLocationText.classList.remove('located');
      ui.listenerApkLink.classList.remove('hidden');
    } else {
      ui.listenerLocationRow.classList.add('hidden');
    }
  }

  function handleNativeWifiScan(aps) {
    if (!aps || !state.role) return;
    const now = Date.now();
    if (now - state.lastWifiScanSentAt < 900) return;
    state.lastWifiScanSentAt = now;
    network.sendWifiScan(aps);
  }

  function requestNativeWifiScanIfAvailable() {
    if (!isNativeAndroidApp()) return;
    try {
      const cached = window.OrpheusNative.getLastWifiScan && window.OrpheusNative.getLastWifiScan();
      if (cached) {
        const parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;
        if (Array.isArray(parsed) && parsed.length > 0) handleNativeWifiScan(parsed);
      }
      window.OrpheusNative.requestWifiScan();
    } catch (_) {}
  }

  window.__orpheusOnNativeWifiScan = (apsOrJson) => {
    try {
      const aps = typeof apsOrJson === 'string' ? JSON.parse(apsOrJson) : apsOrJson;
      if (Array.isArray(aps) && aps.length > 0) {
        handleNativeWifiScan(aps);
      }
    } catch (_) {}
  };

  ui.btnListenerReconnect.addEventListener('click', () => {
    if (state.roomCode) enterAsListener(state.roomCode);
  });

  let _volSyncTimer = null;
  function syncHostVolume(immediate = false) {
    if (state.role !== 'host') return;
    const { isAll, peerIds } = getActiveTargetScope();
    const targetIds = isAll ? null : peerIds;
    if (!isAll && peerIds.length === 0) return;
    const v = Number(ui.volumeSlider.value);
    const m = ui.iconVolOn.classList.contains('hidden');
    if (immediate) {
      clearTimeout(_volSyncTimer);
      _volSyncTimer = null;
      network.broadcastVolume({ volume: v, muted: m, targetIds });
      return;
    }
    if (!_volSyncTimer) {
      _volSyncTimer = setTimeout(() => {
        _volSyncTimer = null;
        if (state.role === 'host') {
          const curScope = getActiveTargetScope();
          network.broadcastVolume({
            volume: Number(ui.volumeSlider.value),
            muted: ui.iconVolOn.classList.contains('hidden'),
            targetIds: curScope.isAll ? null : curScope.peerIds,
          });
        }
      }, 45);
    }
  }

  ui.volumeSlider.addEventListener('input', () => {
    const val = Number(ui.volumeSlider.value);
    const { includeHost } = state.role === 'host' ? getActiveTargetScope() : { includeHost: true };
    if (includeHost) {
      audio.setVolume(val);
      if (val > 0 && audio.muted) audio.setMuted(false);
    }
    if (val > 0) {
      ui.iconVolOn.classList.remove('hidden');
      ui.iconVolOff.classList.add('hidden');
    }
    ui.volumePct.textContent = `${Math.round(val * 100)}%`;
    syncHostVolume(false);
  });

  ui.volumeSlider.addEventListener('change', () => {
    syncHostVolume(true);
  });

  ui.btnMute.addEventListener('click', () => {
    const nextMuted = !ui.iconVolOn.classList.contains('hidden');
    const { includeHost } = state.role === 'host' ? getActiveTargetScope() : { includeHost: true };
    if (includeHost) {
      audio.setMuted(nextMuted);
    }
    ui.iconVolOn.classList.toggle('hidden', nextMuted);
    ui.iconVolOff.classList.toggle('hidden', !nextMuted);
    syncHostVolume(true);
  });

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && state.role) {
      touchHostSession();
      await audio.ensureResumed();
      audio.measureSystemLatency(true);
      if (clock && !clock.isHost) clock.reburst();
      if (audio.isPlaying) audio.checkDrift();
      ensureRenderLoopRunning();
    } else if (document.visibilityState === 'hidden') {
      if (state.role === 'host') touchHostSession();
      if (state.rafId) {
        cancelAnimationFrame(state.rafId);
        state.rafId = null;
      }
    }
  });

  window.addEventListener('pagehide', () => {
    if (state.role === 'host') touchHostSession();
  });

  ui.inputRoomCode.addEventListener('input', () => {
    const clean = NetworkManager.normalizeCode(ui.inputRoomCode.value);
    ui.inputRoomCode.value = clean.length > 3 ? `${clean.slice(0, 3)}-${clean.slice(3)}` : clean;
  });

  window.__orpheus = {
    state,
    audio,
    network,
    getClock: () => clock,
    getFloorMap: () => floorMap,
    getYandexPanel: () => yandexPanel,
    setHostTab,
    setSelection,
    enterAsHost,
    enterAsListener,
    leaveRoom,
    hostAddSynthTrack,
    hostSchedulePlay,
    hostPause,
    handleNativeWifiScan,
  };

  async function bootstrapInitialView() {
    const params = new URLSearchParams(window.location.search);
    const hashMatch = window.location.hash.match(/room=([A-Za-z0-9-]+)/i);
    const urlRoom = NetworkManager.normalizeCode(
      window.__initialRoomCode || params.get('room') || (hashMatch ? hashMatch[1] : '')
    );

    // 1. Если в этом браузере есть активная хост-сессия (< 5 минут) и URL пуст или указывает на эту же комнату —
    //    автоматически восстанавливаем комнату Хоста (НЕ предлагаем «Создать комнату» и НЕ кидаем в приглашение!).
    const savedHost = window.__resumeHostSession || loadHostSession();
    if (savedHost && (!urlRoom || urlRoom === savedHost.code)) {
      const ok = await resumeHostSession(savedHost);
      if (ok) return;
      // Комната на сервере уже истекла (> 5 мин) — очищаем URL и показываем главное меню
      if (urlRoom) {
        window.history.replaceState({}, '', window.location.pathname);
      }
      showView('landing');
      return;
    }

    // 2. Если перешли по ссылке ?room=CODE (на телефоне или другом устройстве) —
    //    СНАЧАЛА проверяем на сервере, существует ли комната!
    //    Если комнаты нет -> сразу перебрасываем в главное меню; если есть -> предлагаем подключиться.
    if (urlRoom.length >= 4) {
      const check = await network.checkRoomExists(urlRoom);
      if (check.exists === false) {
        window.history.replaceState({}, '', window.location.pathname);
        showView('landing');
        return;
      }
      const formatted = NetworkManager.formatCode(urlRoom);
      ui.inviteRoomCode.textContent = formatted;
      ui.inviteRoomCode.dataset.code = urlRoom;
      ui.inputRoomCode.value = formatted;
      ui.btnUnlockAndJoin.textContent = `Подключиться к ${formatted}`;
      showView('invite');
      return;
    }

    showView('landing');
  }

  bootstrapInitialView();
})();
