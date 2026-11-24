#!/usr/bin/env python3
"""
Wi-Fi-only Indoor Positioning Engine for Orpheus Sync.

Exact port of `navigator/app`'s Wi-Fi-only baseline (`Radio.kt` + `WifiKnn` + `Positioning.kt` with pdr=False):
- Supports both «Пансион Рекордов 15» (`rekordov15`) and «ГМЦ / НТУ Сириус» (`gmc`).
- Automatically detects which building a scan belongs to purely from Wi-Fi BSSIDs + RSSI
  (NO step detector, NO barometer, NO GPS, NO cell).
- Similarity metric:
  - Per scan & per fingerprint: top 20 strongest APs >= -88 dBm.
  - Shared AP: min(25, |rssi_scan - rssi_fp|).
  - Missing AP (in only one set): clamp(rssi + 95, 3, 25).
  - raw = exp(-d / 9.0).
- Validity gate: best_sim >= 0.20 and (known_aps >= 3 or best_sim >= 0.40).
  Fallback for uncalibrated rooms (apPeaks): if >= 8 known site APs and strongest >= -70 dBm.
- Stateful per-device `WifiKnn`:
  - Floor of best match, weighted top-5 fingerprints on that floor (weights = raw^4).
  - 60% blend toward new (x, y) on the same floor; floor change accepted on 2nd consecutive scan.
"""

from __future__ import annotations

import json
import math
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple


def _clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else (hi if v > hi else v)


class _FpPoint:
    __slots__ = ("floor", "x", "y", "outdoor", "ap_map", "top_ids", "top_rssi", "n_ap")

    def __init__(self, floor: int, x: float, y: float, outdoor: bool, ap_map: Dict[int, float]):
        self.floor = floor
        self.x = x
        self.y = y
        self.outdoor = outdoor
        self.ap_map = ap_map
        self.n_ap = len(ap_map)
        # Top 20 strongest APs >= -88 dBm
        top_items = sorted(
            ((k, v) for k, v in ap_map.items() if v >= -88.0),
            key=lambda kv: kv[1],
            reverse=True,
        )[:20]
        self.top_ids = [k for k, _ in top_items]
        self.top_rssi = [v for _, v in top_items]


