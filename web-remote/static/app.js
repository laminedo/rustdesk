"use strict";

const $ = (id) => document.getElementById(id);

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem("remote." + key);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem("remote." + key, JSON.stringify(value)); } catch { /* private mode */ }
  },
};

const settings = {
  quality: store.get("quality", "medium"),
  mode: store.get("mode", "trackpad"),
  speed: store.get("speed", 1.4),
  showCursor: store.get("showCursor", true),
  monitor: store.get("monitor", 0),
};

const MODE_HELP = {
  trackpad: "Drag one finger to move the pointer. Tap to click, tap with two fingers to right-click. Tap, then touch again and drag to select or move things. Drag two fingers to scroll, pinch to zoom.",
  touch: "Tap exactly where you want to click. Touch and hold to right-click. Drag to select or move things. Drag two fingers to scroll, pinch to zoom.",
};

// ------------------------------------------------------------------ sign in

async function checkSession() {
  try {
    const res = await fetch("api/session", { cache: "no-store" });
    const data = await res.json();
    $("host-name").textContent = data.host;
    return data.authenticated;
  } catch {
    return false;
  }
}

function showLogin(message) {
  disconnect(true);
  $("session").hidden = true;
  $("login").hidden = false;
  $("login-error").textContent = message || "";
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("login-btn");
  btn.disabled = true;
  $("login-error").textContent = "";
  try {
    const res = await fetch("api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: $("password").value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Could not sign in");
    $("password").value = "";
    startSession();
  } catch (err) {
    $("login-error").textContent = err.message === "Failed to fetch" ? "Can’t reach your computer" : err.message;
    const card = document.querySelector(".login-card");
    card.classList.remove("shake");
    void card.offsetWidth;
    card.classList.add("shake");
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------------------------------ session

let ws = null;
let manualClose = false;
let retryDelay = 1000;
let wakeLock = null;
let frameW = 0, frameH = 0;
let hostName = "";

const canvas = $("canvas");
const ctx = canvas.getContext("2d");
const stage = $("stage");
const viewport = $("viewport");
const cursorEl = $("cursor");

function startSession() {
  $("login").hidden = true;
  $("session").hidden = false;
  manualClose = false;
  applySettingsUI();
  connect();
  requestWakeLock();
}

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}${location.pathname.replace(/[^/]*$/, "")}ws`);
  ws.binaryType = "blob";
  setStatus("Connecting…", "");

  ws.onopen = () => {
    retryDelay = 1000;
    send({ t: "settings", quality: settings.quality, monitor: settings.monitor });
  };

  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") return onJSON(JSON.parse(ev.data));
    drawFrame(ev.data);
  };

  ws.onclose = async () => {
    ws = null;
    if (manualClose) return;
    if (!(await checkSession())) return showLogin("Your session ended. Please sign in again.");
    setStatus("Reconnecting…", "bad");
    setTimeout(() => { if (!manualClose && !ws) connect(); }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 10000);
  };
}

function disconnect(silent) {
  manualClose = true;
  if (ws) ws.close();
  ws = null;
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  if (!silent) fetch("api/logout", { method: "POST" }).finally(() => showLogin());
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function onJSON(msg) {
  if (msg.t === "hello") {
    hostName = msg.host;
    buildMonitorPicker(msg.monitors);
  } else if (msg.t === "cursor") {
    remoteCursor.x = msg.x;
    remoteCursor.y = msg.y;
    if (performance.now() - lastLocalMove > 600) {
      pointer.x = msg.x;
      pointer.y = msg.y;
    }
    renderCursor();
  }
}

async function drawFrame(blob) {
  let img;
  try {
    img = "createImageBitmap" in window ? await createImageBitmap(blob) : await loadImage(blob);
  } catch {
    send({ t: "ack" });
    return;
  }
  if (img.width !== frameW || img.height !== frameH) {
    frameW = canvas.width = img.width;
    frameH = canvas.height = img.height;
    stage.style.width = frameW + "px";
    stage.style.height = frameH + "px";
    fitView();
  }
  ctx.drawImage(img, 0, 0);
  if (img.close) img.close();
  send({ t: "ack" });
}

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = reject;
    img.src = url;
  });
}

setInterval(() => {
  if (!ws || ws.readyState !== WebSocket.OPEN || !frameW) return;
  setStatus(`Connected to ${hostName}`, "ok", true);
}, 1000);

let statusShownAt = 0;
function setStatus(text, cls, autoFade) {
  const el = $("status");
  $("status-text").textContent = text;
  el.className = "status glass " + cls;
  if (!autoFade) { statusShownAt = performance.now(); return; }
  if (performance.now() - statusShownAt > 2500) el.classList.add("faded");
}

async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* not supported */ }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !$("session").hidden) requestWakeLock();
});

// --------------------------------------------------------------- view/zoom

const view = { s: 1, ox: 0, oy: 0 };
let fitScale = 1;

function fitView() {
  if (!frameW) return;
  const vw = viewport.clientWidth, vh = viewport.clientHeight;
  fitScale = Math.min(vw / frameW, vh / frameH);
  view.s = fitScale;
  clampView();
}

function clampView() {
  const vw = viewport.clientWidth, vh = viewport.clientHeight;
  view.s = Math.min(Math.max(view.s, fitScale), fitScale * 6);
  const w = frameW * view.s, h = frameH * view.s;
  view.ox = w <= vw ? (vw - w) / 2 : Math.min(0, Math.max(vw - w, view.ox));
  view.oy = h <= vh ? (vh - h) / 2 : Math.min(0, Math.max(vh - h, view.oy));
  stage.style.transform = `translate(${view.ox}px, ${view.oy}px) scale(${view.s})`;
  renderCursor();
}

window.addEventListener("resize", fitView);
window.visualViewport?.addEventListener("resize", () => {
  const vv = window.visualViewport;
  const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  document.documentElement.style.setProperty("--kb", kb + "px");
});

function toNormalized(clientX, clientY) {
  const r = viewport.getBoundingClientRect();
  return {
    x: clamp01((clientX - r.left - view.ox) / view.s / frameW),
    y: clamp01((clientY - r.top - view.oy) / view.s / frameH),
  };
}
const clamp01 = (v) => Math.min(1, Math.max(0, v));

// ------------------------------------------------------------------ pointer

const pointer = { x: 0.5, y: 0.5 };       // where we want the remote cursor
const remoteCursor = { x: 0.5, y: 0.5 };  // where the remote says it is
let lastLocalMove = -Infinity;
let pendingMove = false;

function renderCursor() {
  const local = performance.now() - lastLocalMove < 600;
  const p = local ? pointer : remoteCursor;
  cursorEl.hidden = !settings.showCursor || !frameW;
  cursorEl.style.left = p.x * frameW + "px";
  cursorEl.style.top = p.y * frameH + "px";
  cursorEl.style.transform = `scale(${1 / view.s})`;
}

function moveTo(x, y) {
  pointer.x = clamp01(x);
  pointer.y = clamp01(y);
  lastLocalMove = performance.now();
  renderCursor();
  if (pendingMove) return;
  pendingMove = true;
  requestAnimationFrame(() => {
    pendingMove = false;
    send({ t: "move", x: pointer.x, y: pointer.y });
  });
}

function flushMove() {
  send({ t: "move", x: pointer.x, y: pointer.y });
}

function followPointer() {
  if (view.s <= fitScale * 1.01) return;
  const vw = viewport.clientWidth, vh = viewport.clientHeight, m = 60;
  const sx = view.ox + pointer.x * frameW * view.s;
  const sy = view.oy + pointer.y * frameH * view.s;
  if (sx < m) view.ox += m - sx;
  if (sx > vw - m) view.ox -= sx - (vw - m);
  if (sy < m) view.oy += m - sy;
  if (sy > vh - m) view.oy -= sy - (vh - m);
  clampView();
}

function click(button = "left") {
  flushMove();
  send({ t: "click", b: button });
}

// ------------------------------------------------------------------ touch

const TAP_MS = 280, TAP_SLOP = 10, HOLD_MS = 550;
let g = null;           // current gesture
let lastTapEnd = 0;
let lastTapPos = null;

viewport.addEventListener("touchstart", (e) => {
  e.preventDefault();
  if (!frameW) return;
  const t = e.touches;

  if (t.length === 1) {
    const now = performance.now();
    const p = { x: t[0].clientX, y: t[0].clientY };
    const secondTap = now - lastTapEnd < 320 && lastTapPos && dist(p, lastTapPos) < 40;
    g = { kind: "one", start: p, last: p, t0: now, moved: false, dragging: false, secondTap };
    if (settings.mode === "touch") {
      g.hold = setTimeout(() => {
        if (!g || g.moved) return;
        const n = toNormalized(p.x, p.y);
        moveTo(n.x, n.y);
        click("right");
        g.held = true;
        navigator.vibrate?.(10);
      }, HOLD_MS);
    }
  } else if (t.length === 2) {
    endOne();
    const a = { x: t[0].clientX, y: t[0].clientY }, b = { x: t[1].clientX, y: t[1].clientY };
    g = {
      kind: "two", t0: performance.now(), d0: dist(a, b), m0: mid(a, b), last: mid(a, b),
      s0: view.s, ox0: view.ox, oy0: view.oy, cls: null, sx: 0, sy: 0,
    };
  } else {
    g = { kind: "done" };
  }
}, { passive: false });

viewport.addEventListener("touchmove", (e) => {
  e.preventDefault();
  if (!g) return;
  const t = e.touches;

  if (g.kind === "one" && t.length === 1) {
    const p = { x: t[0].clientX, y: t[0].clientY };
    if (!g.moved && dist(p, g.start) > TAP_SLOP) {
      g.moved = true;
      clearTimeout(g.hold);
      if (settings.mode === "touch") {
        const n = toNormalized(g.start.x, g.start.y);
        moveTo(n.x, n.y);
        flushMove();
        send({ t: "down", b: "left" });
        g.dragging = true;
      } else if (g.secondTap) {
        flushMove();
        send({ t: "down", b: "left" });
        g.dragging = true;
      }
    }
    if (g.moved) {
      if (settings.mode === "touch") {
        const n = toNormalized(p.x, p.y);
        moveTo(n.x, n.y);
      } else {
        const k = settings.speed / (frameW * view.s);
        const ky = settings.speed / (frameH * view.s);
        moveTo(pointer.x + (p.x - g.last.x) * k * accel(p, g.last), pointer.y + (p.y - g.last.y) * ky * accel(p, g.last));
        followPointer();
      }
    }
    g.last = p;
  } else if (g.kind === "two" && t.length === 2) {
    const a = { x: t[0].clientX, y: t[0].clientY }, b = { x: t[1].clientX, y: t[1].clientY };
    const d = dist(a, b), m = mid(a, b);
    if (!g.cls) {
      if (Math.abs(d - g.d0) > 24) g.cls = "zoom";
      else if (dist(m, g.m0) > 10) g.cls = "scroll";
    }
    if (g.cls === "zoom") {
      const r = viewport.getBoundingClientRect();
      const s = Math.min(Math.max(g.s0 * d / g.d0, fitScale), fitScale * 6);
      view.ox = (m.x - r.left) - ((g.m0.x - r.left) - g.ox0) * (s / g.s0);
      view.oy = (m.y - r.top) - ((g.m0.y - r.top) - g.oy0) * (s / g.s0);
      view.s = s;
      clampView();
    } else if (g.cls === "scroll") {
      g.sx += m.x - g.last.x;
      g.sy += m.y - g.last.y;
      const STEP = 24;
      const dy = Math.trunc(g.sy / STEP), dx = Math.trunc(g.sx / STEP);
      if (dx || dy) {
        send({ t: "scroll", dx: -dx, dy });
        g.sx -= dx * STEP;
        g.sy -= dy * STEP;
      }
    }
    g.last = m;
  }
}, { passive: false });

function onTouchEnd(e) {
  e.preventDefault();
  if (!g) return;
  const now = performance.now();

  if (g.kind === "one") {
    clearTimeout(g.hold);
    if (g.dragging) {
      flushMove();
      send({ t: "up", b: "left" });
    } else if (!g.moved && !g.held && now - g.t0 < 400) {
      if (settings.mode === "touch") {
        const n = toNormalized(g.start.x, g.start.y);
        moveTo(n.x, n.y);
      }
      click("left");
      lastTapEnd = now;
      lastTapPos = g.start;
    }
  } else if (g.kind === "two" && !g.cls && now - g.t0 < TAP_MS + 120) {
    if (settings.mode === "touch") {
      const n = toNormalized(g.m0.x, g.m0.y);
      moveTo(n.x, n.y);
    }
    click("right");
  }

  if (e.touches.length === 0) g = null;
  else if (g.kind !== "done") g = { kind: "done" };
}
viewport.addEventListener("touchend", onTouchEnd, { passive: false });
viewport.addEventListener("touchcancel", onTouchEnd, { passive: false });

function endOne() {
  if (g && g.kind === "one") {
    clearTimeout(g.hold);
    if (g.dragging) send({ t: "up", b: "left" });
  }
}

function accel(p, q) {
  const v = dist(p, q);
  return v > 12 ? 1.8 : v > 5 ? 1.3 : 1;
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

// ---------------------------------------- mouse / trackpad on iPad & desktop

const BUTTONS = ["left", "middle", "right"];
viewport.addEventListener("pointermove", (e) => {
  if (e.pointerType !== "mouse" || !frameW) return;
  const n = toNormalized(e.clientX, e.clientY);
  moveTo(n.x, n.y);
});
viewport.addEventListener("pointerdown", (e) => {
  if (e.pointerType !== "mouse" || !frameW) return;
  const n = toNormalized(e.clientX, e.clientY);
  moveTo(n.x, n.y);
  flushMove();
  send({ t: "down", b: BUTTONS[e.button] || "left" });
});
viewport.addEventListener("pointerup", (e) => {
  if (e.pointerType !== "mouse") return;
  send({ t: "up", b: BUTTONS[e.button] || "left" });
});
viewport.addEventListener("contextmenu", (e) => e.preventDefault());

let wheelX = 0, wheelY = 0;
viewport.addEventListener("wheel", (e) => {
  e.preventDefault();
  const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
  wheelX += e.deltaX * unit;
  wheelY += e.deltaY * unit;
  const STEP = 50;
  const dx = Math.trunc(wheelX / STEP), dy = Math.trunc(wheelY / STEP);
  if (dx || dy) {
    send({ t: "scroll", dx, dy: -dy });
    wheelX -= dx * STEP;
    wheelY -= dy * STEP;
  }
}, { passive: false });

// ------------------------------------------------------------------ keyboard

const kbd = $("kbd");
const sticky = new Set();
const SPECIAL = new Set([
  "Enter", "Backspace", "Tab", "Escape", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Home", "End", "PageUp", "PageDown", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
]);

function sendKey(key, mods = []) {
  const all = [...new Set([...mods, ...sticky])];
  send({ t: "key", key, mods: all });
  clearSticky();
}

function sendText(text) {
  if (!text) return;
  if (sticky.size && text.length === 1) return sendKey(text);
  send({ t: "text", text });
}

function clearSticky() {
  if (!sticky.size) return;
  sticky.clear();
  document.querySelectorAll("[data-mod]").forEach((b) => b.classList.remove("on"));
}

document.addEventListener("keydown", (e) => {
  if ($("session").hidden || $("sheet").classList.contains("open")) return;
  const mods = [];
  if (e.ctrlKey) mods.push("ctrl");
  if (e.altKey) mods.push("alt");
  if (e.metaKey) mods.push("meta");
  if (SPECIAL.has(e.key)) {
    if (e.shiftKey) mods.push("shift");
    e.preventDefault();
    sendKey(e.key, mods);
  } else if (e.key.length === 1 && (mods.length || e.target !== kbd)) {
    e.preventDefault();
    if (mods.length) sendKey(e.key, mods);
    else sendText(e.key);
  }
});

kbd.addEventListener("beforeinput", (e) => {
  if (e.inputType === "insertText" || e.inputType === "insertReplacementText") {
    e.preventDefault();
    sendText(e.data || e.dataTransfer?.getData("text/plain") || "");
  } else if (e.inputType === "deleteContentBackward") {
    e.preventDefault();
    sendKey("Backspace");
  } else if (e.inputType === "insertLineBreak" || e.inputType === "insertParagraph") {
    e.preventDefault();
    sendKey("Enter");
  }
});
kbd.addEventListener("input", () => {
  if (kbd.value) { sendText(kbd.value); kbd.value = ""; }
});

$("btn-keyboard").addEventListener("click", () => {
  if (document.activeElement === kbd) {
    kbd.blur();
  } else {
    kbd.focus({ preventScroll: true });
  }
});
kbd.addEventListener("focus", () => $("btn-keyboard").classList.add("active"));
kbd.addEventListener("blur", () => $("btn-keyboard").classList.remove("active"));

$("btn-keys").addEventListener("click", () => {
  const bar = $("keys-bar");
  bar.hidden = !bar.hidden;
  $("btn-keys").classList.toggle("active", !bar.hidden);
});

$("keys-bar").addEventListener("pointerdown", (e) => e.preventDefault()); // keep soft keyboard open
$("keys-bar").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.mod) {
    const m = b.dataset.mod;
    if (sticky.has(m)) sticky.delete(m); else sticky.add(m);
    b.classList.toggle("on", sticky.has(m));
  } else if (b.dataset.key) {
    sendKey(b.dataset.key);
  }
});

// ------------------------------------------------------------------ toolbar

function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  el.style.animation = "none";
  void el.offsetWidth;
  el.style.animation = "";
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 1200);
}

$("btn-mode").addEventListener("click", () => {
  setMode(settings.mode === "trackpad" ? "touch" : "trackpad");
  toast(settings.mode === "trackpad" ? "Trackpad mode" : "Touch mode");
});

$("btn-hide").addEventListener("click", () => {
  $("toolbar").classList.add("hidden-down");
  $("keys-bar").hidden = true;
  $("btn-keys").classList.remove("active");
  $("btn-show").hidden = false;
});
$("btn-show").addEventListener("click", () => {
  $("toolbar").classList.remove("hidden-down");
  $("btn-show").hidden = true;
});

// ------------------------------------------------------------------ settings

function openSheet() {
  kbd.blur();
  $("sheet-backdrop").hidden = false;
  $("sheet").classList.add("open");
  $("sheet").setAttribute("aria-hidden", "false");
}
function closeSheet() {
  $("sheet-backdrop").hidden = true;
  $("sheet").classList.remove("open");
  $("sheet").setAttribute("aria-hidden", "true");
}
$("btn-settings").addEventListener("click", openSheet);
$("sheet-done").addEventListener("click", closeSheet);
$("sheet-backdrop").addEventListener("click", closeSheet);

function bindSegmented(id, onPick) {
  $(id).addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) onPick(b.dataset.value);
  });
}
function markSegmented(id, value) {
  $(id).querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.value === String(value)));
}

function setMode(mode) {
  settings.mode = mode;
  store.set("mode", mode);
  applySettingsUI();
}

bindSegmented("seg-quality", (q) => {
  settings.quality = q;
  store.set("quality", q);
  send({ t: "settings", quality: q });
  applySettingsUI();
});
bindSegmented("seg-mode", setMode);
bindSegmented("seg-monitor", (v) => {
  settings.monitor = Number(v);
  store.set("monitor", settings.monitor);
  send({ t: "settings", monitor: settings.monitor });
  applySettingsUI();
});
$("opt-speed").addEventListener("input", (e) => {
  settings.speed = Number(e.target.value);
  store.set("speed", settings.speed);
});
$("opt-cursor").addEventListener("change", (e) => {
  settings.showCursor = e.target.checked;
  store.set("showCursor", settings.showCursor);
  renderCursor();
});
$("btn-disconnect").addEventListener("click", () => {
  closeSheet();
  disconnect(false);
});

function buildMonitorPicker(monitors) {
  const seg = $("seg-monitor");
  seg.innerHTML = "";
  monitors.forEach((m, i) => {
    const b = document.createElement("button");
    b.dataset.value = i;
    b.textContent = monitors.length > 1 ? `${i + 1}` : `${m.width}×${m.height}`;
    seg.appendChild(b);
  });
  if (settings.monitor >= monitors.length) settings.monitor = 0;
  applySettingsUI();
}

function applySettingsUI() {
  markSegmented("seg-quality", settings.quality);
  markSegmented("seg-mode", settings.mode);
  markSegmented("seg-monitor", settings.monitor);
  $("opt-speed").value = settings.speed;
  $("opt-cursor").checked = settings.showCursor;
  $("mode-help").textContent = MODE_HELP[settings.mode];
  $("ico-trackpad").toggleAttribute("hidden", settings.mode !== "trackpad");
  $("ico-touch").toggleAttribute("hidden", settings.mode !== "touch");
}

// ------------------------------------------------------------------ boot

applySettingsUI();
checkSession().then((ok) => (ok ? startSession() : showLogin()));
