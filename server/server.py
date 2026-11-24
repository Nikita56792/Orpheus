#!/usr/bin/env python3
"""
Orpheus Sync — High-Speed Hybrid WebSocket + Progressive Audio Streaming Server.

Возможности:
- Мгновенное создание и вход в комнаты по WebSocket (/ws) с минимальной задержкой.
- Релей WebRTC-сигналинга (SDP/ICE) для автоматического поднятия прямого локального LAN/P2P канала.
- Двухпутевая доставка аудио:
  1) Мгновенный потоковый сегмент (PUT/GET /api/rooms/<code>/seg/<key>) — старт музыки < 1 сек
     во время фонового кэширования полного файла.
  2) Полный оригинальный аудиофайл (PUT/GET /api/rooms/<code>/tracks/<id>) с поддержкой
     HTTP Range и потоковой отдачи — Хост загружает файл 1 раз, все устройства качают параллельно.
- Полная поддержка CORS (работает как напрямую с домена сервера, так и с GitHub Pages).
- Авто-очистка неактивных комнат и кэша из RAM.
"""

import asyncio
import json
import os
import secrets
import time
from pathlib import Path
from typing import Dict, Optional

from aiohttp import web, WSMsgType

from wifi_locator import DeviceWifiTracker, MultiSiteWifiLocator

PORT = int(os.environ.get("PORT", "8765"))
HOST = os.environ.get("HOST", "0.0.0.0")
MAX_FILE_BYTES = int(os.environ.get("MAX_FILE_MB", "60")) * 1024 * 1024
ROOM_IDLE_TTL_SEC = 7200  # 2 часа

ROOT_DIR = Path(__file__).resolve().parent.parent
CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"


def generate_code() -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(6))


def normalize_code(raw: str) -> str:
    clean = "".join(ch for ch in str(raw or "").upper() if ch.isalnum())
    return clean[:6]


class Room:
    def __init__(self, code: str, host_id: str, host_ws: web.WebSocketResponse, host_name: str):
        self.code = code
        self.host_id = host_id
        self.host_ws = host_ws
        self.host_name = host_name
        self.listeners: Dict[str, dict] = {}  # peer_id -> { ws, deviceName }
        self.tracks: Dict[str, dict] = {}     # track_id -> { data: bytes, mime: str, name: str, ts: float }
        self.segments: Dict[str, dict] = {}   # seg_key -> { data: bytes, ts: float }
        self.created_at = time.time()
        self.last_activity = time.time()

    def touch(self):
        self.last_activity = time.time()

    def prune_segments(self):
        if len(self.segments) > 24:
            oldest = sorted(self.segments.items(), key=lambda kv: kv[1]["ts"])[: len(self.segments) - 16]
            for k, _ in oldest:
                self.segments.pop(k, None)


