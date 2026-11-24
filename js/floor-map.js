/**
 * FloorMapPanel — интерактивный многоэтажный план здания (Рекордов 15 и ГМЦ)
 * с отображением точного Wi-Fi местоположения устройств и выделением рамкой
 * (desktop marquee multi-select) сразу по нескольким этажам.
 */
(() => {
  const TRACK_PALETTE = [
    '#007aff', // Blue
    '#34c759', // Green
    '#ff9500', // Orange
    '#af52de', // Purple
    '#ff2d55', // Pink
    '#32ade6', // Cyan
    '#ffcc00', // Yellow
    '#ff3b30', // Red
  ];

  const SITE_CONFIG = {
    rekordov15: {
      id: 'rekordov15',
      name: 'Рекордов 15',
      fullTitle: 'Пансион «Сириус», ул. Рекордов, 15',
      shortFloorLabel: (n) => (n === 0 ? 'Подвал' : n === 9 ? 'Чердак' : `${n} этаж`),
      shortPill: (n) => (n === 0 ? 'П' : n === 9 ? 'Ч' : `${n}`),
    },
    gmc: {
      id: 'gmc',
      name: 'ГМЦ',
      fullTitle: 'НТУ «Сириус» (ГМЦ)',
      shortFloorLabel: (n) => `${n} этаж`,
      shortPill: (n) => `${n}`,
    },
  };

  function readMesh(buffer) {
    const size = new DataView(buffer).getUint32(0, true);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, size)));
    const base = (4 + size + 3) & ~3;
    const types = {
      float32: Float32Array,
      uint32: Uint32Array,
      uint16: Uint16Array,
      int32: Int32Array,
      uint8: Uint8Array,
    };
    const out = {};
    for (const h of header) {
      const Ctor = types[h.dtype];
      if (!Ctor) continue;
      out[h.k] = new Ctor(buffer.slice(base + h.off, base + h.off + h.len));
    }
    return out;
  }

  function getTrackColor(trackId, playlist = []) {
    if (!trackId) return '#8e8e93';
    const idx = playlist.findIndex((t) => t.id === trackId);
    if (idx >= 0) return TRACK_PALETTE[idx % TRACK_PALETTE.length];
    let h = 0;
    for (let i = 0; i < trackId.length; i++) h = (h * 31 + trackId.charCodeAt(i)) >>> 0;
    return TRACK_PALETTE[h % TRACK_PALETTE.length];
  }

  class FloorMapPanel {
    constructor({
      rootEl,
      gridEl,
      floorPillsEl,
      unlocatedWrapEl,
      unlocatedListEl,
      marqueeEl,
      siteButtons,
      onSelectionChange,
      onSiteChange,
    }) {
      this.rootEl = rootEl;
      this.gridEl = gridEl;
      this.floorPillsEl = floorPillsEl;
      this.unlocatedWrapEl = unlocatedWrapEl;
      this.unlocatedListEl = unlocatedListEl;
      this.marqueeEl = marqueeEl;
      this.siteButtons = siteButtons || [];
      this.onSelectionChange = onSelectionChange || (() => {});
      this.onSiteChange = onSiteChange || (() => {});

      this.currentSite = 'rekordov15';
      this.viewFloor = 'all'; // 'all' | number
      this.siteCache = new Map(); // siteId -> { meta, floors: Map<n, { meta, mesh }> }
      this.loadingSites = new Map();

      this.devices = []; // [{ id, label, isHost, location, trackId, trackName, playing, isBluetooth, latencyMs }]
      this.playlist = [];
      this.selectedIds = new Set();

      this.floorTiles = new Map(); // floorN -> { tileEl, canvas, ctx, vp, staticCanvas, staticKey, dotHitboxes: [] }
      this.darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
      this._darkHandler = () => this._invalidateStaticAndRender();
      if (this.darkQuery.addEventListener) {
        this.darkQuery.addEventListener('change', this._darkHandler);
      }

      this._resizeObserver = new ResizeObserver(() => this._scheduleRender(true));
      if (this.gridEl) this._resizeObserver.observe(this.gridEl);

      this._marqueeState = null;
      this._animRaf = null;
      this._autoSwitchedSite = false;

      this._bindSiteButtons();
      this._bindMarqueeAndClicks();
    }

    static getTrackColor(trackId, playlist) {
      return getTrackColor(trackId, playlist);
    }

    _bindSiteButtons() {
      for (const btn of this.siteButtons) {
        btn.addEventListener('click', () => {
          const site = btn.dataset.site;
          if (site && SITE_CONFIG[site]) {
            this.setSite(site, true);
          }
        });
      }
    }

    async init() {
      await this.setSite(this.currentSite, false);
      this._startPulseLoop();
    }

    async setSite(siteId, userInitiated = false) {
      if (!SITE_CONFIG[siteId]) return;
      if (userInitiated) this._autoSwitchedSite = true;
      this.currentSite = siteId;
      this.viewFloor = 'all';

      for (const btn of this.siteButtons) {
        btn.classList.toggle('active', btn.dataset.site === siteId);
      }
      this.onSiteChange(siteId);

      await this._ensureSiteLoaded(siteId);
      this._buildFloorPills();
      this._buildFloorGrid();
      this.renderAll();
    }

    async _ensureSiteLoaded(siteId) {
      if (this.siteCache.has(siteId)) return this.siteCache.get(siteId);
      if (this.loadingSites.has(siteId)) return this.loadingSites.get(siteId);

      const p = (async () => {
        if (this.gridEl) {
          this.gridEl.innerHTML = `<div class="map-loading">Загрузка планов ${SITE_CONFIG[siteId].name}...</div>`;
        }
        const metaResp = await fetch(`maps/${siteId}/meta.json?v=19`);
        if (!metaResp.ok) throw new Error(`Map meta ${siteId} HTTP ${metaResp.status}`);
        const meta = await metaResp.json();

        const floorsMap = new Map();
        await Promise.all(
          meta.floors.map(async (fl) => {
            const resp = await fetch(`maps/${siteId}/floor${fl.n}.bin?v=19`);
            if (!resp.ok) return;
            const buf = await resp.arrayBuffer();
            const mesh = readMesh(buf);
            floorsMap.set(fl.n, { meta: fl, mesh });
          })
        );

        const entry = { meta, floors: floorsMap };
        this.siteCache.set(siteId, entry);
        return entry;
      })();

      this.loadingSites.set(siteId, p);
      try {
        return await p;
      } finally {
        this.loadingSites.delete(siteId);
      }
    }

    setData({ devices, playlist, selectedIds }) {
      this.devices = devices || [];
      this.playlist = playlist || [];
      if (selectedIds) {
        this.selectedIds = new Set(selectedIds);
      }

      // Автопереключение здания, если подключилось устройство из другого объекта (1 раз, пока пользователь не переключал вручную)
      if (!this._autoSwitchedSite) {
        const locatedSites = new Set(
          this.devices.map((d) => d.location?.site).filter((s) => s && SITE_CONFIG[s])
        );
        if (locatedSites.size === 1 && !locatedSites.has(this.currentSite)) {
          const detected = locatedSites.values().next().value;
          this._autoSwitchedSite = true;
          this.setSite(detected, false);
          return;
        }
      }

      this._updateFloorBadges();
      this._renderUnlocatedStrip();
      this.renderAll();
    }

    setSelectedIds(idsSet) {
      this.selectedIds = new Set(idsSet);
      this._renderUnlocatedStrip();
      this.renderAll();
    }

    _buildFloorPills() {
      if (!this.floorPillsEl) return;
      const siteData = this.siteCache.get(this.currentSite);
      if (!siteData) return;
      const cfg = SITE_CONFIG[this.currentSite];
      const floors = siteData.meta.floors;

      const pills = [
        `<button type="button" class="floor-pill ${this.viewFloor === 'all' ? 'active' : ''}" data-floor-view="all">Все (${floors.length})</button>`,
      ];
      for (const fl of floors) {
        const active = this.viewFloor === fl.n ? 'active' : '';
        pills.push(
          `<button type="button" class="floor-pill ${active}" data-floor-view="${fl.n}" title="${fl.name}">` +
            `${cfg.shortPill(fl.n)}<span class="floor-pill-cnt hidden" data-pill-cnt="${fl.n}">0</span>` +
          `</button>`
        );
      }
      this.floorPillsEl.innerHTML = pills.join('');

      this.floorPillsEl.querySelectorAll('[data-floor-view]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const raw = btn.dataset.floorView;
          this.viewFloor = raw === 'all' ? 'all' : Number(raw);
          this._buildFloorPills();
          this._buildFloorGrid();
          this.renderAll();
        });
      });
      this._updateFloorBadges();
    }

    _buildFloorGrid() {
      if (!this.gridEl) return;
      const siteData = this.siteCache.get(this.currentSite);
      if (!siteData) return;
      const cfg = SITE_CONFIG[this.currentSite];

      this.floorTiles.clear();
      const floors =
        this.viewFloor === 'all'
          ? siteData.meta.floors
          : siteData.meta.floors.filter((f) => f.n === this.viewFloor);

      this.gridEl.classList.toggle('single-floor', this.viewFloor !== 'all');
      this.gridEl.classList.toggle('gmc-grid', this.currentSite === 'gmc' && this.viewFloor === 'all');
      this.gridEl.innerHTML = '';

      for (const fl of floors) {
        const floorObj = siteData.floors.get(fl.n);
        if (!floorObj) continue;

        const tile = document.createElement('div');
        tile.className = 'floor-tile';
        tile.dataset.floor = String(fl.n);

        const head = document.createElement('div');
        head.className = 'floor-tile-head';
        head.innerHTML = `
          <div class="floor-tile-title">
            <span class="floor-name">${cfg.shortFloorLabel(fl.n)}</span>
            <span class="floor-dev-badge hidden" data-floor-badge="${fl.n}">0</span>
          </div>
          <div class="floor-tile-actions">
            <button type="button" class="floor-mini-btn" data-select-floor="${fl.n}" title="Выбрать все устройства на этаже">Выбрать</button>
            ${
              this.viewFloor === 'all'
                ? `<button type="button" class="floor-mini-btn" data-focus-floor="${fl.n}" title="Открыть этаж крупно">⤢</button>`
                : `<button type="button" class="floor-mini-btn" data-focus-floor="all" title="Вернуться ко всем этажам">Все этажи</button>`
            }
          </div>
        `;

        const canvasWrap = document.createElement('div');
        canvasWrap.className = 'floor-canvas-wrap';
        const canvas = document.createElement('canvas');
        canvas.className = 'floor-canvas';
        canvasWrap.appendChild(canvas);

        tile.appendChild(head);
        tile.appendChild(canvasWrap);
        this.gridEl.appendChild(tile);

        head.querySelector('[data-select-floor]')?.addEventListener('click', (e) => {
          e.stopPropagation();
          const onFloor = this._devicesOnFloor(fl.n).map((d) => d.id);
          if (onFloor.length === 0) return;
          const next = e.shiftKey || e.metaKey || e.ctrlKey ? new Set(this.selectedIds) : new Set();
          const allAlready = onFloor.every((id) => next.has(id));
          if (allAlready && (e.shiftKey || e.metaKey || e.ctrlKey)) {
            for (const id of onFloor) next.delete(id);
          } else {
            for (const id of onFloor) next.add(id);
          }
          this.selectedIds = next;
          this.onSelectionChange(new Set(this.selectedIds));
          this._renderUnlocatedStrip();
          this.renderAll();
        });

        head.querySelector('[data-focus-floor]')?.addEventListener('click', (e) => {
          e.stopPropagation();
          const target = e.currentTarget.dataset.focusFloor;
          this.viewFloor = target === 'all' ? 'all' : Number(target);
          this._buildFloorPills();
          this._buildFloorGrid();
          this.renderAll();
        });

        this.floorTiles.set(fl.n, {
          floorN: fl.n,
          floorObj,
          tileEl: tile,
          canvasWrap,
          canvas,
          ctx: canvas.getContext('2d'),
          vp: { cx: 0, cy: 0, scale: 1, w: 1, h: 1 },
          staticCanvas: null,
          staticKey: '',
          dotHitboxes: [],
        });
      }

      this._updateFloorBadges();
      this._renderUnlocatedStrip();
    }

    _devicesOnFloor(floorN) {
      return this.devices.filter(
        (d) => d.location && d.location.site === this.currentSite && d.location.floor === floorN
      );
    }

    _unlocatedDevices() {
      return this.devices.filter(
        (d) => !d.location || d.location.site !== this.currentSite
      );
    }

    _updateFloorBadges() {
      const counts = new Map();
      for (const d of this.devices) {
        if (d.location && d.location.site === this.currentSite) {
          counts.set(d.location.floor, (counts.get(d.location.floor) || 0) + 1);
        }
      }
      if (this.floorPillsEl) {
        this.floorPillsEl.querySelectorAll('[data-pill-cnt]').forEach((el) => {
          const n = Number(el.dataset.pillCnt);
          const c = counts.get(n) || 0;
          el.textContent = String(c);
          el.classList.toggle('hidden', c === 0);
        });
      }
      if (this.gridEl) {
        this.gridEl.querySelectorAll('[data-floor-badge]').forEach((el) => {
          const n = Number(el.dataset.floorBadge);
          const c = counts.get(n) || 0;
          el.textContent = String(c);
          el.classList.toggle('hidden', c === 0);
        });
      }
    }

    _renderUnlocatedStrip() {
      if (!this.unlocatedWrapEl || !this.unlocatedListEl) return;
      const unloc = this._unlocatedDevices();
      this.unlocatedWrapEl.classList.toggle('hidden', unloc.length === 0);
      if (unloc.length === 0) return;

      this.unlocatedListEl.innerHTML = unloc
        .map((d) => {
          const sel = this.selectedIds.has(d.id);
          const color = getTrackColor(d.trackId, this.playlist);
          const otherSite = d.location?.site ? ` · ${d.location.siteName} ${d.location.floor} эт.` : '';
          const playGlyph = d.playing ? '▶ ' : '';
          return `
            <button type="button" class="map-unloc-chip ${sel ? 'selected' : ''}" data-unloc-id="${d.id}">
              <span class="map-unloc-dot" style="background:${color}"></span>
              <span class="map-unloc-name">${playGlyph}${d.label}${otherSite}</span>
            </button>
          `;
        })
        .join('');

      this.unlocatedListEl.querySelectorAll('[data-unloc-id]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = btn.dataset.unlocId;
          const additive = e.shiftKey || e.metaKey || e.ctrlKey;
          const next = additive ? new Set(this.selectedIds) : new Set();
          if (additive && next.has(id)) next.delete(id);
          else if (!additive && this.selectedIds.size === 1 && this.selectedIds.has(id)) next.clear();
          else next.add(id);
          this.selectedIds = next;
          this.onSelectionChange(new Set(this.selectedIds));
          this._renderUnlocatedStrip();
          this.renderAll();
        });
      });
    }

    _computeViewport(tile, w, h) {
      const bb = tile.floorObj.meta.bbox;
      const bw = Math.max(1, bb[2] - bb[0]);
      const bh = Math.max(1, bb[3] - bb[1]);
      const margin = this.viewFloor === 'all' ? 0.90 : 0.93;
      const scale = Math.min(w / bw, h / bh) * margin;
      tile.vp = {
        cx: (bb[0] + bb[2]) / 2,
        cy: (bb[1] + bb[3]) / 2,
        scale,
        w,
        h,
      };
    }

    _toScreen(vp, lx, ly) {
      return [
        vp.w / 2 + (lx - vp.cx) * vp.scale,
        vp.h / 2 - (ly - vp.cy) * vp.scale,
      ];
    }

    _renderStaticFloor(tile, dpr) {
      const { vp, floorObj } = tile;
      const mesh = floorObj.mesh;
      const isDark = this.darkQuery.matches;
      const key = `${Math.round(vp.w)}x${Math.round(vp.h)}x${dpr.toFixed(2)}x${isDark ? 'd' : 'l'}`;
      if (tile.staticCanvas && tile.staticKey === key) return tile.staticCanvas;

      const off = document.createElement('canvas');
      off.width = Math.max(1, Math.round(vp.w * dpr));
      off.height = Math.max(1, Math.round(vp.h * dpr));
      const ctx = off.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Background
      ctx.fillStyle = isDark ? '#141416' : '#f2f3f0';
      ctx.fillRect(0, 0, vp.w, vp.h);

      const toX = (x) => vp.w / 2 + (x - vp.cx) * vp.scale;
      const toY = (y) => vp.h / 2 - (y - vp.cy) * vp.scale;

      // 1. Rooms (batch by quantized rgb string for speed!)
      const rxy = mesh.room_xy;
      const ridx = mesh.room_idx;
      const rrgb = mesh.room_rgb;
      if (rxy && ridx && ridx.length) {
        const byColor = new Map();
        for (let i = 0; i < ridx.length; i += 3) {
          let col;
          if (rrgb) {
            const cOff = ridx[i] * 3;
            let r = rrgb[cOff];
            let g = rrgb[cOff + 1];
            let b = rrgb[cOff + 2];
            if (isDark) {
              // Convert light architectural pastel into sleek dark blueprint fill
              r = Math.round(28 + (r / 255) * 34);
              g = Math.round(30 + (g / 255) * 36);
              b = Math.round(35 + (b / 255) * 42);
            }
            col = `rgb(${r},${g},${b})`;
          } else {
            col = isDark ? '#25262b' : '#ffffff';
          }
          let bucket = byColor.get(col);
          if (!bucket) {
            bucket = [];
            byColor.set(col, bucket);
          }
          bucket.push(i);
        }

        for (const [col, tris] of byColor.entries()) {
          ctx.fillStyle = col;
          ctx.beginPath();
          for (let t = 0; t < tris.length; t++) {
            const i = tris[t];
            const j0 = ridx[i] * 2;
            const j1 = ridx[i + 1] * 2;
            const j2 = ridx[i + 2] * 2;
            ctx.moveTo(toX(rxy[j0]), toY(rxy[j0 + 1]));
            ctx.lineTo(toX(rxy[j1]), toY(rxy[j1 + 1]));
            ctx.lineTo(toX(rxy[j2]), toY(rxy[j2 + 1]));
            ctx.closePath();
          }
          ctx.fill();
        }
      }

      // Helper for line segments
      const drawLines = (arr, color, lw) => {
        if (!arr || arr.length < 4) return;
        ctx.strokeStyle = color;
        ctx.lineWidth = lw;
        ctx.beginPath();
        for (let i = 0; i + 3 < arr.length; i += 4) {
          ctx.moveTo(toX(arr[i]), toY(arr[i + 1]));
          ctx.lineTo(toX(arr[i + 2]), toY(arr[i + 3]));
        }
        ctx.stroke();
      };

      drawLines(mesh.path_xy, isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,250,0.9)', 1.5);
      drawLines(mesh.stair_xy, isDark ? '#5a708a' : '#8c9eb3', 1);
      drawLines(mesh.door_xy, isDark ? '#4a4e57' : '#cfd4dc', 1);
      drawLines(mesh.furn_xy || mesh.furn_lines, isDark ? 'rgba(180,150,120,0.22)' : 'rgba(199,168,133,0.45)', 0.8);

      // Walls (triangles)
      const wxy = mesh.wall_xy;
      const widx = mesh.wall_idx;
      if (wxy && widx && widx.length) {
        ctx.fillStyle = isDark ? '#586070' : '#8e97a6';
        ctx.beginPath();
        for (let i = 0; i < widx.length; i += 3) {
          const j0 = widx[i] * 2;
          const j1 = widx[i + 1] * 2;
          const j2 = widx[i + 2] * 2;
          ctx.moveTo(toX(wxy[j0]), toY(wxy[j0 + 1]));
          ctx.lineTo(toX(wxy[j1]), toY(wxy[j1 + 1]));
          ctx.lineTo(toX(wxy[j2]), toY(wxy[j2 + 1]));
          ctx.closePath();
        }
        ctx.fill();
      }

      drawLines(mesh.fence_xy, isDark ? '#525866' : '#59606b', 1.2);
      drawLines(mesh.roof_xy, isDark ? '#666e7d' : '#9096a0', 1);

      // Room / zone labels (non-overlapping)
      const labels = floorObj.meta.labels || [];
      const showDetail = this.viewFloor !== 'all' || vp.scale >= 4.2;
      const sortedLabels = [...labels].sort((a, b) => b[4] - a[4]);
      const occupied = [];
      ctx.font = this.viewFloor !== 'all' ? '600 10.5px -apple-system, system-ui, sans-serif' : '600 9px -apple-system, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      let drawn = 0;
      const maxLabels = this.viewFloor !== 'all' ? 110 : 28;

      for (const l of sortedLabels) {
        if (drawn >= maxLabels) break;
        const isZone = l[4] >= 2;
        if (!isZone && !showDetail) continue;
        const text = l[2] || l[3];
        if (!text) continue;
        const sx = toX(l[0]);
        const sy = toY(l[1]);
        if (sx < 14 || sy < 10 || sx > vp.w - 14 || sy > vp.h - 10) continue;
        const tw = ctx.measureText(text).width + 6;
        const th = 12;
        const bx0 = sx - tw / 2;
        const by0 = sy - th / 2;
        const bx1 = sx + tw / 2;
        const by1 = sy + th / 2;
        if (occupied.some((b) => b[0] < bx1 && b[2] > bx0 && b[1] < by1 && b[3] > by0)) continue;
        occupied.push([bx0, by0, bx1, by1]);

        ctx.strokeStyle = isDark ? 'rgba(20,20,22,0.85)' : 'rgba(255,255,255,0.88)';
        ctx.lineWidth = 2.6;
        ctx.strokeText(text, sx, sy);
        ctx.fillStyle = isZone
          ? (isDark ? 'rgba(235,235,245,0.72)' : 'rgba(70,78,88,0.88)')
          : (isDark ? 'rgba(200,205,215,0.62)' : 'rgba(80,88,98,0.78)');
        ctx.fillText(text, sx, sy);
        drawn++;
      }

      tile.staticCanvas = off;
      tile.staticKey = key;
      return off;
    }

    _invalidateStaticAndRender() {
      for (const tile of this.floorTiles.values()) {
        tile.staticCanvas = null;
        tile.staticKey = '';
      }
      this.renderAll();
    }

    _scheduleRender(invalidateStatic = false) {
      if (invalidateStatic) {
        for (const tile of this.floorTiles.values()) {
          tile.staticCanvas = null;
          tile.staticKey = '';
        }
      }
      if (!this._renderQueued) {
        this._renderQueued = true;
        requestAnimationFrame(() => {
          this._renderQueued = false;
          this.renderAll();
        });
      }
    }

    _startPulseLoop() {
      if (this._animRaf) cancelAnimationFrame(this._animRaf);
      const tick = () => {
        const anyPlaying = this.devices.some((d) => d.playing && d.location?.site === this.currentSite);
        if (anyPlaying && this.rootEl && !this.rootEl.classList.contains('hidden')) {
          this.renderAll();
        }
        this._animRaf = requestAnimationFrame(tick);
      };
      this._animRaf = requestAnimationFrame(tick);
    }

    renderAll() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const now = performance.now();
      const isDark = this.darkQuery.matches;

      for (const tile of this.floorTiles.values()) {
        const rect = tile.canvasWrap.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 10) continue;

        const w = rect.width;
        const h = rect.height;
        const targetW = Math.round(w * dpr);
        const targetH = Math.round(h * dpr);
        if (tile.canvas.width !== targetW || tile.canvas.height !== targetH) {
          tile.canvas.width = targetW;
          tile.canvas.height = targetH;
        }

        this._computeViewport(tile, w, h);
        const staticImg = this._renderStaticFloor(tile, dpr);

        const ctx = tile.ctx;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, targetW, targetH);
        ctx.drawImage(staticImg, 0, 0);

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        // Draw devices on this floor
        const devs = this._devicesOnFloor(tile.floorN);
        tile.dotHitboxes = [];

        for (const dev of devs) {
          const loc = dev.location;
          const [sx, sy] = this._toScreen(tile.vp, loc.lx, loc.ly);
          const clampedX = Math.max(10, Math.min(w - 10, sx));
          const clampedY = Math.max(10, Math.min(h - 10, sy));
          const color = getTrackColor(dev.trackId, this.playlist);
          const isSelected = this.selectedIds.has(dev.id);
          const isPreview = this._marqueeState?.previewIds?.has(dev.id);
          const highlighted = isSelected || isPreview;

          // Accuracy radius circle (subtle)
          const accPx = Math.max(8, Math.min(34, (loc.accuracy || 2.5) * tile.vp.scale));
          ctx.beginPath();
          ctx.arc(clampedX, clampedY, accPx, 0, Math.PI * 2);
          ctx.fillStyle = highlighted ? 'rgba(0, 122, 255, 0.14)' : 'rgba(0, 122, 255, 0.07)';
          ctx.fill();

          // Playing pulse ring
          if (dev.playing) {
            const phase = (now % 1400) / 1400;
            const pulseR = 7 + phase * 15;
            ctx.beginPath();
            ctx.arc(clampedX, clampedY, pulseR, 0, Math.PI * 2);
            ctx.strokeStyle = color;
            ctx.globalAlpha = (1 - phase) * 0.65;
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.globalAlpha = 1;
          }

          // Selection outer halo
          if (highlighted) {
            ctx.beginPath();
            ctx.arc(clampedX, clampedY, 12, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(0, 122, 255, 0.24)';
            ctx.fill();
            ctx.strokeStyle = '#007aff';
            ctx.lineWidth = 2.2;
            ctx.stroke();
          }

          // Main dot
          ctx.beginPath();
          ctx.arc(clampedX, clampedY, highlighted ? 7.5 : 6.5, 0, Math.PI * 2);
          ctx.fillStyle = '#ffffff';
          ctx.fill();

          ctx.beginPath();
          ctx.arc(clampedX, clampedY, highlighted ? 5.5 : 4.8, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();

          // Label pill above dot
          const labelText = `${dev.playing ? '▶ ' : ''}${dev.label}`;
          ctx.font = '600 10.5px -apple-system, system-ui, sans-serif';
          const tw = ctx.measureText(labelText).width;
          const px = 6;
          const pillW = tw + px * 2;
          const pillH = 18;
          const pillX = Math.max(4, Math.min(w - pillW - 4, clampedX - pillW / 2));
          const pillY = clampedY - 27 > 4 ? clampedY - 27 : clampedY + 12;

          ctx.fillStyle = highlighted
            ? '#007aff'
            : (isDark ? 'rgba(28, 28, 30, 0.92)' : 'rgba(255, 255, 255, 0.94)');
          ctx.strokeStyle = highlighted
            ? '#007aff'
            : (isDark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.12)');
          ctx.lineWidth = 1;
          ctx.beginPath();
          if (typeof ctx.roundRect === 'function') {
            ctx.roundRect(pillX, pillY, pillW, pillH, 9);
          } else {
            ctx.rect(pillX, pillY, pillW, pillH);
          }
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = highlighted ? '#ffffff' : (isDark ? '#f5f5f7' : '#1d1d1f');
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(labelText, pillX + pillW / 2, pillY + pillH / 2 + 0.5);

          tile.dotHitboxes.push({
            id: dev.id,
            x: clampedX,
            y: clampedY,
            r: 15,
            pillX,
            pillY,
            pillW,
            pillH,
          });
        }
      }
    }

    /* ==================== DESKTOP MARQUEE MULTI-SELECT ACROSS ALL FLOORS ==================== */

    _bindMarqueeAndClicks() {
      if (!this.rootEl) return;

      const onPointerDown = (e) => {
        if (e.button !== 0) return;
        // Ignore clicks on buttons/controls inside header
        if (e.target.closest('button, input, select, .map-toolbar, .floor-pills, .floor-tile-head')) {
          return;
        }
        const insideArea = e.target.closest('.floor-grid, .map-unlocated-wrap');
        if (!insideArea) return;

        const startX = e.clientX;
        const startY = e.clientY;
        const additive = e.shiftKey || e.metaKey || e.ctrlKey;
        const baseSelection = additive ? new Set(this.selectedIds) : new Set();

        // Check immediate hit on a canvas dot
        const hitId = this._hitTestCanvasDot(e.clientX, e.clientY);

        this._marqueeState = {
          pointerId: e.pointerId,
          startX,
          startY,
          curX: startX,
          curY: startY,
          dragging: false,
          additive,
          baseSelection,
          hitId,
          previewIds: new Set(),
        };

        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('pointercancel', onPointerUp);
      };

      const onPointerMove = (e) => {
        const st = this._marqueeState;
        if (!st) return;
        st.curX = e.clientX;
        st.curY = e.clientY;
        const dx = st.curX - st.startX;
        const dy = st.curY - st.startY;
        if (!st.dragging && Math.hypot(dx, dy) >= 5) {
          st.dragging = true;
          document.body.classList.add('orpheus-selecting');
        }
        if (!st.dragging) return;

        const left = Math.min(st.startX, st.curX);
        const top = Math.min(st.startY, st.curY);
        const width = Math.abs(dx);
        const height = Math.abs(dy);

        if (this.marqueeEl) {
          this.marqueeEl.classList.remove('hidden');
          this.marqueeEl.style.left = `${left}px`;
          this.marqueeEl.style.top = `${top}px`;
          this.marqueeEl.style.width = `${width}px`;
          this.marqueeEl.style.height = `${height}px`;
        }

        // Hit-test ALL dots across ALL visible floors + unlocated chips!
        const inBox = this._collectDevicesInClientRect(left, top, left + width, top + height);
        st.previewIds = new Set(st.baseSelection);
        for (const id of inBox) st.previewIds.add(id);

        // Live preview on unlocated chips
        if (this.unlocatedListEl) {
          this.unlocatedListEl.querySelectorAll('[data-unloc-id]').forEach((el) => {
            el.classList.toggle('selected', st.previewIds.has(el.dataset.unlocId));
          });
        }
        this.renderAll();
      };

      const onPointerUp = () => {
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerUp);
        document.body.classList.remove('orpheus-selecting');

        const st = this._marqueeState;
        this._marqueeState = null;
        if (this.marqueeEl) this.marqueeEl.classList.add('hidden');
        if (!st) return;

        if (st.dragging) {
          this.selectedIds = new Set(st.previewIds);
          this.onSelectionChange(new Set(this.selectedIds));
          this._renderUnlocatedStrip();
          this.renderAll();
          return;
        }

        // Single click on map area
        if (st.hitId) {
          const next = st.additive ? new Set(this.selectedIds) : new Set();
          if (st.additive && next.has(st.hitId)) {
            next.delete(st.hitId);
          } else if (!st.additive && this.selectedIds.size === 1 && this.selectedIds.has(st.hitId)) {
            next.clear();
          } else {
            next.add(st.hitId);
          }
          this.selectedIds = next;
          this.onSelectionChange(new Set(this.selectedIds));
          this._renderUnlocatedStrip();
          this.renderAll();
        } else if (!st.additive && this.selectedIds.size > 0) {
          // Click on empty floor background clears selection (= Все устройства)
          this.selectedIds.clear();
          this.onSelectionChange(new Set());
          this._renderUnlocatedStrip();
          this.renderAll();
        }
      };

      this.rootEl.addEventListener('pointerdown', onPointerDown);
    }

    _hitTestCanvasDot(clientX, clientY) {
      for (const tile of this.floorTiles.values()) {
        const rect = tile.canvas.getBoundingClientRect();
        if (
          clientX < rect.left ||
          clientX > rect.right ||
          clientY < rect.top ||
          clientY > rect.bottom
        ) {
          continue;
        }
        const lx = clientX - rect.left;
        const ly = clientY - rect.top;
        // Iterate in reverse so topmost drawn dot wins
        for (let i = tile.dotHitboxes.length - 1; i >= 0; i--) {
          const hb = tile.dotHitboxes[i];
          const inCircle = Math.hypot(lx - hb.x, ly - hb.y) <= hb.r;
          const inPill =
            lx >= hb.pillX &&
            lx <= hb.pillX + hb.pillW &&
            ly >= hb.pillY &&
            ly <= hb.pillY + hb.pillH;
          if (inCircle || inPill) return hb.id;
        }
      }
      return null;
    }

    _collectDevicesInClientRect(x0, y0, x1, y1) {
      const found = [];
      for (const tile of this.floorTiles.values()) {
        const rect = tile.canvas.getBoundingClientRect();
        if (rect.right < x0 || rect.left > x1 || rect.bottom < y0 || rect.top > y1) continue;
        for (const hb of tile.dotHitboxes) {
          const cx = rect.left + hb.x;
          const cy = rect.top + hb.y;
          if (cx >= x0 - 6 && cx <= x1 + 6 && cy >= y0 - 6 && cy <= y1 + 6) {
            found.push(hb.id);
          }
        }
      }
      if (this.unlocatedListEl) {
        this.unlocatedListEl.querySelectorAll('[data-unloc-id]').forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.right >= x0 && r.left <= x1 && r.bottom >= y0 && r.top <= y1) {
            found.push(el.dataset.unlocId);
          }
        });
      }
      return found;
    }
  }

  window.FloorMapPanel = FloorMapPanel;
})();
