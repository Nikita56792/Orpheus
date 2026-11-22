/**
 * Orpheus Sync v2 — главный контроллер интерфейса, плейлиста и глобальной
 * Bluetooth-синхронизации по всему зданию.
 */
(() => {
  const MIN_START_BUFFER_MS = 2200; // Минимальный буфер старта (увеличивается автоматически под max Bluetooth)

  const $ = (id) => document.getElementById(id);

  const ui = {
    viewLanding: $('viewLanding'),
    viewInviteUnlock: $('viewInviteUnlock'),
    viewRoom: $('viewRoom'),

    btnHome: $('btnHome'),
    btnLeaveRoom: $('btnLeaveRoom'),
    wakeLockBadge: $('wakeLockBadge'),
    transportBadge: $('transportBadge'),

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
    metricOffset: $('metricOffset'),
    metricDrift: $('metricDrift'),

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
    playlistHint: $('playlistHint'),
    loopToggleWrap: $('loopToggleWrap'),
    chkLoopPlaylist: $('chkLoopPlaylist'),

    trackTitle: $('trackTitle'),
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

    btnMute: $('btnMute'),
    iconVolOn: $('iconVolOn'),
    iconVolOff: $('iconVolOff'),
    volumeSlider: $('volumeSlider'),
    volumePct: $('volumePct'),

    // Глобальная BT-синхронизация
    btDeviceBadge: $('btDeviceBadge'),
    metricSysLatency: $('metricSysLatency'),
    metricTotalLatency: $('metricTotalLatency'),
    metricRoomMaxLatency: $('metricRoomMaxLatency'),
    metricWaitDelay: $('metricWaitDelay'),
    btSyncSummary: $('btSyncSummary'),
    chkAutoSysLatency: $('chkAutoSysLatency'),
    btnDetectDevices: $('btnDetectDevices'),
    manualOffsetVal: $('manualOffsetVal'),
    btnResetOffset: $('btnResetOffset'),

    hostPeersSection: $('hostPeersSection'),
    peerCount: $('peerCount'),
    peerList: $('peerList'),
    toastContainer: $('toastContainer'),
  };

  const state = {
    role: null,
    roomCode: null,
    playlist: [],          // [{ id, type, name, duration, size, mime, url, buffer }]
    activeTrackId: null,
    loopPlaylist: true,
    isSeeking: false,
    rafId: null,
    pendingPlayCmd: null,
    reconnectAttempts: 0,
    reconnectTimer: null,
    roomLatency: { roomMaxLatencyMs: 0, slowestLabel: 'Хост', bluetoothCount: 0, deviceCount: 1 },
  };

  /* ==================== ПОДСИСТЕМЫ ==================== */

  const wakeLock = new WakeLockManager(({ active, supported }) => {
    const textEl = ui.wakeLockBadge.querySelector('.pill-text');
    if (!supported) {
      ui.wakeLockBadge.className = 'pill pill-muted';
      textEl.textContent = 'WakeLock: нет';
    } else if (active) {
      ui.wakeLockBadge.className = 'pill pill-active';
      textEl.textContent = 'Экран активен';
    } else {
      ui.wakeLockBadge.className = 'pill pill-muted';
      textEl.textContent = 'Экран: авто';
    }
  });

  const audio = new AudioEngine({
    onDrift: (driftMs, mode) => updateDriftMetric(driftMs, mode),
    onEnded: () => handleTrackEnded(),
    onStateChange: ({ playing }) => updatePlaybackUI(playing),
    onLatencyChange: (profile) => handleLocalLatencyChanged(profile),
  });

  let clock = null;

  const network = new NetworkManager({
    onPeersChanged: (peers) => renderPeerList(peers),

    onTransportChanged: (type, label) => {
      updateTransportBadge(type, label);
      if (clock) {
        clock.setMode(type === 'relay' ? 'relay' : 'p2p');
      }
    },

    onRoomLatencyChanged: (roomLat) => {
      state.roomLatency = roomLat;
      audio.setRoomMaxLatency(roomLat.roomMaxLatencyMs);
      renderLatencyUI(audio.getLatencyProfile());
      updatePlaybackUI(audio.isPlaying);
    },

    onHostConnected: (transportType) => {
      state.reconnectAttempts = 0;
      if (state.reconnectTimer) {
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = null;
      }
      setStatusMetric('Калибровка...', 'metric-warn');
      ui.btnListenerReconnect.classList.add('hidden');
      ui.listenerBannerText.textContent = 'Подключено! Сверка часов с Хостом...';
      updateTransportBadge(transportType, transportType === 'relay' ? 'WSS Relay' : 'P2P');

      // Сразу отправляем нашу измеренную системную/BT задержку Хосту
      sendLocalLatencyToHost();
    },

    onHostDisconnected: (reason = '') => {
      audio.pause();
      if (clock) clock.stop();
      setStatusMetric('Переподкл...', 'metric-warn');
      ui.btnListenerReconnect.classList.remove('hidden');

      const detail = reason && reason !== 'unknown' ? ` (${reason})` : '';
      if (state.role === 'listener' && state.roomCode && state.reconnectAttempts < 3) {
        state.reconnectAttempts++;
        ui.listenerBannerText.textContent = `Связь прервалась${detail}. Переподключение ${state.reconnectAttempts}/3...`;
        state.reconnectTimer = setTimeout(() => {
          if (state.role === 'listener' && state.roomCode) {
            enterAsListener(state.roomCode, true);
          }
        }, 1800);
      } else {
        setStatusMetric('Отключён', 'metric-bad');
        ui.listenerBannerText.textContent = `Связь с Хостом потеряна${detail}. Нажмите «Переподключиться».`;
        showToast('Соединение с Хостом разорвано', 'error');
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

    onFileProgress: ({ trackId, name, pct, isActive }) => {
      if (!isActive && trackId !== state.activeTrackId) return;
      if (pct === 0 && trackId === state.activeTrackId) {
        state.pendingPlayCmd = null;
        audio.pause(0);
      }
      ui.trackTitle.textContent = name;
      ui.trackSub.textContent = 'Приём аудиофайла от Хоста (бинарный P2P)...';
      showTransfer(true, 'Загрузка от Хоста...', pct);
    },

    onFileComplete: async ({ trackId, name, buffer, isActive }) => {
      await handleListenerFileComplete(trackId, name, buffer, isActive);
    },

    onCmdPlay: (cmd) => handleListenerPlayCmd(cmd),

    onCmdPause: ({ trackOffset }) => {
      state.pendingPlayCmd = null;
      audio.pause(trackOffset);
      ui.listenerBannerText.textContent = 'Пауза (ожидание Хоста)';
    },

    onError: (err) => {
      showToast(err.message || 'Сетевая ошибка', 'error');
    },
  });

  /* ==================== УТИЛИТЫ UI ==================== */

  function showView(name) {
    ui.viewLanding.classList.toggle('hidden', name !== 'landing');
    ui.viewInviteUnlock.classList.toggle('hidden', name !== 'invite');
    ui.viewRoom.classList.toggle('hidden', name !== 'room');
    ui.btnLeaveRoom.classList.toggle('hidden', name !== 'room');
    ui.transportBadge.classList.toggle('hidden', name !== 'room');
  }

  function showToast(text, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${type === 'error' ? 'toast-error' : type === 'success' ? 'toast-success' : ''}`;
    el.textContent = text;
    ui.toastContainer.appendChild(el);
    setTimeout(() => el.remove(), 3600);
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

  function updateTransportBadge(type, label) {
    const textEl = ui.transportBadge.querySelector('.pill-text');
    textEl.textContent = label || '—';
    if (type === 'p2p-lan' || type === 'p2p-udp' || type === 'p2p' || type === 'host') {
      ui.transportBadge.className = 'pill pill-active';
    } else if (type === 'relay' || type === 'turn') {
      ui.transportBadge.className = 'pill pill-warn';
    } else {
      ui.transportBadge.className = 'pill pill-muted';
    }
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

  /* ==================== ГЛОБАЛЬНАЯ СИНХРОНИЗАЦИЯ BLUETOOTH ==================== */

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

  function handleLocalLatencyChanged(profile) {
    renderLatencyUI(profile);
    if (state.role) {
      sendLocalLatencyToHost();
    }
  }

  function renderLatencyUI(profile) {
    ui.metricSysLatency.textContent = `${profile.systemLatencyMs} мс`;
    ui.metricTotalLatency.textContent = `${profile.totalLatencyMs} мс`;

    const roomMax = Math.max(profile.totalLatencyMs, state.roomLatency.roomMaxLatencyMs || 0);
    const waitMs = Math.max(0, roomMax - profile.totalLatencyMs);

    ui.metricRoomMaxLatency.textContent = `${roomMax} мс`;
    ui.metricWaitDelay.textContent = `+${waitMs} мс`;

    const sign = profile.extraLatencyMs > 0 ? '+' : '';
    ui.manualOffsetVal.textContent = `${sign}${profile.extraLatencyMs} мс`;
    ui.chkAutoSysLatency.checked = profile.autoSystemLatency;

    // Обновляем подсветку пресетов
    document.querySelectorAll('[data-bt-preset]').forEach((btn) => {
      const val = Number(btn.dataset.btPreset);
      btn.classList.toggle('active', val === profile.extraLatencyMs);
    });

    // Бейдж типа вывода (Bluetooth или Динамик)
    if (profile.isBluetooth) {
      const label = profile.outputDeviceLabel ? `BT: ${profile.outputDeviceLabel}` : 'Bluetooth аудио';
      ui.btDeviceBadge.textContent = label;
      ui.btDeviceBadge.className = 'bt-badge bt-active';
    } else {
      ui.btDeviceBadge.textContent = profile.outputDeviceLabel || 'Динамик / провод';
      ui.btDeviceBadge.className = 'bt-badge';
    }

    // Понятное описание глобального выравнивания
    if (roomMax > 0 && waitMs > 5) {
      ui.btSyncSummary.textContent = `Вся сеть выровнена под «${state.roomLatency.slowestLabel}» (${roomMax} мс). Это устройство автоматически придерживает звук на +${waitMs} мс, чтобы по всему зданию всё звучало в унисон.`;
    } else if (profile.isBluetooth) {
      ui.btSyncSummary.textContent = `Это устройство задаёт опорную Bluetooth-задержку (${profile.totalLatencyMs} мс) — остальные телефоны в здании автоматически подстраиваются под него.`;
    } else {
      ui.btSyncSummary.textContent = `Системная задержка: ${profile.systemLatencyMs} мс (output ${profile.outputLatencyMs} + base ${profile.baseLatencyMs} мс). При подключении Bluetooth к любому телефону вся сеть автоматически выровняется.`;
    }
  }

  /* ==================== ЗАПУСК ХОСТА ==================== */

  async function enterAsHost() {
    ui.btnCreateRoom.disabled = true;
    ui.btnCreateRoom.textContent = 'Создание комнаты...';

    try {
      await audio.unlock();
      wakeLock.acquire();

      const code = await network.startHost();
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

      ui.hostShareActions.classList.remove('hidden');
      ui.hostTrackSection.classList.remove('hidden');
      ui.hostPlaybackControls.classList.remove('hidden');
      ui.hostPeersSection.classList.remove('hidden');
      ui.loopToggleWrap.classList.remove('hidden');
      ui.listenerPlaybackBanner.classList.add('hidden');
      ui.qrPanel.classList.remove('hidden');

      setStatusMetric('Комната активна', 'metric-good');
      updateTransportBadge('host', 'Хост (P2P)');
      ui.metricRtt.textContent = '0 мс (Хост)';
      ui.metricOffset.textContent = '0 мс';
      ui.metricDrift.textContent = '0 мс';

      // Регистрируем локальную задержку Хоста в расчёте комнаты
      sendLocalLatencyToHost();
      renderPlaylist();
      showView('room');
      startRenderLoop();
      showToast(`Комната ${NetworkManager.formatCode(code)} создана!`, 'success');
    } catch (err) {
      showToast(err.message || 'Не удалось создать комнату', 'error');
    } finally {
      ui.btnCreateRoom.disabled = false;
      ui.btnCreateRoom.textContent = 'Создать комнату';
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
      const msg = 'Введите 6-значный код комнаты (например, K7M-4PX)';
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
    setConnectStatus('Разблокировка звука...');

    try {
      if (!isAutoReconnect) {
        await audio.unlock();
        wakeLock.acquire();
      }

      await network.joinAsListener(code, (progressText) => {
        setConnectStatus(progressText, false);
      });
      setConnectStatus('');
      state.role = 'listener';
      state.roomCode = code;

      clock = new ClockSync({
        isHost: false,
        mode: network.hostTransport === 'relay' ? 'relay' : 'p2p',
        sendPing: (payload) => network.sendToHost(payload, 'ntp'),
        onUpdate: ({ offsetMs, rttMs }) => {
          const rttRound = Math.round(rttMs);
          ui.metricRtt.textContent = `${rttRound} мс`;
          ui.metricRtt.className = `metric-value mono ${
            rttRound < 45 ? 'metric-good' : rttRound < 120 ? 'metric-warn' : 'metric-bad'
          }`;

          const offRound = Math.round(offsetMs);
          ui.metricOffset.textContent = `${offRound > 0 ? '+' : ''}${offRound} мс`;
          setStatusMetric('Синхронизирован', 'metric-good');

          network.sendToHost({ type: 'CLIENT_METRICS', rttMs: rttRound }, 'ctrl');

          if (state.pendingPlayCmd && audio.buffer && state.activeTrackId === state.pendingPlayCmd.trackId) {
            const cmd = state.pendingPlayCmd;
            state.pendingPlayCmd = null;
            executeScheduledPlay(cmd);
          } else if (audio.isScheduled) {
            audio.refineScheduledStart();
          }
        },
      });
      clock.start();
      sendLocalLatencyToHost();

      ui.roleBadge.textContent = 'СЛУШАТЕЛЬ';
      ui.roleBadge.className = 'role-badge listener';
      ui.displayRoomCode.textContent = NetworkManager.formatCode(code);

      ui.hostShareActions.classList.add('hidden');
      ui.qrPanel.classList.add('hidden');
      ui.hostTrackSection.classList.add('hidden');
      ui.hostPlaybackControls.classList.add('hidden');
      ui.hostPeersSection.classList.add('hidden');
      ui.loopToggleWrap.classList.add('hidden');
      ui.listenerPlaybackBanner.classList.remove('hidden');
      ui.seekSlider.disabled = true;

      ui.trackTitle.textContent = 'Ожидание плейлиста от Хоста';
      ui.trackSub.textContent = 'Как только Хост добавит треки, они загрузятся автоматически';
      ui.listenerBannerText.textContent = 'Калибровка часов с Хостом...';

      renderPlaylist();
      showView('room');
      startRenderLoop();
      showToast(`Подключено к комнате ${NetworkManager.formatCode(code)}`, 'success');
    } catch (err) {
      const msg = err.message || 'Не удалось подключиться';
      setConnectStatus(msg, true);
      showToast(msg, 'error');
    } finally {
      ui.btnJoinRoom.disabled = false;
      ui.btnUnlockAndJoin.disabled = false;
      ui.btnJoinRoom.textContent = 'Подключиться и включить звук';
      ui.btnUnlockAndJoin.textContent = 'Подключиться и разблокировать звук';
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
        showToast(`Файл «${file.name}» > 40 МБ. Рекомендуем MP3 до 15 МБ.`, 'error');
      }
      showTransfer(true, `Декодирование (${i + 1}/${files.length}): ${file.name}`, Math.round(((i + 0.5) / files.length) * 100));

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
        console.error('[App] File decode failed:', file.name, err);
        showToast(`Не удалось декодировать ${file.name}`, 'error');
      }
    }

    showTransfer(false);

    if (added > 0) {
      if (!state.activeTrackId) {
        await hostSelectTrack(state.playlist[0].id, false);
      } else {
        network.setHostPlaylist(state.playlist, state.activeTrackId);
        renderPlaylist();
      }
      showToast(added === 1 ? 'Трек добавлен в плейлист' : `Добавлено треков: ${added}`, 'success');
    }
  }

  async function hostAddSynthTrack(type) {
    const isPulse = type === 'pulse';
    const trackId = isPulse ? 'demo-pulse-60bpm-v2' : 'demo-120bpm-v2';
    const name = isPulse ? 'Калибровочный метроном (1 Гц)' : 'Встроенный тест-бит (120 BPM)';

    showTransfer(true, `Генерация: ${name}...`, 65);
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
      showToast(`«${name}» готов!`, 'success');
    } catch (_) {
      showTransfer(false);
      showToast('Ошибка генерации тест-трека', 'error');
    }
  }

  async function hostAddUrlTrack(url) {
    showTransfer(true, 'Загрузка аудио по URL...', 40);
    try {
      const resp = await fetch(url, { mode: 'cors' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const arrayBuffer = await resp.arrayBuffer();
      const trackId = `url-${url}`;
      showTransfer(true, 'Декодирование аудио...', 85);
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
        network.setHostPlaylist(state.playlist, state.activeTrackId);
        renderPlaylist();
      }
      showToast('URL-трек добавлен в плейлист!', 'success');
    } catch (_) {
      showTransfer(false);
      showToast('Не удалось загрузить URL (проверьте CORS или выберите локальные файлы)', 'error');
    }
  }

  async function hostSelectTrack(trackId, autoPlay = false) {
    const track = state.playlist.find((t) => t.id === trackId);
    if (!track) return;

    audio.pause(0);
    network.broadcastPause({ trackOffset: 0 });

    // Убеждаемся, что буфер декодирован в кэше
    let decoded = audio.activateTrack(trackId);
    if (!decoded) {
      if (track.type === 'demo') decoded = await audio.generateDemoTrack(trackId, true);
      else if (track.type === 'pulse') decoded = await audio.generatePulseTrack(trackId, true);
      else if (track.type === 'file' && track.buffer) decoded = await audio.decodeArrayBuffer(track.buffer, trackId);
      else if (track.type === 'url' && track.url) {
        const resp = await fetch(track.url, { mode: 'cors' });
        decoded = await audio.decodeArrayBuffer(await resp.arrayBuffer(), trackId);
      }
    }
    if (!decoded) return;

    state.activeTrackId = trackId;
    const sub =
      track.type === 'file'
        ? `${formatTime(decoded.duration)} • ${(track.size / 1024 / 1024).toFixed(1)} МБ • P2P бинарный`
        : track.type === 'url'
        ? `${formatTime(decoded.duration)} • Прямая ссылка`
        : `${formatTime(decoded.duration)} • Синтез без трафика`;

    onTrackReadyUI(track.name, sub, decoded.duration);
    network.setHostPlaylist(state.playlist, trackId);
    renderPlaylist();

    if (autoPlay) {
      hostSchedulePlay(0);
    }
  }

  function hostRemoveTrack(trackId) {
    const idx = state.playlist.findIndex((t) => t.id === trackId);
    if (idx < 0) return;
    const wasActive = state.activeTrackId === trackId;
    state.playlist.splice(idx, 1);

    if (wasActive) {
      audio.pause(0);
      network.broadcastPause({ trackOffset: 0 });
      const next = state.playlist[idx] || state.playlist[0] || null;
      if (next) {
        hostSelectTrack(next.id, false);
        return;
      } else {
        state.activeTrackId = null;
        audio.buffer = null;
        resetPlayerNoTrackUI();
      }
    }

    network.setHostPlaylist(state.playlist, state.activeTrackId);
    renderPlaylist();
  }

  function hostMoveTrack(trackId, dir) {
    const idx = state.playlist.findIndex((t) => t.id === trackId);
    const target = idx + dir;
    if (idx < 0 || target < 0 || target >= state.playlist.length) return;
    const [item] = state.playlist.splice(idx, 1);
    state.playlist.splice(target, 0, item);
    network.setHostPlaylist(state.playlist, state.activeTrackId);
    renderPlaylist();
  }

  function hostSwitchAdjacent(delta, autoPlay = true) {
    if (state.playlist.length === 0) return;
    const idx = state.playlist.findIndex((t) => t.id === state.activeTrackId);
    let nextIdx = idx + delta;
    if (nextIdx >= state.playlist.length) {
      if (!state.loopPlaylist) return;
      nextIdx = 0;
    } else if (nextIdx < 0) {
      nextIdx = state.playlist.length - 1;
    }
    hostSelectTrack(state.playlist[nextIdx].id, autoPlay);
  }

  function handleTrackEnded() {
    updatePlaybackUI(false);
    if (state.role !== 'host') return;

    if (state.playlist.length > 1) {
      const idx = state.playlist.findIndex((t) => t.id === state.activeTrackId);
      const hasNext = idx >= 0 && idx < state.playlist.length - 1;
      if (hasNext || state.loopPlaylist) {
        hostSwitchAdjacent(1, true);
        return;
      }
    } else if (state.playlist.length === 1 && state.loopPlaylist) {
      hostSchedulePlay(0);
      return;
    }

    network.broadcastPause({ trackOffset: 0 });
  }

  /* ==================== ПЛЕЙЛИСТ (СЛУШАТЕЛЬ) ==================== */

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

    // Если новый активный трек УЖЕ предзагружен в кэше — мгновенно активируем его!
    if (activeTrackId !== prevActive && audio.hasCachedTrack(activeTrackId)) {
      const decoded = audio.activateTrack(activeTrackId);
      const meta = state.playlist.find((t) => t.id === activeTrackId);
      if (decoded && meta) {
        onTrackReadyUI(meta.name, `${formatTime(decoded.duration)} • Из кэша (мгновенно)`, decoded.duration);
        showTransfer(false);
        ui.listenerBannerText.textContent = 'Трек готов. Ожидание старта от Хоста...';
        network.sendToHost({ type: 'TRACK_READY', trackId: activeTrackId });
        tryApplyPendingPlay();
      }
    }
  }

  async function handleListenerSynthTrack(trackId, synthType, name, isActive) {
    const activateNow = isActive || trackId === state.activeTrackId;
    if (activateNow) {
      audio.pause(0);
      showTransfer(true, `Локальный синтез: ${name}...`, 65);
    }
    try {
      const decoded =
        synthType === 'pulse'
          ? await audio.generatePulseTrack(trackId, activateNow)
          : await audio.generateDemoTrack(trackId, activateNow);

      if (activateNow) {
        state.activeTrackId = trackId;
        onTrackReadyUI(name, `${formatTime(decoded.duration)} • Локальный синтез (0 КБ)`, decoded.duration);
        showTransfer(false);
        ui.listenerBannerText.textContent = 'Трек готов. Ожидание старта от Хоста...';
      }
      network.sendToHost({ type: 'TRACK_READY', trackId });
      renderPlaylist();
      if (activateNow) tryApplyPendingPlay();
    } catch (_) {
      if (activateNow) showTransfer(false);
      network.sendToHost({ type: 'TRACK_ERROR', trackId });
    }
  }

  async function handleListenerUrlTrack(trackId, name, url, isActive) {
    const activateNow = isActive || trackId === state.activeTrackId;
    if (activateNow) {
      audio.pause(0);
      showTransfer(true, 'Загрузка трека по URL...', 35);
    }
    try {
      const resp = await fetch(url, { mode: 'cors' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = await resp.arrayBuffer();
      if (activateNow) showTransfer(true, 'Декодирование аудио...', 85);
      const decoded = await audio.decodeToCache(trackId, buf);
      if (activateNow) {
        audio.activateTrack(trackId);
        state.activeTrackId = trackId;
        onTrackReadyUI(name, `${formatTime(decoded.duration)} • Загружено по URL`, decoded.duration);
        showTransfer(false);
        ui.listenerBannerText.textContent = 'Трек готов. Ожидание старта от Хоста...';
      }
      network.sendToHost({ type: 'TRACK_READY', trackId });
      renderPlaylist();
      if (activateNow) tryApplyPendingPlay();
    } catch (_) {
      if (activateNow) showTransfer(false);
      network.sendToHost({ type: 'TRACK_ERROR', trackId });
    }
  }

  async function handleListenerFileComplete(trackId, name, buffer, isActive) {
    const activateNow = isActive || trackId === state.activeTrackId;
    if (activateNow) {
      showTransfer(true, 'Декодирование аудио...', 100);
    }
    try {
      const decoded = await audio.decodeToCache(trackId, buffer);
      if (activateNow) {
        audio.activateTrack(trackId);
        state.activeTrackId = trackId;
        onTrackReadyUI(name, `${formatTime(decoded.duration)} • Получено от Хоста`, decoded.duration);
        showTransfer(false);
        ui.listenerBannerText.textContent = 'Трек готов. Ожидание старта от Хоста...';
      }
      network.sendToHost({ type: 'TRACK_READY', trackId });
      renderPlaylist();
      if (activateNow) tryApplyPendingPlay();
    } catch (err) {
      console.error('[App/Listener] Decode error:', err);
      if (activateNow) showTransfer(false);
      network.sendToHost({ type: 'TRACK_ERROR', trackId });
      if (activateNow) showToast('Ошибка декодирования полученного файла', 'error');
    }
  }

  function onTrackReadyUI(title, subtitle, duration) {
    ui.trackTitle.textContent = title;
    ui.trackSub.textContent = subtitle;
    ui.timeDuration.textContent = formatTime(duration);
    ui.timeCurrent.textContent = '0:00';
    ui.seekSlider.max = String(duration);
    ui.seekSlider.value = '0';

    if (state.role === 'host') {
      ui.seekSlider.disabled = false;
      ui.btnPlayPause.disabled = false;
      ui.btnPrevTrack.disabled = state.playlist.length === 0;
      ui.btnNextTrack.disabled = state.playlist.length === 0;
      ui.btnForceResync.disabled = false;
    }
  }

  function resetPlayerNoTrackUI() {
    ui.trackTitle.textContent = 'Плейлист пуст';
    ui.trackSub.textContent = state.role === 'host' ? 'Добавьте файлы или тест-бит ниже' : 'Ожидание треков от Хоста...';
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
          ? '<li class="peer-empty">Добавьте один или несколько аудиофайлов, либо нажмите «Тест-бит 120 BPM».</li>'
          : '<li class="peer-empty">Ожидание плейлиста от Хоста...</li>';
      return;
    }

    ui.playlistList.innerHTML = state.playlist
      .map((t, idx) => {
        const isActive = t.id === state.activeTrackId;
        const cached = audio.hasCachedTrack(t.id);
        const badge =
          state.role === 'listener'
            ? cached
              ? '<span class="track-pill ready">Кэш ✓</span>'
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

        return `
          <li class="playlist-item ${isActive ? 'active' : ''}" data-pl-select="${escapeHtml(t.id)}">
            <div class="playlist-item-main">
              <span class="playlist-num mono">${isActive ? '▶' : idx + 1}</span>
              <div class="playlist-item-text">
                <div class="playlist-item-name">${escapeHtml(t.name)}</div>
                <div class="playlist-item-meta mono">${formatTime(t.duration)} ${badge}</div>
              </div>
            </div>
            ${controls}
          </li>`;
      })
      .join('');
  }

  /* ==================== ВОСПРОИЗВЕДЕНИЕ И СИНХРОНИЗАЦИЯ ==================== */

  function getEffectiveStartBufferMs() {
    // Гарантируем, что буфера старта хватит даже для самой медленной Bluetooth-колонки в здании!
    const roomMax = Math.max(audio.getTotalOutputLatencyMs(), state.roomLatency.roomMaxLatencyMs || 0);
    return Math.max(MIN_START_BUFFER_MS, roomMax + 1100);
  }

  function hostSchedulePlay(trackOffset = audio.getAcousticPosition()) {
    if (!audio.buffer || !clock || !state.activeTrackId) return;

    const bufferMs = getEffectiveStartBufferMs();
    // hostStartTime = T_acoustic (когда звук должен выйти в воздух со всех динамиков и BT-колонок!)
    const hostStartTime = clock.hostNow() + bufferMs;
    const clampedOffset = Math.max(0, Math.min(trackOffset, Math.max(0, audio.getDuration() - 0.1)));

    network.broadcastPlay({
      hostStartTime,
      trackOffset: clampedOffset,
      trackId: state.activeTrackId,
    });

    audio.schedulePlay({
      hostStartTime,
      trackOffset: clampedOffset,
      getHostTime: () => clock.hostNow(),
    });
  }

  function hostPause() {
    const pos = audio.getAcousticPosition();
    audio.pause(pos);
    network.broadcastPause({ trackOffset: pos });
  }

  function handleListenerPlayCmd(cmd) {
    // Если этот трек уже в кэше, но ещё не активирован — активируем мгновенно!
    if (cmd.trackId && cmd.trackId !== state.activeTrackId && audio.hasCachedTrack(cmd.trackId)) {
      const decoded = audio.activateTrack(cmd.trackId);
      const meta = state.playlist.find((t) => t.id === cmd.trackId);
      if (decoded && meta) {
        state.activeTrackId = cmd.trackId;
        onTrackReadyUI(meta.name, `${formatTime(decoded.duration)} • Из кэша`, decoded.duration);
        renderPlaylist();
      }
    }

    if (!audio.buffer || state.activeTrackId !== cmd.trackId || !clock || !clock.synced) {
      state.pendingPlayCmd = cmd;
      return;
    }
    executeScheduledPlay(cmd);
  }

  function tryApplyPendingPlay() {
    if (state.pendingPlayCmd && clock && clock.synced && state.activeTrackId === state.pendingPlayCmd.trackId) {
      const cmd = state.pendingPlayCmd;
      state.pendingPlayCmd = null;
      executeScheduledPlay(cmd);
    }
  }

  function executeScheduledPlay(cmd) {
    audio.schedulePlay({
      hostStartTime: cmd.hostStartTime,
      trackOffset: cmd.trackOffset,
      getHostTime: () => clock.hostNow(),
    });
    ui.listenerBannerText.textContent = 'Синхронное воспроизведение с Хостом';
  }

  function updatePlaybackUI(isPlaying) {
    const bufSec = (getEffectiveStartBufferMs() / 1000).toFixed(1);
    ui.iconPlay.classList.toggle('hidden', isPlaying);
    ui.iconPause.classList.toggle('hidden', !isPlaying);
    ui.playPauseLabel.textContent = isPlaying ? 'Пауза' : `Старт (+${bufSec}с)`;
    ui.listenerPulse.classList.toggle('playing', isPlaying);
    if (!isPlaying) {
      ui.countdownBadge.classList.add('hidden');
    }
  }

  function renderPeerList(peers) {
    ui.peerCount.textContent = String(peers.length);
    if (peers.length === 0) {
      ui.peerList.innerHTML =
        '<li class="peer-empty">Пока никто не подключился. Покажите QR-код или отправьте ссылку устройствам в здании.</li>';
      return;
    }

    const roomMax = state.roomLatency.roomMaxLatencyMs || 0;

    ui.peerList.innerHTML = peers
      .map((p) => {
        const isSlowest = roomMax > 30 && p.latencyMs === roomMax;
        const btTag = p.isBluetooth
          ? `<span class="peer-chip peer-chip-bt ${isSlowest ? 'slowest' : ''}">BT ${p.latencyMs} мс</span>`
          : `<span class="peer-chip">${p.latencyMs} мс</span>`;
        const trTag = `<span class="peer-chip peer-chip-net">${escapeHtml(p.transportLabel || 'P2P')}</span>`;

        return `
          <li class="peer-item">
            <div class="peer-main">
              <span class="peer-status-dot ${p.ready ? 'ready' : ''}"></span>
              <div class="peer-name-wrap">
                <strong>${escapeHtml(p.label)}</strong>
                <div class="peer-chips">${trTag} ${btTag}</div>
              </div>
            </div>
            <div class="peer-meta">
              <span>${escapeHtml(p.status)}</span>
              <span class="mono">${p.rttMs !== null ? `${p.rttMs} мс` : '—'}</span>
            </div>
          </li>`;
      })
      .join('');
  }

  /* ==================== ЦИКЛ ОТРИСОВКИ ==================== */

  const freqBins = new Uint8Array(64);

  function startRenderLoop() {
    if (state.rafId) cancelAnimationFrame(state.rafId);

    const canvas = ui.visualizerCanvas;
    const ctx2d = canvas.getContext('2d');

    const tick = () => {
      const countdown = audio.getCountdownSec();
      if (countdown > 0.02) {
        ui.countdownBadge.classList.remove('hidden');
        ui.countdownBadge.textContent = `Старт: ${countdown.toFixed(1)}с`;
        if (state.role === 'listener') {
          ui.listenerBannerText.textContent = `Общий акустический старт через ${countdown.toFixed(1)} с...`;
        }
      } else {
        ui.countdownBadge.classList.add('hidden');
        if (state.role === 'listener' && audio.isPlaying) {
          ui.listenerBannerText.textContent = 'Синхронное воспроизведение с Хостом';
        }
      }

      if (audio.buffer && !state.isSeeking) {
        const pos = audio.getAcousticPosition();
        ui.timeCurrent.textContent = formatTime(pos);
        ui.seekSlider.value = String(pos);
      }

      const w = canvas.width;
      const h = canvas.height;
      ctx2d.clearRect(0, 0, w, h);

      const hasAudio = audio.isPlaying && audio.getFrequencyData(freqBins);
      const barCount = 40;
      const gap = 4;
      const barWidth = (w - gap * (barCount - 1)) / barCount;

      for (let i = 0; i < barCount; i++) {
        const val = hasAudio ? freqBins[i] / 255 : 0.04;
        const barH = Math.max(4, val * (h - 14));
        const x = i * (barWidth + gap);
        const y = h - barH;

        const grad = ctx2d.createLinearGradient(0, y, 0, h);
        grad.addColorStop(0, '#10b981');
        grad.addColorStop(1, '#6366f1');
        ctx2d.fillStyle = hasAudio ? grad : 'rgba(147, 160, 184, 0.2)';
        ctx2d.beginPath();
        if (typeof ctx2d.roundRect === 'function') {
          ctx2d.roundRect(x, y, barWidth, barH, 3);
        } else {
          ctx2d.rect(x, y, barWidth, barH);
        }
        ctx2d.fill();
      }

      state.rafId = requestAnimationFrame(tick);
    };

    state.rafId = requestAnimationFrame(tick);
  }

  function leaveRoom() {
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
    network.destroy();
    wakeLock.release();

    state.role = null;
    state.roomCode = null;
    state.playlist = [];
    state.activeTrackId = null;
    state.pendingPlayCmd = null;
    state.roomLatency = { roomMaxLatencyMs: 0, slowestLabel: 'Хост', bluetoothCount: 0, deviceCount: 1 };

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

  ui.btnLeaveRoom.addEventListener('click', leaveRoom);
  ui.btnHome.addEventListener('click', () => {
    if (state.role) leaveRoom();
  });

  ui.btnToggleQR.addEventListener('click', () => {
    ui.qrPanel.classList.toggle('hidden');
  });

  const copyShareLink = async () => {
    const url = buildShareUrl(state.roomCode);
    try {
      await navigator.clipboard.writeText(url);
      showToast('Ссылка на комнату скопирована!', 'success');
    } catch (_) {
      ui.shareLinkInput.select();
      document.execCommand('copy');
      showToast('Ссылка скопирована!', 'success');
    }
  };

  ui.btnCopyCode.addEventListener('click', copyShareLink);

  ui.btnShareLink.addEventListener('click', async () => {
    const url = buildShareUrl(state.roomCode);
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Orpheus Sync — Синхронная музыка',
          text: `Подключайся к комнате ${NetworkManager.formatCode(state.roomCode)}!`,
          url,
        });
        return;
      } catch (_) {}
    }
    copyShareLink();
  });

  // Добавление файлов (множественный выбор + Drag & Drop)
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

  // Делегирование кликов по плейлисту (Хост)
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
      if (id === state.activeTrackId) {
        if (audio.isPlaying) hostPause();
        else hostSchedulePlay(audio.getAcousticPosition());
      } else {
        hostSelectTrack(id, audio.isPlaying);
      }
    }
  });

  // Управление плеером (Хост)
  ui.btnPlayPause.addEventListener('click', () => {
    if (!audio.buffer) return;
    if (audio.isPlaying) hostPause();
    else hostSchedulePlay(audio.getAcousticPosition());
  });

  ui.btnPrevTrack.addEventListener('click', () => {
    if (!audio.buffer) return;
    // Если прошло > 3 сек — перезапуск текущего трека, иначе предыдущий в плейлисте
    if (audio.getAcousticPosition() > 3 || state.playlist.length <= 1) {
      if (audio.isPlaying) hostSchedulePlay(0);
      else {
        audio.pause(0);
        ui.seekSlider.value = '0';
        ui.timeCurrent.textContent = '0:00';
        network.broadcastPause({ trackOffset: 0 });
      }
    } else {
      hostSwitchAdjacent(-1, audio.isPlaying);
    }
  });

  ui.btnNextTrack.addEventListener('click', () => {
    if (state.playlist.length > 1) {
      hostSwitchAdjacent(1, audio.isPlaying);
    }
  });

  ui.btnForceResync.addEventListener('click', () => {
    if (!audio.buffer) return;
    if (audio.isPlaying) {
      hostSchedulePlay(audio.getAcousticPosition());
      showToast('Команда пересинхронизации отправлена всем', 'success');
    } else {
      showToast('Сначала нажмите Старт');
    }
  });

  // Перемотка
  ui.seekSlider.addEventListener('input', () => {
    state.isSeeking = true;
    ui.timeCurrent.textContent = formatTime(Number(ui.seekSlider.value));
  });

  ui.seekSlider.addEventListener('change', () => {
    state.isSeeking = false;
    const targetSec = Number(ui.seekSlider.value);
    if (state.role !== 'host' || !audio.buffer) return;

    if (audio.isPlaying) hostSchedulePlay(targetSec);
    else {
      audio.pause(targetSec);
      network.broadcastPause({ trackOffset: targetSec });
    }
  });

  ui.btnListenerReconnect.addEventListener('click', () => {
    if (state.roomCode) enterAsListener(state.roomCode);
  });

  // Громкость
  ui.volumeSlider.addEventListener('input', () => {
    const val = Number(ui.volumeSlider.value);
    audio.setVolume(val);
    if (val > 0 && audio.muted) {
      audio.setMuted(false);
      ui.iconVolOn.classList.remove('hidden');
      ui.iconVolOff.classList.add('hidden');
    }
    ui.volumePct.textContent = `${Math.round(val * 100)}%`;
  });

  ui.btnMute.addEventListener('click', () => {
    audio.setMuted(!audio.muted);
    ui.iconVolOn.classList.toggle('hidden', audio.muted);
    ui.iconVolOff.classList.toggle('hidden', !audio.muted);
  });

  // Настройки Bluetooth и глобальной задержки
  ui.chkAutoSysLatency.addEventListener('change', () => {
    audio.setAutoSystemLatency(ui.chkAutoSysLatency.checked);
  });

  ui.btnDetectDevices.addEventListener('click', async () => {
    const ok = await audio.requestDeviceLabelsAccess();
    if (ok) {
      showToast('Аудиоустройства и локальный IP определены!', 'success');
    } else {
      showToast('Доступ отклонён — используется системный outputLatency', 'info');
    }
  });

  document.querySelectorAll('[data-bt-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ms = Number(btn.dataset.btPreset);
      audio.setExtraLatency(ms);
    });
  });

  document.querySelectorAll('[data-nudge]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const delta = Number(btn.dataset.nudge);
      audio.nudgeExtraLatency(delta);
    });
  });

  ui.btnResetOffset.addEventListener('click', () => {
    audio.setExtraLatency(0);
  });

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && state.role) {
      await audio.ensureResumed();
      audio.measureSystemLatency(true);
      if (clock && !clock.isHost) clock.reburst();
      if (audio.isPlaying) audio.checkDrift();
    }
  });

  ui.inputRoomCode.addEventListener('input', () => {
    const clean = NetworkManager.normalizeCode(ui.inputRoomCode.value);
    ui.inputRoomCode.value = clean.length > 3 ? `${clean.slice(0, 3)}-${clean.slice(3)}` : clean;
  });

  // Диагностический хук для автотестов
  window.__orpheus = {
    state,
    audio,
    network,
    getClock: () => clock,
    enterAsHost,
    enterAsListener,
    hostAddSynthTrack,
    hostSchedulePlay,
    hostPause,
  };

  // Инициализация стартового экрана
  renderLatencyUI(audio.getLatencyProfile());
  const params = new URLSearchParams(window.location.search);
  const urlRoom = NetworkManager.normalizeCode(params.get('room') || window.location.hash.replace('#room=', ''));
  if (urlRoom.length >= 4) {
    ui.inviteRoomCode.textContent = NetworkManager.formatCode(urlRoom);
    ui.inviteRoomCode.dataset.code = urlRoom;
    showView('invite');
  } else {
    showView('landing');
  }
})();