class OrpheusServer:
    def __init__(self):
        self.rooms: Dict[str, Room] = {}
        self.started_at = time.time()
        self.wifi_locator = MultiSiteWifiLocator(ROOT_DIR)

    async def safe_send(self, ws: Optional[web.WebSocketResponse], payload: dict):
        if not ws or ws.closed:
            return
        try:
            await ws.send_str(json.dumps(payload, separators=(",", ":")))
        except Exception:
            pass

    async def cleanup_loop(self):
        while True:
            await asyncio.sleep(60)
            now = time.time()
            dead = [
                code
                for code, room in self.rooms.items()
                if (room.host_ws.closed and len(room.listeners) == 0)
                or (now - room.last_activity > ROOM_IDLE_TTL_SEC)
            ]
            for code in dead:
                self.rooms.pop(code, None)

    # ==================== HTTP API ====================

    async def handle_health(self, request: web.Request) -> web.Response:
        return web.json_response(
            {
                "ok": True,
                "service": "orpheus-sync",
                "rooms": len(self.rooms),
                "uptimeSec": round(time.time() - self.started_at, 1),
                "wifiSites": list(self.wifi_locator.sites.keys()),
            }
        )

    async def handle_sites(self, request: web.Request) -> web.Response:
        return web.json_response({"ok": True, "sites": self.wifi_locator.list_sites()})

    async def handle_locate(self, request: web.Request) -> web.Response:
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "invalid_json"}, status=400)
        aps = body.get("aps") if isinstance(body, dict) else None
        preferred = body.get("site") if isinstance(body, dict) else None
        if not aps:
            return web.json_response({"ok": True, "location": None})
        loc = self.wifi_locator.locate(aps, preferred_site=preferred)
        return web.json_response({"ok": True, "location": loc})

    async def handle_put_track(self, request: web.Request) -> web.Response:
        code = normalize_code(request.match_info["code"])
        track_id = request.match_info["track_id"]
        room = self.rooms.get(code)
        if not room:
            return web.json_response({"error": "room_not_found"}, status=404)

        data = await request.read()
        if len(data) > MAX_FILE_BYTES:
            return web.json_response({"error": "file_too_large"}, status=413)

        mime = request.headers.get("Content-Type") or "application/octet-stream"
        name = request.headers.get("X-Track-Name") or track_id
        room.tracks[track_id] = {"data": data, "mime": mime, "name": name, "ts": time.time()}
        # Ограничиваем память на комнату (держим до 12 последних треков)
        if len(room.tracks) > 12:
            oldest_key = min(room.tracks.items(), key=lambda kv: kv[1]["ts"])[0]
            if oldest_key != track_id:
                room.tracks.pop(oldest_key, None)
        room.touch()
        return web.json_response({"ok": True, "trackId": track_id, "size": len(data)})

    async def handle_get_track(self, request: web.Request) -> web.StreamResponse:
        code = normalize_code(request.match_info["code"])
        track_id = request.match_info["track_id"]
        room = self.rooms.get(code)
        if not room or track_id not in room.tracks:
            return web.json_response({"error": "track_not_found"}, status=404)

        room.touch()
        entry = room.tracks[track_id]
        data: bytes = entry["data"]
        total = len(data)
        mime = entry["mime"]

        range_header = request.headers.get("Range")
        if range_header and range_header.startswith("bytes="):
            try:
                spec = range_header.replace("bytes=", "").split(",")[0].strip()
                start_s, end_s = spec.split("-")
                start = int(start_s) if start_s else 0
                end = int(end_s) if end_s else total - 1
                start = max(0, min(start, total - 1))
                end = max(start, min(end, total - 1))
                chunk = data[start : end + 1]
                return web.Response(
                    status=206,
                    body=chunk,
                    headers={
                        "Content-Type": mime,
                        "Content-Length": str(len(chunk)),
                        "Content-Range": f"bytes {start}-{end}/{total}",
                        "Accept-Ranges": "bytes",
                        "Cache-Control": "no-store",
                    },
                )
            except Exception:
                pass

        return web.Response(
            status=200,
            body=data,
            headers={
                "Content-Type": mime,
                "Content-Length": str(total),
                "Accept-Ranges": "bytes",
                "Cache-Control": "no-store",
            },
        )

    async def handle_put_segment(self, request: web.Request) -> web.Response:
        code = normalize_code(request.match_info["code"])
        seg_key = request.match_info["seg_key"]
        room = self.rooms.get(code)
        if not room:
            return web.json_response({"error": "room_not_found"}, status=404)

        data = await request.read()
        if len(data) > 8 * 1024 * 1024:
            return web.json_response({"error": "segment_too_large"}, status=413)

        room.segments[seg_key] = {"data": data, "ts": time.time()}
        room.prune_segments()
        room.touch()
        return web.json_response({"ok": True, "segKey": seg_key, "size": len(data)})

    async def handle_get_segment(self, request: web.Request) -> web.Response:
        code = normalize_code(request.match_info["code"])
        seg_key = request.match_info["seg_key"]
        room = self.rooms.get(code)
        if not room or seg_key not in room.segments:
            return web.json_response({"error": "segment_not_found"}, status=404)

        room.touch()
        data: bytes = room.segments[seg_key]["data"]
        return web.Response(
            status=200,
            body=data,
            headers={
                "Content-Type": "audio/wav",
                "Content-Length": str(len(data)),
                "Cache-Control": "no-store",
            },
        )

    # ==================== WEBSOCKET HUB ====================

    async def handle_ws(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=20.0, max_msg_size=4 * 1024 * 1024)
        await ws.prepare(request)

        role: Optional[str] = None
        peer_id = secrets.token_hex(6)
        room: Optional[Room] = None
        wifi_tracker = DeviceWifiTracker()

        try:
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                try:
                    data = json.loads(msg.data)
                except Exception:
                    continue
                if not isinstance(data, dict):
                    continue

                mtype = data.get("t")

                if mtype == "CREATE_ROOM":
                    # Закрываем старую комнату если была
                    preferred = normalize_code(data.get("code", ""))
                    code = preferred if (len(preferred) >= 4 and preferred not in self.rooms) else generate_code()
                    while code in self.rooms:
                        code = generate_code()

                    device_name = str(data.get("deviceName") or "Хост")[:48]
                    room = Room(code, peer_id, ws, device_name)
                    self.rooms[code] = room
                    role = "host"
                    await self.safe_send(ws, {"t": "ROOM_CREATED", "code": code, "peerId": peer_id})

                elif mtype == "JOIN_ROOM":
                    code = normalize_code(data.get("code", ""))
                    target = self.rooms.get(code)
                    if not target or target.host_ws.closed:
                        await self.safe_send(
                            ws,
                            {
                                "t": "JOIN_ERROR",
                                "message": f"Комната {code[:3]}-{code[3:]} не найдена. Проверьте код и что вкладка Хоста открыта.",
                            },
                        )
                        continue

                    device_name = str(data.get("deviceName") or "Устройство")[:48]
                    room = target
                    role = "listener"
                    room.listeners[peer_id] = {"ws": ws, "deviceName": device_name}
                    room.touch()

                    await self.safe_send(
                        ws,
                        {
                            "t": "ROOM_JOINED",
                            "code": code,
                            "peerId": peer_id,
                            "hostPeerId": room.host_id,
                            "hostDeviceName": room.host_name,
                        },
                    )
                    await self.safe_send(
                        room.host_ws,
                        {
                            "t": "PEER_JOINED",
                            "peerId": peer_id,
                            "deviceName": device_name,
                        },
                    )

                elif mtype == "TO_HOST":
                    if room and role == "listener":
                        room.touch()
                        await self.safe_send(
                            room.host_ws,
                            {
                                "t": "FROM_PEER",
                                "from": peer_id,
                                "payload": data.get("payload"),
                            },
                        )

                elif mtype == "TO_PEER":
                    if room and role == "host":
                        room.touch()
                        to_id = data.get("to")
                        payload = data.get("payload")
                        if to_id:
                            listener = room.listeners.get(to_id)
                            if listener:
                                await self.safe_send(
                                    listener["ws"],
                                    {"t": "FROM_HOST", "from": peer_id, "payload": payload},
                                )
                        else:
                            # Broadcast всем слушателям параллельно
                            tasks = [
                                self.safe_send(l["ws"], {"t": "FROM_HOST", "from": peer_id, "payload": payload})
                                for l in room.listeners.values()
                            ]
                            if tasks:
                                await asyncio.gather(*tasks, return_exceptions=True)

                elif mtype == "SIGNAL":
                    if not room:
                        continue
                    room.touch()
                    to_id = data.get("to")
                    sig_data = data.get("data")
                    if role == "listener":
                        await self.safe_send(room.host_ws, {"t": "SIGNAL", "from": peer_id, "data": sig_data})
                    elif role == "host" and to_id:
                        listener = room.listeners.get(to_id)
                        if listener:
                            await self.safe_send(listener["ws"], {"t": "SIGNAL", "from": peer_id, "data": sig_data})

                elif mtype == "WIFI_SCAN":
                    aps = data.get("aps")
                    preferred = data.get("site")
                    loc = self.wifi_locator.locate(aps, tracker=wifi_tracker, preferred_site=preferred)
                    if loc:
                        await self.safe_send(ws, {"t": "LOCATION_UPDATE", "location": loc})
                        if room and role == "listener":
                            room.touch()
                            await self.safe_send(
                                room.host_ws,
                                {
                                    "t": "FROM_PEER",
                                    "from": peer_id,
                                    "payload": {"type": "DEVICE_LOCATION", "location": loc},
                                },
                            )
                    else:
                        await self.safe_send(
                            ws,
                            {
                                "t": "LOCATION_UPDATE",
                                "location": None,
                                "totalAps": len(self.wifi_locator.normalize_scan(aps)),
                            },
                        )

                elif mtype == "LEAVE":
                    break

        finally:
            if room:
                if role == "listener":
                    room.listeners.pop(peer_id, None)
                    await self.safe_send(room.host_ws, {"t": "PEER_LEFT", "peerId": peer_id})
                elif role == "host" and room.host_id == peer_id:
                    for l in list(room.listeners.values()):
                        await self.safe_send(l["ws"], {"t": "HOST_LEFT"})
                    self.rooms.pop(room.code, None)

        return ws

    # ==================== STATIC FRONTEND ====================

    async def handle_static(self, request: web.Request) -> web.StreamResponse:
        rel = request.match_info.get("path", "").lstrip("/")
        if not rel:
            rel = "index.html"
        # Безопасная проверка пути
        target = (ROOT_DIR / rel).resolve()
        if not str(target).startswith(str(ROOT_DIR)) or not target.is_file():
            return web.Response(status=404, text="Not found")
        resp = web.FileResponse(target)
        resp.headers["Cache-Control"] = "no-cache, must-revalidate"
        return resp


