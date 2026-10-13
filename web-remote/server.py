#!/usr/bin/env python3
"""Remote — control this computer from a web browser (iPhone, iPad, anything).

Run:  python server.py
Then open http://<this-computer>:8765 on your phone.
"""

import argparse
import asyncio
import hashlib
import hmac
import io
import json
import os
import secrets
import socket
import sys
import time
from pathlib import Path

from aiohttp import WSMsgType, web
import mss
from PIL import Image

try:
    from pynput.keyboard import Controller as KeyboardController, Key
    from pynput.mouse import Button, Controller as MouseController
except Exception as e:  # e.g. no display / missing permissions
    print(f"[warn] Input control unavailable: {e}")
    KeyboardController = MouseController = None

HERE = Path(__file__).resolve().parent
STATIC = HERE / "static"
CONFIG_FILE = HERE / "config.json"
COOKIE = "remote_session"

QUALITY = {
    "low": {"width": 1280, "jpeg": 50, "fps": 12},
    "medium": {"width": 1920, "jpeg": 70, "fps": 20},
    "high": {"width": 2880, "jpeg": 85, "fps": 30},
}


# ---------------------------------------------------------------- config ----

def hash_password(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 200_000).hex()


def load_config(reset_password: bool) -> dict:
    cfg = {}
    if CONFIG_FILE.exists():
        cfg = json.loads(CONFIG_FILE.read_text())
    if reset_password or "password_hash" not in cfg:
        password = os.environ.get("REMOTE_PASSWORD") or input(
            "Choose a password for remote access (min 8 characters): "
        ).strip()
        if len(password) < 8:
            sys.exit("Password must be at least 8 characters.")
        cfg["salt"] = secrets.token_hex(16)
        cfg["password_hash"] = hash_password(password, cfg["salt"])
        CONFIG_FILE.write_text(json.dumps(cfg, indent=2))
        try:
            CONFIG_FILE.chmod(0o600)
        except OSError:
            pass
        print("Password saved.")
    return cfg


# ------------------------------------------------------------------ auth ----

class Auth:
    MAX_FAILS = 5
    LOCKOUT_SECONDS = 300

    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.tokens: dict[str, float] = {}
        self.fails: dict[str, list[float]] = {}

    def locked(self, ip: str) -> bool:
        now = time.time()
        recent = [t for t in self.fails.get(ip, []) if now - t < self.LOCKOUT_SECONDS]
        self.fails[ip] = recent
        return len(recent) >= self.MAX_FAILS

    def login(self, ip: str, password: str) -> str | None:
        attempt = hash_password(password, self.cfg["salt"])
        if hmac.compare_digest(attempt, self.cfg["password_hash"]):
            self.fails.pop(ip, None)
            token = secrets.token_urlsafe(32)
            self.tokens[token] = time.time() + 30 * 24 * 3600
            return token
        self.fails.setdefault(ip, []).append(time.time())
        return None

    def valid(self, token: str | None) -> bool:
        expiry = self.tokens.get(token or "")
        return bool(expiry and expiry > time.time())


def client_ip(request: web.Request) -> str:
    return request.remote or "unknown"


# ----------------------------------------------------------------- input ----

SPECIAL_KEYS = {
    "Enter": "enter", "Backspace": "backspace", "Tab": "tab", "Escape": "esc",
    "Delete": "delete", "ArrowUp": "up", "ArrowDown": "down", "ArrowLeft": "left",
    "ArrowRight": "right", "Home": "home", "End": "end", "PageUp": "page_up",
    "PageDown": "page_down", " ": "space", "CapsLock": "caps_lock",
    **{f"F{i}": f"f{i}" for i in range(1, 13)},
}
MODIFIERS = {"ctrl": "ctrl", "alt": "alt", "shift": "shift", "meta": "cmd"}


