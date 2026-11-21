/**
 * Orpheus Sync — главный контроллер интерфейса и координация модулей.
 */
(() => {
  const START_BUFFER_MS = 2800; // Буфер запланированного старта (2.8 сек)

  const $ = (id) => document.getElementById(id);

  // DOM элементы
  const ui = {
    viewLanding: $('viewLanding'),
    viewInviteUnlock: $('viewInviteUnlock'),
    viewRoom: $('viewRoom'),

    btnHome: $('btnHome'),
    btnLeaveRoom: $('btnLeaveRoom'),
    wakeLockBadge: $('wakeLockBadge'),

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
    btnToggleUrlInput: $('btnToggleUrlInput'),
    urlTrackForm: $('urlTrackForm'),
    inputAudioUrl: $('inputAudioUrl'),

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
    btnRestart: $('btnRestart'),
    btnPlayPause: $('btnPlayPause'),
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

    manualOffsetVal: $('manualOffsetVal'),
    btnResetOffset: $('btnResetOffset'),

    hostPeersSection: $('hostPeersSection'),
    peerCount: $('peerCount'),
    peerList: $('peerList'),
    toastContainer: $('toastContainer'),
  };

  // Состояние приложения
  const state = {
    role: null,
    roomCode: null,
    currentTrackId: null,
    isSeeking: false,
    rafId: null,
    pendingPlayCmd: null, // Если команда PLAY пришла до завершения декодирования трека
  };

  // Инициализация подсистем
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
    onEnded: () => {
      updatePlaybackUI(false);
      if (state.role === 'host') {
        network.broadcastPause({ trackOffset: 0 });
      }
    },
    onStateChange: ({ playing }) => updatePlaybackUI(playing),
  });

  let clock = null;

  const network = new NetworkManager({
    onPeersChanged: (peers) => renderPeerList(peers),
    onHostConnected: () => {
      setStatusMetric('Синхронизация...', 'metric-warn');
      ui.btnListenerReconnect.classList.add('hidden');
      ui.listenerBannerText.textContent = 'Подключено! Калибровка часов...';
    },
    onHostDisconnected: () => {
      audio.pause();
      if (clock) clock.stop();
      setStatusMetric('Отключён', 'metric-bad');
      ui.listenerBannerText.textContent = 'Связь с Хостом потеряна.';
      ui.btnListenerReconnect.classList.remove('hidden');
      showToast('Соединение с Хостом разорвано', 'error');
    },
    onSyncPong: (msg) => {
      if (clock) clock.handlePong(msg);
    },
    onTrackDemo: async ({ trackId, name }) => {
      await handleListenerDemoTrack(trackId, name);
    },
    onTrackUrl: async ({ trackId, name, url }) => {
      await handleListenerUrlTrack(trackId, name, url);
    },
    onFileProgress: ({ name, pct }) => {
      if (pct === 0) {
        state.pendingPlayCmd = null;
        audio.pause(0);
      }
      ui.trackTitle.textContent = name;
      ui.trackSub.textContent = 'Приём аудиофайла от Хоста (WebRTC P2P)...';
      showTransfer(true, `Загрузка от Хоста...`, pct);
    },
    onFileComplete: async ({ trackId, name, buffer }) => {
      await handleListenerFileComplete(trackId, name, buffer);
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

  /* ==================== НАВИГАЦИЯ И ИНИЦИАЛИЗАЦИЯ ==================== */

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
    setTimeout(() => el.remove(), 3600);
  }

  function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function buildShareUrl(code) {
    const base = `${window.location.origin}${window.location.pathname}`;
    return `${base}?room=${NetworkManager.normalizeCode(code)}`;
  }

  function updateManualOffsetUI() {
    const val = audio.manualOffsetMs;
    const sign = val > 0 ? '+' : '';
    ui.manualOffsetVal.textContent = `${sign}${val} мс`;
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
    else if (abs > 15 || mode === 'nudging') cls = 'metric-warn';
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

  /* ==================== ЗАПУСК ХОСТА ==================== */

  async function enterAsHost() {
    ui.btnCreateRoom.disabled = true;
    ui.btnCreateRoom.textContent = 'Создание комнаты...';

    try {
      // 1. Разблокируем Web Audio и Wake Lock прямо в клике
      await audio.unlock();
      wakeLock.acquire();

      // 2. Поднимаем PeerJS-хост
      const code = await network.startHost();
      state.role = 'host';
      state.roomCode = code;

      clock = new ClockSync({ isHost: true });

      // 3. Обновляем URL (без перезагрузки) и интерфейс
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
      ui.listenerPlaybackBanner.classList.add('hidden');
      ui.qrPanel.classList.remove('hidden'); // Показываем QR сразу для удобства

      setStatusMetric('Комната активна', 'metric-good');
      ui.metricRtt.textContent = '0 мс (Хост)';
      ui.metricOffset.textContent = '0 мс';
      ui.metricDrift.textContent = '0 мс';

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

  async function enterAsListener(rawCode) {
    const code = NetworkManager.normalizeCode(rawCode);
    if (code.length < 4) {
      const msg = 'Введите 6-значный код комнаты (например, K7M-4PX)';
      setConnectStatus(msg, true);
      showToast(msg, 'error');
      return;
    }

    ui.btnJoinRoom.disabled = true;
    ui.btnUnlockAndJoin.disabled = true;
    ui.btnJoinRoom.textContent = 'Подключение...';
    ui.btnUnlockAndJoin.textContent = 'Подключение...';
    setConnectStatus('Разблокировка звука...');

    try {
      // 1. КРИТИЧНО: Разблокируем AudioContext строго внутри обработчика клика!
      await audio.unlock();
      wakeLock.acquire();

      // Если скрипт PeerJS ещё догружается с резервного CDN — подождём до 3 сек
      if (typeof Peer === 'undefined') {
        setConnectStatus('Загрузка PeerJS...');
        const startWait = Date.now();
        while (typeof Peer === 'undefined' && Date.now() - startWait < 3000) {
          await new Promise((r) => setTimeout(r, 150));
        }
      }

      // 2. Подключаемся к Хосту по WebRTC DataChannel с отображением шагов
      await network.joinAsListener(code, (progressText) => {
        setConnectStatus(progressText, false);
      });
      setConnectStatus('');
      state.role = 'listener';
      state.roomCode = code;

      // 3. Запускаем NTP-калибровку часов
      clock = new ClockSync({
        isHost: false,
        sendPing: (payload) => network.sendToHost(payload),
        onUpdate: ({ offsetMs, rttMs }) => {
          const rttRound = Math.round(rttMs);
          ui.metricRtt.textContent = `${rttRound} мс`;
          ui.metricRtt.className = `metric-value mono ${
            rttRound < 40 ? 'metric-good' : rttRound < 100 ? 'metric-warn' : 'metric-bad'
          }`;

          const offRound = Math.round(offsetMs);
          ui.metricOffset.textContent = `${offRound > 0 ? '+' : ''}${offRound} мс`;
          setStatusMetric('Синхронизирован', 'metric-good');

          network.sendToHost({ type: 'CLIENT_METRICS', rttMs: rttRound });

          // Если команда PLAY пришла раньше завершения первичной сверки часов
          if (state.pendingPlayCmd && audio.buffer && state.currentTrackId === state.pendingPlayCmd.trackId) {
            const cmd = state.pendingPlayCmd;
            state.pendingPlayCmd = null;
            executeScheduledPlay(cmd);
          } else if (audio.isScheduled) {
            // Уточняем запланированный старт, пока идёт обратный отсчёт
            audio.refineScheduledStart();
          }
        },
      });
      clock.start();

      // 4. Настраиваем UI слушателя
      ui.roleBadge.textContent = 'СЛУШАТЕЛЬ';
      ui.roleBadge.className = 'role-badge listener';
      ui.displayRoomCode.textContent = NetworkManager.formatCode(code);

      ui.hostShareActions.classList.add('hidden');
      ui.qrPanel.classList.add('hidden');
      ui.hostTrackSection.classList.add('hidden');
      ui.hostPlaybackControls.classList.add('hidden');
      ui.hostPeersSection.classList.add('hidden');
      ui.listenerPlaybackBanner.classList.remove('hidden');
      ui.seekSlider.disabled = true;

      ui.trackTitle.textContent = 'Ожидание трека от Хоста';
      ui.trackSub.textContent = 'Как только Хост выберет музыку, она загрузится автоматически';
      ui.listenerBannerText.textContent = 'Калибровка часов с Хостом...';

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

  /* ==================== ЗАГРУЗКА ТРЕКОВ (ХОСТ) ==================== */

  async function hostLoadFile(file) {
    if (!file) return;
    if (file.size > 40 * 1024 * 1024) {
      showToast('Файл больше 40 МБ может долго передаваться по P2P. Рекомендуем MP3 до 15 МБ.', 'error');
    }

    audio.pause(0);
    network.broadcastPause({ trackOffset: 0 });
    showTransfer(true, 'Декодирование аудиофайла...', 50);

    try {
      const arrayBuffer = await file.arrayBuffer();
      const decoded = await audio.decodeArrayBuffer(arrayBuffer);

      const trackId = `file-${file.name}-${file.size}-${file.lastModified}`;
      state.currentTrackId = trackId;

      onTrackReadyUI(file.name, `${formatTime(decoded.duration)} • ${(file.size / 1024 / 1024).toFixed(1)} МБ • Локальный файл`, decoded.duration);
      showTransfer(false);

      network.setHostTrack({
        id: trackId,
        type: 'file',
        name: file.name,
        mime: file.type || 'audio/mpeg',
        size: file.size,
        buffer: arrayBuffer,
      });

      showToast('Трек готов и отправляется слушателям', 'success');
    } catch (err) {
      showTransfer(false);
      showToast('Не удалось декодировать аудиофайл. Попробуйте MP3/WAV/M4A.', 'error');
      console.error(err);
    }
  }

  async function hostLoadDemoTrack() {
    audio.pause(0);
    network.broadcastPause({ trackOffset: 0 });
    showTransfer(true, 'Генерация 120 BPM тест-бита...', 60);

    try {
      const decoded = await audio.generateDemoTrack();
      const trackId = 'demo-120bpm-v1';
      state.currentTrackId = trackId;

      onTrackReadyUI('Встроенный тест-бит (120 BPM)', '32 сек • Синтез без трафика • Идеально для проверки синхрона', decoded.duration);
      showTransfer(false);

      network.setHostTrack({
        id: trackId,
        type: 'demo',
        name: 'Встроенный тест-бит (120 BPM)',
      });

      showToast('Тест-бит готов! Жмите «Старт» для проверки синхронности.', 'success');
    } catch (err) {
      showTransfer(false);
      showToast('Ошибка генерации тест-трека', 'error');
    }
  }

  async function hostLoadUrlTrack(url) {
    audio.pause(0);
    network.broadcastPause({ trackOffset: 0 });
    showTransfer(true, 'Загрузка аудио по URL...', 35);

    try {
      const resp = await fetch(url, { mode: 'cors' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const arrayBuffer = await resp.arrayBuffer();
      showTransfer(true, 'Декодирование аудио...', 80);
      const decoded = await audio.decodeArrayBuffer(arrayBuffer);

      const cleanName = decodeURIComponent(url.split('/').pop().split('?')[0] || 'Аудио по ссылке');
      const trackId = `url-${url}`;
      state.currentTrackId = trackId;

      onTrackReadyUI(cleanName, `${formatTime(decoded.duration)} • Прямая ссылка (CORS)`, decoded.duration);
      showTransfer(false);

      network.setHostTrack({
        id: trackId,
        type: 'url',
        name: cleanName,
        url,
      });

      showToast('Аудио по URL загружено!', 'success');
    } catch (err) {
      showTransfer(false);
      showToast('Не удалось загрузить URL (проверьте CORS-заголовки или выберите локальный файл)', 'error');
    }
  }

  /* ==================== ЗАГРУЗКА ТРЕКОВ (СЛУШАТЕЛЬ) ==================== */

  async function handleListenerDemoTrack(trackId, name) {
    audio.pause(0);
    showTransfer(true, 'Локальный синтез тест-бита...', 60);
    try {
      const decoded = await audio.generateDemoTrack();
      state.currentTrackId = trackId;
      onTrackReadyUI(name, `${formatTime(decoded.duration)} • Локальный синтез (0 КБ трафика)`, decoded.duration);
      showTransfer(false);
      ui.listenerBannerText.textContent = 'Трек готов. Ожидание старта от Хоста...';
      network.sendToHost({ type: 'TRACK_READY', trackId });
      tryApplyPendingPlay();
    } catch (err) {
      showTransfer(false);
      network.sendToHost({ type: 'TRACK_ERROR', trackId });
      showToast('Ошибка синтеза тест-трека', 'error');
    }
  }

  async function handleListenerUrlTrack(trackId, name, url) {
    audio.pause(0);
    showTransfer(true, 'Загрузка трека по URL...', 35);
    try {
      const resp = await fetch(url, { mode: 'cors' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = await resp.arrayBuffer();
      showTransfer(true, 'Декодирование аудио...', 85);
      const decoded = await audio.decodeArrayBuffer(buf);
      state.currentTrackId = trackId;
      onTrackReadyUI(name, `${formatTime(decoded.duration)} • Загружено по URL`, decoded.duration);
      showTransfer(false);
      ui.listenerBannerText.textContent = 'Трек готов. Ожидание старта от Хоста...';
      network.sendToHost({ type: 'TRACK_READY', trackId });
      tryApplyPendingPlay();
    } catch (err) {
      showTransfer(false);
      network.sendToHost({ type: 'TRACK_ERROR', trackId });
      showToast('Не удалось загрузить трек по ссылке', 'error');
    }
  }

  async function handleListenerFileComplete(trackId, name, buffer) {
    showTransfer(true, 'Декодирование аудио (Web Audio API)...', 100);
    try {
      const decoded = await audio.decodeArrayBuffer(buffer);
      state.currentTrackId = trackId;
      onTrackReadyUI(name, `${formatTime(decoded.duration)} • Получено от Хоста`, decoded.duration);
      showTransfer(false);
      ui.listenerBannerText.textContent = 'Трек готов. Ожидание старта от Хоста...';
      network.sendToHost({ type: 'TRACK_READY', trackId });
      tryApplyPendingPlay();
    } catch (err) {
      showTransfer(false);
      network.sendToHost({ type: 'TRACK_ERROR', trackId });
      showToast('Ошибка декодирования полученного файла', 'error');
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
      ui.btnRestart.disabled = false;
      ui.btnForceResync.disabled = false;
    }
  }

  /* ==================== ВОСПРОИЗВЕДЕНИЕ И СИНХРОНИЗАЦИЯ ==================== */

  function hostSchedulePlay(trackOffset = audio.getCurrentPosition()) {
    if (!audio.buffer || !clock) return;

    const hostStartTime = clock.hostNow() + START_BUFFER_MS;
    const clampedOffset = Math.max(0, Math.min(trackOffset, audio.getDuration() - 0.1));

    // Отправляем всем слушателям точное время старта в часах Хоста
    network.broadcastPlay({
      hostStartTime,
      trackOffset: clampedOffset,
      trackId: state.currentTrackId,
    });

    // И запускаем самого Хоста через тот же планировщик
    audio.schedulePlay({
      hostStartTime,
      trackOffset: clampedOffset,
      getHostTime: () => clock.hostNow(),
    });
  }

  function hostPause() {
    const pos = audio.getCurrentPosition();
    audio.pause(pos);
    network.broadcastPause({ trackOffset: pos });
  }

  function handleListenerPlayCmd(cmd) {
    // Если трек ещё декодируется или часы не откалиброваны — отложим команду до готовности
    if (!audio.buffer || state.currentTrackId !== cmd.trackId || !clock || !clock.synced) {
      state.pendingPlayCmd = cmd;
      return;
    }
    executeScheduledPlay(cmd);
  }

  function tryApplyPendingPlay() {
    if (state.pendingPlayCmd && clock && clock.synced && state.currentTrackId === state.pendingPlayCmd.trackId) {
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
    ui.iconPlay.classList.toggle('hidden', isPlaying);
    ui.iconPause.classList.toggle('hidden', !isPlaying);
    ui.playPauseLabel.textContent = isPlaying ? 'Пауза' : `Старт (+${(START_BUFFER_MS / 1000).toFixed(1)}с)`;
    ui.listenerPulse.classList.toggle('playing', isPlaying);
    if (!isPlaying) {
      ui.countdownBadge.classList.add('hidden');
    }
  }

  function renderPeerList(peers) {
    ui.peerCount.textContent = String(peers.length);
    if (peers.length === 0) {
      ui.peerList.innerHTML =
        '<li class="peer-empty">Пока никто не подключился. Покажите QR-код или отправьте ссылку друзьям.</li>';
      return;
    }

    ui.peerList.innerHTML = peers
      .map(
        (p) => `
      <li class="peer-item">
        <div class="peer-main">
          <span class="peer-status-dot ${p.ready ? 'ready' : ''}"></span>
          <strong>${p.label}</strong>
        </div>
        <div class="peer-meta">
          <span>${p.status}</span>
          <span class="mono">${p.rttMs !== null ? `${p.rttMs} мс` : '—'}</span>
        </div>
      </li>`
      )
      .join('');
  }

  /* ==================== ЦИКЛ ОТРИСОВКИ (ПРОГРЕСС + ВИЗУАЛИЗАТОР) ==================== */

  const freqBins = new Uint8Array(64);

  function startRenderLoop() {
    if (state.rafId) cancelAnimationFrame(state.rafId);

    const canvas = ui.visualizerCanvas;
    const ctx2d = canvas.getContext('2d');

    const tick = () => {
      // 1. Обратный отсчёт перед стартом
      const countdown = audio.getCountdownSec();
      if (countdown > 0.02) {
        ui.countdownBadge.classList.remove('hidden');
        ui.countdownBadge.textContent = `Старт: ${countdown.toFixed(1)}с`;
        if (state.role === 'listener') {
          ui.listenerBannerText.textContent = `Запланированный старт через ${countdown.toFixed(1)} с...`;
        }
      } else {
        ui.countdownBadge.classList.add('hidden');
        if (state.role === 'listener' && audio.isPlaying) {
          ui.listenerBannerText.textContent = 'Синхронное воспроизведение с Хостом';
        }
      }

      // 2. Обновление бегунка времени
      if (audio.buffer && !state.isSeeking) {
        const pos = audio.getCurrentPosition();
        ui.timeCurrent.textContent = formatTime(pos);
        ui.seekSlider.value = String(pos);
      }

      // 3. Отрисовка частотного визуализатора
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
    network.destroy();
    wakeLock.release();

    state.role = null;
    state.roomCode = null;
    state.currentTrackId = null;
    state.pendingPlayCmd = null;

    ui.btnPlayPause.disabled = true;
    ui.btnRestart.disabled = true;
    ui.btnForceResync.disabled = true;
    ui.seekSlider.disabled = true;
    ui.seekSlider.value = '0';
    ui.timeCurrent.textContent = '0:00';
    ui.timeDuration.textContent = '0:00';
    ui.trackTitle.textContent = 'Трек не выбран';
    ui.trackSub.textContent = 'Ожидание загрузки аудио...';
    showTransfer(false);
    renderPeerList([]);

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

  // Копирование ссылки и QR
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
          title: 'Orpheus Sync — Слушаем вместе',
          text: `Подключайся к моей комнате ${NetworkManager.formatCode(state.roomCode)} для синхронного прослушивания!`,
          url,
        });
        return;
      } catch (_) {}
    }
    copyShareLink();
  });

  // Загрузка файлов (клик + Drag & Drop)
  ui.audioFileInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) hostLoadFile(file);
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
    const file = e.dataTransfer?.files?.[0];
    if (file) hostLoadFile(file);
  });

  ui.btnLoadDemoTrack.addEventListener('click', hostLoadDemoTrack);

  ui.btnToggleUrlInput.addEventListener('click', () => {
    ui.urlTrackForm.classList.toggle('hidden');
  });

  ui.urlTrackForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = ui.inputAudioUrl.value.trim();
    if (url) hostLoadUrlTrack(url);
  });

  // Кнопки управления плеером Хоста
  ui.btnPlayPause.addEventListener('click', () => {
    if (!audio.buffer) return;
    if (audio.isPlaying) {
      hostPause();
    } else {
      hostSchedulePlay(audio.getCurrentPosition());
    }
  });

  ui.btnRestart.addEventListener('click', () => {
    if (!audio.buffer) return;
    if (audio.isPlaying) {
      hostSchedulePlay(0);
    } else {
      audio.pause(0);
      ui.seekSlider.value = '0';
      ui.timeCurrent.textContent = '0:00';
      network.broadcastPause({ trackOffset: 0 });
    }
  });

  ui.btnForceResync.addEventListener('click', () => {
    if (!audio.buffer) return;
    if (audio.isPlaying) {
      hostSchedulePlay(audio.getCurrentPosition());
      showToast('Команда пересинхронизации отправлена всем', 'success');
    } else {
      showToast('Сначала нажмите Старт');
    }
  });

  // Перемотка (Seek) на Хосте
  ui.seekSlider.addEventListener('input', () => {
    state.isSeeking = true;
    ui.timeCurrent.textContent = formatTime(Number(ui.seekSlider.value));
  });

  ui.seekSlider.addEventListener('change', () => {
    state.isSeeking = false;
    const targetSec = Number(ui.seekSlider.value);
    if (state.role !== 'host' || !audio.buffer) return;

    if (audio.isPlaying) {
      hostSchedulePlay(targetSec);
    } else {
      audio.pause(targetSec);
      network.broadcastPause({ trackOffset: targetSec });
    }
  });

  // Переподключение слушателя
  ui.btnListenerReconnect.addEventListener('click', () => {
    if (state.roomCode) enterAsListener(state.roomCode);
  });

  // Локальная громкость
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

  // Ручная микро-коррекция (-50 / -10 / 0 / +10 / +50 мс)
  document.querySelectorAll('[data-nudge]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const delta = Number(btn.dataset.nudge);
      audio.nudgeManualOffset(delta);
      updateManualOffsetUI();
    });
  });

  ui.btnResetOffset.addEventListener('click', () => {
    audio.setManualOffset(0);
    updateManualOffsetUI();
  });

  // Авто-ресинк и восстановление AudioContext при возврате из фона (актуально для мобильных)
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && state.role) {
      await audio.ensureResumed();
      if (audio.isPlaying) {
        audio.checkDrift();
      }
    }
  });

  // Автоформат ввода кода комнаты
  ui.inputRoomCode.addEventListener('input', () => {
    const clean = NetworkManager.normalizeCode(ui.inputRoomCode.value);
    ui.inputRoomCode.value = clean.length > 3 ? `${clean.slice(0, 3)}-${clean.slice(3)}` : clean;
  });

  // Старт приложения: проверяем, есть ли ?room=CODE в адресной строке
  updateManualOffsetUI();
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
