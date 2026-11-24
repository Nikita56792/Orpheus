#!/usr/bin/env python3
"""
Async Python client for the unofficial Yandex Music API.

Protocol details (endpoints, client headers, OAuth Device Code flow,
download-info MD5 signing, get-file-info HMAC-SHA256 signing, and URL host
validation) are modeled after https://github.com/SpolzerMod/yamusic-rs.

Dependencies:
  - aiohttp (already in server/requirements.txt)
  - Python standard library only (hashlib, hmac, base64, urllib, xml.etree)
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import socket
import time
import urllib.parse
import xml.etree.ElementTree as ET
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import aiohttp

# ==================== Protocol Constants (from yamusic-rs) ====================

API_BASE = "https://api.music.yandex.net"
OAUTH_BASE = "https://oauth.yandex.ru"
OAUTH_VERIFICATION_URL = "https://ya.ru/device"

# Official Yandex Music Android OAuth client credentials used by third-party clients
OAUTH_CLIENT_ID = "23cabbbdc6cd418abb4b39c32c41195d"
OAUTH_CLIENT_SECRET = "53bc75238f0c4d08a118e51fe9203300"
OAUTH_SCOPE = "music:content music:read music:write"

# Audio & lyrics request signing secrets
MP3_SALT = "XGRlBW9FXlekgbPrRHuSiA"
SIGN_KEY = "p93jhgh689SBReK6ghtw62"

# Client identification headers
ANDROID_CLIENT = "YandexMusicAndroid/24023621"
DESKTOP_CLIENT = "YandexMusicDesktopAppWindows/5.126.1"
USER_AGENT = "Yandex-Music-API"

WAVE_STATION = "user:onyourwave"

TRUSTED_YANDEX_DOMAINS = ("yandex.net", "yandex.ru")

MISC_IMAGE_SIZES = (30, 40, 50, 75, 80, 100, 150, 160, 200, 300, 400, 460, 600, 700, 800, 1000)
DEFAULT_IMAGE_SIZES = (50, 100, 200, 300, 400, 600, 1000)

CODEC_MIME_MAP: Dict[str, str] = {
    "mp3": "audio/mpeg",
    "aac": "audio/aac",
    "he-aac": "audio/aac",
    "aac-mp4": "audio/mp4",
    "he-aac-mp4": "audio/mp4",
    "mp4": "audio/mp4",
    "m4a": "audio/mp4",
    "flac": "audio/flac",
    "flac-mp4": "audio/mp4",
    "ogg": "audio/ogg",
}

# ==================== Exceptions ====================


class YandexMusicError(Exception):
    """Base error for Yandex Music API and network failures."""

    def __init__(
        self,
        message: str,
        *,
        status: Optional[int] = None,
        code: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code


class YandexAuthError(YandexMusicError):
    """Raised when the OAuth token is missing, invalid, or expired."""


class YandexNotFoundError(YandexMusicError):
    """Raised when a requested track, album, playlist, or resource is not found."""


# ==================== Helper & Crypto Functions ====================


def is_trusted_yandex_url(url: str) -> bool:
    """Allow sending OAuth tokens only over HTTPS to official Yandex domains."""
    try:
        parsed = urllib.parse.urlparse(url.strip())
    except ValueError:
        return False
    if parsed.scheme != "https":
        return False
    host = (parsed.hostname or "").lower()
    if not host:
        return False
    return any(host == domain or host.endswith(f".{domain}") for domain in TRUSTED_YANDEX_DOMAINS)


def generate_device_id(seed: Optional[str] = None) -> str:
    """Generate a 32-character hex device ID (stable if seed is provided)."""
    if seed is not None:
        return hashlib.md5(seed.encode("utf-8")).hexdigest()
    return secrets.token_hex(16)


def build_device_header(device_id: str) -> str:
    """Build the X-Yandex-Music-Device header in desktop client format."""
    clean = device_id.strip().lower()
    if len(clean) != 32 or any(ch not in "0123456789abcdef" for ch in clean):
        clean = hashlib.md5(clean.encode("utf-8")).hexdigest()
    uuid_str = f"{clean[:8]}-{clean[8:12]}-{clean[12:16]}-{clean[16:20]}-{clean[20:32]}"
    device_hash = hashlib.sha256(clean.encode("utf-8")).hexdigest()
    return (
        f"manufacturer=; model=; uuid={uuid_str}; os=win32; "
        f"os_version=; device_id={device_hash}; clid=0"
    )


def format_cover_url(uri: Optional[str], size: int = 400) -> Optional[str]:
    """Convert a Yandex cover URI template (with `%%`) into a full HTTPS URL."""
    if not uri or not isinstance(uri, str):
        return None
    cleaned = uri.strip()
    if not cleaned:
        return None
    if cleaned.startswith("https://"):
        cleaned = cleaned[len("https://") :]
    elif cleaned.startswith("http://"):
        cleaned = cleaned[len("http://") :]

    sizes = MISC_IMAGE_SIZES if "/get-music-misc/" in cleaned else DEFAULT_IMAGE_SIZES
    picked = next((s for s in sizes if s >= size), sizes[-1])
    return f"https://{cleaned.replace('%%', f'{picked}x{picked}')}"


def sign_hmac_sha256(message: str, *, key: str = SIGN_KEY, strip_padding: bool = False) -> str:
    """
    Compute Base64(HMAC-SHA256(key, message)).

    Note: Yandex's `/get-file-info` endpoint requires stripping the trailing `=`
    character from the Base64 digest (`strip_padding=True`), whereas `/lyrics`
    keeps standard Base64 padding (`strip_padding=False`).
    """
    digest = hmac.new(key.encode("utf-8"), message.encode("utf-8"), hashlib.sha256).digest()
    encoded = base64.b64encode(digest).decode("ascii")
    if strip_padding and encoded.endswith("="):
        return encoded[:-1]
    return encoded


def compute_download_md5(path: str, s_value: str, *, salt: str = MP3_SALT) -> str:
    """Compute the legacy download-info MD5 signature: md5(salt + path[1:] + s)."""
    trimmed_path = path[1:] if path.startswith("/") else path
    payload = f"{salt}{trimmed_path}{s_value}".encode("utf-8")
    return hashlib.md5(payload).hexdigest()


def build_download_url(xml_text: str, *, codec: str = "mp3", salt: str = MP3_SALT) -> str:
    """Parse Yandex download-info XML and build the signed direct media URL."""
    try:
        root = ET.fromstring(xml_text.strip())
    except ET.ParseError as exc:
        raise YandexMusicError(f"Failed to parse download-info XML: {exc}") from exc

    def _tag(name: str) -> str:
        el = root.find(name)
        if el is None or not el.text:
            raise YandexMusicError(f"Missing <{name}> in download-info XML")
        return el.text.strip()

    host = _tag("host")
    path = _tag("path")
    ts = _tag("ts")
    s_val = _tag("s")

    md5_hex = compute_download_md5(path, s_val, salt=salt)
    normalized_path = path if path.startswith("/") else f"/{path}"
    codec_norm = (codec or "mp3").lower()
    endpoint = "get-mp3" if codec_norm == "mp3" else f"get-{codec_norm}"
    return f"https://{host}/{endpoint}/{md5_hex}/{ts}{normalized_path}"


def codec_to_mime(codec: Optional[str]) -> str:
    """Map a Yandex codec string to a browser-friendly MIME type."""
    if not codec:
        return "audio/mpeg"
    return CODEC_MIME_MAP.get(codec.lower().strip(), "audio/mpeg")


def detect_audio_mime(data: bytes, fallback: str = "audio/mpeg") -> str:
    """Sniff audio container/codec MIME type from magic header bytes."""
    if len(data) >= 3 and data[:3] == b"ID3":
        return "audio/mpeg"
    if len(data) >= 8 and data[4:8] == b"ftyp":
        return "audio/mp4"
    if len(data) >= 4 and data[:4] == b"fLaC":
        return "audio/flac"
    if len(data) >= 4 and data[:4] == b"OggS":
        return "audio/ogg"
    if len(data) >= 2 and data[0] == 0xFF:
        # ADTS AAC frame sync: 0xFFF0 / 0xFFF1 / 0xFFF8 / 0xFFF9 (layer bits == 00)
        if (data[1] & 0xF6) == 0xF0:
            return "audio/aac"
        # MPEG audio frame sync (MP3)
        if (data[1] & 0xE0) == 0xE0:
            return "audio/mpeg"
    return fallback or "audio/mpeg"


def get_oauth_authorize_url(client_id: str = OAUTH_CLIENT_ID) -> str:
    """
    Build a 1-click browser OAuth URL that yields an `access_token` in the URL fragment.

    For seamless login without copying URLs, prefer the Device Code flow
    (`start_device_auth` + `poll_device_auth`) used by yamusic-rs.
    """
    params = urllib.parse.urlencode(
        {
            "response_type": "token",
            "client_id": client_id,
        }
    )
    return f"{OAUTH_BASE}/authorize?{params}"


# ==================== Normalization Helpers ====================


def _as_str(val: Any) -> str:
    if val is None:
        return ""
    if isinstance(val, str):
        return val
    if isinstance(val, (int, float)):
        return str(val)
    return ""


def _extract_artists_str(raw: Dict[str, Any]) -> str:
    artists = raw.get("artists")
    if not isinstance(artists, list):
        return ""
    names = [str(a["name"]).strip() for a in artists if isinstance(a, dict) and a.get("name")]
    return ", ".join(names)


def normalize_track(raw: Any, *, cover_size: int = 400) -> Optional[Dict[str, Any]]:
    """
    Normalize a Yandex Music track object into the Orpheus track schema:
    `{ id, title, artists, album, durationSec, coverUrl, available, explicit }`.
    """
    if not isinstance(raw, dict):
        return None
    # Some endpoints wrap the track under {"track": {...}}
    if "track" in raw and isinstance(raw["track"], dict) and "title" not in raw:
        raw = raw["track"]

    track_id = _as_str(raw.get("id")).strip()
    title = _as_str(raw.get("title")).strip()
    if not track_id or not title:
        return None

    version = _as_str(raw.get("version")).strip()
    if version and version.lower() not in title.lower():
        full_title = f"{title} ({version})"
    else:
        full_title = title

    albums = raw.get("albums")
    first_album = albums[0] if isinstance(albums, list) and albums and isinstance(albums[0], dict) else None
    album_title = _as_str(first_album.get("title")).strip() if first_album else ""

    duration_ms = raw.get("durationMs")
    try:
        duration_sec = round(float(duration_ms) / 1000.0, 3) if duration_ms is not None else 0.0
    except (TypeError, ValueError):
        duration_sec = 0.0

    cover_uri = raw.get("coverUri")
    if not cover_uri and first_album:
        cover_uri = first_album.get("coverUri") or (
            first_album.get("cover", {}).get("uri") if isinstance(first_album.get("cover"), dict) else None
        )
    if not cover_uri:
        cover_uri = raw.get("ogImage")

    available_raw = raw.get("available")
    available = True if available_raw is None else bool(available_raw)

    explicit = (
        raw.get("contentWarning") == "explicit"
        or bool(raw.get("explicit"))
        or (bool(first_album) and first_album.get("contentWarning") == "explicit")
    )

    return {
        "id": track_id,
        "title": full_title,
        "artists": _extract_artists_str(raw),
        "album": album_title,
        "durationSec": duration_sec,
        "coverUrl": format_cover_url(cover_uri, size=cover_size),
        "available": available,
        "explicit": explicit,
    }


def normalize_playlist(raw: Any, *, cover_size: int = 400) -> Optional[Dict[str, Any]]:
    """Normalize a Yandex Music playlist object."""
    if not isinstance(raw, dict):
        return None
    owner = raw.get("owner") if isinstance(raw.get("owner"), dict) else {}
    uid = _as_str(raw.get("uid") or owner.get("uid")).strip()
    kind = _as_str(raw.get("kind")).strip()
    if not uid or not kind:
        return None

    cover_uri: Optional[str] = None
    cover = raw.get("cover")
    if isinstance(cover, dict):
        if isinstance(cover.get("uri"), str) and cover["uri"]:
            cover_uri = cover["uri"]
        elif isinstance(cover.get("itemsUri"), list) and cover["itemsUri"]:
            first_item = cover["itemsUri"][0]
            if isinstance(first_item, str) and first_item:
                cover_uri = first_item
    if not cover_uri and isinstance(raw.get("ogImage"), str):
        cover_uri = raw["ogImage"]

    owner_name = _as_str(owner.get("name")).strip() or _as_str(owner.get("login")).strip()
    track_count = raw.get("trackCount")
    try:
        track_count_int = int(track_count) if track_count is not None else 0
    except (TypeError, ValueError):
        track_count_int = 0

    return {
        "uid": uid,
        "kind": kind,
        "title": _as_str(raw.get("title")).strip(),
        "owner": owner_name,
        "trackCount": track_count_int,
        "coverUrl": format_cover_url(cover_uri, size=cover_size),
        "description": _as_str(raw.get("description")).strip(),
        "modified": _as_str(raw.get("modified")).strip(),
    }


def normalize_album(raw: Any, *, cover_size: int = 400) -> Optional[Dict[str, Any]]:
    """Normalize a Yandex Music album object."""
    if not isinstance(raw, dict):
        return None
    album_id = _as_str(raw.get("id")).strip()
    title = _as_str(raw.get("title")).strip()
    if not album_id or not title:
        return None

    cover_uri = raw.get("coverUri")
    if not cover_uri and isinstance(raw.get("cover"), dict):
        cover_uri = raw["cover"].get("uri")
    if not cover_uri:
        cover_uri = raw.get("ogImage")

    year_val = raw.get("year")
    year: Optional[int] = None
    if isinstance(year_val, int):
        year = year_val
    elif isinstance(raw.get("releaseDate"), str) and len(raw["releaseDate"]) >= 4:
        try:
            year = int(raw["releaseDate"][:4])
        except ValueError:
            year = None

    track_count = raw.get("trackCount")
    try:
        track_count_int = int(track_count) if track_count is not None else 0
    except (TypeError, ValueError):
        track_count_int = 0

    return {
        "id": album_id,
        "title": title,
        "artists": _extract_artists_str(raw),
        "year": year,
        "type": _as_str(raw.get("type") or raw.get("albumType")).strip(),
        "trackCount": track_count_int,
        "coverUrl": format_cover_url(cover_uri, size=cover_size),
    }


def normalize_artist(raw: Any, *, cover_size: int = 400) -> Optional[Dict[str, Any]]:
    """Normalize a Yandex Music artist object."""
    if not isinstance(raw, dict):
        return None
    artist_id = _as_str(raw.get("id")).strip()
    name = _as_str(raw.get("name")).strip()
    if not artist_id or not name:
        return None
    cover_uri = None
    if isinstance(raw.get("cover"), dict):
        cover_uri = raw["cover"].get("uri")
    if not cover_uri:
        cover_uri = raw.get("ogImage")
    return {
        "id": artist_id,
        "name": name,
        "coverUrl": format_cover_url(cover_uri, size=cover_size),
    }


# ==================== OAuth Device Code Flow (yamusic-rs/src/auth.rs) ====================


async def _oauth_post(
    path: str,
    form: Dict[str, str],
    *,
    session: Optional[aiohttp.ClientSession] = None,
    timeout: float = 20.0,
) -> Dict[str, Any]:
    url = f"{OAUTH_BASE}{path}"
    owns_session = session is None
    client_session = session or aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout))
    try:
        async with client_session.post(url, data=form) as resp:
            text = await resp.text()
            try:
                data = await resp.json(content_type=None)
            except Exception as exc:
                raise YandexAuthError(
                    f"Unexpected OAuth response (HTTP {resp.status}): {text[:200]}",
                    status=resp.status,
                ) from exc
            if not isinstance(data, dict):
                raise YandexAuthError(
                    f"Unexpected OAuth JSON payload (HTTP {resp.status})",
                    status=resp.status,
                )
            return data
    except aiohttp.ClientError as exc:
        raise YandexMusicError(f"OAuth network error: {exc}") from exc
    finally:
        if owns_session:
            await client_session.close()


async def start_device_auth(
    *,
    device_name: Optional[str] = None,
    device_id: Optional[str] = None,
    session: Optional[aiohttp.ClientSession] = None,
) -> Dict[str, Any]:
    """
    Start the Yandex OAuth Device Code flow (same flow as yamusic-rs).

    The user visits `verificationUrl` (https://ya.ru/device) on any phone or
    desktop browser and enters `userCode`. Then poll `poll_device_auth(deviceCode)`.
    """
    dev_id = device_id or generate_device_id()
    if not device_name:
        try:
            host = socket.gethostname() or "Server"
        except Exception:
            host = "Server"
        device_name = f"Orpheus ({host})"

    data = await _oauth_post(
        "/device/code",
        {
            "client_id": OAUTH_CLIENT_ID,
            "device_id": dev_id,
            "device_name": device_name,
            "scope": OAUTH_SCOPE,
        },
        session=session,
    )

    device_code = data.get("device_code")
    user_code = data.get("user_code")
    if not device_code or not user_code:
        desc = data.get("error_description") or data.get("error") or "Yandex OAuth did not return a device code"
        raise YandexAuthError(str(desc), code=data.get("error"))

    return {
        "deviceCode": str(device_code),
        "userCode": str(user_code),
        "verificationUrl": str(data.get("verification_url") or OAUTH_VERIFICATION_URL),
        "interval": max(1, int(data.get("interval") or 5)),
        "expiresIn": int(data.get("expires_in") or 300),
        "deviceId": dev_id,
    }


async def poll_device_auth(
    device_code: str,
    *,
    session: Optional[aiohttp.ClientSession] = None,
) -> Dict[str, Any]:
    """
    Poll Yandex OAuth for completion of a Device Code login.

    Returns:
      - `{ "status": "pending" }` while waiting for the user
      - `{ "status": "done", "accessToken": str, "refreshToken": Optional[str], "expiresIn": Optional[int] }`
      - `{ "status": "failed", "error": str, "code": Optional[str] }`
    """
    try:
        data = await _oauth_post(
            "/token",
            {
                "grant_type": "device_code",
                "code": device_code,
                "client_id": OAUTH_CLIENT_ID,
                "client_secret": OAUTH_CLIENT_SECRET,
            },
            session=session,
        )
    except YandexMusicError:
        return {"status": "pending"}

    access_token = data.get("access_token")
    if isinstance(access_token, str) and access_token:
        return {
            "status": "done",
            "accessToken": access_token,
            "refreshToken": data.get("refresh_token"),
            "expiresIn": data.get("expires_in"),
        }

    err = data.get("error")
    if err in ("authorization_pending", "slow_down"):
        return {"status": "pending"}

    desc = data.get("error_description") or err or "Device authorization failed"
    return {
        "status": "failed",
        "error": str(desc),
        "code": str(err) if err else None,
    }


async def refresh_oauth_token(
    refresh_token: str,
    *,
    session: Optional[aiohttp.ClientSession] = None,
) -> Dict[str, Any]:
    """Refresh an OAuth access token using a refresh_token."""
    data = await _oauth_post(
        "/token",
        {
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": OAUTH_CLIENT_ID,
            "client_secret": OAUTH_CLIENT_SECRET,
        },
        session=session,
    )
    access_token = data.get("access_token")
    if not isinstance(access_token, str) or not access_token:
        desc = data.get("error_description") or data.get("error") or "Failed to refresh OAuth token"
        raise YandexAuthError(str(desc), code=data.get("error"))
    return {
        "accessToken": access_token,
        "refreshToken": data.get("refresh_token"),
        "expiresIn": data.get("expires_in"),
    }


async def revoke_oauth_token(
    access_token: str,
    *,
    session: Optional[aiohttp.ClientSession] = None,
) -> bool:
    """Revoke an OAuth access token issued with a device_id."""
    data = await _oauth_post(
        "/revoke_token",
        {
            "access_token": access_token,
            "client_id": OAUTH_CLIENT_ID,
            "client_secret": OAUTH_CLIENT_SECRET,
        },
        session=session,
    )
    if data.get("status") == "ok":
        return True
    desc = data.get("error_description") or data.get("error") or "Failed to revoke OAuth token"
    raise YandexAuthError(str(desc), code=data.get("error"))


# ==================== Main Async Client ====================


class YandexMusicClient:
    """
    Async Yandex Music API client built on aiohttp.

    Supports both authenticated access (OAuth token) and anonymous public access
    (chart, public playlists, albums, search, and 30-second track previews).
    """

    get_oauth_authorize_url = staticmethod(get_oauth_authorize_url)
    start_device_auth = staticmethod(start_device_auth)
    poll_device_auth = staticmethod(poll_device_auth)
    refresh_oauth_token = staticmethod(refresh_oauth_token)
    revoke_oauth_token = staticmethod(revoke_oauth_token)

    def __init__(
        self,
        token: str = "",
        *,
        lang: str = "ru",
        session: Optional[aiohttp.ClientSession] = None,
        timeout: float = 30.0,
        download_timeout: float = 120.0,
        device_id: Optional[str] = None,
    ) -> None:
        self.token = (token or "").strip()
        self.lang = (lang or "ru").strip()
        self._external_session = session
        self._session: Optional[aiohttp.ClientSession] = session
        self._timeout = timeout
        self._download_timeout = download_timeout
        self._device_id = device_id or generate_device_id("orpheus-yandex-music")
        self._device_header = build_device_header(self._device_id)
        self._uid_cache: Optional[str] = None
        self._account_cache: Optional[Dict[str, Any]] = None

    @property
    def is_authenticated(self) -> bool:
        return bool(self.token)

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            timeout = aiohttp.ClientTimeout(total=self._timeout, connect=10.0)
            self._session = aiohttp.ClientSession(timeout=timeout)
        return self._session

    async def close(self) -> None:
        """Close the internal aiohttp session if this client owns it."""
        if self._session is not None and self._session is not self._external_session:
            if not self._session.closed:
                await self._session.close()
        self._session = self._external_session

    async def __aenter__(self) -> "YandexMusicClient":
        await self._get_session()
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        await self.close()

    # -------------------- Low-level HTTP --------------------

    def _build_url(self, path_or_url: str) -> str:
        if path_or_url.startswith("https://") or path_or_url.startswith("http://"):
            return path_or_url
        if not path_or_url.startswith("/"):
            path_or_url = f"/{path_or_url}"
        return f"{API_BASE}{path_or_url}"

    def _build_headers(self, url: str, *, desktop: bool = False, extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
        headers: Dict[str, str] = {
            "User-Agent": USER_AGENT,
            "Accept-Language": self.lang,
            "X-Yandex-Music-Client": DESKTOP_CLIENT if desktop else ANDROID_CLIENT,
        }
        if desktop:
            headers["X-Yandex-Music-Device"] = self._device_header
            headers["X-Yandex-Music-Without-Invocation-Info"] = "1"
        if self.token and is_trusted_yandex_url(url):
            headers["Authorization"] = f"OAuth {self.token}"
        if extra:
            headers.update(extra)
        return headers

    async def _request_text(
        self,
        method: str,
        path_or_url: str,
        *,
        params: Optional[Dict[str, Any]] = None,
        data: Optional[Dict[str, Any]] = None,
        json_body: Optional[Dict[str, Any]] = None,
        desktop: bool = False,
        extra_headers: Optional[Dict[str, str]] = None,
    ) -> Tuple[int, str]:
        url = self._build_url(path_or_url)
        headers = self._build_headers(url, desktop=desktop, extra=extra_headers)
        session = await self._get_session()
        try:
            async with session.request(
                method,
                url,
                params=params,
                data=data,
                json=json_body,
                headers=headers,
            ) as resp:
                text = await resp.text()
                return resp.status, text
        except aiohttp.ClientError as exc:
            raise YandexMusicError(f"Network error calling Yandex Music API: {exc}") from exc

    async def _request_api(
        self,
        method: str,
        path_or_url: str,
        *,
        params: Optional[Dict[str, Any]] = None,
        data: Optional[Dict[str, Any]] = None,
        json_body: Optional[Dict[str, Any]] = None,
        desktop: bool = False,
        unwrap_result: bool = True,
        extra_headers: Optional[Dict[str, str]] = None,
    ) -> Any:
        status, text = await self._request_text(
            method,
            path_or_url,
            params=params,
            data=data,
            json_body=json_body,
            desktop=desktop,
            extra_headers=extra_headers,
        )

        import json

        try:
            payload = json.loads(text)
        except json.JSONDecodeError as exc:
            if status in (401, 403):
                raise YandexAuthError(
                    f"Unauthorized (HTTP {status}): invalid or expired token",
                    status=status,
                ) from exc
            if status == 404:
                raise YandexNotFoundError(f"Resource not found (HTTP 404): {path_or_url}", status=404) from exc
            raise YandexMusicError(f"HTTP {status}: {text[:200]}", status=status) from exc

        if status < 200 or status >= 300:
            err_obj = payload.get("error") if isinstance(payload, dict) else None
            err_name = err_obj.get("name") if isinstance(err_obj, dict) else None
            err_msg = (
                (err_obj.get("message") if isinstance(err_obj, dict) else None)
                or err_name
                or (payload.get("message") if isinstance(payload, dict) else None)
                or text[:200]
            )
            if status in (401, 403):
                raise YandexAuthError(
                    f"Access denied (HTTP {status}) — OAuth token is invalid or expired. {err_msg}",
                    status=status,
                    code=str(err_name) if err_name else None,
                )
            if status == 404:
                raise YandexNotFoundError(
                    f"Not found (HTTP 404): {err_msg}",
                    status=404,
                    code=str(err_name) if err_name else None,
                )
            raise YandexMusicError(
                f"Yandex Music API error (HTTP {status}): {err_msg}",
                status=status,
                code=str(err_name) if err_name else None,
            )

        if unwrap_result and isinstance(payload, dict) and "result" in payload:
            return payload["result"]
        return payload

    def _require_token(self, action: str) -> None:
        if not self.token:
            raise YandexAuthError(
                f"Yandex Music OAuth token is required for {action}",
                status=401,
                code="token-required",
            )

    async def _ensure_uid(self) -> str:
        self._require_token("authenticated user data")
        if self._uid_cache:
            return self._uid_cache
        status = await self.account_status()
        return status["uid"]

    # -------------------- Account --------------------

    async def account_status(self) -> Dict[str, Any]:
        """
        Validate the current OAuth token and return account metadata.

        Endpoint: GET /account/status (optionally enriched via GET /account/about).
        """
        self._require_token("account_status")
        res = await self._request_api("GET", "/account/status")
        if not isinstance(res, dict) or not isinstance(res.get("account"), dict):
            raise YandexAuthError("Missing account section in /account/status response", status=401)

        acc = res["account"]
        uid = _as_str(acc.get("uid")).strip()
        if not uid:
            raise YandexAuthError(
                "Yandex Music did not recognize the OAuth token — please sign in again",
                status=401,
                code="invalid-token",
            )

        login = _as_str(acc.get("login")).strip()
        full_name = _as_str(acc.get("fullName")).strip()
        display_name = _as_str(acc.get("displayName")).strip() or full_name or login
        plus = res.get("plus") if isinstance(res.get("plus"), dict) else {}
        has_plus = bool(plus.get("hasPlus"))

        avatar_url: Optional[str] = None
        try:
            about = await self._request_api("GET", "/account/about")
            if isinstance(about, dict):
                pub = _as_str(about.get("publicName")).strip()
                if pub:
                    display_name = pub
                avatar_id = _as_str(about.get("avatarId")).strip()
                if avatar_id:
                    avatar_url = f"https://avatars.yandex.net/get-yapic/{avatar_id}/islands-retina-50"
        except YandexMusicError:
            pass

        info = {
            "authenticated": True,
            "uid": uid,
            "login": login,
            "displayName": display_name,
            "fullName": full_name,
            "hasPlus": has_plus,
            "avatarUrl": avatar_url,
        }
        self._uid_cache = uid
        self._account_cache = info
        return info

    # -------------------- Search & Catalog --------------------

    async def search(self, query: str, page: int = 0, *, search_type: str = "all") -> Dict[str, List[Dict[str, Any]]]:
        """
        Search Yandex Music catalog.

        Endpoint: GET /search?text=<query>&type=<type>&page=<page>&nocorrect=false
        Returns normalized `{ tracks, playlists, albums, artists }`.
        """
        text = (query or "").strip()
        if not text:
            return {"tracks": [], "playlists": [], "albums": [], "artists": []}

        res = await self._request_api(
            "GET",
            "/search",
            params={
                "text": text,
                "type": search_type,
                "page": str(max(0, int(page))),
                "nocorrect": "false",
            },
        )
        if not isinstance(res, dict):
            return {"tracks": [], "playlists": [], "albums": [], "artists": []}

        def _extract(section: str, normalizer: Any) -> List[Dict[str, Any]]:
            block = res.get(section)
            if not isinstance(block, dict):
                return []
            items = block.get("results")
            if not isinstance(items, list):
                return []
            out: List[Dict[str, Any]] = []
            for item in items:
                norm = normalizer(item)
                if norm is not None:
                    out.append(norm)
            return out

        return {
            "tracks": _extract("tracks", normalize_track),
            "playlists": _extract("playlists", normalize_playlist),
            "albums": _extract("albums", normalize_album),
            "artists": _extract("artists", normalize_artist),
        }

    async def tracks_by_ids(self, track_ids: Sequence[str]) -> List[Dict[str, Any]]:
        """
        Batch-fetch full track metadata by IDs (chunked in batches of 250).

        Endpoint: POST /tracks (form: track-ids=<csv>)
        """
        clean_ids = [str(tid).strip() for tid in track_ids if str(tid).strip()]
        if not clean_ids:
            return []

        out: List[Dict[str, Any]] = []
        chunk_size = 250
        for start in range(0, len(clean_ids), chunk_size):
            chunk = clean_ids[start : start + chunk_size]
            res = await self._request_api(
                "POST",
                "/tracks",
                data={"track-ids": ",".join(chunk)},
            )
            if isinstance(res, list):
                for item in res:
                    norm = normalize_track(item)
                    if norm is not None:
                        out.append(norm)
        return out

    async def liked_tracks(self, limit: int = 100) -> List[Dict[str, Any]]:
        """
        Fetch the authenticated user's Liked tracks in exact library order.

        Endpoints: GET /users/{uid}/likes/tracks + POST /tracks
        """
        uid = await self._ensure_uid()
        res = await self._request_api("GET", f"/users/{uid}/likes/tracks")
        library = res.get("library") if isinstance(res, dict) else None
        raw_items = library.get("tracks") if isinstance(library, dict) else None
        if not isinstance(raw_items, list) or not raw_items:
            return []

        ordered_ids: List[str] = []
        for item in raw_items:
            if isinstance(item, dict):
                tid = _as_str(item.get("id")).strip()
                if tid:
                    ordered_ids.append(tid)

        if limit and limit > 0:
            ordered_ids = ordered_ids[:limit]

        tracks = await self.tracks_by_ids(ordered_ids)
        pos_map = {tid: idx for idx, tid in enumerate(ordered_ids)}
        tracks.sort(key=lambda t: pos_map.get(t["id"], len(ordered_ids)))
        return tracks

    async def user_playlists(self) -> List[Dict[str, Any]]:
        """
        Fetch playlists created by the authenticated user.

        Endpoint: GET /users/{uid}/playlists/list
        """
        uid = await self._ensure_uid()
        res = await self._request_api("GET", f"/users/{uid}/playlists/list")
        if not isinstance(res, list):
            return []
        out: List[Dict[str, Any]] = []
        for item in res:
            norm = normalize_playlist(item)
            if norm is not None:
                out.append(norm)
        return out

    async def playlist_tracks(self, uid: str, kind: str) -> Dict[str, Any]:
        """
        Fetch a playlist and its normalized tracks. Works for public playlists
        even without authentication.

        Endpoint: GET /users/{uid}/playlists/{kind} (+ POST /tracks fallback for stub entries)
        """
        uid_clean = _as_str(uid).strip()
        kind_clean = _as_str(kind).strip()
        res = await self._request_api("GET", f"/users/{uid_clean}/playlists/{kind_clean}")
        if not isinstance(res, dict):
            raise YandexNotFoundError(f"Playlist {uid_clean}:{kind_clean} returned empty response", status=404)

        meta = normalize_playlist(res) or {
            "uid": uid_clean,
            "kind": kind_clean,
            "title": _as_str(res.get("title")).strip(),
            "owner": "",
            "trackCount": 0,
            "coverUrl": None,
            "description": "",
            "modified": "",
        }

        items = res.get("tracks") if isinstance(res.get("tracks"), list) else []
        tracks: List[Dict[str, Any]] = []
        missing_ids: List[str] = []

        for entry in items:
            if not isinstance(entry, dict):
                continue
            embedded = entry.get("track")
            if isinstance(embedded, dict):
                norm = normalize_track(embedded)
                if norm is not None:
                    tracks.append(norm)
                    continue
            tid = _as_str(entry.get("id")).strip()
            if tid:
                missing_ids.append(tid)

        # Fallback: large playlists often return only {id, albumId} stubs without embedded `track`
        if not tracks and missing_ids:
            fetched = await self.tracks_by_ids(missing_ids)
            by_id = {t["id"]: t for t in fetched}
            tracks = [by_id[tid] for tid in missing_ids if tid in by_id]

        return {
            "uid": meta["uid"],
            "kind": meta["kind"],
            "title": meta["title"],
            "owner": meta["owner"],
            "coverUrl": meta["coverUrl"],
            "trackCount": meta["trackCount"] or len(tracks),
            "tracks": tracks,
        }

    async def album_tracks(self, album_id: str) -> Dict[str, Any]:
        """
        Fetch an album and all its tracks flattened across volumes/discs.

        Endpoint: GET /albums/{album_id}/with-tracks
        """
        aid = _as_str(album_id).strip()
        res = await self._request_api("GET", f"/albums/{aid}/with-tracks")
        if not isinstance(res, dict):
            raise YandexNotFoundError(f"Album {aid} returned empty response", status=404)

        album = normalize_album(res) or {
            "id": aid,
            "title": _as_str(res.get("title")).strip(),
            "artists": _extract_artists_str(res),
            "year": None,
            "type": "",
            "trackCount": 0,
            "coverUrl": None,
        }

        tracks: List[Dict[str, Any]] = []
        volumes = res.get("volumes")
        if isinstance(volumes, list):
            for disc in volumes:
                if not isinstance(disc, list):
                    continue
                for raw_track in disc:
                    norm = normalize_track(raw_track)
                    if norm is not None:
                        if not norm["album"] and album["title"]:
                            norm["album"] = album["title"]
                        if not norm["coverUrl"] and album["coverUrl"]:
                            norm["coverUrl"] = album["coverUrl"]
                        tracks.append(norm)

        return {
            "id": album["id"],
            "title": album["title"],
            "artists": album["artists"],
            "year": album["year"],
            "coverUrl": album["coverUrl"],
            "tracks": tracks,
        }

    # -------------------- Chart & Wave (Rotor) --------------------

    async def chart(self, chart_option: str = "world") -> List[Dict[str, Any]]:
        """
        Fetch the Yandex Music top chart. Works both anonymously and authenticated.

        Primary endpoint: GET /landing3/chart (or /landing3/chart/{chart_option})
        Fallback endpoint: GET /landing/block/chart (desktop block used by yamusic-rs)
        """
        res: Any = None
        last_err: Optional[Exception] = None

        path = "/landing3/chart" if not chart_option or chart_option == "world" else f"/landing3/chart/{chart_option}"
        try:
            res = await self._request_api("GET", path)
        except YandexMusicError as exc:
            last_err = exc
            try:
                res = await self._request_api("GET", "/landing/block/chart", desktop=True)
            except YandexMusicError as exc2:
                raise YandexMusicError(
                    f"Chart request failed: {last_err}; fallback failed: {exc2}",
                    status=exc2.status or last_err.status,
                ) from exc2

        chart_obj = res.get("chart") if isinstance(res, dict) and isinstance(res.get("chart"), dict) else res
        raw_tracks = chart_obj.get("tracks") if isinstance(chart_obj, dict) else None
        if not isinstance(raw_tracks, list):
            return []

        out: List[Dict[str, Any]] = []
        for idx, item in enumerate(raw_tracks, start=1):
            if not isinstance(item, dict):
                continue
            track_raw = item.get("track") if isinstance(item.get("track"), dict) else item
            norm = normalize_track(track_raw)
            if norm is None:
                continue
            chart_info = item.get("chart") if isinstance(item.get("chart"), dict) else {}
            pos = chart_info.get("position")
            norm["position"] = int(pos) if isinstance(pos, int) else idx
            out.append(norm)
        return out

    async def wave_session(
        self,
        station: str = WAVE_STATION,
        *,
        session_id: Optional[str] = None,
        queue: Optional[Sequence[str]] = None,
        allow_explicit: bool = True,
    ) -> Dict[str, Any]:
        """
        Fetch a batch of tracks from My Wave / Rotor station using the modern
        desktop session API (`/rotor/session/new` & `/rotor/session/{id}/tracks`)
        with fallback to `/rotor/station/{station}/tracks`.
        """
        self._require_token("wave_tracks")
        station_clean = (station or WAVE_STATION).strip()
        queue_list = [str(q) for q in (queue or []) if q]

        res: Any = None
        resolved_session_id = session_id or ""

        # 1) Try modern Rotor session API (matching yamusic-rs)
        try:
            if session_id:
                res = await self._request_api(
                    "POST",
                    f"/rotor/session/{session_id}/tracks",
                    json_body={"queue": queue_list},
                    desktop=True,
                )
            else:
                body: Dict[str, Any] = {
                    "seeds": [station_clean],
                    "includeTracksInResponse": True,
                    "includeWaveModel": True,
                    "interactive": True,
                }
                if not allow_explicit:
                    body["allowExplicit"] = False
                res = await self._request_api(
                    "POST",
                    "/rotor/session/new",
                    json_body=body,
                    desktop=True,
                )
                if isinstance(res, dict):
                    resolved_session_id = _as_str(res.get("radioSessionId")).strip()
        except YandexAuthError:
            raise
        except YandexMusicError:
            res = None

        # 2) Fallback to classic Rotor station endpoint
        if not isinstance(res, dict) or not res.get("sequence"):
            params: Dict[str, str] = {"settings2": "true"}
            if queue_list:
                params["queue"] = queue_list[-1]
            res = await self._request_api(
                "GET",
                f"/rotor/station/{station_clean}/tracks",
                params=params,
            )

        sequence = res.get("sequence") if isinstance(res, dict) else None
        batch_id = _as_str(res.get("batchId")).strip() if isinstance(res, dict) else ""

        tracks: List[Dict[str, Any]] = []
        if isinstance(sequence, list):
            for entry in sequence:
                if not isinstance(entry, dict):
                    continue
                norm = normalize_track(entry.get("track") or entry)
                if norm is not None and norm["available"]:
                    tracks.append(norm)

        return {
            "station": station_clean,
            "sessionId": resolved_session_id,
            "batchId": batch_id,
            "tracks": tracks,
        }

    async def wave_tracks(
        self,
        station: str = WAVE_STATION,
        *,
        queue: Optional[Sequence[str]] = None,
    ) -> List[Dict[str, Any]]:
        """Fetch normalized tracks for My Wave (`user:onyourwave`) or any Rotor station."""
        batch = await self.wave_session(station=station, queue=queue)
        return batch["tracks"]

    async def rotor_stations(self) -> List[Dict[str, Any]]:
        """List available Rotor / Wave stations (`GET /rotor/stations/list`)."""
        res = await self._request_api("GET", "/rotor/stations/list")
        if not isinstance(res, list):
            return []
        stations: List[Dict[str, Any]] = []
        for item in res:
            if not isinstance(item, dict):
                continue
            st = item.get("station") if isinstance(item.get("station"), dict) else item
            st_id = st.get("id")
            if isinstance(st_id, dict):
                station_key = f"{st_id.get('type', '')}:{st_id.get('tag', '')}".strip(":")
            else:
                station_key = _as_str(st_id).strip()
            if not station_key:
                continue
            icon = st.get("icon") if isinstance(st.get("icon"), dict) else {}
            stations.append(
                {
                    "id": station_key,
                    "name": _as_str(st.get("name")).strip(),
                    "iconUrl": format_cover_url(icon.get("imageUrl"), size=200),
                }
            )
        return stations

    # -------------------- Audio Streaming & Download --------------------

    async def _get_stream_url_legacy(self, track_id: str, quality: str = "hq") -> Dict[str, Any]:
        """
        Resolve direct audio URL via `/tracks/{id}/download-info` + XML + MD5 signing.
        Produces unencrypted MP3 (up to 320 kbps with Plus, or 30s preview without)
        or AAC compatible with Web Audio API `decodeAudioData`.
        """
        res = await self._request_api("GET", f"/tracks/{track_id}/download-info")
        if not isinstance(res, list) or not res:
            raise YandexMusicError(f"Empty download-info for track {track_id}")

        def _is_full(item: Dict[str, Any]) -> bool:
            return not bool(item.get("preview", False))

        def _bitrate(item: Dict[str, Any]) -> int:
            try:
                return int(item.get("bitrateInKbps") or 0)
            except (TypeError, ValueError):
                return 0

        def _codec(item: Dict[str, Any]) -> str:
            return _as_str(item.get("codec")).lower().strip()

        def _sort_key(item: Dict[str, Any]) -> Tuple[int, int, int]:
            # Prefer non-preview, then Web-Audio-friendly codec (mp3 > aac), then higher bitrate
            codec_rank = 2 if _codec(item) == "mp3" else (1 if "aac" in _codec(item) else 0)
            return (1 if _is_full(item) else 0, codec_rank, _bitrate(item))

        valid_items = [x for x in res if isinstance(x, dict) and x.get("downloadInfoUrl")]
        if not valid_items:
            raise YandexMusicError(f"No valid download variants for track {track_id}")

        mp3_items = [x for x in valid_items if _codec(x) == "mp3"]
        full_mp3 = [x for x in mp3_items if _is_full(x)]

        q = (quality or "hq").lower().strip()
        picked: Optional[Dict[str, Any]] = None

        if q in ("lq", "low", "eco"):
            if full_mp3:
                picked = min(full_mp3, key=_bitrate)
            elif mp3_items:
                picked = min(mp3_items, key=_bitrate)
        elif q in ("nq", "normal", "medium"):
            under_192 = [x for x in full_mp3 if _bitrate(x) <= 192]
            if under_192:
                picked = max(under_192, key=_bitrate)
            elif full_mp3:
                picked = min(full_mp3, key=_bitrate)

        if picked is None:
            if mp3_items:
                picked = max(mp3_items, key=lambda x: (1 if _is_full(x) else 0, _bitrate(x)))
            else:
                picked = max(valid_items, key=_sort_key)

        info_url = str(picked["downloadInfoUrl"])
        if not is_trusted_yandex_url(info_url):
            raise YandexMusicError("Refusing untrusted non-Yandex downloadInfoUrl")

        status, xml_text = await self._request_text("GET", info_url)
        if status < 200 or status >= 300:
            raise YandexMusicError(f"Failed fetching download-info XML (HTTP {status})", status=status)

        codec = _codec(picked) or "mp3"
        direct_url = build_download_url(xml_text, codec=codec)
        return {
            "url": direct_url,
            "codec": codec,
            "bitrate": _bitrate(picked),
            "mime": codec_to_mime(codec),
            "preview": bool(picked.get("preview", False)),
        }

    async def _get_file_info(
        self,
        track_id: str,
        *,
        quality: str = "nq",
        codecs: str = "mp3,aac,he-aac",
        transports: str = "raw",
    ) -> Dict[str, Any]:
        """
        Resolve direct audio URL via `/get-file-info` with HMAC-SHA256 signing
        (matching yamusic-rs `Api::file_info`).
        """
        ts = str(int(time.time()))
        sign_input = f"{ts}{track_id}{quality}{codecs}{transports}".replace(",", "")
        sig = sign_hmac_sha256(sign_input, strip_padding=True)

        res = await self._request_api(
            "GET",
            "/get-file-info",
            params={
                "ts": ts,
                "trackId": str(track_id),
                "quality": quality,
                "codecs": codecs,
                "transports": transports,
                "sign": sig,
            },
        )
        di = res.get("downloadInfo") if isinstance(res, dict) else None
        if not isinstance(di, dict):
            raise YandexMusicError(f"Missing downloadInfo in /get-file-info for track {track_id}")

        url = di.get("url")
        if not url and isinstance(di.get("urls"), list) and di["urls"]:
            url = di["urls"][0]
        if not isinstance(url, str) or not url:
            raise YandexMusicError(f"Missing stream URL in /get-file-info for track {track_id}")

        codec = _as_str(di.get("codec")).lower().strip() or "mp3"
        try:
            bitrate = int(di.get("bitrate") or di.get("bitrateInKbps") or 0)
        except (TypeError, ValueError):
            bitrate = 0

        return {
            "url": url,
            "codec": codec,
            "bitrate": bitrate,
            "mime": codec_to_mime(codec),
            "preview": bool(di.get("preview", False)),
        }

    async def get_track_stream_url(self, track_id: str, quality: str = "hq") -> Dict[str, Any]:
        """
        Resolve a direct playable stream URL for `track_id`.

        Returns: `{ url, codec, bitrate, mime, preview }`.

        Strategy (matching yamusic-rs):
          - For `lossless`/`flac`: tries `/get-file-info` (`flac,flac-mp4`),
            falls back to `hq` MP3.
          - For `hq`/`nq`/`lq` (default `hq`): tries `/tracks/{id}/download-info`
            (unencrypted MP3 up to 320 kbps — universal Web Audio API support),
            then falls back to `/get-file-info` (`mp3,aac,he-aac`).
        """
        tid = _as_str(track_id).strip()
        if not tid:
            raise YandexMusicError("track_id is required")

        q = (quality or "hq").lower().strip()
        if q in ("lossless", "flac"):
            try:
                info = await self._get_file_info(tid, quality="lossless", codecs="flac,flac-mp4")
                if info["codec"].startswith("flac"):
                    return info
            except YandexMusicError:
                pass
            q = "hq"

        legacy_err: Optional[Exception] = None
        try:
            return await self._get_stream_url_legacy(tid, quality=q)
        except YandexAuthError:
            raise
        except YandexMusicError as exc:
            legacy_err = exc

        api_quality = "lq" if q in ("lq", "low", "eco") else "nq"
        try:
            return await self._get_file_info(tid, quality=api_quality, codecs="mp3,aac,he-aac")
        except YandexMusicError as exc2:
            raise YandexMusicError(
                f"Failed to resolve stream URL for track {tid}: "
                f"download-info: {legacy_err}; get-file-info: {exc2}",
                status=exc2.status or (legacy_err.status if isinstance(legacy_err, YandexMusicError) else None),
            ) from exc2

    async def fetch_track_bytes(
        self,
        track_id: str,
        *,
        quality: str = "hq",
        max_bytes: Optional[int] = None,
    ) -> Tuple[bytes, str]:
        """
        Download a track's audio bytes and resolved MIME content-type for
        proxying directly to Orpheus Host & Listeners.

        Signed CDN URLs are fetched WITHOUT the OAuth Authorization header.
        Returns `(audio_bytes, mime_type)`.
        """
        info = await self.get_track_stream_url(track_id, quality=quality)
        stream_url = info["url"]
        fallback_mime = info["mime"]

        session = await self._get_session()
        timeout = aiohttp.ClientTimeout(total=self._download_timeout, connect=10.0)
        try:
            async with session.get(
                stream_url,
                headers={"User-Agent": USER_AGENT},
                timeout=timeout,
            ) as resp:
                if resp.status < 200 or resp.status >= 300:
                    raise YandexMusicError(
                        f"Audio download failed (HTTP {resp.status})",
                        status=resp.status,
                    )

                if max_bytes is not None and resp.content_length and resp.content_length > max_bytes:
                    raise YandexMusicError(
                        f"Audio file exceeds size limit ({resp.content_length} > {max_bytes} bytes)"
                    )

                chunks: List[bytes] = []
                total = 0
                async for chunk in resp.content.iter_chunked(64 * 1024):
                    total += len(chunk)
                    if max_bytes is not None and total > max_bytes:
                        raise YandexMusicError(f"Audio file exceeded size limit ({max_bytes} bytes)")
                    chunks.append(chunk)

                audio_bytes = b"".join(chunks)
                if not audio_bytes:
                    raise YandexMusicError(f"Empty audio payload returned for track {track_id}")

                header_ct = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
                if header_ct and header_ct.startswith("audio/"):
                    mime = detect_audio_mime(audio_bytes, fallback=header_ct)
                else:
                    mime = detect_audio_mime(audio_bytes, fallback=fallback_mime)
                return audio_bytes, mime
        except aiohttp.ClientError as exc:
            raise YandexMusicError(f"Network error downloading audio for track {track_id}: {exc}") from exc


__all__ = [
    "API_BASE",
    "OAUTH_BASE",
    "OAUTH_VERIFICATION_URL",
    "OAUTH_CLIENT_ID",
    "OAUTH_CLIENT_SECRET",
    "OAUTH_SCOPE",
    "MP3_SALT",
    "SIGN_KEY",
    "ANDROID_CLIENT",
    "DESKTOP_CLIENT",
    "USER_AGENT",
    "WAVE_STATION",
    "YandexMusicError",
    "YandexAuthError",
    "YandexNotFoundError",
    "YandexMusicClient",
    "is_trusted_yandex_url",
    "generate_device_id",
    "build_device_header",
    "format_cover_url",
    "sign_hmac_sha256",
    "compute_download_md5",
    "build_download_url",
    "codec_to_mime",
    "detect_audio_mime",
    "get_oauth_authorize_url",
    "start_device_auth",
    "poll_device_auth",
    "refresh_oauth_token",
    "revoke_oauth_token",
    "normalize_track",
    "normalize_playlist",
    "normalize_album",
    "normalize_artist",
]
