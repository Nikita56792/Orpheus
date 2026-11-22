/**
 * Orpheus Sync v2.1 — минималистичный контроллер интерфейса (Apple HIG),
 * автоматическая синхронизация при подключении во время воспроизведения (Late Join),
 * живые проценты загрузки по каждому устройству и полная авто-компенсация Bluetooth.
 */
(() => {
  const MIN_START_BUFFER_MS = 2200;

  const $ = (id) => document.getElementById(id);

  const ui = {
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
    activeTrackId: null,
    loopPlaylist: true,
    isSeeking: false,
    rafId: null,
    pendingPlayCmd: null,
    pendingPlayTimer: null,
    reconnectAttempts: 0,
    reconnectTimer: null,
    roomLatency: { roomMaxLatencyMs: 0, slowestLabel: 'Хост', bluetoothCount: 0, deviceCount: 1 },
  };

  const darkThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');

  /* ==================== ПОДСИСТЕМЫ ==================== */

  // Wake Lock работает полностью автоматически в фоне без лишних индикаторов
  const wakeLock = new WakeLockManager(() => {});

  const audio = new AudioEngine({
    onDrift: (driftMs, mode) => updateDriftMetric(driftMs, mode),
    onEnded: () => handleTrackEnded(),
    onStateChange: ({ playing }) => updatePlaybackUI(playing),
    onLatencyChange: () => {
      if (state.role) sendLocalLatencyToHost();
    },
  });

  let clock = null;

  const network = new NetworkManager({
    onPeersChanged: (peers) => renderPeerList(peers),

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

    onHostConnected: () => {
      state.reconnectAttempts = 0;
      if (state.reconnectTimer) {
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = null;
      }
      setStatusMetric('Синхронизация', 'metric-warn');
      ui.btnListenerReconnect.classList.add('hidden');
      ui.listenerBannerText.textContent = 'Синхронизация с комнатой...';
      sendLocalLatencyToHost();
    },

    onHostDisconnected: () => {
      audio.pause();
      if (clock) clock.stop();
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

    onFileProgress: ({ trackId, name, pct, isActive }) => {
      if (!isActive && trackId !== state.activeTrackId) return;
      if (pct === 0 && trackId === state.activeTrackId) {
        clearPendingPlay();
        audio.pause(0);
      }
      ui.trackTitle.textContent = name;
      ui.trackSub.textContent = 'Загрузка аудио...';
      showTransfer(true, 'Загрузка', pct);
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
  }

  function showToast(text, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${type === 'error' ? 'toast-error' : type === 'success' ? 'toast-success' : ''}`;
    el.textContent = text;
    ui.toastContainer.appendChild(el);
    setTimeout(() => el.remove(), 3400);
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

  /* ==================== ЗАПУСК ХОСТА ==================== */

  async function enterAsHost() {
    ui.btnCreateRoom.disabled = true;
    ui.btnCreateRoom.textContent = 'Создание...';

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

      setStatusMetric('Активна', 'metric-good');
      ui.metricRtt.textContent = '0 мс';
      ui.metricDrift.textContent = '0 мс';

      sendLocalLatencyToHost();
      renderPlaylist();
      renderPeerList([]);
      showView('room');
      startRenderLoop();
      showToast(`Комната ${NetworkManager.formatCode(code)} создана`, 'success');
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
        onUpdate: ({ rttMs, sampleCount }) => {
          const rttRound = Math.round(rttMs);
          ui.metricRtt.textContent = `${rttRound} мс`;
          ui.metricRtt.className = `metric-value mono ${
            rttRound < 50 ? 'metric-good' : rttRound < 130 ? 'metric-warn' : 'metric-bad'
          }`;
          setStatusMetric('Синхронизирован', 'metric-good');

          network.sendToHost({ type: 'CLIENT_METRICS', rttMs: rttRound }, 'ctrl');

          // Запускаем отложенный Late Join как только часы надёжно откалиброваны
          const minSamples = network.hostTransport === 'relay' ? 2 : 4;
          if (
            state.pendingPlayCmd &&
            audio.buffer &&
            state.activeTrackId === state.pendingPlayCmd.trackId &&
            sampleCount >= minSamples
          ) {
            const cmd = state.pendingPlayCmd;
            clearPendingPlay();
            executeScheduledPlay(cmd);
          } else if (audio.isScheduled) {
            audio.refineScheduledStart();
          } else if (audio.isPlaying && sampleCount <= 12) {
            // При раннем уточнении NTP во время Late Join сразу поджимаем дрейф
            audio.checkDrift();
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

      ui.trackTitle.textContent = 'Ожидание трека';
      ui.trackSub.textContent = 'Подключено к комнате';
      ui.listenerBannerText.textContent = 'Синхронизация часов...';

      renderPlaylist();
      showView('room');
      startRenderLoop();
      showToast(`Подключено к ${NetworkManager.formatCode(code)}`, 'success');
    } catch (err) {
      const msg = err.message || 'Не удалось подключиться';
      setConnectStatus(msg, true);
      showToast(msg, 'error');
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
        showToast(`Файл «${file.name}» больше 40 МБ — загрузка займёт больше времени`, 'error');
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
        network.setHostPlaylist(state.playlist, state.activeTrackId);
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
        network.setHostPlaylist(state.playlist, state.activeTrackId);
        renderPlaylist();
      }
      showToast('Трек добавлен', 'success');
    } catch (_) {
      showTransfer(false);
      showToast('Не удалось загрузить ссылку (проверьте CORS)', 'error');
    }
  }

  async function hostSelectTrack(trackId, autoPlay = false) {
    const track = state.playlist.find((t) => t.id === trackId);
    if (!track) return;

    audio.pause(0);
    network.broadcastPause({ trackOffset: 0 });

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
        ? `${formatTime(decoded.duration)} • ${(track.size / 1024 / 1024).toFixed(1)} МБ`
        : formatTime(decoded.duration);

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
        showTransfer(true, 'Декодирование...', 90);
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
    if (isCurrentlyActive()) {
      showTransfer(true, 'Декодирование...', 96);
      network.sendToHost({ type: 'TRACK_PROGRESS', trackId, progress: 96, phase: 'decoding' });
    }
    try {
      const decoded = await audio.decodeToCache(trackId, buffer);
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
    } catch (err) {
      console.error('[App/Listener] Decode error:', err);
      if (isCurrentlyActive()) showTransfer(false);
      network.sendToHost({ type: 'TRACK_ERROR', trackId });
      if (isCurrentlyActive()) showToast('Ошибка декодирования трека', 'error');
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

    ui.playlistList.innerHTML = state.playlist
      .map((t, idx) => {
        const isActive = t.id === state.activeTrackId;
        const cached = audio.hasCachedTrack(t.id);
        const badge =
          state.role === 'listener'
            ? cached
              ? '<span class="track-pill ready">Готово</span>'
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

  /* ==================== ВОСПРОИЗВЕДЕНИЕ И LATE JOIN ==================== */

  function getEffectiveStartBufferMs() {
    const roomMax = Math.max(audio.getTotalOutputLatencyMs(), state.roomLatency.roomMaxLatencyMs || 0);
    return Math.max(MIN_START_BUFFER_MS, roomMax + 1100);
  }

  function hostSchedulePlay(trackOffset = audio.getAcousticPosition()) {
    if (!audio.buffer || !clock || !state.activeTrackId) return;

    const bufferMs = getEffectiveStartBufferMs();
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
    if (cmd.trackId && cmd.trackId !== state.activeTrackId && audio.hasCachedTrack(cmd.trackId)) {
      const decoded = audio.activateTrack(cmd.trackId);
      const meta = state.playlist.find((t) => t.id === cmd.trackId);
      if (decoded && meta) {
        state.activeTrackId = cmd.trackId;
        onTrackReadyUI(meta.name, formatTime(decoded.duration), decoded.duration);
        renderPlaylist();
      }
    }

    const minSamples = network.hostTransport === 'relay' ? 2 : 4;
    const clockReady = clock && clock.synced && (clock.samples.length >= minSamples || !cmd.isLateJoin);

    if (!audio.buffer || state.activeTrackId !== cmd.trackId || !clockReady) {
      clearPendingPlay();
      state.pendingPlayCmd = cmd;
      // Страховка для Late Join: если 4 пинга не успели прийти за 1.1 с, стартуем по текущему NTP
      if (cmd.isLateJoin) {
        state.pendingPlayTimer = setTimeout(() => {
          if (state.pendingPlayCmd && audio.buffer && state.activeTrackId === state.pendingPlayCmd.trackId && clock && clock.synced) {
            const c = state.pendingPlayCmd;
            clearPendingPlay();
            executeScheduledPlay(c);
          }
        }, 1100);
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
    const minSamples = network.hostTransport === 'relay' ? 2 : 4;
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

  /* ==================== СПИСОК УСТРОЙСТВ С ПРОЦЕНТАМИ ЗАГРУЗКИ ==================== */

  function renderPeerList(peers) {
    ui.peerCount.textContent = String(peers.length);

    if (peers.length === 0) {
      ui.peersOverallProgress.textContent = 'Ожидание';
      ui.peerList.innerHTML =
        '<li class="peer-empty">Пока никто не подключился. Покажите QR-код или отправьте ссылку.</li>';
      return;
    }

    const readyCount = peers.filter((p) => p.ready).length;
    const avgPct = Math.round(peers.reduce((acc, p) => acc + (p.progress || 0), 0) / peers.length);
    ui.peersOverallProgress.textContent =
      readyCount === peers.length ? `Готовы все (${readyCount}/${peers.length})` : `Загрузка ${avgPct}% (${readyCount}/${peers.length})`;

    ui.peerList.innerHTML = peers
      .map((p) => {
        const pct = Math.max(0, Math.min(100, Math.round(p.progress || 0)));
        const dotCls = p.phase === 'error' ? 'error' : p.ready ? 'ready' : '';
        const btChip = p.isBluetooth ? `<span class="peer-chip peer-chip-bt">BT ${p.latencyMs} мс</span>` : '';
        const netChip = p.transportLabel ? `<span class="peer-chip">${escapeHtml(p.transportLabel)}</span>` : '';

        return `
          <li class="peer-item">
            <div class="peer-top">
              <div class="peer-main">
                <span class="peer-status-dot ${dotCls}"></span>
                <div class="peer-title-row">
                  <strong>${escapeHtml(p.label)}</strong>
                  ${netChip}
                  ${btChip}
                </div>
              </div>
              <div class="peer-right mono">
                <span>${p.rttMs !== null ? `${p.rttMs} мс` : '—'}</span>
                <span class="peer-pct ${p.ready ? 'ready' : ''}">${pct}%</span>
              </div>
            </div>
            <div class="peer-progress-row">
              <div class="peer-progress-track">
                <div class="peer-progress-fill ${p.ready ? 'ready' : ''}" style="width: ${pct}%"></div>
              </div>
              <span class="peer-status-label">${escapeHtml(p.status)}</span>
            </div>
          </li>`;
      })
      .join('');
  }

  /* ==================== ВИЗУАЛИЗАТОР И ОТРИСОВКА ==================== */

  const freqBins = new Uint8Array(64);

  function startRenderLoop() {
    if (state.rafId) cancelAnimationFrame(state.rafId);

    const canvas = ui.visualizerCanvas;
    const ctx2d = canvas.getContext('2d');

    const tick = () => {
      const countdown = audio.getCountdownSec();
      if (countdown > 0.02) {
        ui.countdownBadge.classList.remove('hidden');
        ui.countdownBadge.textContent = `${countdown.toFixed(1)}с`;
        if (state.role === 'listener') {
          ui.listenerBannerText.textContent = `Старт через ${countdown.toFixed(1)} с`;
        }
      } else {
        ui.countdownBadge.classList.add('hidden');
        if (state.role === 'listener' && audio.isPlaying) {
          ui.listenerBannerText.textContent = 'Синхронное воспроизведение';
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

      const isDark = darkThemeQuery.matches;
      const hasAudio = audio.isPlaying && audio.getFrequencyData(freqBins);
      const barCount = 42;
      const gap = 5;
      const barWidth = (w - gap * (barCount - 1)) / barCount;

      for (let i = 0; i < barCount; i++) {
        const val = hasAudio ? freqBins[i] / 255 : 0.06;
        const barH = Math.max(4, val * (h - 14));
        const x = i * (barWidth + gap);
        const y = (h - barH) / 2;

        if (hasAudio) {
          ctx2d.fillStyle = isDark ? '#0a84ff' : '#007aff';
        } else {
          ctx2d.fillStyle = isDark ? 'rgba(255, 255, 255, 0.14)' : 'rgba(0, 0, 0, 0.12)';
        }
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
    clearPendingPlay();
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
      if (id === state.activeTrackId) {
        if (audio.isPlaying) hostPause();
        else hostSchedulePlay(audio.getAcousticPosition());
      } else {
        hostSelectTrack(id, audio.isPlaying);
      }
    }
  });

  ui.btnPlayPause.addEventListener('click', () => {
    if (!audio.buffer) return;
    if (audio.isPlaying) hostPause();
    else hostSchedulePlay(audio.getAcousticPosition());
  });

  ui.btnPrevTrack.addEventListener('click', () => {
    if (!audio.buffer) return;
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