class SiteRadioMap:
    def __init__(self, site_id: str, title: str, short_name: str, radio_path: Path, meta_path: Path):
        self.site_id = site_id
        self.title = title
        self.short_name = short_name
        self.bssid_to_id: Dict[str, int] = {}
        self.points: List[_FpPoint] = []
        # Inverted index: bssid_id -> list of point indices (massive speedup, zero loss of exactness)
        self.inv_index: Dict[int, List[int]] = {}
        self.center: Tuple[float, float] = (0.0, 0.0)
        self.floor_names: Dict[int, str] = {}
        self.floor_labels: Dict[int, List[Tuple[float, float, str, str, int]]] = {}
        self._load_meta(meta_path)
        self._load_radio(radio_path)

    def _load_meta(self, meta_path: Path):
        if not meta_path.is_file():
            return
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        c = meta.get("center") or [0.0, 0.0]
        self.center = (float(c[0]), float(c[1]))
        for fl in meta.get("floors", []):
            fn = int(fl["n"])
            self.floor_names[fn] = str(fl.get("name") or f"{fn} этаж")
            lbls = []
            for l in fl.get("labels", []):
                if len(l) >= 5:
                    lbls.append((float(l[0]), float(l[1]), str(l[2]), str(l[3]), int(l[4])))
            self.floor_labels[fn] = lbls

    def _load_radio(self, radio_path: Path):
        if not radio_path.is_file():
            return
        data = json.loads(radio_path.read_text(encoding="utf-8"))
        bssids = data.get("bssids", [])
        local_ids: List[int] = []
        for raw_b in bssids:
            b = str(raw_b).strip().lower()
            bid = self.bssid_to_id.get(b)
            if bid is None:
                bid = len(self.bssid_to_id)
                self.bssid_to_id[b] = bid
            local_ids.append(bid)

        fields = data.get("fields", [])
        fx = {name: i for i, name in enumerate(fields)}
        i_floor = fx["floor"]
        i_x = fx["x"]
        i_y = fx["y"]
        i_ap = fx["ap_idx"]
        i_rssi = fx["rssi"]
        i_out = fx.get("outdoor")

        for idx, pt in enumerate(data.get("points", [])):
            ap_idx = pt[i_ap]
            rssi_arr = pt[i_rssi]
            ap_map: Dict[int, float] = {}
            for k_i, r_v in zip(ap_idx, rssi_arr):
                bid = local_ids[int(k_i)]
                ap_map[bid] = float(r_v)
            outdoor = bool(i_out is not None and int(pt[i_out]) == 1)
            fp = _FpPoint(int(pt[i_floor]), float(pt[i_x]), float(pt[i_y]), outdoor, ap_map)
            self.points.append(fp)
            for bid in ap_map.keys():
                lst = self.inv_index.get(bid)
                if lst is None:
                    self.inv_index[bid] = [idx]
                else:
                    lst.append(idx)

    def nearest_label(self, floor: int, local_x: float, local_y: float) -> str:
        labels = self.floor_labels.get(floor)
        if not labels:
            return ""
        best_text = ""
        best_d2 = 18.0 * 18.0  # within 18m
        for lx, ly, code, name, prio in labels:
            d2 = (lx - local_x) ** 2 + (ly - local_y) ** 2
            # Slight preference for room labels (prio 1) over large zone titles (prio 2) when very close
            score = d2 if prio == 1 else d2 + 9.0
            if score < best_d2:
                best_d2 = score
                if code and name and code != name:
                    best_text = f"{code} · {name}" if len(name) <= 24 else code
                else:
                    best_text = code or name
        return best_text

    def match(self, raw_aps: Dict[str, float]) -> Tuple[List[Tuple[float, _FpPoint]], float, float, int]:
        """Score scan against this site's fingerprints. Returns (ranked[(raw, fp)], best_indoor, best_outdoor, known_count)."""
        known_ap: Dict[int, float] = {}
        for bssid, rssi in raw_aps.items():
            bid = self.bssid_to_id.get(bssid)
            if bid is not None:
                prev = known_ap.get(bid)
                if prev is None or rssi > prev:
                    known_ap[bid] = rssi

        known_count = len(known_ap)
        if known_count == 0:
            return [], 0.0, 0.0, 0

        # Scan top-20 strongest known APs >= -88 dBm
        scan_top = sorted(
            ((k, v) for k, v in known_ap.items() if v >= -88.0),
            key=lambda kv: kv[1],
            reverse=True,
        )[:20]
        if not scan_top:
            # Fallback if all known APs are < -88 dBm: take strongest 10 anyway
            scan_top = sorted(known_ap.items(), key=lambda kv: kv[1], reverse=True)[:10]

        # Candidate fingerprints sharing at least one BSSID with the scan
        cand_indices = set()
        for bid in known_ap.keys():
            lst = self.inv_index.get(bid)
            if lst:
                cand_indices.update(lst)

        if not cand_indices:
            return [], 0.0, 0.0, known_count

        ranked: List[Tuple[float, _FpPoint]] = []
        best_in = 0.0
        best_out = 0.0
        points = self.points

        for idx in cand_indices:
            p = points[idx]
            p_map = p.ap_map
            total = 0.0
            n = 0

            for k, v in scan_top:
                f = p_map.get(k)
                if f is not None:
                    diff = abs(v - f)
                    total += 25.0 if diff > 25.0 else diff
                else:
                    total += _clamp(v + 95.0, 3.0, 25.0)
                n += 1

            for k, pv in zip(p.top_ids, p.top_rssi):
                if k in known_ap:
                    continue
                total += _clamp(pv + 95.0, 3.0, 25.0)
                n += 1

            d = 25.0 if n == 0 else total / n
            raw = math.exp(-d / 9.0)
            if p.outdoor:
                if raw > best_out:
                    best_out = raw
                ranked.append((raw, p))
            else:
                if raw > best_in:
                    best_in = raw
                ranked.append((raw, p))

        ranked.sort(key=lambda item: item[0], reverse=True)
        return ranked, best_in, best_out, known_count

    def ap_peaks_fallback(self, raw_aps: Dict[str, float]) -> Optional[Tuple[int, float, float, float]]:
        """Coarse fallback when in an uncalibrated room inside a known building (`Radio.kt` apPeaks)."""
        strong = sorted(
            ((self.bssid_to_id[b], r) for b, r in raw_aps.items() if b in self.bssid_to_id and r >= -75.0),
            key=lambda kv: kv[1],
            reverse=True,
        )
        if not strong or strong[0][1] < -70.0:
            return None

        peaks: List[Tuple[_FpPoint, float]] = []
        for bid, scan_rssi in strong:
            if len(peaks) >= 6:
                break
            best_p: Optional[_FpPoint] = None
            best_r = -999.0
            for idx in self.inv_index.get(bid, ()):
                p = self.points[idx]
                if p.outdoor:
                    continue
                r = p.ap_map.get(bid)
                if r is not None and r > best_r:
                    best_r = r
                    best_p = p
            if best_p is None:
                continue
            if all(
                not (ep.floor == best_p.floor and math.hypot(ep.x - best_p.x, ep.y - best_p.y) < 3.0)
                for ep, _ in peaks
            ):
                peaks.append((best_p, scan_rssi))

        if not peaks:
            return None

        # Vote floor by weight = exp((rssi + 80) / 8)
        floor_w: Dict[int, float] = {}
        for p, r in peaks:
            w = math.exp((r + 80.0) / 8.0)
            floor_w[p.floor] = floor_w.get(p.floor, 0.0) + w
        fl = max(floor_w.items(), key=lambda kv: kv[1])[0]
        on_fl = [(p, math.exp((r + 80.0) / 8.0)) for p, r in peaks if p.floor == fl]
        ws = sum(w for _, w in on_fl)
        if ws <= 0:
            return None
        x = sum(w * p.x for p, w in on_fl) / ws
        y = sum(w * p.y for p, w in on_fl) / ws
        return fl, x, y, 8.0