class InputController:
    def __init__(self):
        self.mouse = MouseController() if MouseController else None
        self.keyboard = KeyboardController() if KeyboardController else None

    def cursor(self):
        if not self.mouse:
            return None
        try:
            return self.mouse.position
        except Exception:
            return None

    def handle(self, msg: dict, mon: dict):
        if not self.mouse or not self.keyboard:
            return
        t = msg.get("t")
        if t == "move":
            x = mon["left"] + max(0.0, min(1.0, float(msg["x"]))) * (mon["width"] - 1)
            y = mon["top"] + max(0.0, min(1.0, float(msg["y"]))) * (mon["height"] - 1)
            self.mouse.position = (int(x), int(y))
        elif t in ("down", "up", "click"):
            button = {"left": Button.left, "right": Button.right, "middle": Button.middle}.get(
                msg.get("b", "left"), Button.left
            )
            if t == "down":
                self.mouse.press(button)
            elif t == "up":
                self.mouse.release(button)
            else:
                self.mouse.click(button, int(msg.get("n", 1)))
        elif t == "scroll":
            self.mouse.scroll(int(msg.get("dx", 0)), int(msg.get("dy", 0)))
        elif t == "text":
            self.keyboard.type(str(msg.get("text", ""))[:500])
        elif t == "key":
            self.key(str(msg.get("key", "")), msg.get("mods", []))

    def key(self, name: str, mods: list):
        if name in SPECIAL_KEYS:
            key = getattr(Key, SPECIAL_KEYS[name])
        elif len(name) == 1:
            key = name.lower() if mods else name
        else:
            return
        held = [getattr(Key, MODIFIERS[m]) for m in mods if m in MODIFIERS]
        for m in held:
            self.keyboard.press(m)
        try:
            self.keyboard.press(key)
            self.keyboard.release(key)
        finally:
            for m in reversed(held):
                self.keyboard.release(m)


# ---------------------------------------------------------------- screen ----

class Screen:
    """Grabs and encodes frames. Lives in a worker thread (mss is not thread-safe)."""

    def __init__(self):
        self.sct = None

    def monitors(self):
        if self.sct is None:
            self.sct = (getattr(mss, "MSS", None) or mss.mss)()
        return self.sct.monitors[1:] or self.sct.monitors

    def grab(self, index: int, quality: dict, last_digest: bytes | None):
        mons = self.monitors()
        mon = mons[min(index, len(mons) - 1)]
        shot = self.sct.grab(mon)
        digest = hashlib.blake2b(shot.raw, digest_size=16).digest()
        if digest == last_digest:
            return mon, digest, None
        img = Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")
        if img.width > quality["width"]:
            h = round(img.height * quality["width"] / img.width)
            img = img.resize((quality["width"], h), Image.Resampling.BILINEAR)
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=quality["jpeg"])
        return mon, digest, buf.getvalue()


# --------------------------------------------------------------- session ----

async def stream(ws: web.WebSocketResponse, inputs: InputController):
    loop = asyncio.get_running_loop()
    from concurrent.futures import ThreadPoolExecutor

    grabber = ThreadPoolExecutor(max_workers=1)
    screen = Screen()
    state = {"monitor": 0, "quality": "medium", "refresh": False}
    acked = asyncio.Event()
    acked.set()
    current_mon = {}

    mons = await loop.run_in_executor(grabber, screen.monitors)
    await ws.send_json({
        "t": "hello",
        "host": socket.gethostname(),
        "monitors": [{"width": m["width"], "height": m["height"]} for m in mons],
    })

    async def send_frames():
        digest = None
        last_cursor = None
        while not ws.closed:
            started = time.monotonic()
            q = QUALITY[state["quality"]]
            if state["refresh"]:
                state["refresh"], digest = False, None
            try:
                await asyncio.wait_for(acked.wait(), timeout=3)
            except asyncio.TimeoutError:
                pass
            mon, digest, jpeg = await loop.run_in_executor(
                grabber, screen.grab, state["monitor"], q, digest
            )
            current_mon.update(mon)
            pos = inputs.cursor()
            if pos:
                cx = (pos[0] - mon["left"]) / mon["width"]
                cy = (pos[1] - mon["top"]) / mon["height"]
                if (cx, cy) != last_cursor:
                    last_cursor = (cx, cy)
                    await ws.send_json({"t": "cursor", "x": cx, "y": cy})
            if jpeg:
                acked.clear()
                await ws.send_bytes(jpeg)
            await asyncio.sleep(max(0.0, 1 / q["fps"] - (time.monotonic() - started)))

    sender = asyncio.create_task(send_frames())
    try:
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            try:
                data = json.loads(msg.data)
            except ValueError:
                continue
            t = data.get("t")
            if t == "ack":
                acked.set()
            elif t == "settings":
                if data.get("quality") in QUALITY:
                    state["quality"] = data["quality"]
                if isinstance(data.get("monitor"), int):
                    state["monitor"] = max(0, data["monitor"])
                state["refresh"] = True
            elif current_mon:
                try:
                    await loop.run_in_executor(None, inputs.handle, data, dict(current_mon))
                except Exception as e:
                    print(f"[warn] input error: {e}")
    finally:
        sender.cancel()
        grabber.shutdown(wait=False)


