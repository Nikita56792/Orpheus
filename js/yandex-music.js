/**
 * YandexMusicPanel v2 — встроенный модуль Яндекс Музыки (протокол SpolzerMod/yamusic-rs)
 * с авто-обновлением OAuth refreshToken, защитой от гонок запросов (AbortController + seq),
 * отображением активного трека / «в плейлисте», и чистым Apple HIG интерфейсом.
 */
(() => {
  const STORAGE_KEY = 'orpheus_ym_token_v1';
  const REFRESH_KEY = 'orpheus_ym_refresh_v1';

  function esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtDur(sec) {
    const s = Math.max(0, Math.floor(Number(sec || 0)));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function fmtArtists(raw) {
    return Array.isArray(raw) ? raw.join(', ') : String(raw || '');
  }

  class YandexMusicPanel {
    constructor({ rootEl, getServerBaseUrl, getPlaylistContext, onPlayTrack, onAddTrack, onAddManyTracks, onToast }) {
      this.rootEl = rootEl;
      this.getServerBaseUrl = getServerBaseUrl;
      this.getPlaylistContext = getPlaylistContext || (() => ({ activeTrackId: null, playing: false, trackIds: new Set() }));
      this.onPlayTrack = onPlayTrack || (() => {});
      this.onAddTrack = onAddTrack || (() => {});
      this.onAddManyTracks = onAddManyTracks || (() => {});
      this.onToast = onToast || (() => {});

      this.token = this._loadKey(STORAGE_KEY);
      this.refreshToken = this._loadKey(REFRESH_KEY);
      this.account = null;
      this.activeTab = 'chart';
      this.deviceAuth = null;
      this._pollTimer = null;
      this._searchTimer = null;
      this._loadedOnce = false;
      this._currentTracks = [];
      this._collectionStack = null;
      this._loadingTrackId = null;
      this._addingAll = false;
      this._reqSeq = 0;
      this._activeAbort = null;

      this._cache = {
        chart: null,
        likes: null,
        playlists: null,
        wave: null,
      };

      this._bindDOM();
    }

    _loadKey(k) {
      try {
        return (localStorage.getItem(k) || '').trim();
      } catch (_) {
        return '';
      }
    }

    _saveTokens(accessTok, refreshTok = null) {
      this.token = (accessTok || '').trim();
      if (refreshTok !== null) this.refreshToken = (refreshTok || '').trim();
      try {
        if (this.token) localStorage.setItem(STORAGE_KEY, this.token);
        else localStorage.removeItem(STORAGE_KEY);
        if (this.refreshToken) localStorage.setItem(REFRESH_KEY, this.refreshToken);
        else localStorage.removeItem(REFRESH_KEY);
      } catch (_) {}
    }

    getToken() {
      return this.token;
    }

    _apiUrl(path) {
      const base = (this.getServerBaseUrl() || 'https://158.160.205.107/orpheus').replace(/\/+$/, '');
      return `${base}${path}`;
    }

    async _tryRefreshToken() {
      if (!this.refreshToken) return false;
      try {
        const resp = await fetch(this._apiUrl('/api/ym/auth/refresh'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: this.refreshToken }),
        });
        const data = await resp.json().catch(() => null);
        if (resp.ok && data?.ok && data.accessToken) {
          this._saveTokens(data.accessToken, data.refreshToken || this.refreshToken);
          return true;
        }
      } catch (_) {}
      return false;
    }

    async _api(path, { method = 'GET', body = null, signal = undefined, allowRefresh = true } = {}) {
      const headers = {};
      if (this.token) headers['X-YM-Token'] = this.token;
      if (body !== null) headers['Content-Type'] = 'application/json';
      const resp = await fetch(this._apiUrl(path), {
        method,
        headers,
        body: body !== null ? JSON.stringify(body) : undefined,
        signal,
      });
      const data = await resp.json().catch(() => ({ ok: false, error: `HTTP ${resp.status}` }));
      if (resp.status === 401 && allowRefresh && this.refreshToken) {
        const refreshed = await this._tryRefreshToken();
        if (refreshed) {
          return this._api(path, { method, body, signal, allowRefresh: false });
        }
      }
      if (!resp.ok || data.ok === false) {
        const err = new Error(data.error || `Ошибка ${resp.status}`);
        err.status = resp.status;
        err.authRequired = Boolean(data.authRequired);
        throw err;
      }
      return data;
    }

    _nextRequestSignal() {
      if (this._activeAbort) {
        try { this._activeAbort.abort(); } catch (_) {}
      }
      this._activeAbort = new AbortController();
      return { seq: ++this._reqSeq, signal: this._activeAbort.signal };
    }

    _bindDOM() {
      if (!this.rootEl) return;
      this.elAuthBar = this.rootEl.querySelector('#ymAuthBar');
      this.elDeviceModal = this.rootEl.querySelector('#ymDeviceBox');
      this.elTokenForm = this.rootEl.querySelector('#ymTokenForm');
      this.elTokenInput = this.rootEl.querySelector('#ymTokenInput');
      this.elSearchForm = this.rootEl.querySelector('#ymSearchForm');
      this.elSearchInput = this.rootEl.querySelector('#ymSearchInput');
      this.elClearSearch = this.rootEl.querySelector('#btnYmClearSearch');
      this.elTabs = Array.from(this.rootEl.querySelectorAll('[data-ym-tab]'));
      this.elContent = this.rootEl.querySelector('#ymContent');

      for (const btn of this.elTabs) {
        btn.addEventListener('click', () => {
          const tab = btn.dataset.ymTab;
          if (tab) this.selectTab(tab);
        });
      }

      const syncClearBtn = () => {
        const hasText = Boolean((this.elSearchInput?.value || '').trim());
        this.elClearSearch?.classList.toggle('hidden', !hasText);
      };

      this.elClearSearch?.addEventListener('click', () => {
        if (this.elSearchInput) {
          this.elSearchInput.value = '';
          this.elSearchInput.focus();
        }
        syncClearBtn();
        if (this.activeTab === 'search') {
          this.elContent.innerHTML = `<div class="ym-empty">Введите название трека, исполнителя или альбома выше.</div>`;
        }
      });

      this.elSearchForm?.addEventListener('submit', (e) => {
        e.preventDefault();
        const q = (this.elSearchInput?.value || '').trim();
        if (q) {
          this.activeTab = 'search';
          this._updateTabButtons();
          this.runSearch(q);
        }
      });

      this.elSearchInput?.addEventListener('input', () => {
        syncClearBtn();
        const q = (this.elSearchInput?.value || '').trim();
        clearTimeout(this._searchTimer);
        if (!q) {
          if (this.activeTab === 'search') {
            this.elContent.innerHTML = `<div class="ym-empty">Введите название трека, исполнителя или альбома выше.</div>`;
          }
          return;
        }
        this._searchTimer = setTimeout(() => {
          this.activeTab = 'search';
          this._updateTabButtons();
          this.runSearch(q);
        }, 400);
      });

      this.elTokenForm?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const tok = (this.elTokenInput?.value || '').trim();
        if (!tok) return;
        await this.applyToken(tok, '');
      });
    }

    syncPlaybackState() {
      if (!this.elContent || this._currentTracks.length === 0) return;
      const ctx = this.getPlaylistContext();
      this.elContent.querySelectorAll('.ym-track-item').forEach((row) => {
        const idx = Number(row.dataset.ymIdx);
        const tr = this._currentTracks[idx];
        if (!tr) return;
        const fullId = `ym-${tr.id}`;
        const isCurrent = ctx.activeTrackId === fullId;
        const inPl = ctx.trackIds.has(fullId);
        row.classList.toggle('active', isCurrent);
        const addBtn = row.querySelector('[data-ym-add]');
        if (addBtn && !addBtn.disabled) {
          addBtn.textContent = inPl ? '✓' : '+';
          addBtn.classList.toggle('is-added', inPl);
        }
      });
    }

    async onOpen() {
      if (!this._loadedOnce) {
        this._loadedOnce = true;
        this._renderAuthBar();
        await Promise.all([this.refreshAccount(), this.selectTab(this.activeTab)]);
      } else {
        this.syncPlaybackState();
      }
    }

    async refreshAccount() {
      if (!this.token) {
        this.account = null;
        this._renderAuthBar();
        return;
      }
      try {
        const data = await this._api('/api/ym/account');
        this.account = data.authenticated ? data : null;
      } catch (err) {
        if (err.authRequired) {
          this._saveTokens('', '');
          this.account = null;
        }
      }
      this._renderAuthBar();
    }

    async applyToken(rawToken, refreshTok = null) {
      let tok = String(rawToken || '').trim();
      const m = tok.match(/access_token=([^&#\s]+)/i);
      if (m) tok = decodeURIComponent(m[1]);
      tok = tok.replace(/^OAuth\s+/i, '').trim();
      if (!tok) return;

      this._saveTokens(tok, refreshTok);
      this._cache = { chart: null, likes: null, playlists: null, wave: null };
      try {
        const data = await this._api('/api/ym/account');
        if (!data.authenticated) throw new Error('Токен недействителен');
        this.account = data;
        this.stopDeviceAuth();
        this.elTokenForm?.classList.add('hidden');
        if (this.elTokenInput) this.elTokenInput.value = '';
        this._renderAuthBar();
        this.onToast(`Яндекс Музыка: ${data.displayName || data.login}`, 'success');
        await this.selectTab(this.activeTab);
      } catch (err) {
        this._saveTokens('', '');
        this.account = null;
        this._renderAuthBar();
        this.onToast(err.message || 'Не удалось войти в Яндекс Музыку', 'error');
      }
    }

    async startDeviceAuthFlow() {
      this.stopDeviceAuth();
      if (this.elDeviceModal) {
        this.elDeviceModal.classList.remove('hidden');
        this.elDeviceModal.innerHTML = `<div class="ym-device-status">Запрос кода авторизации...</div>`;
      }
      try {
        const res = await this._api('/api/ym/auth/device/start', { method: 'POST', allowRefresh: false });
        this.deviceAuth = res;
        if (this.elDeviceModal) {
          const url = res.verificationUrl || 'https://ya.ru/device';
          this.elDeviceModal.innerHTML = `
            <div class="ym-device-head">
              <strong>Вход через Яндекс (ya.ru/device)</strong>
              <button type="button" class="mini-btn" id="btnYmCancelDevice" aria-label="Закрыть">✕</button>
            </div>
            <div class="ym-device-body">
              <div class="ym-device-code mono">${esc(res.userCode)}</div>
              <div class="ym-device-hint">
                Откройте <a href="${esc(url)}" target="_blank" rel="noopener" class="listener-apk-link">${esc(url)}</a> и введите код — вход произойдёт автоматически.
              </div>
              <div class="ym-device-actions">
                <a href="${esc(url)}" target="_blank" rel="noopener" class="btn btn-primary btn-xs">Открыть ya.ru/device</a>
                <button type="button" class="btn btn-secondary btn-xs" id="btnYmCopyCode">Скопировать код</button>
              </div>
            </div>
          `;
          this.elDeviceModal.querySelector('#btnYmCancelDevice')?.addEventListener('click', () => this.stopDeviceAuth());
          this.elDeviceModal.querySelector('#btnYmCopyCode')?.addEventListener('click', async () => {
            try {
              await navigator.clipboard.writeText(res.userCode);
              this.onToast('Код скопирован', 'success');
            } catch (_) {}
          });
        }

        const intervalMs = Math.max(3500, (Number(res.interval) || 5) * 1000);
        const expiresAt = Date.now() + (Number(res.expiresIn) || 300) * 1000;

        const pollOnce = async () => {
          if (!this.deviceAuth) return;
          if (Date.now() > expiresAt) {
            this.stopDeviceAuth();
            this.onToast('Время кода истекло, попробуйте снова', 'error');
            return;
          }
          try {
            const p = await this._api('/api/ym/auth/device/poll', {
              method: 'POST',
              body: { deviceCode: this.deviceAuth.deviceCode },
              allowRefresh: false,
            });
            if (p.status === 'done' && p.accessToken) {
              await this.applyToken(p.accessToken, p.refreshToken || '');
              return;
            }
            if (p.status === 'failed') {
              this.stopDeviceAuth();
              this.onToast(p.error || 'Авторизация отменена', 'error');
              return;
            }
          } catch (_) {}
          this._pollTimer = setTimeout(pollOnce, intervalMs);
        };
        this._pollTimer = setTimeout(pollOnce, intervalMs);
      } catch (err) {
        this.stopDeviceAuth();
        this.onToast(err.message || 'Не удалось начать авторизацию', 'error');
      }
    }

    stopDeviceAuth() {
      this.deviceAuth = null;
      if (this._pollTimer) {
        clearTimeout(this._pollTimer);
        this._pollTimer = null;
      }
      this.elDeviceModal?.classList.add('hidden');
    }

    logout() {
      this.stopDeviceAuth();
      this._saveTokens('', '');
      this.account = null;
      this._cache = { chart: null, likes: null, playlists: null, wave: null };
      this._renderAuthBar();
      this.onToast('Выход из Яндекс Музыки выполнен');
      this.selectTab('chart');
    }

    _renderAuthBar() {
      if (!this.elAuthBar) return;
      if (this.account) {
        const name = this.account.displayName || this.account.login || 'Яндекс Аккаунт';
        const plus = this.account.hasPlus ? `<span class="ym-plus-pill">Плюс</span>` : '';
        this.elAuthBar.innerHTML = `
          <div class="ym-auth-info">
            <span class="ym-logo-badge">Я</span>
            <span class="ym-user-name">${esc(name)}</span>
            ${plus}
          </div>
          <button type="button" class="btn btn-ghost btn-xs" id="btnYmLogout">Выйти</button>
        `;
        this.elAuthBar.querySelector('#btnYmLogout')?.addEventListener('click', () => this.logout());
      } else {
        this.elAuthBar.innerHTML = `
          <div class="ym-auth-info">
            <span class="ym-logo-badge">Я</span>
            <span class="ym-auth-hint">Без входа доступны превью 30 с · войдите для полных HQ-треков и «Моей волны»</span>
          </div>
          <div class="ym-auth-btns">
            <button type="button" class="btn btn-primary btn-xs" id="btnYmDeviceLogin">Войти</button>
            <button type="button" class="btn btn-secondary btn-xs" id="btnYmToggleToken">Токен</button>
          </div>
        `;
        this.elAuthBar.querySelector('#btnYmDeviceLogin')?.addEventListener('click', () => this.startDeviceAuthFlow());
        this.elAuthBar.querySelector('#btnYmToggleToken')?.addEventListener('click', () => {
          this.elTokenForm?.classList.toggle('hidden');
        });
      }
    }

    _updateTabButtons() {
      for (const btn of this.elTabs) {
        const active = btn.dataset.ymTab === this.activeTab;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-selected', String(active));
      }
    }

    async selectTab(tab) {
      this.activeTab = tab;
      this._collectionStack = null;
      this._updateTabButtons();

      if (!this.elContent) return;

      if (tab === 'search') {
        const q = (this.elSearchInput?.value || '').trim();
        if (q) {
          await this.runSearch(q);
        } else {
          this.elContent.innerHTML = `<div class="ym-empty">Введите название трека, исполнителя или альбома выше.</div>`;
          this.elSearchInput?.focus();
        }
        return;
      }

      if (tab === 'chart') {
        if (this._cache.chart) {
          this._renderTrackList(this._cache.chart, { heading: 'Чарт Яндекс Музыки' });
          return;
        }
        const { seq, signal } = this._nextRequestSignal();
        this._setLoading('Загрузка чарта...');
        try {
          const data = await this._api('/api/ym/chart', { signal });
          if (seq !== this._reqSeq) return;
          this._cache.chart = data.tracks || [];
          this._renderTrackList(this._cache.chart, { heading: 'Чарт Яндекс Музыки' });
        } catch (err) {
          if (err.name !== 'AbortError' && seq === this._reqSeq) this._setError(err.message);
        }
        return;
      }

      if (!this.token) {
        this._setAuthNeeded();
        return;
      }

      if (tab === 'wave') {
        const { seq, signal } = this._nextRequestSignal();
        this._setLoading('Настройка «Моей волны»...');
        try {
          const data = await this._api('/api/ym/wave', { signal });
          if (seq !== this._reqSeq) return;
          this._cache.wave = data.tracks || [];
          this._renderTrackList(this._cache.wave, { heading: 'Моя волна', showRefreshWave: true });
        } catch (err) {
          if (err.name === 'AbortError' || seq !== this._reqSeq) return;
          if (err.authRequired) this._setAuthNeeded();
          else this._setError(err.message);
        }
        return;
      }

      if (tab === 'likes') {
        if (this._cache.likes) {
          this._renderTrackList(this._cache.likes, { heading: 'Мне нравится' });
          return;
        }
        const { seq, signal } = this._nextRequestSignal();
        this._setLoading('Загрузка любимых треков...');
        try {
          const data = await this._api('/api/ym/likes?limit=100', { signal });
          if (seq !== this._reqSeq) return;
          this._cache.likes = data.tracks || [];
          this._renderTrackList(this._cache.likes, { heading: 'Мне нравится' });
        } catch (err) {
          if (err.name === 'AbortError' || seq !== this._reqSeq) return;
          if (err.authRequired) this._setAuthNeeded();
          else this._setError(err.message);
        }
        return;
      }

      if (tab === 'playlists') {
        if (this._cache.playlists) {
          this._renderPlaylistsGrid(this._cache.playlists);
          return;
        }
        const { seq, signal } = this._nextRequestSignal();
        this._setLoading('Загрузка плейлистов...');
        try {
          const data = await this._api('/api/ym/playlists', { signal });
          if (seq !== this._reqSeq) return;
          this._cache.playlists = data.playlists || [];
          this._renderPlaylistsGrid(this._cache.playlists);
        } catch (err) {
          if (err.name === 'AbortError' || seq !== this._reqSeq) return;
          if (err.authRequired) this._setAuthNeeded();
          else this._setError(err.message);
        }
      }
    }

    async runSearch(query) {
      this._collectionStack = null;
      const { seq, signal } = this._nextRequestSignal();
      this._setLoading(`Поиск «${query}»...`);
      try {
        const data = await this._api(`/api/ym/search?q=${encodeURIComponent(query)}`, { signal });
        if (seq !== this._reqSeq) return;
        const tracks = data.tracks || [];
        const albums = data.albums || [];
        const playlists = data.playlists || [];
        this._currentTracks = tracks;

        if (!tracks.length && !albums.length && !playlists.length) {
          this.elContent.innerHTML = `<div class="ym-empty">По запросу «${esc(query)}» ничего не найдено.</div>`;
          return;
        }

        let html = '';
        if (tracks.length) {
          html += `<div class="ym-subhead"><span>Треки (${tracks.length})</span></div>`;
          html += this._buildTrackListHtml(tracks);
        }
        if (albums.length) {
          html += `<div class="ym-subhead"><span>Альбомы</span></div><div class="ym-cards-row">`;
          html += albums
            .slice(0, 8)
            .map(
              (a) => `
              <button type="button" class="ym-col-card" data-ym-album="${esc(a.id)}">
                ${a.coverUrl ? `<img class="ym-col-cover" src="${esc(a.coverUrl)}" alt="" loading="lazy" />` : `<div class="ym-col-cover ym-cover-ph">♪</div>`}
                <div class="ym-col-title">${esc(a.title)}</div>
                <div class="ym-col-sub">${esc(fmtArtists(a.artists) || (a.year ? String(a.year) : ''))}</div>
              </button>`
            )
            .join('');
          html += `</div>`;
        }
        if (playlists.length) {
          html += `<div class="ym-subhead"><span>Плейлисты</span></div><div class="ym-cards-row">`;
          html += playlists
            .slice(0, 8)
            .map(
              (p) => `
              <button type="button" class="ym-col-card" data-ym-pl-uid="${esc(p.uid)}" data-ym-pl-kind="${esc(p.kind)}">
                ${p.coverUrl ? `<img class="ym-col-cover" src="${esc(p.coverUrl)}" alt="" loading="lazy" />` : `<div class="ym-col-cover ym-cover-ph">♫</div>`}
                <div class="ym-col-title">${esc(p.title)}</div>
                <div class="ym-col-sub">${p.trackCount ? `${p.trackCount} треков` : esc(p.owner || '')}</div>
              </button>`
            )
            .join('');
          html += `</div>`;
        }

        this.elContent.innerHTML = html;
        this._bindContentEvents();
      } catch (err) {
        if (err.name !== 'AbortError' && seq === this._reqSeq) this._setError(err.message);
      }
    }

    async openPlaylist(uid, kind) {
      const { seq, signal } = this._nextRequestSignal();
      this._setLoading('Загрузка плейлиста...');
      try {
        const data = await this._api(`/api/ym/playlists/${encodeURIComponent(uid)}/${encodeURIComponent(kind)}`, { signal });
        if (seq !== this._reqSeq) return;
        this._collectionStack = { title: data.title || 'Плейлист', tracks: data.tracks || [] };
        this._renderTrackList(this._collectionStack.tracks, {
          heading: this._collectionStack.title,
          showBack: true,
        });
      } catch (err) {
        if (err.name !== 'AbortError' && seq === this._reqSeq) this._setError(err.message);
      }
    }

    async openAlbum(albumId) {
      const { seq, signal } = this._nextRequestSignal();
      this._setLoading('Загрузка альбома...');
      try {
        const data = await this._api(`/api/ym/albums/${encodeURIComponent(albumId)}`, { signal });
        if (seq !== this._reqSeq) return;
        this._collectionStack = { title: data.title || 'Альбом', tracks: data.tracks || [] };
        this._renderTrackList(this._collectionStack.tracks, {
          heading: this._collectionStack.title,
          showBack: true,
        });
      } catch (err) {
        if (err.name !== 'AbortError' && seq === this._reqSeq) this._setError(err.message);
      }
    }

    _renderPlaylistsGrid(playlists) {
      if (!playlists.length) {
        this.elContent.innerHTML = `<div class="ym-empty">У аккаунта пока нет плейлистов.</div>`;
        return;
      }
      this.elContent.innerHTML = `<div class="ym-cards-grid">${playlists
        .map(
          (p) => `
          <button type="button" class="ym-col-card" data-ym-pl-uid="${esc(p.uid)}" data-ym-pl-kind="${esc(p.kind)}">
            ${p.coverUrl ? `<img class="ym-col-cover" src="${esc(p.coverUrl)}" alt="" loading="lazy" />` : `<div class="ym-col-cover ym-cover-ph">♫</div>`}
            <div class="ym-col-title">${esc(p.title)}</div>
            <div class="ym-col-sub">${p.trackCount || 0} треков</div>
          </button>`
        )
        .join('')}</div>`;
      this._bindContentEvents();
    }

    _buildTrackListHtml(tracks) {
      const ctx = this.getPlaylistContext();
      return `<ul class="ym-track-list">${tracks
        .map((t, idx) => {
          const artists = fmtArtists(t.artists);
          const fullId = `ym-${t.id}`;
          const busy = this._loadingTrackId === String(t.id);
          const isCurrent = ctx.activeTrackId === fullId;
          const inPl = ctx.trackIds.has(fullId);
          return `
            <li class="ym-track-item ${busy ? 'loading' : ''} ${isCurrent ? 'active' : ''}" data-ym-idx="${idx}">
              ${
                t.coverUrl
                  ? `<img class="ym-cover" src="${esc(t.coverUrl)}" alt="" loading="lazy" />`
                  : `<div class="ym-cover ym-cover-ph">♪</div>`
              }
              <div class="ym-track-meta">
                <div class="ym-track-title">${esc(t.title)}${t.explicit ? ' <span class="ym-exp">E</span>' : ''}</div>
                <div class="ym-track-sub">${esc(artists || t.album || 'Яндекс Музыка')} · <span class="mono">${fmtDur(t.durationSec)}</span></div>
              </div>
              <div class="ym-track-actions">
                <button type="button" class="ym-icon-btn ym-icon-play" data-ym-play="${idx}" title="Транслировать выбранным устройствам" aria-label="Воспроизвести">
                  ${busy ? '…' : '▶'}
                </button>
                <button type="button" class="ym-icon-btn ym-icon-add ${inPl ? 'is-added' : ''}" data-ym-add="${idx}" title="Добавить в плейлист комнаты" aria-label="Добавить в плейлист">${inPl ? '✓' : '+'}</button>
              </div>
            </li>
          `;
        })
        .join('')}</ul>`;
    }

    _renderTrackList(tracks, { heading = '', showBack = false, showRefreshWave = false } = {}) {
      this._currentTracks = tracks || [];
      if (!this._currentTracks.length) {
        this.elContent.innerHTML = `<div class="ym-empty">Список треков пуст.</div>`;
        return;
      }

      const backBtn = showBack
        ? `<button type="button" class="btn btn-secondary btn-xs" id="btnYmBack">← Назад</button>`
        : '';
      const refreshBtn = showRefreshWave
        ? `<button type="button" class="btn btn-secondary btn-xs" id="btnYmWaveNext">Обновить волну</button>`
        : '';
      const batchCount = Math.min(12, this._currentTracks.length);
      const addAllBtn = `<button type="button" class="btn btn-secondary btn-xs" id="btnYmAddAll">+ ${batchCount} в плейлист</button>`;

      this.elContent.innerHTML = `
        <div class="ym-subhead">
          <div class="ym-subhead-left">${backBtn}<span>${esc(heading)} (${this._currentTracks.length})</span></div>
          <div class="ym-subhead-right">${refreshBtn}${addAllBtn}</div>
        </div>
        ${this._buildTrackListHtml(this._currentTracks)}
      `;
      this._bindContentEvents();
    }

    _bindContentEvents() {
      if (!this.elContent) return;

      this.elContent.querySelector('#btnYmBack')?.addEventListener('click', () => {
        this.selectTab(this.activeTab);
      });
      this.elContent.querySelector('#btnYmWaveNext')?.addEventListener('click', () => {
        this._cache.wave = null;
        this.selectTab('wave');
      });
      const addAllBtn = this.elContent.querySelector('#btnYmAddAll');
      addAllBtn?.addEventListener('click', async () => {
        if (this._addingAll) return;
        const subset = this._currentTracks.slice(0, 12);
        if (!subset.length) return;
        this._addingAll = true;
        addAllBtn.disabled = true;
        const origText = addAllBtn.textContent;
        try {
          await this.onAddManyTracks(subset, (done, total) => {
            addAllBtn.textContent = `Добавление ${done}/${total}...`;
          });
        } finally {
          this._addingAll = false;
          addAllBtn.disabled = false;
          addAllBtn.textContent = origText;
          this.syncPlaybackState();
        }
      });

      const triggerPlayRow = async (idx, playBtn) => {
        const tr = this._currentTracks[idx];
        if (!tr || this._loadingTrackId === String(tr.id)) return;
        this._loadingTrackId = String(tr.id);
        if (playBtn) {
          playBtn.textContent = '…';
          playBtn.disabled = true;
        }
        try {
          await this.onPlayTrack(tr);
        } finally {
          this._loadingTrackId = null;
          if (playBtn) {
            playBtn.textContent = '▶';
            playBtn.disabled = false;
          }
          this.syncPlaybackState();
        }
      };

      this.elContent.querySelectorAll('.ym-track-item').forEach((row) => {
        row.addEventListener('click', (e) => {
          if (e.target.closest('[data-ym-add]')) return;
          const idx = Number(row.dataset.ymIdx);
          const playBtn = row.querySelector('[data-ym-play]');
          triggerPlayRow(idx, playBtn);
        });
      });

      this.elContent.querySelectorAll('[data-ym-add]').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const tr = this._currentTracks[Number(btn.dataset.ymAdd)];
          if (!tr) return;
          btn.textContent = '…';
          btn.disabled = true;
          try {
            await this.onAddTrack(tr);
            btn.textContent = '✓';
            btn.classList.add('is-added');
          } catch (_) {
            btn.textContent = '+';
          } finally {
            btn.disabled = false;
          }
        });
      });

      this.elContent.querySelectorAll('[data-ym-pl-uid]').forEach((btn) => {
        btn.addEventListener('click', () => {
          this.openPlaylist(btn.dataset.ymPlUid, btn.dataset.ymPlKind);
        });
      });

      this.elContent.querySelectorAll('[data-ym-album]').forEach((btn) => {
        btn.addEventListener('click', () => {
          this.openAlbum(btn.dataset.ymAlbum);
        });
      });
    }

    _setLoading(text) {
      if (this.elContent) {
        this.elContent.innerHTML = `<div class="ym-empty">${esc(text)}</div>`;
      }
    }

    _setError(msg) {
      if (this.elContent) {
        this.elContent.innerHTML = `<div class="ym-empty ym-err">${esc(msg || 'Ошибка загрузки')}</div>`;
      }
    }

    _setAuthNeeded() {
      if (this.elContent) {
        this.elContent.innerHTML = `
          <div class="ym-empty">
            <p>Для этого раздела нужен вход в аккаунт Яндекс Музыки.</p>
            <button type="button" class="btn btn-primary btn-sm" id="btnYmPromptLogin">Войти через Яндекс</button>
          </div>
        `;
        this.elContent.querySelector('#btnYmPromptLogin')?.addEventListener('click', () => this.startDeviceAuthFlow());
      }
    }
  }

  window.YandexMusicPanel = YandexMusicPanel;
})();