class DeviceWifiTracker:
    """Per-device stateful Wi-Fi-only kNN smoother (matches `Radio.kt` WifiKnn)."""

    def __init__(self):
        self.site_id: Optional[str] = None
        self.floor: Optional[int] = None
        self.x: float = 0.0
        self.y: float = 0.0
        self.pending_floor: Optional[int] = None
        self.pending_site: Optional[str] = None
        self.last_fix: Optional[dict] = None

    def reset(self):
        self.site_id = None
        self.floor = None
        self.pending_floor = None
        self.pending_site = None
        self.last_fix = None

    def update(self, site: SiteRadioMap, ranked: List[Tuple[float, _FpPoint]], best_sim: float, known_count: int, total_aps: int, raw_aps: Dict[str, float]) -> Optional[dict]:
        fl: Optional[int] = None
        x = 0.0
        y = 0.0
        radius = 4.0
        source = "wifi-knn"

        radio_ok = best_sim >= 0.20 and (known_count >= 3 or best_sim >= 0.40)
        if radio_ok and ranked and ranked[0][0] >= 0.05:
            fl = ranked[0][1].floor
            top_k = [(raw, p) for raw, p in ranked if p.floor == fl][:5]
            ws = 0.0
            sx = 0.0
            sy = 0.0
            for raw, p in top_k:
                w = raw ** 4
                ws += w
                sx += w * p.x
                sy += w * p.y
            if ws <= 0:
                return self.last_fix
            x = sx / ws
            y = sy / ws
            var = sum((raw ** 4) * ((p.x - x) ** 2 + (p.y - y) ** 2) for raw, p in top_k)
            radius = max(1.5, math.sqrt(var / ws))
        elif known_count >= 6 and (total_aps == 0 or known_count / max(1, total_aps) >= 0.35):
            # Uncalibrated room inside known building fallback
            fb = site.ap_peaks_fallback(raw_aps)
            if fb is None:
                return self.last_fix
            fl, x, y, radius = fb
            source = "wifi-peaks"
        else:
            return None

        # Site & floor hysteresis (2 consecutive scans to switch floor or building)
        if self.site_id is not None and self.site_id != site.site_id:
            if self.pending_site == site.site_id:
                self.site_id = site.site_id
                self.floor = fl
                self.x = x
                self.y = y
                self.pending_site = None
                self.pending_floor = None
            else:
                self.pending_site = site.site_id
                return self.last_fix
        else:
            self.pending_site = None
            if self.floor is None:
                self.site_id = site.site_id
                self.floor = fl
                self.x = x
                self.y = y
            elif fl != self.floor:
                if self.pending_floor == fl:
                    self.pending_floor = None
                    self.floor = fl
                    self.x = x
                    self.y = y
                else:
                    self.pending_floor = fl
                    # Hold previous floor/coords on single-scan glitch
                    fl = self.floor
                    x = self.x
                    y = self.y
            else:
                self.pending_floor = None
                self.x = self.x + (x - self.x) * 0.6
                self.y = self.y + (y - self.y) * 0.6
                x = self.x
                y = self.y

        lx = x - site.center[0]
        ly = y - site.center[1]
        room = site.nearest_label(fl, lx, ly)
        fix = {
            "site": site.site_id,
            "siteName": site.short_name,
            "floor": fl,
            "floorName": site.floor_names.get(fl, f"{fl} этаж"),
            "x": round(x, 2),
            "y": round(y, 2),
            "lx": round(lx, 2),
            "ly": round(ly, 2),
            "room": room,
            "accuracy": round(max(1.5, radius), 1),
            "similarity": round(best_sim, 3),
            "knownAps": known_count,
            "totalAps": total_aps,
            "source": source,
            "ts": int(time.time() * 1000),
        }
        self.last_fix = fix
        return fix