# ---------------------------------------------------------------- routes ----

def build_app(auth: Auth) -> web.Application:
    inputs = InputController()

    async def index(request):
        return web.FileResponse(STATIC / "index.html")

    async def login(request):
        ip = client_ip(request)
        if auth.locked(ip):
            return web.json_response({"error": "Too many attempts. Try again in 5 minutes."}, status=429)
        try:
            body = await request.json()
        except ValueError:
            return web.json_response({"error": "Bad request"}, status=400)
        token = auth.login(ip, str(body.get("password", "")))
        if not token:
            await asyncio.sleep(1)
            return web.json_response({"error": "Incorrect password"}, status=401)
        resp = web.json_response({"ok": True})
        resp.set_cookie(COOKIE, token, max_age=30 * 24 * 3600, httponly=True, samesite="Strict",
                        secure=request.secure)
        return resp

    async def logout(request):
        auth.tokens.pop(request.cookies.get(COOKIE, ""), None)
        resp = web.json_response({"ok": True})
        resp.del_cookie(COOKIE)
        return resp

    async def session(request):
        return web.json_response({
            "authenticated": auth.valid(request.cookies.get(COOKIE)),
            "host": socket.gethostname(),
        })

    async def websocket(request):
        if not auth.valid(request.cookies.get(COOKIE)):
            raise web.HTTPUnauthorized()
        ws = web.WebSocketResponse(heartbeat=20, max_msg_size=1 << 20)
        await ws.prepare(request)
        print(f"[info] connected: {client_ip(request)}")
        try:
            await stream(ws, inputs)
        finally:
            print(f"[info] disconnected: {client_ip(request)}")
        return ws

    @web.middleware
    async def headers(request, handler):
        resp = await handler(request)
        resp.headers["Cache-Control"] = "no-cache"
        resp.headers["X-Frame-Options"] = "DENY"
        resp.headers["X-Content-Type-Options"] = "nosniff"
        return resp

    app = web.Application(middlewares=[headers])
    app.router.add_get("/", index)
    app.router.add_post("/api/login", login)
    app.router.add_post("/api/logout", logout)
    app.router.add_get("/api/session", session)
    app.router.add_get("/ws", websocket)
    app.router.add_static("/", STATIC)
    return app


def local_addresses():
    addrs = set()
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            addrs.add(s.getsockname()[0])
    except OSError:
        pass
    return sorted(addrs)


def main():
    parser = argparse.ArgumentParser(description="Remote — control this computer from your phone.")
    parser.add_argument("--host", default="0.0.0.0", help="address to listen on (default: all)")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--reset-password", action="store_true", help="choose a new password")
    args = parser.parse_args()

    auth = Auth(load_config(args.reset_password))
    print("\n  Remote is running. Open one of these on your iPhone or iPad:\n")
    print(f"    http://localhost:{args.port}")
    for a in local_addresses():
        print(f"    http://{a}:{args.port}   (same Wi-Fi)")
    print("\n  For access from anywhere, see README.md (Tailscale).\n")
    web.run_app(build_app(auth), host=args.host, port=args.port, print=None)


if __name__ == "__main__":
    main()