@web.middleware
async def cors_middleware(request: web.Request, handler):
    if request.method == "OPTIONS":
        resp = web.Response(status=204)
    else:
        resp = await handler(request)
    if not resp.prepared:
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type, Range, X-Track-Name"
        resp.headers["Access-Control-Expose-Headers"] = "Content-Length, Content-Range, Accept-Ranges"
        resp.headers["Access-Control-Max-Age"] = "86400"
    return resp


def create_app() -> web.Application:
    srv = OrpheusServer()
    app = web.Application(client_max_size=MAX_FILE_BYTES + 1024 * 1024, middlewares=[cors_middleware])
    app.router.add_get("/health", srv.handle_health)
    app.router.add_get("/api/sites", srv.handle_sites)
    app.router.add_post("/api/locate", srv.handle_locate)
    app.router.add_get("/ws", srv.handle_ws)
    app.router.add_put("/api/rooms/{code}/tracks/{track_id}", srv.handle_put_track)
    app.router.add_get("/api/rooms/{code}/tracks/{track_id}", srv.handle_get_track)
    app.router.add_put("/api/rooms/{code}/seg/{seg_key}", srv.handle_put_segment)
    app.router.add_get("/api/rooms/{code}/seg/{seg_key}", srv.handle_get_segment)
    app.router.add_get("/", srv.handle_static)
    app.router.add_get("/{path:.*}", srv.handle_static)

    async def on_startup(app_inst):
        app_inst["cleanup_task"] = asyncio.create_task(srv.cleanup_loop())

    async def on_cleanup(app_inst):
        task = app_inst.get("cleanup_task")
        if task:
            task.cancel()

    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app


if __name__ == "__main__":
    print(f"[Orpheus Server] Listening on http://{HOST}:{PORT} (root: {ROOT_DIR})", flush=True)
    web.run_app(create_app(), host=HOST, port=PORT, access_log=None)