class MultiSiteWifiLocator:
    """Loads both `rekordov15` and `gmc` Wi-Fi radio maps and locates scans automatically."""

    def __init__(self, root_dir: Path):
        self.sites: Dict[str, SiteRadioMap] = {}
        configs = [
            (
                "rekordov15",
                "Пансион лицея «Сириус», Рекордов 15",
                "Рекордов 15",
                root_dir / "server" / "radio" / "rekordov15_wifi.json",
                root_dir / "maps" / "rekordov15" / "meta.json",
            ),
            (
                "gmc",
                "НТУ «Сириус» (ГМЦ)",
                "ГМЦ",
                root_dir / "server" / "radio" / "gmc_wifi.json",
                root_dir / "maps" / "gmc" / "meta.json",
            ),
        ]
        for site_id, title, short_name, radio_path, meta_path in configs:
            if radio_path.is_file():
                t0 = time.time()
                sm = SiteRadioMap(site_id, title, short_name, radio_path, meta_path)
                self.sites[site_id] = sm
                dt = (time.time() - t0) * 1000
                print(
                    f"[WifiLocator] Loaded {site_id}: {len(sm.points)} fps, {len(sm.bssid_to_id)} BSSIDs ({dt:.0f} ms)",
                    flush=True,
                )

    @staticmethod
    def normalize_scan(raw_aps) -> Dict[str, float]:
        """Accepts either dict {bssid: rssi} or list [[bssid, rssi], ...] or list [{bssid, rssi}, ...]."""
        out: Dict[str, float] = {}
        if isinstance(raw_aps, dict):
            items = raw_aps.items()
        elif isinstance(raw_aps, list):
            items = []
            for row in raw_aps:
                if isinstance(row, (list, tuple)) and len(row) >= 2:
                    items.append((row[0], row[1]))
                elif isinstance(row, dict) and "bssid" in row and "rssi" in row:
                    items.append((row["bssid"], row["rssi"]))
        else:
            return out

        for b_raw, r_raw in items:
            if not b_raw:
                continue
            b = str(b_raw).strip().replace("\x00", "").lower()
            try:
                r = float(r_raw)
            except (TypeError, ValueError):
                continue
            if -115.0 <= r <= -5.0:
                prev = out.get(b)
                if prev is None or r > prev:
                    out[b] = r
        return out

    def locate(self, raw_aps, tracker: Optional[DeviceWifiTracker] = None, preferred_site: Optional[str] = None) -> Optional[dict]:
        ap_map = self.normalize_scan(raw_aps)
        total_aps = len(ap_map)
        if total_aps == 0:
            return None

        best_choice = None
        best_score = -1.0

        for site_id, site in self.sites.items():
            if preferred_site and preferred_site in self.sites and site_id != preferred_site:
                continue
            ranked, bi, bo, known = site.match(ap_map)
            best_sim = max(bi, bo)
            # Combine similarity & known AP count to unambiguously pick the right building
            score = best_sim * (1.0 + min(known, 12) * 0.05) if (known >= 2 or best_sim >= 0.35) else 0.0
            if score > best_score and (known >= 3 or best_sim >= 0.20):
                best_score = score
                best_choice = (site, ranked, best_sim, known)

        if best_choice is None:
            return None

        site, ranked, best_sim, known = best_choice
        tr = tracker if tracker is not None else DeviceWifiTracker()
        return tr.update(site, ranked, best_sim, known, total_aps, ap_map)

    def list_sites(self) -> List[dict]:
        return [
            {
                "id": s.site_id,
                "title": s.title,
                "shortName": s.short_name,
                "center": list(s.center),
                "floors": sorted(s.floor_names.keys()),
                "floorNames": s.floor_names,
                "fingerprints": len(s.points),
                "bssids": len(s.bssid_to_id),
            }
            for s in self.sites.values()
        ]
